// @vitest-environment node
/**
 * #2201 U4 AI 相談で身長・体重などを入れたら、プロフィールの完成度 (user_profiles.profile_completeness) を計算し直す
 *
 * 問題 (直す前):
 *   profile_completeness を書くのは PUT /api/profile だけで、AI 相談の update_profile_preferences (身長・体重・年齢・体づくりの目標・
 *   健康の状態などを書く) と add_health_record (今日の体重を user_profiles.weight にも写す) は計算し直さなかった。
 *   AI で身長を入れると、帯 (ProfileReminderBanner) の未入力の一覧は消えるが「プロフィール完成度 X%」と帯は古いまま残った。
 *
 * 直したあと:
 *   - 書いた後の行 (select('*')) から PUT と同じ計算 (src/lib/profile-completeness.ts) で完成度を出し、変わっていれば書く
 *   - 計算は PUT /api/profile が使っていたものと同じ (欄・重み・判定を変えない)
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
import { calculateProfileCompleteness, profileCompletenessOfRow } from '@/lib/profile-completeness';
import { todayLocal } from '@/lib/date-utils';
import type { DbUserProfile } from '@/types/database';
import { createRecordingSupabase, firstMethodOf, type QueryOutcome, type RecordedQuery } from './helpers/recording-supabase';

const USER = { id: 'user-1' };
/** 身長の重み (src/lib/profile-completeness.ts の PROFILE_COMPLETENESS_FIELDS の height。重みの合計は 100) */
const HEIGHT_WEIGHT_PERCENT = 4;
const HEIGHT_CM = 170;
const WEIGHT_KG = 62.5;
/** 計算し直す前の行に入っていた完成度 (古い値) */
const STALE_COMPLETENESS = 10;
/** DB の読み取りの失敗 */
const DB_FAILURE = { message: 'db error', code: 'XX000' };

/** 身長・体重の無い行 (名前・性別だけ。ほかは null) */
const ROW_BEFORE: Partial<DbUserProfile> = {
  id: USER.id,
  nickname: 'ほり',
  gender: 'female',
  age: null,
  height: null,
  weight: null,
  profile_completeness: STALE_COMPLETENESS,
};

/** 書いた後の行を返し、書き込みは成功させる。user_profiles の update に渡した値を記録する */
function respondWith(rowAfter: Partial<DbUserProfile> | null, overrides: (query: RecordedQuery) => QueryOutcome | null = () => null) {
  return (query: RecordedQuery): QueryOutcome => {
    const overridden = overrides(query);
    if (overridden) return overridden;
    const first = firstMethodOf(query);
    if (first === 'select' && query.table === 'user_profiles') return { data: rowAfter };
    return { data: null };
  };
}

async function run(actionType: string, params: Record<string, unknown>, respond: (query: RecordedQuery) => QueryOutcome) {
  const db = createRecordingSupabase(respond);
  const out = await runConsultationAction(db.client, USER, {
    id: 'action-1',
    action_type: actionType,
    action_params: params,
    ai_consultation_sessions: { user_id: USER.id },
  });
  return { out, queries: db.queries };
}

/** user_profiles の update に渡した値 (書いた順) */
function profileUpdates(queries: RecordedQuery[]): unknown[] {
  return queries
    .filter((query) => query.table === 'user_profiles' && firstMethodOf(query) === 'update')
    .map((query) => query.calls[0].args[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('完成度の計算は PUT /api/profile と同じ (#2201 U4 で src/lib/profile-completeness.ts に移した)', () => {
  it('何も入っていなければ 0、全部の欄が入っていれば 100', () => {
    expect(calculateProfileCompleteness({})).toBe(0);
    expect(
      calculateProfileCompleteness({
        nickname: 'ほり',
        age: 30,
        gender: 'female',
        height: HEIGHT_CM,
        weight: WEIGHT_KG,
        goalText: '健康',
        fitnessGoals: ['maintain'],
        targetWeight: 60,
        occupation: 'engineer',
        workStyle: 'desk',
        weeklyExerciseMinutes: 60,
        healthConditions: ['none'],
        sleepQuality: 'good',
        stressLevel: 'low',
        dietFlags: { vegetarian: false },
        dietStyle: 'normal',
        dislikedCookingMethods: ['fry'],
        cookingExperience: 'beginner',
        weekdayCookingMinutes: 30,
        cuisinePreferences: { japanese: 5 },
        favoriteIngredients: ['卵'],
      }),
    ).toBe(100);
  });

  it("性別の 'unspecified'・空の文字・空の配列・空のオブジェクトは入っていないと数える", () => {
    expect(calculateProfileCompleteness({ gender: 'unspecified', nickname: '', fitnessGoals: [], dietFlags: {} })).toBe(0);
    expect(calculateProfileCompleteness({ height: HEIGHT_CM })).toBe(HEIGHT_WEIGHT_PERCENT);
  });
});

describe('AI 相談で身長・体重を入れると、プロフィールの完成度を計算し直す (#2201 U4)', () => {
  it('update_profile_preferences で身長を入れると、書いた後の行から計算した完成度 (上がった値) を書く', async () => {
    const rowAfter: Partial<DbUserProfile> = { ...ROW_BEFORE, height: HEIGHT_CM };
    const { out, queries } = await run('update_profile_preferences', { updates: { height: HEIGHT_CM } }, respondWith(rowAfter));

    expect(out.success).toBe(true);
    const expected = profileCompletenessOfRow(rowAfter);
    expect(expected).toBe(profileCompletenessOfRow(ROW_BEFORE) + HEIGHT_WEIGHT_PERCENT);
    expect(profileUpdates(queries)).toEqual([{ height: HEIGHT_CM }, { profile_completeness: expected }]);
    // 本人の行に書く
    const completenessWrite = queries.filter((query) => query.table === 'user_profiles' && firstMethodOf(query) === 'update')[1];
    expect(completenessWrite.calls).toEqual(expect.arrayContaining([{ method: 'eq', args: ['id', USER.id] }]));
  });

  it('完成度が変わらなければ書かない', async () => {
    const rowAfter: Partial<DbUserProfile> = { ...ROW_BEFORE, height: HEIGHT_CM };
    const unchanged: Partial<DbUserProfile> = { ...rowAfter, profile_completeness: profileCompletenessOfRow(rowAfter) };
    const { out, queries } = await run('update_profile_preferences', { updates: { height: HEIGHT_CM } }, respondWith(unchanged));

    expect(out.success).toBe(true);
    expect(profileUpdates(queries)).toEqual([{ height: HEIGHT_CM }]);
  });

  it('欄の書き込みに失敗したら、計算し直さない', async () => {
    const rowAfter: Partial<DbUserProfile> = { ...ROW_BEFORE, height: HEIGHT_CM };
    const { out, queries } = await run(
      'update_profile_preferences',
      { updates: { height: HEIGHT_CM } },
      respondWith(rowAfter, (query) => (firstMethodOf(query) === 'update' ? { error: DB_FAILURE } : null)),
    );

    expect(out.success).toBe(false);
    expect(queries.some((query) => query.table === 'user_profiles' && firstMethodOf(query) === 'select')).toBe(false);
  });

  it('計算し直しの読み取りに失敗しても、欄の書き込みは成功として返す (失敗はログに残す)', async () => {
    const { out, queries } = await run(
      'update_profile_preferences',
      { updates: { height: HEIGHT_CM } },
      respondWith(null, (query) => (firstMethodOf(query) === 'select' ? { error: DB_FAILURE } : null)),
    );

    expect(out.success).toBe(true);
    expect(profileUpdates(queries)).toEqual([{ height: HEIGHT_CM }]);
    expect(logger.error).toHaveBeenCalledWith(
      'AI 相談のアクションの DB 操作に失敗しました',
      expect.any(Error),
      expect.objectContaining({ operation: 'user_profiles.profile_completeness' }),
    );
  });

  it('add_health_record で今日の体重を記録すると、user_profiles.weight と一緒に完成度を計算し直す', async () => {
    const rowAfter: Partial<DbUserProfile> = { ...ROW_BEFORE, weight: WEIGHT_KG };
    const { out, queries } = await run('add_health_record', { date: todayLocal(), weight: WEIGHT_KG }, respondWith(rowAfter));

    expect(out.success).toBe(true);
    expect(profileUpdates(queries)).toEqual([{ weight: WEIGHT_KG }, { profile_completeness: profileCompletenessOfRow(rowAfter) }]);
  });
});
