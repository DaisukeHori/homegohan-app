// @vitest-environment node
/**
 * #2283 判断待ち 7 (選択 B) オンボーディングの完了 (POST /api/onboarding/complete) が、答えていない質問から作った欄を書いて
 * 完成度に数えない
 *
 * 問題 (直す前):
 *   完了は、元の列から 3 つの欄 (体づくりの目標 fitness_goals・目標の文 goal_text・週の運動の時間 weekly_exercise_minutes) を
 *   答えの有無に関わらず作って書いていた。元の列には DB の既定値があり (栄養の目標 'maintain'・運動の日数 3・1 回の時間 60)、
 *   答えずに完了した (web の welcome の「あとで設定する」・質問の途中のスキップ・resume のスキップ・モバイルの welcome) ときも
 *   ['improve_energy']・「現在の体型を維持する」・180 を書き、完成度が 15 (5 × 3 欄) になった (帯に「プロフィール完成度: 15%」)。
 *   「運動していない」と答えたときも、日数は聞かれず既定値 3 のままなので週の運動が 180 になって数えられた。
 *
 * 直したあと (このテストが固定する):
 *   - 答え (onboarding_progress.answers) に元の質問の答えが無ければ、3 つの欄に触れない (前から入っていた値も消さない)
 *   - 運動していないと答えたら週の運動は 0 (列の既定値と同じなので数えない)
 *   - 栄養の目標・運動の日数に答えたら、以前と同じ計算で書き、完成度に数える
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// オンボーディングの完了のあとの案内の状態は、この検査では見ない
vi.mock('@/lib/handson-tour/getStatus', () => ({ getHandsonTourStatusInternal: vi.fn(async () => ({ should_show: false })) }));
/** route の利用者のクライアント (テストごとに置く。createRecordingSupabase の client に auth を足したもの) */
const routeDb = vi.hoisted(() => ({ client: null as null | Record<string, unknown> }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ ...routeDb.client, auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) } }),
}));

import { POST as postOnboardingComplete } from '@/app/api/onboarding/complete/route';
import { answeredOnboardingNutritionGoal, onboardingWeeklyExerciseDecision } from '@/lib/onboarding-derived-columns';
import { profileCompletenessOfRow } from '@/lib/profile-completeness';
import { createRecordingSupabase, firstMethodOf, type RecordedQuery } from './helpers/recording-supabase';

const USER_ID = 'user-1';

/** 名前・年齢・性別・身長・体重の重み (src/lib/profile-completeness.ts の PROFILE_COMPLETENESS_FIELDS) */
const BASIC_FIELD_WEIGHT = 4;
/** そのほかの欄の重み */
const OTHER_FIELD_WEIGHT = 5;

/** 運動の日数の列の DB の既定値 (supabase/migrations/20251126124224_create_meal_planner_tables.sql の user_profiles) */
const DB_DEFAULT_EXERCISE_FREQUENCY = 3;
/** 1 回の運動の時間の列の DB の既定値 */
const DB_DEFAULT_EXERCISE_DURATION = 60;
/** 直す前に、答えずに完了したときに書いていた週の運動の時間 (既定値の日数 × 既定値の 1 回の時間) */
const DEFAULTS_WEEKLY_EXERCISE_MINUTES = DB_DEFAULT_EXERCISE_FREQUENCY * DB_DEFAULT_EXERCISE_DURATION;
/** 利用者が答えた運動の日数 */
const ANSWERED_EXERCISE_FREQUENCY = 4;
/** 利用者が前から入れていた週の運動の時間 (プロフィールの画面で入れた値) */
const ENTERED_WEEKLY_EXERCISE_MINUTES = 90;

/**
 * 行を作ったときに DB が入れる値 (同じ migration の DEFAULT。完成度に数える列と、完了が欄を作るときに読む列)。
 * 名前・性別・年代の仮置きは完了の route が行を作るときに入れる
 */
const DB_COLUMN_DEFAULTS: Record<string, unknown> = {
  fitness_goals: [],
  weekly_exercise_minutes: 0,
  health_conditions: [],
  diet_style: 'normal',
  disliked_cooking_methods: [],
  cooking_experience: 'beginner',
  weekday_cooking_minutes: 30,
  cuisine_preferences: { chinese: 3, western: 3, japanese: 4 },
  favorite_ingredients: [],
  profile_completeness: 0,
  exercise_frequency: DB_DEFAULT_EXERCISE_FREQUENCY,
  exercise_duration_per_session: DB_DEFAULT_EXERCISE_DURATION,
  nutrition_goal: 'maintain',
  performance_profile: {},
};

/** eq / is の条件 (列 → 値) */
function filtersOf(query: RecordedQuery): Array<{ column: string; value: unknown }> {
  return query.calls
    .filter((call) => call.method === 'eq' || call.method === 'is')
    .map((call) => ({ column: String(call.args[0]), value: call.args[1] }));
}

/** user_profiles の update に渡した値 (書いた順) */
function profileUpdates(queries: RecordedQuery[]): Array<Record<string, unknown>> {
  return queries
    .filter((query) => query.table === 'user_profiles' && firstMethodOf(query) === 'update')
    .map((query) => query.calls[0].args[0] as Record<string, unknown>);
}

/**
 * user_profiles を 1 行の表として真似る。initialRow が null なら行が無い (upsert で DB の既定値を入れて作る)。
 * update は eq / is の条件に合うときだけ書く (完成度の条件つきの書き込み。#2206 G4・#2227 H4)。ほかのテーブルは無害な結果
 */
function useProfileTable(initialRow: Record<string, unknown> | null) {
  let row: Record<string, unknown> | null = initialRow ? { ...initialRow } : null;
  const db = createRecordingSupabase((query: RecordedQuery) => {
    if (query.table !== 'user_profiles') return { data: null };
    const first = firstMethodOf(query);
    if (first === 'upsert') {
      row = { ...DB_COLUMN_DEFAULTS, ...(row ?? {}), ...(query.calls[0].args[0] as Record<string, unknown>) };
      return { data: { ...row } };
    }
    if (first === 'update') {
      if (!row) return { data: null };
      const current = row;
      const matches = filtersOf(query).every(({ column, value }) => (current[column] ?? null) === value);
      if (!matches) return { data: null };
      row = { ...current, ...(query.calls[0].args[0] as Record<string, unknown>) };
      return { data: { ...row } };
    }
    return { data: row ? { ...row } : null };
  });
  routeDb.client = db.client;
  return { queries: db.queries, currentRow: () => row };
}

/** オンボーディングの進捗 (onboarding_progress) の形 */
function progressWith(answers: Record<string, unknown>): Record<string, unknown> {
  return { currentStep: 1, totalQuestions: 1, lastUpdatedAt: '2026-11-06T00:00:00.000Z', answers };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('答えずに完了しても、答えから作る欄を書かず、完成度に数えない (#2283 選択 B)', () => {
  it('行が無いまま「あとで設定する」で完了すると、完成度は 0 (直す前は 15)', async () => {
    const { queries, currentRow } = useProfileTable(null);

    const res = await postOnboardingComplete();

    expect(res.status).toBe(200);
    const [completionWrite] = profileUpdates(queries);
    expect(completionWrite).not.toHaveProperty('weekly_exercise_minutes');
    expect(completionWrite).not.toHaveProperty('fitness_goals');
    expect(completionWrite).not.toHaveProperty('goal_text');
    expect(currentRow()?.weekly_exercise_minutes).toBe(0);
    expect(currentRow()?.profile_completeness).toBe(0);
  });

  it('名前だけ答えて途中でスキップしても、数えるのは名前だけ', async () => {
    const { currentRow } = useProfileTable({
      ...DB_COLUMN_DEFAULTS,
      id: USER_ID,
      nickname: 'ほり',
      onboarding_progress: progressWith({ nickname: 'ほり' }),
    });

    const res = await postOnboardingComplete();

    expect(res.status).toBe(200);
    expect(currentRow()?.weekly_exercise_minutes).toBe(0);
    expect(currentRow()?.profile_completeness).toBe(BASIC_FIELD_WEIGHT);
  });

  it('前から入っていた週の運動の時間・目標の文は、答えずに完了しても消さない (直す前は 180 と「現在の体型を維持する」で上書き)', async () => {
    const { currentRow } = useProfileTable({
      ...DB_COLUMN_DEFAULTS,
      id: USER_ID,
      nickname: 'ほり',
      weekly_exercise_minutes: ENTERED_WEEKLY_EXERCISE_MINUTES,
      goal_text: '毎朝走る',
      fitness_goals: ['improve_sleep'],
    });

    const res = await postOnboardingComplete();

    expect(res.status).toBe(200);
    expect(currentRow()?.weekly_exercise_minutes).toBe(ENTERED_WEEKLY_EXERCISE_MINUTES);
    expect(currentRow()?.goal_text).toBe('毎朝走る');
    expect(currentRow()?.fitness_goals).toEqual(['improve_sleep']);
  });

  it('「運動していない」と答えたら週の運動は 0 で、数えない (直す前は既定値の日数から 180)', async () => {
    const { currentRow } = useProfileTable({
      ...DB_COLUMN_DEFAULTS,
      id: USER_ID,
      nickname: 'ほり',
      onboarding_progress: progressWith({ nickname: 'ほり', exercise_types: ['none'] }),
    });

    const res = await postOnboardingComplete();

    expect(res.status).toBe(200);
    expect(currentRow()?.weekly_exercise_minutes).toBe(0);
    expect(currentRow()?.weekly_exercise_minutes).not.toBe(DEFAULTS_WEEKLY_EXERCISE_MINUTES);
    expect(currentRow()?.profile_completeness).toBe(BASIC_FIELD_WEIGHT);
  });
});

describe('答えた質問から作る欄は、以前と同じ計算で書いて数える', () => {
  it('運動の日数と栄養の目標に答えたら、日数 × 1 回の時間と、目標の変換を書き、3 欄を数える', async () => {
    const { currentRow } = useProfileTable({
      ...DB_COLUMN_DEFAULTS,
      id: USER_ID,
      nickname: 'ほり',
      exercise_frequency: ANSWERED_EXERCISE_FREQUENCY,
      nutrition_goal: 'lose_weight',
      onboarding_progress: progressWith({
        nickname: 'ほり',
        nutrition_goal: 'lose_weight',
        exercise_types: ['running'],
        exercise_frequency: String(ANSWERED_EXERCISE_FREQUENCY),
      }),
    });

    const res = await postOnboardingComplete();

    expect(res.status).toBe(200);
    const row = currentRow();
    expect(row?.weekly_exercise_minutes).toBe(ANSWERED_EXERCISE_FREQUENCY * DB_DEFAULT_EXERCISE_DURATION);
    expect(row?.fitness_goals).toEqual(['lose_weight']);
    expect(row?.goal_text).toBe('健康的に減量する');
    expect(row?.profile_completeness).toBe(BASIC_FIELD_WEIGHT + OTHER_FIELD_WEIGHT * 3);
    expect(row?.profile_completeness).toBe(profileCompletenessOfRow(row ?? {}));
  });
});

describe('onboardingWeeklyExerciseDecision・answeredOnboardingNutritionGoal (答えの見分け)', () => {
  const columns = { exercise_frequency: ANSWERED_EXERCISE_FREQUENCY, exercise_duration_per_session: DB_DEFAULT_EXERCISE_DURATION };

  it('進捗が無い・答えが無い・形が違うときは書かない', () => {
    for (const onboarding_progress of [null, undefined, {}, { answers: null }, { answers: [] }, 'x', progressWith({})]) {
      expect(onboardingWeeklyExerciseDecision({ ...columns, onboarding_progress })).toEqual({ write: false });
      expect(answeredOnboardingNutritionGoal({ onboarding_progress })).toBe(false);
    }
  });

  it('運動の種類だけ答えて日数に答えていなければ書かない', () => {
    expect(
      onboardingWeeklyExerciseDecision({ ...columns, onboarding_progress: progressWith({ exercise_types: ['running'] }) }),
    ).toEqual({ write: false });
  });

  it('運動していないは、答えに日数が残っていても 0 を優先する', () => {
    expect(
      onboardingWeeklyExerciseDecision({
        ...columns,
        onboarding_progress: progressWith({ exercise_types: ['none'], exercise_frequency: String(ANSWERED_EXERCISE_FREQUENCY) }),
      }),
    ).toEqual({ write: true, minutes: 0 });
  });

  it('日数に答えたら、列の日数 × 列の 1 回の時間', () => {
    expect(
      onboardingWeeklyExerciseDecision({
        ...columns,
        onboarding_progress: progressWith({ exercise_frequency: String(ANSWERED_EXERCISE_FREQUENCY) }),
      }),
    ).toEqual({ write: true, minutes: ANSWERED_EXERCISE_FREQUENCY * DB_DEFAULT_EXERCISE_DURATION });
  });

  it('栄養の目標に答えていれば true', () => {
    expect(answeredOnboardingNutritionGoal({ onboarding_progress: progressWith({ nutrition_goal: 'maintain' }) })).toBe(true);
  });
});
