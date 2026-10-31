/**
 * #2150 Q2-1: モバイルのホーム (useHomeData) の 3 つの一覧の並びは、Web の LIST_ORDERS (src/lib/api/list-order.ts) と同じ鍵で並べる。
 *
 * 1 つの鍵だけで並べると、同じ値の行の順は DB 任せで、開くたびに入れ替わりうる。
 * モバイルの「最新のバッジ」「今週のベスト」が Web と別の行になり、期限の近い品の同じ期限の品の順も揺れる。
 * そこで最後に一意の鍵 (id、id の無い user_badges は badge_id) の昇順を重ね、NULL の位置は今までと同じ値を明示する。
 *
 * 下の表 (HOME_ORDER_TABLE) に、3 か所の並びの鍵を書く:
 *   - 表の各行は Web の LIST_ORDERS の鍵と同じであること (表と Web の食い違いを見る)
 *   - hook が実際に呼んだ order(...) の並びが表の行と同じであること (モバイルと表の食い違いを見る)
 * Supabase は tests/helpers/recording-supabase.ts の偽物 (from の呼び出しと引数を記録する)。
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { LIST_ORDERS, type ListOrderKey } from '../../../../src/lib/api/list-order';
import { argsOf, queriesOf, type QueryOutcome, type RecordedQuery } from '../../../../tests/helpers/recording-supabase';

const USER_ID = 'b2150000-0000-4000-8000-000000000001';

// jest.mock の factory から読む型は名前を mock で始める (babel-plugin-jest-hoist の外の変数の規則)
type MockQueryOutcome = QueryOutcome;
type MockRecordedQuery = RecordedQuery;
interface MockState {
  /** 記録した問い合わせ (it ごとに空にする) */
  queries: MockRecordedQuery[];
}

// 偽物の状態は module の中に持ち、jest.requireMock で取り出す
// (jest.mock は import より先に巻き上げられるので、このファイルの const を factory の中で読むと初期化の前になる)
jest.mock('../../src/lib/supabase', () => {
  const { createRecordingSupabase } = jest.requireActual('../../../../tests/helpers/recording-supabase');
  const state: MockState = { queries: [] };
  const { client, queries } = createRecordingSupabase((query: MockRecordedQuery): MockQueryOutcome => {
    const readsOne = query.calls.some((c) => c.method === 'maybeSingle' || c.method === 'single');
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

/** 1 つの並びの鍵 (order(column, options) の引数) */
type OrderCall = readonly [column: string, options: ListOrderKey['options']];

/** 3 か所の一覧: 読む表・同じ一覧の Web の鍵の名前・並びの鍵 (先頭ほど強い) */
const HOME_ORDER_TABLE = [
  {
    name: '期限の近い品 (fetchExpiringItems)',
    table: 'pantry_items',
    webOrder: 'pantryItemsByExpiration',
    keys: [
      ['expiration_date', { ascending: true, nullsFirst: false }],
      ['id', { ascending: true, nullsFirst: false }],
    ],
  },
  {
    name: '最新のバッジ (fetchBadgeInfo)',
    table: 'user_badges',
    webOrder: 'homeLatestBadge',
    keys: [
      ['obtained_at', { ascending: false, nullsFirst: true }],
      ['badge_id', { ascending: true, nullsFirst: false }],
    ],
  },
  {
    name: '今週のベスト (fetchBestMealThisWeek)',
    table: 'planned_meals',
    webOrder: 'homeBestVegMeal',
    keys: [
      ['veg_score', { ascending: false, nullsFirst: false }],
      ['id', { ascending: true, nullsFirst: false }],
    ],
  },
] as const satisfies readonly {
  name: string;
  table: string;
  webOrder: keyof typeof LIST_ORDERS;
  keys: readonly OrderCall[];
}[];

/** その表への問い合わせのうち order を呼んだもの (user_badges の件数だけの問い合わせは order を呼ばない) */
function orderedQueriesOf(table: string): RecordedQuery[] {
  return queriesOf(mockState.queries, table).filter((q) => argsOf(q, 'order').length > 0);
}

beforeEach(() => {
  mockState.queries.length = 0;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('#2150 Q2-1 モバイルのホームの 3 か所の並び', () => {
  it.each(HOME_ORDER_TABLE)('表の $name の鍵は Web の LIST_ORDERS.$webOrder と同じ', (row) => {
    const webOrder = LIST_ORDERS[row.webOrder];
    expect(webOrder.table).toBe(row.table);
    expect(row.keys.map(([column, options]) => ({ column, options }))).toEqual(webOrder.keys);
  });

  it('hook が呼ぶ 3 か所の order の並びは表の行と同じ (最後に一意の鍵を重ねる)', async () => {
    const { result } = renderHook(() => useHomeData(USER_ID));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      for (const row of HOME_ORDER_TABLE) expect(orderedQueriesOf(row.table)).toHaveLength(1);
    });

    for (const row of HOME_ORDER_TABLE) {
      const [query] = orderedQueriesOf(row.table);
      expect({ name: row.name, orders: argsOf(query, 'order') }).toEqual({ name: row.name, orders: row.keys });
    }
  });
});
