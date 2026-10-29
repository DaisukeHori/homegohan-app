/**
 * #2025: Web のホーム (useHomeData) の「食べた」の切り替えは、RPC planned_meals_set_completed だけで書く。
 * 設計: docs/design/cross/23-planned-meals-score-integrity.md §7.14.1・§12.1
 *
 * 利用者のセッションは planned_meals の is_completed / completed_at を直接書けない (段 C の列の権限)。
 * hook は supabase.rpc(PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id, p_completed }) を呼び、planned_meals を update しない。
 * 失敗したら楽観的更新を戻し、fetchHomeData で読み直す (今までどおり)。
 *
 * このリポジトリには @testing-library/react が無いため、hook を呼ぶだけの小さな部品を react-dom/client + act で描く
 * (src/__tests__/hooks/useFamilyMenu.test.ts と同じ形)。Supabase は tests/helpers/recording-supabase.ts の偽物。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANNED_MEALS_SET_COMPLETED_RPC } from '@homegohan/shared';
import {
  argsOf,
  createRecordingSupabase,
  firstMethodOf,
  queriesOf,
  rpcTable,
  type QueryOutcome,
  type RecordedQuery,
} from '../../../tests/helpers/recording-supabase';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER_ID = 'a2025000-0000-4000-8000-000000000001';
const DAY_ID = 'a2025000-0000-4000-8000-000000000002';
const MEAL_ID = 'a2025000-0000-4000-8000-000000000003';
const COMPLETE_RPC_TABLE = rpcTable(PLANNED_MEALS_SET_COMPLETED_RPC);
/** hook の連打よけの待ち (250ms) を確実に越える時間 */
const DEBOUNCE_SETTLE_MS = 400;
/** 描画の後、最初の読み込みが終わるまで待つ上限 */
const LOAD_TIMEOUT_MS = 5_000;

const h = vi.hoisted(() => ({
  db: null as unknown,
  /** RPC の結果 (it ごとに入れ替える) */
  rpcOutcome: { data: null, error: null } as { data: unknown; error: unknown },
  /** auth.getSession の呼ばれた回数 (fetchHomeData の読み直しを数える) */
  getSessionCalls: 0,
}));

vi.mock('@/lib/supabase/client', () => ({ createClient: () => h.db }));

type HomeData = ReturnType<typeof import('@/hooks/useHomeData').useHomeData>;

function buildDb() {
  const { client, queries } = createRecordingSupabase((query: RecordedQuery): QueryOutcome => {
    if (query.table === COMPLETE_RPC_TABLE) {
      return { data: h.rpcOutcome.data, error: h.rpcOutcome.error as QueryOutcome['error'] };
    }
    const readsOne = query.calls.some((c) => c.method === 'maybeSingle' || c.method === 'single');
    const selectArg = String(argsOf(query, 'select')[0]?.[0] ?? '');
    // 今日の献立 (user_daily_meals → planned_meals(*)): 未完了の昼食 1 件
    if (query.table === 'user_daily_meals' && readsOne && selectArg.includes('planned_meals(*)')) {
      return {
        data: {
          id: DAY_ID,
          day_date: '2026-10-26',
          planned_meals: [{ id: MEAL_ID, meal_type: 'lunch', dish_name: 'カレー', mode: 'cook', is_completed: false, completed_at: null, dishes: [] }],
        },
      };
    }
    return { data: readsOne ? null : [] };
  });
  const auth = {
    getSession: async () => {
      h.getSessionCalls += 1;
      return { data: { session: { user: { id: USER_ID, user_metadata: {} } } }, error: null };
    },
    getUser: async () => ({ data: { user: { id: USER_ID, user_metadata: {} } }, error: null }),
    refreshSession: async () => ({ data: { session: null }, error: null }),
    setSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
  };
  h.db = { ...client, auth };
  return { queries };
}

let container: HTMLDivElement;
let root: Root;
let latest: HomeData | null = null;

async function renderHome(): Promise<void> {
  const { useHomeData } = await import('@/hooks/useHomeData');
  function Probe() {
    latest = useHomeData();
    return null;
  }
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
  await vi.waitFor(
    () => {
      if (!latest || latest.loading || !latest.todayPlan) throw new Error('まだ読み込み中');
    },
    { timeout: LOAD_TIMEOUT_MS },
  );
}

function current(): HomeData {
  if (!latest) throw new Error('hook が描かれていない');
  return latest;
}

async function toggle(currentStatus: boolean): Promise<void> {
  await act(async () => {
    await current().toggleMealCompletion(MEAL_ID, currentStatus);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  latest = null;
  h.getSessionCalls = 0;
  h.rpcOutcome = { data: [{ id: MEAL_ID, is_completed: true, completed_at: '2026-10-26T03:00:00+00:00', updated_at: null }], error: null };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({}), { status: 500, headers: { 'content-type': 'application/json' } })),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#2025 Web のホームの完了の切り替え', () => {
  it('toggleMealCompletion は supabase.rpc(PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id, p_completed }) を呼び、planned_meals を update しない', async () => {
    const { queries } = buildDb();
    await renderHome();
    const sessionCallsBefore = h.getSessionCalls;

    await toggle(false);

    const rpcs = queriesOf(queries, COMPLETE_RPC_TABLE);
    expect(rpcs).toHaveLength(1);
    expect(argsOf(rpcs[0], 'rpc')[0]).toEqual([PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id: MEAL_ID, p_completed: true }]);
    expect(queriesOf(queries, 'planned_meals').filter((q) => ['update', 'insert', 'upsert'].includes(firstMethodOf(q) ?? ''))).toEqual([]);
    // 楽観的更新のまま (成功したので読み直さない)
    expect(current().todayPlan?.meals.find((m) => m.id === MEAL_ID)?.isCompleted).toBe(true);
    expect(current().dailySummary.completedCount).toBe(1);
    expect(h.getSessionCalls).toBe(sessionCallsBefore);
  }, DEBOUNCE_SETTLE_MS * 20);

  it('rpc が失敗したら楽観的更新を戻し fetchHomeData を呼ぶ', async () => {
    const { queries } = buildDb();
    await renderHome();
    const sessionCallsBefore = h.getSessionCalls;
    h.rpcOutcome = { data: null, error: { code: '42501', message: 'permission denied for table planned_meals' } };

    await toggle(false);

    expect(queriesOf(queries, COMPLETE_RPC_TABLE)).toHaveLength(1);
    // 楽観的更新が戻り、読み直し (fetchHomeData → auth.getSession) が走る
    await vi.waitFor(() => {
      expect(h.getSessionCalls).toBeGreaterThan(sessionCallsBefore);
    });
    await vi.waitFor(() => {
      expect(current().loading).toBe(false);
    });
    expect(current().todayPlan?.meals.find((m) => m.id === MEAL_ID)?.isCompleted).toBe(false);
    expect(current().dailySummary.completedCount).toBe(0);
  }, DEBOUNCE_SETTLE_MS * 20);
});
