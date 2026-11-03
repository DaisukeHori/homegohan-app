// @vitest-environment node
/**
 * #2195 V2 AI 相談の提案の実行 (runConsultationAction) の「やり直しても直らない失敗」の印 (notRetryable) と、
 * update_meal の料理画像のジョブの積み込みの例外。
 *
 * 問題 (直す前):
 *   (1) 権限が無い・対象が無い・値が検査に落ちた・入力が空の失敗も、やり直せる種類なら行が pending に残り、
 *       「実行する」を押しても同じ失敗が返るだけで、× を押すまでカードが残った
 *   (2) update_meal が料理画像の 1 回 (meal_image_auto) を数えたあと、画像のジョブの積み込みで例外が出ると、
 *       数え戻さずに例外が外へ出て行が pending に戻り、やり直すともう 1 回数えた (献立の更新は済んでいた)
 *
 * 直したあと:
 *   - (1) の失敗の結果に notRetryable: true を付ける (aiActionLogStatusAfterRun が failed にする)。
 *     DB の読み書きの失敗 (一時的なことがある) と成功には付けない。.single() の「行が無い」は PGRST116 のときだけ印す
 *   - (2) 積み込みの例外は数え戻し、献立の更新は成功として返す
 *
 * #2201 U4 の続き:
 *   - (1) AI が作り出した形の崩れた id (UUID の形でない) で読み書きが 22P02 (invalid_text_representation) になる失敗も、
 *     何度実行しても同じなので notRetryable: true を付ける (以前は付かずに pending に残り、「実行する」が毎回同じ失敗になった)
 *   - (2) 積み込みの例外のときは、ジョブの無い料理を保存済みの献立の上で見送りの状態 ('failed' + 'enqueue_failed') に書き直す
 *     (以前は 'pending' のまま「料理画像を生成中」に残った)。処理の起動 (trigger) の例外は記録だけで、数え戻さない
 *     (以前は数え戻していた。積んだジョブは定期の処理が拾うので、安全弁を 1 回ぶん少なく数えた)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';
import { MEAL_IMAGE_ENQUEUE_THREW_LOG_MESSAGE } from '@/lib/meal-image-enqueue-after-save';
import { MEAL_IMAGE_ENQUEUE_FAILED_ERROR } from '@/lib/meal-image';

const m = vi.hoisted(() => ({
  consumeAiUsage: vi.fn(),
  refundAiUsage: vi.fn(async () => undefined),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(async () => undefined),
  setPlannedMealCompleted: vi.fn(),
  getOrCreateActiveShoppingList: vi.fn(async () => ({ id: 'list-1' })),
  logError: vi.fn(),
}));

vi.mock('@/lib/plan/entitlements', () => ({
  consumeAiUsage: m.consumeAiUsage,
  refundAiUsage: m.refundAiUsage,
  aiUsageRecordedHeaders: vi.fn(async () => ({})),
}));
vi.mock('@/lib/ai/consent-guard', () => ({ checkUserAiConsent: vi.fn(async () => ({ allowed: true })) }));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => ({}) }));
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({ invokeGenerateMenuV4WithRetry: vi.fn(), markWeeklyMenuRequestFailed: vi.fn() }));
vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(async ({ nextDishes }: { nextDishes?: unknown[] }) => ({
    dishes: nextDishes ?? [],
    jobs: [{ dishIndex: 0, subjectHash: 'h', prompt: 'p', model: 'm', referenceImageUrls: [] }],
    mealCoverImageUrl: null,
  })),
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: m.enqueueMealImageJobs,
  triggerMealImageJobProcessing: m.triggerMealImageJobProcessing,
}));
vi.mock('@/lib/v4-target-slots', () => ({ resolveExistingTargetSlots: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/db-logger', () => {
  const logger: Record<string, unknown> = { warn: vi.fn(), info: vi.fn(), error: m.logError };
  logger.withUser = () => logger;
  return { createLogger: () => logger };
});
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));
vi.mock('@/modules/planned-meals-integrity/server', () => ({ setPlannedMealCompleted: m.setPlannedMealCompleted }));
vi.mock('@/lib/shopping-list/active-list', () => ({ getOrCreateActiveShoppingList: m.getOrCreateActiveShoppingList }));

import { runConsultationAction } from '@/lib/ai/consultation-action-executor';
import { aiActionLogStatusAfterRun } from '@/lib/ai/consultation-action-lifecycle';
import { createRecordingSupabase, firstMethodOf, type QueryOutcome, type RecordedQuery } from './helpers/recording-supabase';

const USER = { id: 'user-1' };
const OTHER_USER = 'user-2';
/** .single() が 0 行のときの失敗 (PostgREST の PGRST116) */
const NO_ROWS = { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' };
/** DB の読み取りの失敗 (一時的なことがある) */
const DB_FAILURE = { message: 'db error', code: 'XX000' };
/** uuid の列を UUID の形でない値で引いた・書いたときの失敗 (PostgreSQL の invalid_text_representation。#2201 U4) */
const MALFORMED_ID = { message: 'invalid input syntax for type uuid: "meal-abc"', code: '22P02' };

/** 表ごとの「読み取り (select)」の結果。書き込み (update / insert / upsert / delete) は成功 */
type ReadOutcomes = Record<string, QueryOutcome>;

const WRITE_METHODS = new Set(['update', 'upsert', 'insert', 'delete']);

async function run(actionType: string, params: Record<string, unknown>, reads: ReadOutcomes = {}) {
  return (await runRecorded(actionType, params, (query: RecordedQuery) => {
    if (WRITE_METHODS.has(firstMethodOf(query) ?? '')) return { data: { id: 'new-1' } };
    return reads[query.table] ?? { data: null };
  })).out;
}

/** 応答を決める関数を渡して実行し、結果と記録した問い合わせを返す */
async function runRecorded(actionType: string, params: Record<string, unknown>, respond: (query: RecordedQuery) => QueryOutcome) {
  const db = createRecordingSupabase(respond);
  const out = await runConsultationAction(db.client, USER, {
    id: 'action-1',
    action_type: actionType,
    action_params: params,
    ai_consultation_sessions: { user_id: USER.id },
  });
  return { out, queries: db.queries };
}

const OWN_MEAL = { data: { id: 'meal-1', dish_name: '鮭', dishes: [], image_url: null, user_daily_meals: { user_id: USER.id } } };
const OWN_SHOPPING = {
  shopping_list_items: { data: { shopping_list_id: 'list-1' } },
  shopping_lists: { data: { user_id: USER.id } },
};
const OWN_GOAL = { health_goals: { data: { user_id: USER.id, goal_type: 'weight' } } };

beforeEach(() => {
  vi.clearAllMocks();
  m.consumeAiUsage.mockResolvedValue(AI_USAGE_ALLOWED);
  m.enqueueMealImageJobs.mockResolvedValue({ inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 0 });
});

/** やり直しても直らない失敗 (notRetryable: true が付く) */
const NOT_RETRYABLE_CASES: Array<[string, string, Record<string, unknown>, ReadOutcomes]> = [
  ['update_meal: mealId が無い', 'update_meal', { updates: { dish_name: '鮭' } }, {}],
  ['update_meal: 自分の献立に無い (0 行)', 'update_meal', { mealId: 'meal-1', updates: { dish_name: '鮭' } }, { planned_meals: { data: null } }],
  ['update_meal: 値が検査に落ちた', 'update_meal', { mealId: 'meal-1', updates: { dish_name: '' } }, { planned_meals: OWN_MEAL }],
  ['update_meal: 更新できる項目が無い', 'update_meal', { mealId: 'meal-1', updates: { unknown_key: 1 } }, { planned_meals: OWN_MEAL }],
  ['delete_meal: 自分の献立に無い (0 行)', 'delete_meal', { mealId: 'meal-1' }, { planned_meals: { data: null } }],
  ['add_to_shopping_list: 品が空', 'add_to_shopping_list', { items: [] }, {}],
  ['add_to_shopping_list: 品が無い', 'add_to_shopping_list', {}, {}],
  ['update_shopping_item: 品が無い (0 行)', 'update_shopping_item', { itemId: 'i1', updates: { item_name: '卵' } }, { shopping_list_items: { error: NO_ROWS } }],
  [
    'update_shopping_item: 他人のリスト',
    'update_shopping_item',
    { itemId: 'i1', updates: { item_name: '卵' } },
    { ...OWN_SHOPPING, shopping_lists: { data: { user_id: OTHER_USER } } },
  ],
  [
    'update_shopping_item: リストが無い (0 行)',
    'update_shopping_item',
    { itemId: 'i1', updates: { item_name: '卵' } },
    { ...OWN_SHOPPING, shopping_lists: { error: NO_ROWS } },
  ],
  ['update_shopping_item: 値が検査に落ちた', 'update_shopping_item', { itemId: 'i1', updates: { item_name: ' ' } }, OWN_SHOPPING],
  ['update_shopping_item: 更新できる項目が無い', 'update_shopping_item', { itemId: 'i1', updates: {} }, OWN_SHOPPING],
  ['delete_shopping_item: 品が無い (0 行)', 'delete_shopping_item', { itemId: 'i1' }, { shopping_list_items: { error: NO_ROWS } }],
  ['delete_shopping_item: 他人のリスト', 'delete_shopping_item', { itemId: 'i1' }, { ...OWN_SHOPPING, shopping_lists: { data: { user_id: OTHER_USER } } }],
  ['check_shopping_item: 品が無い (0 行)', 'check_shopping_item', { itemId: 'i1' }, { shopping_list_items: { error: NO_ROWS } }],
  ['check_shopping_item: リストが無い (0 行)', 'check_shopping_item', { itemId: 'i1' }, { ...OWN_SHOPPING, shopping_lists: { error: NO_ROWS } }],
  ['update_pantry_item: 食材が無い (0 行)', 'update_pantry_item', { itemId: 'p1', updates: { name: '卵' } }, { pantry_items: { error: NO_ROWS } }],
  ['update_pantry_item: 他人の食材', 'update_pantry_item', { itemId: 'p1', updates: { name: '卵' } }, { pantry_items: { data: { user_id: OTHER_USER } } }],
  ['delete_pantry_item: 食材が無い (0 行)', 'delete_pantry_item', { itemId: 'p1' }, { pantry_items: { error: NO_ROWS } }],
  ['delete_pantry_item: 他人の食材', 'delete_pantry_item', { itemId: 'p1' }, { pantry_items: { data: { user_id: OTHER_USER } } }],
  ['update_nutrition_target: 値が検査に落ちた', 'update_nutrition_target', { targets: { protein_g: '60' } }, {}],
  ['update_nutrition_target: 更新できる項目が無い', 'update_nutrition_target', { targets: {} }, {}],
  ['set_health_goal: 値が検査に落ちた', 'set_health_goal', { goalType: 'not_a_goal', targetValue: 50 }, {}],
  ['update_health_goal: 目標が無い (0 行)', 'update_health_goal', { goalId: 'g1', updates: { note: 'x' } }, { health_goals: { error: NO_ROWS } }],
  ['update_health_goal: 他人の目標', 'update_health_goal', { goalId: 'g1', updates: { note: 'x' } }, { health_goals: { data: { user_id: OTHER_USER, goal_type: 'weight' } } }],
  ['update_health_goal: 値が検査に落ちた', 'update_health_goal', { goalId: 'g1', updates: { target_value: -1 } }, OWN_GOAL],
  ['update_health_goal: 更新できる項目が無い', 'update_health_goal', { goalId: 'g1', updates: {} }, OWN_GOAL],
  ['update_health_goal: 目標値を空にしようとした', 'update_health_goal', { goalId: 'g1', updates: { target_value: null } }, OWN_GOAL],
  ['delete_health_goal: 目標が無い (0 行)', 'delete_health_goal', { goalId: 'g1' }, { health_goals: { error: NO_ROWS } }],
  ['delete_health_goal: 他人の目標', 'delete_health_goal', { goalId: 'g1' }, { health_goals: { data: { user_id: OTHER_USER } } }],
  ['add_health_record: 実在しない日付', 'add_health_record', { date: '2026-02-30', weight: 60 }, {}],
  ['add_health_record: 値が検査に落ちた', 'add_health_record', { date: '2026-11-01', weight: 'heavy' }, {}],
  ['add_health_record: 保存できる項目が無い', 'add_health_record', { date: '2026-11-01' }, {}],
  ['update_health_record: 実在しない日付', 'update_health_record', { date: '2026-02-30', updates: { weight: 60 } }, {}],
  ['update_health_record: 値が検査に落ちた', 'update_health_record', { date: '2026-11-01', updates: { weight: 'heavy' } }, {}],
  ['update_health_record: 更新できる項目が無い', 'update_health_record', { date: '2026-11-01', updates: {} }, {}],
  ['update_profile_preferences: 値が検査に落ちた', 'update_profile_preferences', { updates: { cooking_experience: 12 } }, {}],
  ['update_profile_preferences: 更新できる項目が無い', 'update_profile_preferences', { updates: {} }, {}],
  // id の形が崩れている (22P02。#2201 U4)
  ['update_meal: id の形が崩れている (22P02)', 'update_meal', { mealId: 'meal-abc', updates: { dish_name: '鮭' } }, { planned_meals: { error: MALFORMED_ID } }],
  ['delete_meal: id の形が崩れている (22P02)', 'delete_meal', { mealId: 'meal-abc' }, { planned_meals: { error: MALFORMED_ID } }],
  ['update_shopping_item: id の形が崩れている (22P02)', 'update_shopping_item', { itemId: 'i1', updates: { item_name: '卵' } }, { shopping_list_items: { error: MALFORMED_ID } }],
  ['delete_shopping_item: id の形が崩れている (22P02)', 'delete_shopping_item', { itemId: 'i1' }, { shopping_list_items: { error: MALFORMED_ID } }],
  ['check_shopping_item: id の形が崩れている (22P02)', 'check_shopping_item', { itemId: 'i1' }, { shopping_list_items: { error: MALFORMED_ID } }],
  ['update_pantry_item: id の形が崩れている (22P02)', 'update_pantry_item', { itemId: 'p1', updates: { name: '卵' } }, { pantry_items: { error: MALFORMED_ID } }],
  ['delete_pantry_item: id の形が崩れている (22P02)', 'delete_pantry_item', { itemId: 'p1' }, { pantry_items: { error: MALFORMED_ID } }],
  ['update_health_goal: id の形が崩れている (22P02)', 'update_health_goal', { goalId: 'g1', updates: { note: 'x' } }, { health_goals: { error: MALFORMED_ID } }],
  ['delete_health_goal: id の形が崩れている (22P02)', 'delete_health_goal', { goalId: 'g1' }, { health_goals: { error: MALFORMED_ID } }],
];

describe('やり直しても直らない失敗には notRetryable: true が付き、行は failed になる (#2195 V2)', () => {
  it.each(NOT_RETRYABLE_CASES)('%s', async (_name, actionType, params, reads) => {
    const out = await run(actionType, params, reads);

    expect(out.success).toBe(false);
    expect(out.notRetryable).toBe(true);
    // やり直せる種類でも、行は failed (画面は「実行する」を出さない)
    expect(aiActionLogStatusAfterRun(actionType, out)).toBe('failed');
  });

  it('complete_meal: 自分の献立に無い (RPC が not_found)', async () => {
    m.setPlannedMealCompleted.mockResolvedValueOnce({ ok: false, reason: 'not_found' });

    const out = await run('complete_meal', { mealId: 'meal-1' });

    expect(out).toMatchObject({ success: false, notRetryable: true });
    expect(aiActionLogStatusAfterRun('complete_meal', out)).toBe('failed');
  });
});

/** DB の読み取りの失敗 (やり直せば直りうる) には付けない */
const RETRYABLE_CASES: Array<[string, string, Record<string, unknown>, ReadOutcomes]> = [
  ['update_meal: 献立を読めなかった', 'update_meal', { mealId: 'meal-1', updates: { dish_name: '鮭' } }, { planned_meals: { error: DB_FAILURE } }],
  ['delete_meal: 献立を読めなかった', 'delete_meal', { mealId: 'meal-1' }, { planned_meals: { error: DB_FAILURE } }],
  ['update_shopping_item: 品を読めなかった', 'update_shopping_item', { itemId: 'i1', updates: { item_name: '卵' } }, { shopping_list_items: { error: DB_FAILURE } }],
  [
    'update_shopping_item: リストを読めなかった',
    'update_shopping_item',
    { itemId: 'i1', updates: { item_name: '卵' } },
    { ...OWN_SHOPPING, shopping_lists: { error: DB_FAILURE } },
  ],
  ['delete_shopping_item: 品を読めなかった', 'delete_shopping_item', { itemId: 'i1' }, { shopping_list_items: { error: DB_FAILURE } }],
  ['delete_shopping_item: リストを読めなかった', 'delete_shopping_item', { itemId: 'i1' }, { ...OWN_SHOPPING, shopping_lists: { error: DB_FAILURE } }],
  ['check_shopping_item: 品を読めなかった', 'check_shopping_item', { itemId: 'i1' }, { shopping_list_items: { error: DB_FAILURE } }],
  ['check_shopping_item: リストを読めなかった', 'check_shopping_item', { itemId: 'i1' }, { ...OWN_SHOPPING, shopping_lists: { error: DB_FAILURE } }],
  ['update_pantry_item: 食材を読めなかった', 'update_pantry_item', { itemId: 'p1', updates: { name: '卵' } }, { pantry_items: { error: DB_FAILURE } }],
  ['delete_pantry_item: 食材を読めなかった', 'delete_pantry_item', { itemId: 'p1' }, { pantry_items: { error: DB_FAILURE } }],
  ['update_health_goal: 目標を読めなかった', 'update_health_goal', { goalId: 'g1', updates: { note: 'x' } }, { health_goals: { error: DB_FAILURE } }],
  ['delete_health_goal: 目標を読めなかった', 'delete_health_goal', { goalId: 'g1' }, { health_goals: { error: DB_FAILURE } }],
];

describe('DB の読み取りの失敗には notRetryable を付けない (行は pending のまま。やり直せる)', () => {
  it.each(RETRYABLE_CASES)('%s', async (_name, actionType, params, reads) => {
    const out = await run(actionType, params, reads);

    expect(out.success).toBe(false);
    expect(out).not.toHaveProperty('notRetryable');
    expect(aiActionLogStatusAfterRun(actionType, out)).toBe('pending');
  });

  it('complete_meal: RPC の失敗 (not_found でない)', async () => {
    m.setPlannedMealCompleted.mockResolvedValueOnce({ ok: false, reason: 'failed' });

    const out = await run('complete_meal', { mealId: 'meal-1' });

    expect(out.success).toBe(false);
    expect(out).not.toHaveProperty('notRetryable');
  });

  it('add_to_shopping_list: 買い物リストを作れなかった', async () => {
    m.getOrCreateActiveShoppingList.mockRejectedValueOnce(DB_FAILURE);

    const out = await run('add_to_shopping_list', { items: [{ name: '卵' }] });

    expect(out.success).toBe(false);
    expect(out).not.toHaveProperty('notRetryable');
  });

  it('成功には付けない (品を足せた)', async () => {
    const out = await run('add_to_shopping_list', { items: [{ name: '卵' }] });

    expect(out.success).toBe(true);
    expect(out).not.toHaveProperty('notRetryable');
  });
});

// ─────────────────────────────────────────────
// update_meal の料理画像のジョブの積み込みの例外
// ─────────────────────────────────────────────
describe('update_meal: 料理画像のジョブの積み込み・処理の起動の例外 (#2195 V2・#2201 U4)', () => {
  const UPDATE_WITH_DISHES = { mealId: 'meal-1', updates: { dishes: [{ name: '筑前煮' }] } };
  /** 保存済みの献立の料理 (buildDishImagePayload の作り物が積むジョブ (dishIndex 0・subjectHash 'h') の料理。画像を待つ状態) */
  const PENDING_DISH = { name: '筑前煮', role: 'main', image_source: 'generated_ai', image_status: 'pending', image_subject_hash: 'h', image_url: null };
  const SAVED_AT = '2026-11-03T00:00:00.000Z';
  const OWN_MEAL_WITH_PENDING_DISH = {
    data: { ...OWN_MEAL.data, dishes: [PENDING_DISH], updated_at: SAVED_AT, catalog_product_id: null, source_type: null },
  };

  /** 献立の読み取りは画像を待つ料理のある献立、更新は成功 (料理の印の書き込み (select('id')) は 1 行書けた) */
  function respondWithPendingDish(query: RecordedQuery): QueryOutcome {
    if (firstMethodOf(query) === 'update') {
      const single = query.calls.some((call) => call.method === 'single');
      return { data: single ? { id: 'meal-1', dish_name: '筑前煮', dishes: [PENDING_DISH] } : [{ id: 'meal-1' }] };
    }
    if (WRITE_METHODS.has(firstMethodOf(query) ?? '')) return { data: { id: 'new-1' } };
    return query.table === 'planned_meals' ? OWN_MEAL_WITH_PENDING_DISH : { data: null };
  }

  /** planned_meals の更新のうち、料理 (dishes) を見送りの状態 ('failed' + 'enqueue_failed') にした書き込み */
  function enqueueFailedMarks(queries: RecordedQuery[]) {
    return queries.filter((query) => {
      if (query.table !== 'planned_meals' || firstMethodOf(query) !== 'update') return false;
      const values = query.calls[0].args[0] as { dishes?: Array<{ image_status?: string; image_error?: string }> };
      return values.dishes?.[0]?.image_status === 'failed' && values.dishes[0].image_error === MEAL_IMAGE_ENQUEUE_FAILED_ERROR;
    });
  }

  it('積み込みの例外: 数えた 1 回を戻し、料理を見送りの状態に書き直し、献立の更新は成功として返す (例外を外へ出さない)', async () => {
    m.enqueueMealImageJobs.mockRejectedValueOnce(new Error('enqueue failed'));

    const { out, queries } = await runRecorded('update_meal', UPDATE_WITH_DISHES, respondWithPendingDish);

    expect(out.success).toBe(true);
    expect(out.result).toMatchObject({ mealId: 'meal-1', updated: true });
    expect(m.consumeAiUsage).toHaveBeenCalledWith(USER.id, 'meal_image_auto');
    expect(m.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(m.refundAiUsage).toHaveBeenCalledWith(USER.id, 'meal_image_auto', AI_USAGE_ALLOWED);
    expect(m.triggerMealImageJobProcessing).not.toHaveBeenCalled();
    expect(m.logError).toHaveBeenCalledWith(
      MEAL_IMAGE_ENQUEUE_THREW_LOG_MESSAGE,
      expect.any(Error),
      expect.objectContaining({ action_id: 'action-1', planned_meal_id: 'meal-1' }),
    );
    // 'pending' のまま (処理するジョブが無いのに「料理画像を生成中」) に残さない。読んだときの updated_at の行にだけ書く
    const marks = enqueueFailedMarks(queries);
    expect(marks).toHaveLength(1);
    expect(marks[0].calls).toEqual(expect.arrayContaining([{ method: 'eq', args: ['updated_at', SAVED_AT] }]));
  });

  it('処理を起こす呼び出しの例外: 数え戻さず (ジョブは積めている)、料理も書き直さない。献立の更新は成功', async () => {
    m.triggerMealImageJobProcessing.mockRejectedValueOnce(new Error('trigger failed'));

    const { out, queries } = await runRecorded('update_meal', UPDATE_WITH_DISHES, respondWithPendingDish);

    expect(out.success).toBe(true);
    expect(m.enqueueMealImageJobs).toHaveBeenCalledTimes(1);
    expect(m.triggerMealImageJobProcessing).toHaveBeenCalledTimes(1);
    expect(m.refundAiUsage).not.toHaveBeenCalled();
    expect(enqueueFailedMarks(queries)).toEqual([]);
  });

  it('積み込みが成功したら数え戻さない', async () => {
    const out = await run('update_meal', UPDATE_WITH_DISHES, { planned_meals: OWN_MEAL });

    expect(out.success).toBe(true);
    expect(m.enqueueMealImageJobs).toHaveBeenCalledTimes(1);
    expect(m.triggerMealImageJobProcessing).toHaveBeenCalledTimes(1);
    expect(m.refundAiUsage).not.toHaveBeenCalled();
  });

  it('数えていない (上限の判定が許さなかった) ときは、積み込みに入らず数え戻しもしない', async () => {
    m.consumeAiUsage.mockResolvedValueOnce({ allowed: false, limit: 20, used: 20, usageDate: '2026-11-01' });

    const out = await run('update_meal', UPDATE_WITH_DISHES, { planned_meals: OWN_MEAL });

    expect(out.success).toBe(true);
    expect(m.enqueueMealImageJobs).not.toHaveBeenCalled();
    expect(m.refundAiUsage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// レシピの id の形が崩れている書き込み (#2201 U4)
// ─────────────────────────────────────────────
describe('レシピの id の形が崩れていて書き込みが 22P02 になったら notRetryable を付ける (#2201 U4)', () => {
  it('like_recipe: いいねの insert が 22P02', async () => {
    const { out } = await runRecorded('like_recipe', { recipeId: 'recipe-abc' }, (query) =>
      firstMethodOf(query) === 'insert' ? { error: MALFORMED_ID } : { data: null },
    );

    expect(out).toMatchObject({ success: false, notRetryable: true });
    expect(aiActionLogStatusAfterRun('like_recipe', out)).toBe('failed');
  });

  it('like_recipe: insert のほかの失敗 (一時的なことがある) には付けない', async () => {
    const { out } = await runRecorded('like_recipe', { recipeId: 'recipe-abc' }, (query) =>
      firstMethodOf(query) === 'insert' ? { error: DB_FAILURE } : { data: null },
    );

    expect(out.success).toBe(false);
    expect(out).not.toHaveProperty('notRetryable');
  });

  it('add_recipe_to_collection: 足す関数 (append_recipe_to_collection) が 22P02', async () => {
    const { out } = await runRecorded('add_recipe_to_collection', { recipeId: 'recipe-abc' }, (query) => {
      if (query.table.startsWith('rpc:')) return { error: MALFORMED_ID };
      return query.table === 'recipe_collections' ? { data: { id: 'collection-1' } } : { data: null };
    });

    expect(out).toMatchObject({ success: false, notRetryable: true });
  });

  it('add_recipe_to_collection: 足す関数のほかの失敗には付けない', async () => {
    const { out } = await runRecorded('add_recipe_to_collection', { recipeId: 'recipe-abc' }, (query) => {
      if (query.table.startsWith('rpc:')) return { error: DB_FAILURE };
      return query.table === 'recipe_collections' ? { data: { id: 'collection-1' } } : { data: null };
    });

    expect(out.success).toBe(false);
    expect(out).not.toHaveProperty('notRetryable');
  });
});
