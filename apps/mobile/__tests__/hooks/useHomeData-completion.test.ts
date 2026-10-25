/**
 * #2025: モバイルのホーム (useHomeData) の「食べた」の切り替えは、RPC planned_meals_set_completed だけで書く。
 * 設計: docs/design/cross/23-planned-meals-score-integrity.md §7.14.2・§12.1
 *
 * 利用者のセッションは planned_meals の is_completed / completed_at を直接書けない (段 C の列の権限)。
 * hook は supabase.rpc(PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id, p_completed }) を呼び、planned_meals を update しない。
 * 失敗したら楽観的更新を戻し、fetchAll で読み直す (今までどおり)。
 * Supabase は tests/helpers/recording-supabase.ts の偽物 (from と rpc の呼び出しを記録する)。
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { PLANNED_MEALS_SET_COMPLETED_RPC } from '@homegohan/shared';
import {
  argsOf,
  firstMethodOf,
  queriesOf,
  rpcTable,
  type QueryOutcome,
  type RecordedQuery,
} from '../../../../tests/helpers/recording-supabase';

const USER_ID = 'b2025000-0000-4000-8000-000000000001';
const DAY_ID = 'b2025000-0000-4000-8000-000000000002';
const MEAL_ID = 'b2025000-0000-4000-8000-000000000003';
const COMPLETE_RPC_TABLE = rpcTable(PLANNED_MEALS_SET_COMPLETED_RPC);
/** hook の連打よけの待ち (250ms) を確実に越える時間 */
const DEBOUNCE_SETTLE_MS = 400;

// jest.mock の factory から読む型は名前を mock で始める (babel-plugin-jest-hoist の外の変数の規則)
type MockQueryOutcome = QueryOutcome;
type MockRecordedQuery = RecordedQuery;
interface MockState {
  /** RPC の結果 (it ごとに入れ替える) */
  rpcOutcome: MockQueryOutcome;
  /** 記録した問い合わせ (it ごとに空にする) */
  queries: MockRecordedQuery[];
}

// 偽物の状態は module の中に持ち、jest.requireMock で取り出す
// (jest.mock は import より先に巻き上げられるので、このファイルの const を factory の中で読むと初期化の前になる)
jest.mock('../../src/lib/supabase', () => {
  const { createRecordingSupabase, rpcTable: rpcTableOf } = jest.requireActual('../../../../tests/helpers/recording-supabase');
  const { PLANNED_MEALS_SET_COMPLETED_RPC: rpcName } = jest.requireActual('@homegohan/shared');
  const state: MockState = { rpcOutcome: { data: null, error: null }, queries: [] };
  const { client, queries } = createRecordingSupabase((query: MockRecordedQuery): MockQueryOutcome => {
    if (query.table === rpcTableOf(rpcName)) return state.rpcOutcome;
    const readsOne = query.calls.some((c) => c.method === 'maybeSingle' || c.method === 'single');
    const selectArg = String(query.calls.find((c) => c.method === 'select')?.args[0] ?? '');
    // 今日の献立 (user_daily_meals → planned_meals): 未完了の昼食 1 件
    if (query.table === 'user_daily_meals' && readsOne && selectArg.includes('planned_meals(')) {
      return {
        data: {
          id: 'b2025000-0000-4000-8000-000000000002',
          day_date: '2026-10-26',
          planned_meals: [
            { id: 'b2025000-0000-4000-8000-000000000003', meal_type: 'lunch', mode: 'cook', dish_name: 'カレー', calories_kcal: 600, is_completed: false, image_url: null },
          ],
        },
      };
    }
    return { data: readsOne ? null : [] };
  });
  state.queries = queries;
  return { supabase: client, mockState: state };
});
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: jest.fn(async () => ({})), post: jest.fn(async () => ({})) }),
}));

import { useHomeData } from '../../src/hooks/useHomeData';

const { mockState } = jest.requireMock<{ mockState: MockState }>('../../src/lib/supabase');

async function renderHome() {
  const rendered = renderHook(() => useHomeData(USER_ID));
  await waitFor(() => {
    expect(rendered.result.current.loading).toBe(false);
    expect(rendered.result.current.todayMeals).toHaveLength(1);
  });
  return rendered;
}

/** 今の献立の読み込み (user_daily_meals → planned_meals) の回数。fetchAll の読み直しを数える */
const todayMealsReads = () =>
  queriesOf(mockState.queries, 'user_daily_meals').filter((q) =>
    String(argsOf(q, 'select')[0]?.[0] ?? '').includes('planned_meals('),
  ).length;

beforeEach(() => {
  mockState.queries.length = 0;
  mockState.rpcOutcome = {
    data: [{ id: MEAL_ID, is_completed: true, completed_at: '2026-10-26T03:00:00+00:00', updated_at: null }],
    error: null,
  };
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('#2025 モバイルのホームの完了の切り替え', () => {
  it('toggleMealCompletion は supabase.rpc(...) を呼び、planned_meals を update しない', async () => {
    const { result } = await renderHome();
    const readsBefore = todayMealsReads();

    await act(async () => {
      await result.current.toggleMealCompletion(MEAL_ID, false);
    });

    const rpcs = queriesOf(mockState.queries, COMPLETE_RPC_TABLE);
    expect(rpcs).toHaveLength(1);
    expect(argsOf(rpcs[0], 'rpc')[0]).toEqual([PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id: MEAL_ID, p_completed: true }]);
    expect(
      queriesOf(mockState.queries, 'planned_meals').filter((q) => ['update', 'insert', 'upsert'].includes(firstMethodOf(q) ?? '')),
    ).toEqual([]);
    // 楽観的更新のまま (成功したので読み直さない)
    expect(result.current.todayMeals.find((m) => m.id === MEAL_ID)?.is_completed).toBe(true);
    expect(result.current.dailySummary.completedCount).toBe(1);
    expect(todayMealsReads()).toBe(readsBefore);
  }, DEBOUNCE_SETTLE_MS * 20);

  it('rpc が失敗したら楽観的更新を戻し fetchAll を呼ぶ', async () => {
    const { result } = await renderHome();
    const readsBefore = todayMealsReads();
    mockState.rpcOutcome = { data: null, error: { code: '42501', message: 'permission denied for table planned_meals' } };

    await act(async () => {
      await result.current.toggleMealCompletion(MEAL_ID, false);
    });

    expect(queriesOf(mockState.queries, COMPLETE_RPC_TABLE)).toHaveLength(1);
    await waitFor(() => {
      expect(todayMealsReads()).toBeGreaterThan(readsBefore);
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.todayMeals.find((m) => m.id === MEAL_ID)?.is_completed).toBe(false);
    expect(result.current.dailySummary.completedCount).toBe(0);
  }, DEBOUNCE_SETTLE_MS * 20);
});
