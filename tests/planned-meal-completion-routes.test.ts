// @vitest-environment node
/**
 * #2025: 献立の完了の切り替えを RPC planned_meals_set_completed に付け替えた 3 経路と、作成の 3 route の回帰テスト。
 * 設計: docs/design/cross/23-planned-meals-score-integrity.md §7.9〜§7.11・§12.1
 *
 *   - PATCH /api/meals/[id] (本文の is_completed。completed_at は読まない)
 *   - PATCH /api/meal-plans/meals/[id] (本文の isCompleted。書く列が無いときは空の UPDATE を送らず行を読む)
 *   - AI 相談の complete_meal (runConsultationAction)
 *   - POST /api/meals・POST /api/meal-plans/meals・POST /api/meal-plans/add-from-photo は is_completed を送らない
 *
 * 利用者のセッションは planned_meals の is_completed / completed_at / veg_score を直接書けない (段 C の列の権限)。
 * 偽物の DB は tests/helpers/recording-supabase.ts (from と rpc の呼び出しを記録する)。
 * 本物の PostgREST での振る舞いは tests/integration/rls/planned-meals-score-integrity.test.ts の I-14・I-15 が見る。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLANNED_MEALS_SERVER_ONLY_COLUMNS,
  PLANNED_MEALS_SET_COMPLETED_RPC,
  PLANNED_MEAL_NOT_FOUND_CODE,
  PLANNED_MEAL_NOT_FOUND_SQLSTATE,
} from '@homegohan/shared';
import {
  argsOf,
  createRecordingSupabase,
  firstMethodOf,
  queriesOf,
  rpcTable,
  type QueryOutcome,
  type RecordedQuery,
} from './helpers/recording-supabase';

const h = vi.hoisted(() => ({
  /** route の createClient が返す利用者のセッションの偽物 (it ごとに作り直す) */
  userDb: null as unknown,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => h.userDb,
  getSupabaseAdmin: () => ({ from: vi.fn() }),
}));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => ({ from: vi.fn() }) }));
// 同意の判定 (T15 / #1154) は「同意済み」に差し替える
vi.mock('@/lib/ai/consent-guard', () => import('./helpers/ai-consent-guard-allowed'));
vi.mock('../lib/catalog-products', () => ({
  buildCatalogSelectionUpdate: vi.fn(),
  clearCatalogSelectionMetadata: vi.fn(),
}));
// 料理の画像のジョブは作らない (完了の切り替えの順序だけを見る)
vi.mock('../lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(async (params: { nextDishes?: unknown; fallbackMealImageUrl?: string | null }) => ({
    dishes: params.nextDishes ?? null,
    jobs: [],
    mealCoverImageUrl: params.fallbackMealImageUrl ?? null,
  })),
  cancelPendingMealImageJobs: vi.fn(async () => undefined),
  enqueueMealImageJobs: vi.fn(async () => undefined),
  triggerMealImageJobProcessing: vi.fn(async () => undefined),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/db-logger', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return {
    createLogger: () => ({ ...logger(), withUser: () => logger() }),
    generateRequestId: () => 'req-test',
  };
});
// AI 相談のアクションの実行部が読むもの (complete_meal では使わない)
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({ invokeGenerateMenuV4WithRetry: vi.fn(), markWeeklyMenuRequestFailed: vi.fn() }));
vi.mock('@/lib/v4-target-slots', () => ({ resolveExistingTargetSlots: vi.fn() }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { MEAL_NOT_FOUND_MESSAGE } from '@/lib/api/user-api-error-messages';
import { AI_ACTION_COMPLETE_MEAL_FAILED_MESSAGE } from '@/lib/ai/ai-api-messages';
import { PLANNED_MEAL_COMPLETION_INVALID_MESSAGE } from '@/modules/planned-meals-integrity/core';
import { PATCH as mealsPatch } from '../src/app/api/meals/[id]/route';
import { PATCH as mealPlansPatch } from '../src/app/api/meal-plans/meals/[id]/route';
import { POST as mealsPost } from '../src/app/api/meals/route';
import { POST as mealPlansPost } from '../src/app/api/meal-plans/meals/route';
import { POST as addFromPhotoPost } from '../src/app/api/meal-plans/add-from-photo/route';
import { runConsultationAction } from '../src/lib/ai/consultation-action-executor';

const USER_ID = 'user-1';
/** route は UUID の形でない id を DB に渡さず 404 にするので、id は UUID の形にする */
const MEAL_ID = '20252025-2025-4025-8025-202520252025';
const DAY_ID = '20252025-2025-4025-8025-202520252026';
/** 画面が送ってくる端末の時刻 (route が読まないことを見る) */
const CLIENT_COMPLETED_AT = '2000-01-01T00:00:00.000Z';
/** RPC が返す時刻 (DB の now()) */
const DB_COMPLETED_AT = '2026-10-26T03:00:00+00:00';
const DB_UPDATED_AT = '2026-10-26T03:00:01+00:00';
const COMPLETE_RPC_TABLE = rpcTable(PLANNED_MEALS_SET_COMPLETED_RPC);

/** route が読む今の献立の行 (料理の無い献立) */
const EXISTING_ROW = {
  id: MEAL_ID,
  daily_meal_id: DAY_ID,
  meal_type: 'lunch',
  dish_name: 'カレー',
  mode: 'cook',
  catalog_product_id: null,
  source_type: 'manual',
  generation_metadata: null,
  dishes: null,
  image_url: null,
  is_completed: false,
  completed_at: null,
  user_daily_meals: { user_id: USER_ID },
};

interface DbScript {
  /** planned_meals の update の失敗 */
  updateError?: { message: string; code?: string } | null;
  /** RPC の結果 (既定は本文どおりに切り替えた 1 行) */
  rpc?: (args: { p_meal_id: string; p_completed: boolean }) => QueryOutcome;
}

function rpcRowOf(args: { p_meal_id: string; p_completed: boolean }) {
  return {
    id: args.p_meal_id,
    is_completed: args.p_completed,
    completed_at: args.p_completed ? DB_COMPLETED_AT : null,
    updated_at: DB_UPDATED_AT,
  };
}

/** 利用者のセッションの偽物を作り、route の createClient が返すようにする */
function installUserDb(script: DbScript = {}) {
  const { client, queries } = createRecordingSupabase((query: RecordedQuery): QueryOutcome => {
    if (query.table === COMPLETE_RPC_TABLE) {
      const args = argsOf(query, 'rpc')[0][1] as { p_meal_id: string; p_completed: boolean };
      return script.rpc ? script.rpc(args) : { data: [rpcRowOf(args)] };
    }
    if (query.table === 'user_daily_meals') return { data: { id: DAY_ID } };
    if (query.table === 'planned_meals') {
      const method = firstMethodOf(query);
      if (method === 'insert') return { data: { id: MEAL_ID, ...(argsOf(query, 'insert')[0][0] as Record<string, unknown>) } };
      if (method === 'update') {
        if (script.updateError) return { error: script.updateError };
        return { data: { ...EXISTING_ROW, ...(argsOf(query, 'update')[0][0] as Record<string, unknown>) } };
      }
      if (method === 'delete') return { data: null };
      // select: 1 行を読む (maybeSingle / single) なら今の行、一覧なら空
      const readsOne = query.calls.some((c) => c.method === 'maybeSingle' || c.method === 'single');
      return { data: readsOne ? EXISTING_ROW : [] };
    }
    return { data: null };
  });
  const db = { ...client, auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) } };
  h.userDb = db;
  return { db, queries };
}

const plannedMealWrites = (queries: RecordedQuery[], method: 'insert' | 'update') =>
  queriesOf(queries, 'planned_meals').filter((q) => firstMethodOf(q) === method);
const rpcCalls = (queries: RecordedQuery[]) => queriesOf(queries, COMPLETE_RPC_TABLE);
const rpcArgsOf = (queries: RecordedQuery[]) => rpcCalls(queries).map((q) => argsOf(q, 'rpc')[0]);

const jsonRequest = (url: string, method: string, body: unknown) =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const patchMeals = (body: unknown) =>
  mealsPatch(jsonRequest(`http://localhost/api/meals/${MEAL_ID}`, 'PATCH', body), { params: Promise.resolve({ id: MEAL_ID }) });
const patchMealPlans = (body: unknown) =>
  mealPlansPatch(jsonRequest(`http://localhost/api/meal-plans/meals/${MEAL_ID}`, 'PATCH', body), {
    params: Promise.resolve({ id: MEAL_ID }),
  });

/** AI 相談の complete_meal を 1 回実行する */
async function completeMeal(actionParams: Record<string, unknown>) {
  const { db, queries } = installUserDb();
  return { queries, ...(await completeMealOn(db, actionParams)) };
}
async function completeMealOn(db: unknown, actionParams: Record<string, unknown>) {
  const out = await runConsultationAction(db as Parameters<typeof runConsultationAction>[0], { id: USER_ID }, {
    id: 'action-1',
    action_type: 'complete_meal',
    action_params: actionParams,
  } as Parameters<typeof runConsultationAction>[2]);
  return { success: out.success, result: out.result as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2025 PATCH /api/meals/[id] の完了の切り替え', () => {
  it('完了の指定が無ければ rpc を呼ばない (ほかの列の update は今までどおり)', async () => {
    const { queries } = installUserDb();
    const res = await patchMeals({ dish_name: '鮭定食' });
    expect(res.status).toBe(200);
    expect(rpcCalls(queries)).toEqual([]);
    const updates = plannedMealWrites(queries, 'update');
    expect(updates).toHaveLength(1);
    expect(argsOf(updates[0], 'update')[0][0]).toEqual({ dish_name: '鮭定食', updated_at: expect.any(String) });
  });

  it('boolean でない完了の指定は 400 で DB に触れない', async () => {
    for (const isCompleted of ['yes', 'true', 1, null, { done: true }]) {
      const { queries } = installUserDb();
      const res = await patchMeals({ is_completed: isCompleted });
      expect(res.status, JSON.stringify(isCompleted)).toBe(400);
      expect(await res.json()).toEqual({ error: PLANNED_MEAL_COMPLETION_INVALID_MESSAGE });
      expect(queries).toEqual([]);
    }
  });

  it('本文の completed_at は update の本文に入らない (PATCH /api/meals/[id])', async () => {
    const { queries } = installUserDb();
    const res = await patchMeals({ is_completed: true, completed_at: CLIENT_COMPLETED_AT, dish_name: '鮭定食' });
    expect(res.status).toBe(200);
    const updates = plannedMealWrites(queries, 'update');
    expect(updates).toHaveLength(1);
    const payload = argsOf(updates[0], 'update')[0][0] as Record<string, unknown>;
    for (const column of PLANNED_MEALS_SERVER_ONLY_COLUMNS) expect(column in payload, column).toBe(false);
    expect(payload).toEqual({ dish_name: '鮭定食', updated_at: expect.any(String) });
    // 完了は RPC で切り替える (端末の時刻は RPC にも渡らない)
    expect(rpcArgsOf(queries)).toEqual([[PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id: MEAL_ID, p_completed: true }]]);
  });

  it('rpc の行 (is_completed / completed_at / updated_at) が応答に重なる', async () => {
    installUserDb();
    const res = await patchMeals({ is_completed: true, completed_at: CLIENT_COMPLETED_AT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: MEAL_ID, dish_name: 'カレー', is_completed: true, completed_at: DB_COMPLETED_AT, updated_at: DB_UPDATED_AT });

    installUserDb();
    const undone = (await (await patchMeals({ is_completed: false })).json()) as Record<string, unknown>;
    expect(undone).toMatchObject({ id: MEAL_ID, is_completed: false, completed_at: null });
  });

  it('not_found は 404 MEAL_NOT_FOUND_MESSAGE', async () => {
    installUserDb({ rpc: () => ({ error: { code: PLANNED_MEAL_NOT_FOUND_SQLSTATE, message: PLANNED_MEAL_NOT_FOUND_CODE } }) });
    const res = await patchMeals({ is_completed: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: MEAL_NOT_FOUND_MESSAGE });
  });

  it('rpc の失敗は 500 internalError', async () => {
    installUserDb({ rpc: () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } }) });
    const res = await patchMeals({ is_completed: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });

    // 行の形が正典と違うときも 500 (DB の生の値を応答に載せない)
    installUserDb({ rpc: () => ({ data: [{ id: MEAL_ID, is_completed: 'yes' }] }) });
    const shape = await patchMeals({ is_completed: true });
    expect(shape.status).toBe(500);
  });

  it('ほかの列の update が失敗したら rpc を呼ばない', async () => {
    const { queries } = installUserDb({ updateError: { message: 'update failed', code: 'XX000' } });
    const res = await patchMeals({ is_completed: true, dish_name: '鮭定食' });
    expect(res.status).toBe(500);
    expect(plannedMealWrites(queries, 'update')).toHaveLength(1);
    expect(rpcCalls(queries)).toEqual([]);
  });
});

describe('#2025 PATCH /api/meal-plans/meals/[id] の完了の切り替え', () => {
  it('完了の指定が無ければ rpc を呼ばない (ほかの列の update は今までどおり)', async () => {
    const { queries } = installUserDb();
    const res = await patchMealPlans({ dishName: '手動で変更' });
    expect(res.status).toBe(200);
    expect(rpcCalls(queries)).toEqual([]);
    const updates = plannedMealWrites(queries, 'update');
    expect(updates).toHaveLength(1);
    expect(argsOf(updates[0], 'update')[0][0]).toEqual({ dish_name: '手動で変更' });
  });

  it('boolean でない完了の指定は 400 で DB に触れない', async () => {
    for (const isCompleted of ['yes', 'false', 0, null]) {
      const { queries } = installUserDb();
      const res = await patchMealPlans({ isCompleted });
      expect(res.status, JSON.stringify(isCompleted)).toBe(400);
      expect(await res.json()).toEqual({ error: PLANNED_MEAL_COMPLETION_INVALID_MESSAGE });
      expect(queries).toEqual([]);
    }
  });

  it('rpc の行 (is_completed / completed_at / updated_at) が応答に重なる', async () => {
    const { queries } = installUserDb();
    const res = await patchMealPlans({ isCompleted: true, dishName: '手動で変更' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; meal: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.meal).toMatchObject({ id: MEAL_ID, dish_name: '手動で変更', is_completed: true, completed_at: DB_COMPLETED_AT, updated_at: DB_UPDATED_AT });
    // update の本文に 3 列は入らない
    const payload = argsOf(plannedMealWrites(queries, 'update')[0], 'update')[0][0] as Record<string, unknown>;
    for (const column of PLANNED_MEALS_SERVER_ONLY_COLUMNS) expect(column in payload, column).toBe(false);
    expect(rpcArgsOf(queries)).toEqual([[PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id: MEAL_ID, p_completed: true }]]);
  });

  it('not_found は 404 MEAL_NOT_FOUND_MESSAGE', async () => {
    installUserDb({ rpc: () => ({ error: { code: PLANNED_MEAL_NOT_FOUND_SQLSTATE, message: PLANNED_MEAL_NOT_FOUND_CODE } }) });
    const res = await patchMealPlans({ isCompleted: false });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: MEAL_NOT_FOUND_MESSAGE });
  });

  it('rpc の失敗は 500 internalError', async () => {
    installUserDb({ rpc: () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } }) });
    const res = await patchMealPlans({ isCompleted: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
  });

  it('ほかの列の update が失敗したら rpc を呼ばない', async () => {
    const { queries } = installUserDb({ updateError: { message: 'update failed', code: 'XX000' } });
    const res = await patchMealPlans({ isCompleted: true, dishName: '手動で変更' });
    expect(res.status).toBe(500);
    expect(plannedMealWrites(queries, 'update')).toHaveLength(1);
    expect(rpcCalls(queries)).toEqual([]);
  });

  it('完了の指定だけで書く列が無いとき (PATCH /api/meal-plans/meals/[id]・料理の無い献立) は update を呼ばず select で行を読み、rpc の行を重ねて 200', async () => {
    const { queries } = installUserDb();
    const res = await patchMealPlans({ isCompleted: true });
    expect(res.status).toBe(200);
    // 空の UPDATE を PostgREST に送らない (送ると 0 行になり .single() が失敗する)
    expect(plannedMealWrites(queries, 'update')).toEqual([]);
    const reads = queriesOf(queries, 'planned_meals').filter((q) => firstMethodOf(q) === 'select');
    // 所有の確認 (maybeSingle) と、行の読み直し (single)
    expect(reads.map((q) => q.calls.map((c) => c.method).at(-1))).toEqual(['maybeSingle', 'single']);
    expect(argsOf(reads[1], 'eq')).toEqual([['id', MEAL_ID]]);
    expect(rpcArgsOf(queries)).toEqual([[PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id: MEAL_ID, p_completed: true }]]);
    const body = (await res.json()) as { success: boolean; meal: Record<string, unknown> };
    expect(body).toMatchObject({ success: true, meal: { id: MEAL_ID, dish_name: 'カレー', is_completed: true, completed_at: DB_COMPLETED_AT } });
  });
});

describe('#2025 AI 相談の complete_meal', () => {
  it('完了の指定が無ければ (isCompleted を省く) 完了にする。rpc を 1 回呼び、planned_meals を直接書かない', async () => {
    const { queries, success, result } = await completeMeal({ mealId: MEAL_ID });
    expect(success).toBe(true);
    expect(result).toEqual({ mealId: MEAL_ID, completed: true });
    expect(rpcArgsOf(queries)).toEqual([[PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id: MEAL_ID, p_completed: true }]]);
    // 所有の確認も RPC が行う (planned_meals を読まない・書かない)
    expect(queriesOf(queries, 'planned_meals')).toEqual([]);
  });

  it('isCompleted: false は未完了にし、result の completed は RPC の行の値', async () => {
    const { queries, success, result } = await completeMeal({ mealId: MEAL_ID, isCompleted: false });
    expect(success).toBe(true);
    expect(result).toEqual({ mealId: MEAL_ID, completed: false });
    expect(rpcArgsOf(queries)).toEqual([[PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id: MEAL_ID, p_completed: false }]]);
  });

  it("not_found は '権限がありません' (UUID の形でない id は rpc を呼ばない)", async () => {
    const { db, queries } = installUserDb({ rpc: () => ({ error: { code: PLANNED_MEAL_NOT_FOUND_SQLSTATE, message: PLANNED_MEAL_NOT_FOUND_CODE } }) });
    const foreign = await completeMealOn(db, { mealId: MEAL_ID, isCompleted: true });
    expect(foreign).toEqual({ success: false, result: { error: '権限がありません' } });
    expect(rpcCalls(queries)).toHaveLength(1);

    for (const mealId of ['not-a-uuid', 42, undefined]) {
      const fresh = installUserDb();
      expect(await completeMealOn(fresh.db, { mealId }), String(mealId)).toEqual({ success: false, result: { error: '権限がありません' } });
      expect(rpcCalls(fresh.queries)).toEqual([]);
    }
  });

  it('rpc の失敗は AI_ACTION_COMPLETE_MEAL_FAILED_MESSAGE で success: false', async () => {
    const { db } = installUserDb({ rpc: () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } }) });
    const out = await completeMealOn(db, { mealId: MEAL_ID, isCompleted: true });
    expect(out).toEqual({ success: false, result: { mealId: MEAL_ID, error: AI_ACTION_COMPLETE_MEAL_FAILED_MESSAGE } });
    // DB の生の文を result に載せない
    expect(JSON.stringify(out.result)).not.toContain('Could not find');
  });
});

describe('#2025 作成の 3 route は is_completed を送らない', () => {
  it('insertData に is_completed が無い (POST /api/meals・POST /api/meal-plans/meals・POST /api/meal-plans/add-from-photo)', async () => {
    const entries: Array<{ name: string; run: () => Promise<Response> }> = [
      {
        name: 'POST /api/meals',
        run: () => mealsPost(jsonRequest('http://localhost/api/meals', 'POST', { date: '2026-10-26', mealType: 'lunch', dishName: '定食' })),
      },
      {
        name: 'POST /api/meal-plans/meals',
        run: () =>
          mealPlansPost(
            jsonRequest('http://localhost/api/meal-plans/meals', 'POST', { dayDate: '2026-10-26', mealType: 'dinner', mode: 'cook', dishName: '手入力' }),
          ),
      },
      {
        name: 'POST /api/meal-plans/add-from-photo',
        run: () =>
          addFromPhotoPost(
            jsonRequest('http://localhost/api/meal-plans/add-from-photo', 'POST', {
              dayDate: '2026-10-26',
              mealType: 'dinner',
              dishes: [{ name: 'カレー', cal: 620, role: 'main' }],
              totalCalories: 620,
            }),
          ),
      },
    ];
    for (const entry of entries) {
      const { queries } = installUserDb();
      const res = await entry.run();
      expect(res.status, entry.name).toBe(200);
      const inserts = plannedMealWrites(queries, 'insert');
      expect(inserts, entry.name).toHaveLength(1);
      const payload = argsOf(inserts[0], 'insert')[0][0] as Record<string, unknown>;
      for (const column of PLANNED_MEALS_SERVER_ONLY_COLUMNS) expect(column in payload, `${entry.name}: ${column}`).toBe(false);
      // 列の既定 (false) に任せる。完了の RPC も呼ばない
      expect(rpcCalls(queries), entry.name).toEqual([]);
    }
  });
});
