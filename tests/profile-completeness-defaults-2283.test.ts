// @vitest-environment node
/**
 * #2283 判断待ち 7 (選択 B) プロフィールの完成度は、利用者が入れた値だけを数える (既定値で埋まった欄は数えない)
 *
 * 問題 (直す前):
 *   完成度 (src/lib/profile-completeness.ts) は、行を toUserProfile (lib/converter.ts) で画面の形にしてから数えていた。
 *   toUserProfile は未入力の欄を既定値で埋める (食事のスタイル 'normal'・料理の経験 'beginner'・平日の調理の時間 30・
 *   週の運動の時間 0)。さらに行を作ると DB が列の既定値 (同じ 4 つと、好きな料理のジャンル {"chinese": 3, "western": 3,
 *   "japanese": 4}) を入れ、名前の無い行にはアプリが仮置きの名前 'Guest' を入れる。どれも「入力済み」と数えていたため、
 *   何も入れていない利用者でも完成度が 29 になった。
 *
 * 直したあと (このテストが固定する):
 *   - 行の列をそのまま読む (toUserProfile の既定値を通さない)。列が無い・null は入っていない
 *   - 列の既定値 (DB の DEFAULT) と同じ値は入っていないと数える。好きな料理のジャンルは、キーの順に関わらず中身が既定値と同じなら入っていない
 *   - 名前は仮置き ('Guest')・空白だけを入っていないと数える (normalizeProfileName と同じ規則)
 *   - 既定値でない値 (利用者が入れた値) は数える
 *   - 画面の形 (calculateProfileCompleteness) と行の形 (profileCompletenessOfRow) は同じ値を返す
 *   - 古い数え方で保存された完成度は、次の書き込みで、読んだときの完成度を条件に (#2206 G4・#2227 H4) 書き直す
 */
import { describe, expect, it } from 'vitest';

import { calculateProfileCompleteness, profileCompletenessOfRow, syncProfileCompletenessOfRow } from '@/lib/profile-completeness';
import { toUserProfile } from '@/lib/converter';
import type { DbUserProfile } from '@/types/database';
import { createRecordingSupabase, firstMethodOf, type QueryOutcome, type RecordedQuery } from './helpers/recording-supabase';

const USER_ID = 'user-1';

/** 名前・年齢・性別・身長・体重の重み (src/lib/profile-completeness.ts の PROFILE_COMPLETENESS_FIELDS) */
const BASIC_FIELD_WEIGHT = 4;
/** そのほかの欄の重み */
const OTHER_FIELD_WEIGHT = 5;
/** 重みの合計 (完成度の満点) */
const FULL_PERCENT = 100;

/** 古い数え方で、既定値だけの行に保存されていた完成度 (週の運動・食事のスタイル・料理の経験・平日の調理の時間・料理のジャンルの 5 欄 + 名前の仮置き) */
const OLD_DEFAULTS_ONLY_COMPLETENESS = OTHER_FIELD_WEIGHT * 5 + BASIC_FIELD_WEIGHT;

/** 利用者が入れた (既定値でない) 値 */
const USER_WEEKLY_EXERCISE_MINUTES = 90;
const USER_WEEKDAY_COOKING_MINUTES = 45;
const USER_CUISINE_PREFERENCES = { japanese: 5 };

/**
 * 行を作ったときに DB とアプリが入れる値だけの行 (利用者は何も入れていない)。
 * 列の既定値は supabase/migrations/20251126124224_create_meal_planner_tables.sql の user_profiles。
 * 名前・性別・年代の仮置きは POST /api/profile の USER_PROFILE_INSERT_PLACEHOLDERS とモバイルのオンボーディングと同じ
 */
const DEFAULTS_ONLY_ROW: Partial<DbUserProfile> = {
  id: USER_ID,
  nickname: 'Guest',
  age_group: 'unspecified',
  gender: 'unspecified',
  goal_text: null,
  diet_flags: null,
  fitness_goals: [],
  weekly_exercise_minutes: 0,
  health_conditions: [],
  diet_style: 'normal',
  disliked_cooking_methods: [],
  cooking_experience: 'beginner',
  weekday_cooking_minutes: 30,
  cuisine_preferences: { chinese: 3, western: 3, japanese: 4 },
  favorite_ingredients: [],
  profile_completeness: OLD_DEFAULTS_ONLY_COMPLETENESS,
};

describe('既定値で埋まった欄は数えない (#2283 選択 B)', () => {
  it('行を作ったときの既定値と仮置きだけの行は 0', () => {
    expect(profileCompletenessOfRow(DEFAULTS_ONLY_ROW)).toBe(0);
  });

  it('列が無い・null の行も 0 (toUserProfile の既定値で埋めて数えない)', () => {
    expect(profileCompletenessOfRow({ id: USER_ID })).toBe(0);
    expect(
      profileCompletenessOfRow({
        id: USER_ID,
        weekly_exercise_minutes: null,
        diet_style: null,
        cooking_experience: null,
        weekday_cooking_minutes: null,
        cuisine_preferences: null,
      }),
    ).toBe(0);
  });

  it('利用者が既定値でない値を入れた欄は、1 欄ずつその重みだけ数える', () => {
    const cases: Array<Partial<DbUserProfile>> = [
      { weekly_exercise_minutes: USER_WEEKLY_EXERCISE_MINUTES },
      { diet_style: 'vegetarian' },
      { cooking_experience: 'intermediate' },
      { weekday_cooking_minutes: USER_WEEKDAY_COOKING_MINUTES },
      { cuisine_preferences: USER_CUISINE_PREFERENCES },
    ];
    for (const entered of cases) {
      expect(profileCompletenessOfRow({ ...DEFAULTS_ONLY_ROW, ...entered })).toBe(OTHER_FIELD_WEIGHT);
    }
    expect(profileCompletenessOfRow({ ...DEFAULTS_ONLY_ROW, nickname: 'ほり' })).toBe(BASIC_FIELD_WEIGHT);
  });

  it('好きな料理のジャンルは、キーの順が違っても中身が既定値と同じなら数えない。1 つでも値が違えば数える', () => {
    expect(
      profileCompletenessOfRow({ ...DEFAULTS_ONLY_ROW, cuisine_preferences: { japanese: 4, chinese: 3, western: 3 } }),
    ).toBe(0);
    expect(
      profileCompletenessOfRow({ ...DEFAULTS_ONLY_ROW, cuisine_preferences: { chinese: 3, western: 3, japanese: 5 } }),
    ).toBe(OTHER_FIELD_WEIGHT);
    expect(
      profileCompletenessOfRow({ ...DEFAULTS_ONLY_ROW, cuisine_preferences: { chinese: 3, western: 3, japanese: 4, italian: 5 } }),
    ).toBe(OTHER_FIELD_WEIGHT);
  });

  it("名前の仮置き ('Guest'。前後の空白を除いて厳密一致) と空白だけの名前は数えない。'guest' は本人の名前として数える", () => {
    expect(profileCompletenessOfRow({ ...DEFAULTS_ONLY_ROW, nickname: ' Guest ' })).toBe(0);
    expect(profileCompletenessOfRow({ ...DEFAULTS_ONLY_ROW, nickname: '   ' })).toBe(0);
    expect(profileCompletenessOfRow({ ...DEFAULTS_ONLY_ROW, nickname: 'guest' })).toBe(BASIC_FIELD_WEIGHT);
  });

  it('全部の欄に既定値でない値が入っていれば 100', () => {
    const filled: Partial<DbUserProfile> = {
      id: USER_ID,
      nickname: 'ほり',
      age: 30,
      gender: 'female',
      height: 160,
      weight: 52,
      goal_text: '健康',
      fitness_goals: ['maintain'],
      target_weight: 50,
      occupation: 'engineer',
      work_style: 'sedentary',
      weekly_exercise_minutes: USER_WEEKLY_EXERCISE_MINUTES,
      health_conditions: ['高血圧'],
      sleep_quality: 'good',
      stress_level: 'low',
      diet_flags: { allergies: ['えび'] },
      diet_style: 'pescatarian',
      disliked_cooking_methods: ['fry'],
      cooking_experience: 'advanced',
      weekday_cooking_minutes: USER_WEEKDAY_COOKING_MINUTES,
      cuisine_preferences: USER_CUISINE_PREFERENCES,
      favorite_ingredients: ['卵'],
    };
    expect(profileCompletenessOfRow(filled)).toBe(FULL_PERCENT);
  });
});

describe('画面の形 (calculateProfileCompleteness) と行の形 (profileCompletenessOfRow) は同じ値 (Web の PUT の本文とモバイルの途中保存のあとの計算し直しが食い違わない)', () => {
  it('既定値だけの行・列が無い行・利用者が入れた行で同じ', () => {
    const rows: Array<Partial<DbUserProfile>> = [
      DEFAULTS_ONLY_ROW,
      { id: USER_ID },
      { ...DEFAULTS_ONLY_ROW, nickname: 'ほり', diet_style: 'vegan', weekday_cooking_minutes: USER_WEEKDAY_COOKING_MINUTES },
    ];
    for (const row of rows) {
      expect(calculateProfileCompleteness({ ...toUserProfile(row as DbUserProfile) })).toBe(profileCompletenessOfRow(row));
    }
  });
});

/** eq / is の条件 (列 → 値) */
function filtersOf(query: RecordedQuery): Array<{ column: string; value: unknown }> {
  return query.calls
    .filter((call) => call.method === 'eq' || call.method === 'is')
    .map((call) => ({ column: String(call.args[0]), value: call.args[1] }));
}

describe('古い数え方で保存された完成度は、次の書き込みで書き直す (読んだときの完成度を条件に。#2206 G4・#2227 H4)', () => {
  it('既定値だけの行に古い完成度が残っていれば、その値を条件に 0 を書く', async () => {
    const row: Record<string, unknown> = { ...DEFAULTS_ONLY_ROW };
    const db = createRecordingSupabase((query: RecordedQuery): QueryOutcome => {
      if (firstMethodOf(query) === 'update') {
        const matches = filtersOf(query).every(({ column, value }) => (row[column] ?? null) === value);
        if (!matches) return { data: null };
        Object.assign(row, query.calls[0].args[0] as Record<string, unknown>);
        return { data: { ...row } };
      }
      return { data: { ...row } };
    });

    const { row: synced, outcome } = await syncProfileCompletenessOfRow(db.client as never, USER_ID, DEFAULTS_ONLY_ROW);

    expect(outcome).toEqual({ status: 'updated', completeness: 0 });
    expect(synced.profile_completeness).toBe(0);
    expect(row.profile_completeness).toBe(0);
    const writes = db.queries.filter((query) => firstMethodOf(query) === 'update');
    expect(writes).toHaveLength(1);
    expect(writes[0].calls).toEqual(
      expect.arrayContaining([
        { method: 'update', args: [{ profile_completeness: 0 }] },
        { method: 'eq', args: ['id', USER_ID] },
        { method: 'eq', args: ['profile_completeness', OLD_DEFAULTS_ONLY_COMPLETENESS] },
      ]),
    );
  });
});
