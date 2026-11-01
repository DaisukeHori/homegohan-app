// @vitest-environment node
/**
 * AI 相談のプロフィールの更新 (update_profile_preferences) は、PUT /api/profile と同じ列の型で値を検査する (#2183 Z2-a)
 *
 * 問題:
 *   以前は許す欄の一覧で欄だけを絞り、値は検査せずに user_profiles へ update していた。DB の time の列は '24:00' や
 *   小数の秒つきの時刻を受けるので、AI がそれを書くと、プロフィールの画面が GET の値をそのまま PUT に戻したとき
 *   PUT の検査 (USER_PROFILE_TIME_OF_DAY_PATTERN) が 400 で拒み、全部の欄が保存できなくなっていた。
 *
 * 決まり (このテストが固定する):
 *   1. wake_time / sleep_time は PUT と同じ時刻の書式 (HH:MM か HH:MM:SS・時は 00〜23) だけを書く。合わなければ何も書かずに失敗の文を返す
 *   2. AI が書いた時刻は、GET → PUT でそのまま戻しても PUT の検査を通る
 *   3. 許す欄の全部が、PUT と同じ欄なら PUT の型 (USER_PROFILE_UPDATE_FIELDS)、PUT に無い欄 (exercise_types) は POST の型で検査される。
 *      列の名前から欄の名前への対応は fromUserProfile と一致する
 *   4. 型に合わない欄が 1 つでもあれば、ほかの欄も書かない。失敗の文は「日本語の名前 (列の名前)」の形の日本語
 *   5. 許す欄は以前の一覧と同じ (広げない)。禁止の欄・一覧に無い欄は黙って落とす。更新の内容がオブジェクトでなければ失敗の文
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  invokeGenerateMenuV4WithRetry: vi.fn(),
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(),
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
}));
vi.mock('@/lib/v4-target-slots', () => ({ resolveExistingTargetSlots: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ ...logger, withUser: () => logger }) }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

import { runConsultationAction } from '@/lib/ai/consultation-action-executor';
import {
  AI_PROFILE_FORBIDDEN_FIELDS,
  AI_PROFILE_PREFERENCE_FIELD_NAMES,
  AI_PROFILE_PREFERENCE_UPDATES_NOT_OBJECT_MESSAGE,
  aiProfilePreferenceSpecOf,
  aiProfilePreferenceValueMessage,
  profileFieldOfColumn,
} from '@/lib/ai/profile-preference-updates';
import {
  USER_PROFILE_POST_FIELDS,
  USER_PROFILE_UPDATE_FIELDS,
  UserProfileUpdateBodySchema,
  type UserProfileColumnKind,
} from '@/lib/profile-update-schema';
import { fromUserProfile } from '@/lib/converter';
import type { UserProfile } from '@/types/domain';
import { englishIdentifiersOutsideParentheses, isEnglishOnly } from './helpers/api-error-text-scan';
import { createRecordingSupabase } from './helpers/recording-supabase';

const USER = { id: 'user-1' };
const WRITE_METHODS = new Set(['update', 'upsert', 'insert', 'delete']);

async function run(params: Record<string, unknown>) {
  const db = createRecordingSupabase(() => ({ data: null, error: null }));
  const out = await runConsultationAction(db.client, USER, {
    id: 'action-1',
    action_type: 'update_profile_preferences',
    action_params: params,
    ai_consultation_sessions: { user_id: USER.id },
  });
  const writes = db.queries.filter((query) => query.calls.some((call) => WRITE_METHODS.has(call.method)));
  return { out, writes };
}

/** 書き込み (update) に渡した値 */
function writtenValues(writes: Awaited<ReturnType<typeof run>>['writes']): unknown[] {
  return writes.flatMap((query) => query.calls.filter((call) => call.method === 'update').map((call) => call.args[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** 以前の許す欄の一覧 (executor の allowedFields。広げない・狭めない) */
const PREVIOUS_ALLOWED_COLUMNS = [
  'nickname', 'age', 'gender', 'height', 'weight', 'target_weight',
  'body_fat_percentage', 'target_body_fat', 'muscle_mass',
  'health_conditions', 'medications', 'fitness_goals',
  'sleep_quality', 'stress_level', 'bowel_movement', 'skin_condition',
  'cold_sensitivity', 'swelling_prone',
  'occupation', 'industry', 'work_style', 'desk_hours_per_day',
  'overtime_frequency', 'business_trip_frequency', 'entertainment_frequency',
  'weekly_exercise_minutes', 'exercise_types',
  'diet_style', 'religious_restrictions', 'diet_flags',
  'cuisine_preferences', 'taste_preferences', 'favorite_ingredients', 'favorite_dishes',
  'cooking_experience', 'specialty_cuisines', 'disliked_cooking',
  'weekday_cooking_minutes', 'weekend_cooking_minutes',
  'meal_prep_ok', 'kitchen_appliances',
  'wake_time', 'sleep_time', 'meal_times',
  'snacking_habit', 'alcohol_frequency', 'smoking', 'caffeine_intake', 'daily_water_ml',
  'family_size', 'has_children', 'children_ages', 'has_elderly',
  'weekly_food_budget', 'shopping_frequency', 'preferred_stores',
  'online_grocery', 'organic_preference',
  'hobbies', 'weekend_activity', 'outdoor_activities',
];

/** PUT に無く POST の型で検査する欄 */
const POST_ONLY_COLUMNS = ['exercise_types'];

const TIME_COLUMNS = ['wake_time', 'sleep_time'];
/** DB の time の列は受けるが、PUT の検査が拒む時刻 (AI がこれを書くと GET → PUT が 400 になる) */
const TIMES_PUT_REJECTS = ['24:00', '24:00:00', '07:30:00.5', '07:30:15.123456'];
/** 書式の誤り・範囲の外 */
const MALFORMED_TIMES: unknown[] = ['25:00', '7:30', '07:60', '07:30:60', '0730', '', ' 07:30', 730, true, ['07:30']];
const VALID_TIMES = ['00:00', '07:30', '23:59', '07:30:15', '23:59:59'];

describe('起床・就寝の時刻は PUT と同じ書式だけを書く (#2183 Z2-a)', () => {
  const rejectCases = TIME_COLUMNS.flatMap((column) =>
    [...TIMES_PUT_REJECTS, ...MALFORMED_TIMES].map((value) => ({ column, value })),
  );
  it.each(rejectCases)('$column に $value は書かずに失敗の文を返す', async ({ column, value }) => {
    const { out, writes } = await run({ updates: { [column]: value } });
    expect(out.success).toBe(false);
    const spec = aiProfilePreferenceSpecOf(column);
    expect(spec).toBeDefined();
    expect(out.result).toEqual({ error: aiProfilePreferenceValueMessage(column, spec!) });
    expect(writes).toEqual([]);
  });

  const validCases = TIME_COLUMNS.flatMap((column) => VALID_TIMES.map((value) => ({ column, value })));
  it.each(validCases)('$column に $value は書き、その値は GET → PUT で戻しても PUT の検査を通る', async ({ column, value }) => {
    const { out, writes } = await run({ updates: { [column]: value } });
    expect(out.success).toBe(true);
    expect(writtenValues(writes)).toEqual([{ [column]: value }]);
    expect(UserProfileUpdateBodySchema.safeParse({ [profileFieldOfColumn(column)]: value }).success).toBe(true);
  });

  it('null (時刻を消す) は書く', async () => {
    const { out, writes } = await run({ updates: { wake_time: null, sleep_time: null } });
    expect(out.success).toBe(true);
    expect(writtenValues(writes)).toEqual([{ wake_time: null, sleep_time: null }]);
  });

  it('PUT が拒む時刻は、AI の更新でも拒む (PUT の検査と同じ判定)', async () => {
    for (const value of TIMES_PUT_REJECTS) {
      expect(UserProfileUpdateBodySchema.safeParse({ wakeTime: value }).success, value).toBe(false);
      const { writes } = await run({ updates: { wake_time: value } });
      expect(writes, value).toEqual([]);
    }
  });

  it('時刻が型に合わなければ、ほかの正しい欄も書かない', async () => {
    const { out, writes } = await run({ updates: { wake_time: '24:00', nickname: '花子', smoking: false } });
    expect(out.success).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('許す欄の全部を、PUT (無ければ POST) と同じ列の型で検査する (#2183 Z2-a)', () => {
  it('許す欄は以前の一覧と同じ (広げない・狭めない)', () => {
    expect([...AI_PROFILE_PREFERENCE_FIELD_NAMES.keys()].sort()).toEqual([...PREVIOUS_ALLOWED_COLUMNS].sort());
  });

  it('禁止の欄は許す欄に入っていない', () => {
    for (const column of AI_PROFILE_FORBIDDEN_FIELDS) {
      expect(AI_PROFILE_PREFERENCE_FIELD_NAMES.has(column), column).toBe(false);
      expect(aiProfilePreferenceSpecOf(column), column).toBeUndefined();
    }
  });

  it.each(PREVIOUS_ALLOWED_COLUMNS)('%s の型は、PUT と同じ欄なら PUT の型・PUT に無い欄は POST の型 (列の名前の対応も一致)', (column) => {
    const field = profileFieldOfColumn(column);
    const spec = aiProfilePreferenceSpecOf(column);
    if (POST_ONLY_COLUMNS.includes(column)) {
      expect(Object.prototype.hasOwnProperty.call(USER_PROFILE_UPDATE_FIELDS, field)).toBe(false);
      expect(USER_PROFILE_POST_FIELDS[field]?.column).toBe(column);
      expect(spec).toBe(USER_PROFILE_POST_FIELDS[field].spec);
      return;
    }
    expect(Object.prototype.hasOwnProperty.call(USER_PROFILE_UPDATE_FIELDS, field), field).toBe(true);
    expect(spec).toBe(USER_PROFILE_UPDATE_FIELDS[field]);
    // PUT は欄 (camelCase) を fromUserProfile で列に写す。AI の更新の列と同じ列に写ること
    const sentinel = { sentinel: column };
    const mapped = fromUserProfile({ [field]: sentinel } as Partial<UserProfile>);
    expect(mapped).toEqual({ [column]: sentinel });
  });

  it('時刻の欄は time の型', () => {
    for (const column of TIME_COLUMNS) {
      expect(aiProfilePreferenceSpecOf(column)?.kind).toBe('time');
    }
  });

  /** 列の型ごとの、型に合わない値 (jsonb はどの値でも通るので無い) */
  const INVALID_VALUE_OF_KIND: Readonly<Record<UserProfileColumnKind, unknown | undefined>> = {
    text: 5,
    date: '2026-02-30',
    time: '24:00',
    integer: 1.5,
    numeric: '60',
    boolean: 'yes',
    textArray: '和食',
    integerArray: ['3'],
    jsonb: undefined,
  };

  const invalidCases = PREVIOUS_ALLOWED_COLUMNS.flatMap((column) => {
    const spec = aiProfilePreferenceSpecOf(column);
    const value = spec ? INVALID_VALUE_OF_KIND[spec.kind] : undefined;
    return value === undefined ? [] : [{ column, value }];
  });

  it('型に合わない値を試せる欄は、許す欄のうち jsonb 以外の全部', () => {
    const nonJsonColumns = PREVIOUS_ALLOWED_COLUMNS.filter((column) => aiProfilePreferenceSpecOf(column)?.kind !== 'jsonb');
    expect(invalidCases.map(({ column }) => column)).toEqual(nonJsonColumns);
  });

  it.each(invalidCases)('$column に型に合わない値 ($value) は書かず、日本語の名前 (列の名前) の文を返す', async ({ column, value }) => {
    const { out, writes } = await run({ updates: { [column]: value } });
    expect(out.success).toBe(false);
    expect(writes).toEqual([]);
    const text = (out.result as { error: string }).error;
    expect(text).toContain(`${AI_PROFILE_PREFERENCE_FIELD_NAMES.get(column)} (${column})`);
    expect(isEnglishOnly(text)).toBe(false);
    expect(englishIdentifiersOutsideParentheses(text), text).toEqual([]);
    // 自分の検証の文は日本語なので、置き換え (固定の文) もログも出さない
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('NOT NULL の列 (名前・性別) に null は書かない', async () => {
    for (const column of ['nickname', 'gender']) {
      const { out, writes } = await run({ updates: { [column]: null } });
      expect(out.success, column).toBe(false);
      expect(writes, column).toEqual([]);
    }
  });

  it('型に合わない欄が 2 つなら、両方の文をつなぐ', async () => {
    const { out } = await run({ updates: { age: 'abc', smoking: 'yes' } });
    expect(out.result).toEqual({
      error: [
        aiProfilePreferenceValueMessage('age', USER_PROFILE_UPDATE_FIELDS.age),
        aiProfilePreferenceValueMessage('smoking', USER_PROFILE_UPDATE_FIELDS.smoking),
      ].join(', '),
    });
  });

  it('型に合う値は、許す欄だけを書く (禁止の欄・一覧に無い欄は黙って落とす)', async () => {
    const { out, writes } = await run({
      updates: {
        nickname: '花子',
        age: 30,
        height: 160.5,
        smoking: false,
        hobbies: ['料理'],
        children_ages: [3, null],
        meal_times: { breakfast: '07:00' },
        exercise_types: ['ウォーキング'],
        role: 'admin',
        email: 'x@example.com',
        unknown_column: 1,
      },
    });
    expect(out.success).toBe(true);
    expect(writtenValues(writes)).toEqual([
      {
        nickname: '花子',
        age: 30,
        height: 160.5,
        smoking: false,
        hobbies: ['料理'],
        children_ages: [3, null],
        meal_times: { breakfast: '07:00' },
        exercise_types: ['ウォーキング'],
      },
    ]);
    expect(out.result).toEqual({
      updated: true,
      fields: ['nickname', 'age', 'height', 'smoking', 'hobbies', 'children_ages', 'meal_times', 'exercise_types'],
    });
  });

  it('許す欄が 1 つも無ければ、今までどおり「更新可能なフィールドがありません」', async () => {
    const { out, writes } = await run({ updates: { role: 'admin', is_banned: false } });
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error: '更新可能なフィールドがありません' });
    expect(writes).toEqual([]);
  });

  it.each([[null], [undefined], ['wake_time'], [['07:30']], [7]])('更新の内容がオブジェクトでない (%j) と、書かずに失敗の文を返す', async (updates) => {
    const { out, writes } = await run({ updates });
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error: AI_PROFILE_PREFERENCE_UPDATES_NOT_OBJECT_MESSAGE });
    expect(writes).toEqual([]);
  });

  it('プロトタイプのキー (constructor など) は許す欄にならない', async () => {
    const updates = JSON.parse('{"constructor": 1, "__proto__": {"wake_time": "24:00"}, "toString": "x"}') as Record<string, unknown>;
    const { out, writes } = await run({ updates });
    expect(out.result).toEqual({ error: '更新可能なフィールドがありません' });
    expect(writes).toEqual([]);
  });
});
