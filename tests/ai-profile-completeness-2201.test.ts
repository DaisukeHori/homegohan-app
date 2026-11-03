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
 *   - PUT・POST /api/profile も本文ではなく書いた後の行から数える (目標の体重だけを送る栄養の目標の画面の PUT で、
 *     ほかの欄が埋まっていても完成度が 5 になっていた)。オンボーディングの progress / complete・チェックインの体重の写しも同じ
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
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ ...logger, withUser: () => logger }), generateRequestId: () => 'request-1' }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));
// オンボーディングの完了のあとの案内の状態 (user_profiles の handson_tour_skipped_at を書くことがある) は、この検査では見ない
vi.mock('@/lib/handson-tour/getStatus', () => ({ getHandsonTourStatusInternal: vi.fn(async () => ({ should_show: false })) }));
/** route の利用者のクライアント (テストごとに置く。createRecordingSupabase の client に auth を足したもの) */
const routeDb = vi.hoisted(() => ({ client: null as null | Record<string, unknown> }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ ...routeDb.client, auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) } }),
  getSupabaseAdmin: () => {
    throw new Error('service role のクライアントは、この検査では使わない');
  },
}));

import { runConsultationAction } from '@/lib/ai/consultation-action-executor';
import { calculateProfileCompleteness, profileCompletenessOfRow, syncProfileCompletenessOfRow } from '@/lib/profile-completeness';
import { toUserProfile } from '@/lib/converter';
import { todayLocal } from '@/lib/date-utils';
import type { DbUserProfile } from '@/types/database';
import { createRecordingSupabase, firstMethodOf, type QueryOutcome, type RecordedQuery } from './helpers/recording-supabase';
import { POST as postHealthRecord } from '@/app/api/health/records/route';
import { POST as postHealthGoal } from '@/app/api/health/goals/route';
import { POST as postQuickHealthRecord } from '@/app/api/health/records/quick/route';
import { POST as postProfile, PUT as putProfile } from '@/app/api/profile/route';
import { POST as postOnboardingProgress } from '@/app/api/onboarding/progress/route';
import { POST as postOnboardingComplete } from '@/app/api/onboarding/complete/route';
import { POST as postPerformanceCheckin } from '@/app/api/performance/checkins/route';

const USER = { id: 'user-1' };
/** 身長の重み (src/lib/profile-completeness.ts の PROFILE_COMPLETENESS_FIELDS の height。重みの合計は 100) */
const HEIGHT_WEIGHT_PERCENT = 4;
const HEIGHT_CM = 170;
const WEIGHT_KG = 62.5;
/** 体脂肪率 (%)。プロフィールの完成度に数えない欄 (PROFILE_COMPLETENESS_FIELDS に無い) */
const BODY_FAT_PERCENT = 22;
/** 目標の体重 (kg) */
const TARGET_WEIGHT_KG = 58;
/** 計算し直す前の行に入っていた完成度 (古い値) */
const STALE_COMPLETENESS = 10;
/** 目標の体重の重み (PROFILE_COMPLETENESS_FIELDS の targetWeight) */
const TARGET_WEIGHT_WEIGHT_PERCENT = 5;
/** 年齢 */
const AGE_YEARS = 35;
/** オンボーディングの進み (本文の currentStep・totalQuestions。値そのものに意味は無い) */
const ONBOARDING_CURRENT_STEP = 3;
const ONBOARDING_TOTAL_QUESTIONS = 30;
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

describe('利用者が体重・目標の体重を記録したときも、プロフィールの完成度を計算し直す (#2201 U4 の同じ型)', () => {
  /** route の問い合わせの答え: user_profiles の読み取りは書いた後の行、ほかの読み取り・書き込みは 1 行 */
  function useRouteDb(rowAfter: Partial<DbUserProfile>, options: { profileWriteFails?: boolean } = {}) {
    const db = createRecordingSupabase((query: RecordedQuery) => {
      if (query.table === 'user_profiles') {
        if (firstMethodOf(query) === 'select') return { data: rowAfter };
        return options.profileWriteFails ? { error: DB_FAILURE } : { data: null };
      }
      return { data: { id: 'row-1' } };
    });
    routeDb.client = db.client;
    return db.queries;
  }

  /**
   * プロフィールへの写し (user_profiles の最初の update) のあとに user_profiles の読み取りがあったか
   * (完成度の計算し直しは、書いた後の行を select('*') で読むところから始まる。goals は写しの前にも開始の値を読むので、写しの後だけを見る)
   */
  const readsProfileAfterWrite = (queries: RecordedQuery[]) => {
    const firstWrite = queries.findIndex((query) => query.table === 'user_profiles' && firstMethodOf(query) === 'update');
    expect(firstWrite).toBeGreaterThanOrEqual(0);
    return queries.slice(firstWrite + 1).some((query) => query.table === 'user_profiles' && firstMethodOf(query) === 'select');
  };

  const jsonRequest = (url: string, body: Record<string, unknown>) =>
    new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('POST /api/health/records: 今日の体重をプロフィールに写したあと、完成度を書く', async () => {
    const rowAfter: Partial<DbUserProfile> = { ...ROW_BEFORE, weight: WEIGHT_KG };
    const queries = useRouteDb(rowAfter);

    const res = await postHealthRecord(jsonRequest('http://localhost/api/health/records', { record_date: todayLocal(), weight: WEIGHT_KG }) as never);

    expect(res.status).toBe(200);
    expect(profileUpdates(queries)).toEqual([{ weight: WEIGHT_KG }, { profile_completeness: profileCompletenessOfRow(rowAfter) }]);
  });

  it('POST /api/health/goals: 目標の体重をプロフィールに写したあと、完成度を書く', async () => {
    const rowAfter: Partial<DbUserProfile> = { ...ROW_BEFORE, weight: WEIGHT_KG, target_weight: TARGET_WEIGHT_KG };
    const queries = useRouteDb(rowAfter);

    const res = await postHealthGoal(
      jsonRequest('http://localhost/api/health/goals', { goal_type: 'weight', target_value: TARGET_WEIGHT_KG, target_unit: 'kg', target_date: null }) as never,
    );

    expect(res.status).toBe(200);
    expect(profileUpdates(queries)).toEqual([
      { target_weight: TARGET_WEIGHT_KG, target_date: null },
      { profile_completeness: profileCompletenessOfRow(rowAfter) },
    ]);
  });
  it('POST /api/health/records/quick: 今日の体重をプロフィールに写したあと、完成度を書く', async () => {
    const rowAfter: Partial<DbUserProfile> = { ...ROW_BEFORE, weight: WEIGHT_KG };
    const queries = useRouteDb(rowAfter);

    const res = await postQuickHealthRecord(
      jsonRequest('http://localhost/api/health/records/quick', { record_date: todayLocal(), weight: WEIGHT_KG }) as never,
    );

    expect(res.status).toBe(200);
    expect(profileUpdates(queries)).toEqual([{ weight: WEIGHT_KG }, { profile_completeness: profileCompletenessOfRow(rowAfter) }]);
  });

  it('POST /api/health/records/quick: 体重を含まない記録 (体脂肪率だけ) では、完成度を計算し直さない (体脂肪率は完成度に数えない欄)', async () => {
    const rowAfter: Partial<DbUserProfile> = { ...ROW_BEFORE, body_fat_percentage: BODY_FAT_PERCENT };
    const queries = useRouteDb(rowAfter);

    const res = await postQuickHealthRecord(
      jsonRequest('http://localhost/api/health/records/quick', { record_date: todayLocal(), body_fat_percentage: BODY_FAT_PERCENT }) as never,
    );

    expect(res.status).toBe(200);
    expect(profileUpdates(queries)).toEqual([{ body_fat_percentage: BODY_FAT_PERCENT }]);
    expect(readsProfileAfterWrite(queries)).toBe(false);
  });

  // プロフィールへの写しに失敗したら計算し直さない (記録・目標そのものは成功のまま返す)。3 つの route に同じ guard がある
  it.each([
    {
      route: 'POST /api/health/records',
      call: () => postHealthRecord(jsonRequest('http://localhost/api/health/records', { record_date: todayLocal(), weight: WEIGHT_KG }) as never),
      firstWrite: { weight: WEIGHT_KG },
    },
    {
      route: 'POST /api/health/records/quick',
      call: () =>
        postQuickHealthRecord(jsonRequest('http://localhost/api/health/records/quick', { record_date: todayLocal(), weight: WEIGHT_KG }) as never),
      firstWrite: { weight: WEIGHT_KG },
    },
    {
      route: 'POST /api/health/goals',
      call: () =>
        postHealthGoal(
          jsonRequest('http://localhost/api/health/goals', { goal_type: 'weight', target_value: TARGET_WEIGHT_KG, target_unit: 'kg', target_date: null }) as never,
        ),
      firstWrite: { target_weight: TARGET_WEIGHT_KG, target_date: null },
    },
  ])('$route: プロフィールへの写しに失敗したら、完成度を計算し直さない (応答は成功のまま)', async ({ call, firstWrite }) => {
    const rowAfter: Partial<DbUserProfile> = { ...ROW_BEFORE, weight: WEIGHT_KG, target_weight: TARGET_WEIGHT_KG };
    const queries = useRouteDb(rowAfter, { profileWriteFails: true });

    const res = await call();

    expect(res.status).toBe(200);
    expect(profileUpdates(queries)).toEqual([firstWrite]);
    expect(readsProfileAfterWrite(queries)).toBe(false);
  });
});

describe('PUT /api/profile も、本文ではなく書いた後の行から完成度を数える (#2201 U4 の分割パネルの指摘)', () => {
  /** 栄養の目標の画面を開く前の行: 名前・性別・年齢・身長・体重・目標の文・仕事が入っていて、目標の体重は無い。完成度はこの行から数えた値 */
  const rowWithoutTarget: Partial<DbUserProfile> = {
    ...ROW_BEFORE,
    age: AGE_YEARS,
    age_group: '30s',
    height: HEIGHT_CM,
    weight: WEIGHT_KG,
    goal_text: '健康',
    occupation: 'engineer',
    target_weight: null,
  };
  const ROW_FILLED: Partial<DbUserProfile> = { ...rowWithoutTarget, profile_completeness: profileCompletenessOfRow(rowWithoutTarget) };

  /**
   * user_profiles の 1 行をまねる: update・upsert・insert は渡した値を行に重ね、どの問い合わせも今の行を返す
   * (update(...).select().single() は書いた後の行を返す)。ほかの表は 1 行を返す
   */
  function useProfileTable(initialRow: Partial<DbUserProfile>) {
    let row: Record<string, unknown> = { ...initialRow };
    const db = createRecordingSupabase((query: RecordedQuery) => {
      if (query.table !== 'user_profiles') return { data: { id: 'row-1' } };
      const first = firstMethodOf(query);
      if (first === 'update' || first === 'upsert' || first === 'insert') {
        row = { ...row, ...(query.calls[0].args[0] as Record<string, unknown>) };
      }
      return { data: row };
    });
    routeDb.client = db.client;
    return { queries: db.queries, currentRow: () => row };
  }

  const requestWith = (method: 'POST' | 'PUT', url: string, body: Record<string, unknown>) =>
    new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('栄養の目標の画面のように目標の体重だけを PUT しても、完成度は 5 にならず、書いた後の行から数えた値になる', async () => {
    const { queries, currentRow } = useProfileTable(ROW_FILLED);

    const res = await putProfile(requestWith('PUT', 'http://localhost/api/profile', { targetWeight: TARGET_WEIGHT_KG }));

    expect(res.status).toBe(200);
    const expected = profileCompletenessOfRow({ ...ROW_FILLED, target_weight: TARGET_WEIGHT_KG });
    expect(expected).toBe(profileCompletenessOfRow(ROW_FILLED) + TARGET_WEIGHT_WEIGHT_PERCENT);
    // 本文だけから数えた値 (直す前に書いていた値) とは違う
    expect(expected).not.toBe(calculateProfileCompleteness({ targetWeight: TARGET_WEIGHT_KG }));
    const [fieldWrite, ...completenessWrites] = profileUpdates(queries);
    expect(fieldWrite).toMatchObject({ target_weight: TARGET_WEIGHT_KG });
    expect(fieldWrite).not.toHaveProperty('profile_completeness');
    expect(completenessWrites).toEqual([{ profile_completeness: expected }]);
    expect(currentRow().profile_completeness).toBe(expected);
    // 応答の行も書いた完成度になる (プロフィールの画面は応答の行を表示する)
    expect((await res.json()).profile_completeness).toBe(expected);
  });

  it('プロフィールの画面のように編集の値の全部を PUT すると、完成度は以前の本文からの計算と同じ値になる', async () => {
    useProfileTable(ROW_FILLED);
    const editForm: Record<string, unknown> = {
      ...toUserProfile(ROW_FILLED as DbUserProfile),
      targetWeight: TARGET_WEIGHT_KG,
      sleepQuality: 'good',
    };

    const res = await putProfile(requestWith('PUT', 'http://localhost/api/profile', editForm));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile_completeness).toBe(calculateProfileCompleteness(editForm));
    expect(body.profile_completeness).toBeGreaterThan(ROW_FILLED.profile_completeness ?? 0);
  });

  it('本文の profileCompleteness (画面が送り返した古い値) は書かず、書いた後の行から数えた値を書く', async () => {
    const { queries } = useProfileTable(ROW_FILLED);

    const res = await putProfile(
      requestWith('PUT', 'http://localhost/api/profile', { profileCompleteness: STALE_COMPLETENESS, targetWeight: TARGET_WEIGHT_KG }),
    );

    expect(res.status).toBe(200);
    const writes = profileUpdates(queries);
    expect(writes[0]).not.toHaveProperty('profile_completeness');
    expect(writes.slice(1)).toEqual([{ profile_completeness: profileCompletenessOfRow({ ...ROW_FILLED, target_weight: TARGET_WEIGHT_KG }) }]);
  });

  it('完成度が変わらない PUT (完成度に数えない欄だけ) では、完成度を書き直さない', async () => {
    const { queries } = useProfileTable(ROW_FILLED);

    const res = await putProfile(requestWith('PUT', 'http://localhost/api/profile', { hobbies: ['料理'] }));

    expect(res.status).toBe(200);
    expect(profileUpdates(queries)).toHaveLength(1);
    expect((await res.json()).profile_completeness).toBe(ROW_FILLED.profile_completeness);
  });

  it('完成度の書き直しに失敗しても、PUT は成功のまま書いた行を返す (失敗はログに残す)', async () => {
    let profileWrites = 0;
    const row: Record<string, unknown> = { ...ROW_FILLED };
    const db = createRecordingSupabase((query: RecordedQuery) => {
      if (query.table !== 'user_profiles') return { data: { id: 'row-1' } };
      if (firstMethodOf(query) === 'update') {
        profileWrites += 1;
        // 2 回目の update (完成度の書き直し) だけ失敗させる
        if (profileWrites > 1) return { error: DB_FAILURE };
        Object.assign(row, query.calls[0].args[0] as Record<string, unknown>);
      }
      return { data: row };
    });
    routeDb.client = db.client;

    const res = await putProfile(requestWith('PUT', 'http://localhost/api/profile', { targetWeight: TARGET_WEIGHT_KG }));

    expect(res.status).toBe(200);
    expect(profileWrites).toBe(2);
    const body = await res.json();
    expect(body.target_weight).toBe(TARGET_WEIGHT_KG);
    expect(body.profile_completeness).toBe(ROW_FILLED.profile_completeness);
    expect(logger.error).toHaveBeenCalledWith('Profile completeness sync error', DB_FAILURE);
  });

  it('POST /api/profile (完成度に数える欄を書く) も、書いた後の行から完成度を書く', async () => {
    const { queries } = useProfileTable(ROW_BEFORE);

    const res = await postProfile(requestWith('POST', 'http://localhost/api/profile', { height: HEIGHT_CM }));

    expect(res.status).toBe(200);
    const expected = profileCompletenessOfRow({ ...ROW_BEFORE, height: HEIGHT_CM });
    const writes = profileUpdates(queries);
    expect(writes[0]).toMatchObject({ height: HEIGHT_CM });
    expect(writes.slice(1)).toEqual([{ profile_completeness: expected }]);
    expect((await res.json()).profile_completeness).toBe(expected);
  });

  it('POST /api/onboarding/progress: 答えを保存したあと、書いた後の行から完成度を書く', async () => {
    const { queries, currentRow } = useProfileTable(ROW_BEFORE);

    const res = await postOnboardingProgress(
      requestWith('POST', 'http://localhost/api/onboarding/progress', {
        currentStep: ONBOARDING_CURRENT_STEP,
        totalQuestions: ONBOARDING_TOTAL_QUESTIONS,
        answers: { height: HEIGHT_CM },
      }),
    );

    expect(res.status).toBe(200);
    // 答えは upsert で書く (update ではない)。そのあとの update は完成度の書き込みだけ
    expect(currentRow().height).toBe(HEIGHT_CM);
    expect(profileUpdates(queries)).toEqual([{ profile_completeness: profileCompletenessOfRow(currentRow()) }]);
    expect(currentRow().profile_completeness).not.toBe(STALE_COMPLETENESS);
  });

  it('POST /api/onboarding/complete: 自動で入れる欄 (目標の文・週の運動の分など) を書いたあと、完成度を書く', async () => {
    const { queries, currentRow } = useProfileTable({ ...ROW_BEFORE, nutrition_goal: 'lose_weight' });

    const res = await postOnboardingComplete();

    expect(res.status).toBe(200);
    const writes = profileUpdates(queries);
    expect(writes[0]).toMatchObject({ goal_text: expect.any(String), fitness_goals: expect.any(Array) });
    expect(writes.slice(1)).toEqual([{ profile_completeness: profileCompletenessOfRow(currentRow()) }]);
    expect(currentRow().profile_completeness).toBeGreaterThan(profileCompletenessOfRow(ROW_BEFORE));
  });

  it('POST /api/performance/checkins: 体重をプロフィールに写したあと、完成度を書く', async () => {
    const { queries } = useProfileTable(ROW_BEFORE);

    const res = await postPerformanceCheckin(
      requestWith('POST', 'http://localhost/api/performance/checkins', { checkinDate: todayLocal(), weight: WEIGHT_KG }) as never,
    );

    expect(res.status).toBe(200);
    const writes = profileUpdates(queries);
    expect(writes[0]).toMatchObject({ weight: WEIGHT_KG });
    expect(writes.slice(1)).toEqual([{ profile_completeness: profileCompletenessOfRow({ ...ROW_BEFORE, weight: WEIGHT_KG }) }]);
  });

  it('syncProfileCompletenessOfRow: 行の完成度が計算と同じなら書かず、違えば書いて新しい値の行を返す', async () => {
    const same = createRecordingSupabase(() => ({ data: null }));
    const unchanged = await syncProfileCompletenessOfRow(same.client, USER.id, ROW_FILLED);
    expect(unchanged).toEqual({ row: ROW_FILLED, outcome: { status: 'unchanged', completeness: ROW_FILLED.profile_completeness } });
    expect(same.queries).toHaveLength(0);

    const stale = createRecordingSupabase(() => ({ data: null }));
    const staleRow: Partial<DbUserProfile> = { ...ROW_FILLED, profile_completeness: STALE_COMPLETENESS };
    const updated = await syncProfileCompletenessOfRow(stale.client, USER.id, staleRow);
    expect(updated).toEqual({
      row: { ...staleRow, profile_completeness: ROW_FILLED.profile_completeness },
      outcome: { status: 'updated', completeness: ROW_FILLED.profile_completeness },
    });
    expect(profileUpdates(stale.queries)).toEqual([{ profile_completeness: ROW_FILLED.profile_completeness }]);
    expect(stale.queries[0].calls).toEqual(expect.arrayContaining([{ method: 'eq', args: ['id', USER.id] }]));
  });
});
