/**
 * src/__tests__/api/ai/menu/meal-pending.test.ts
 *
 * #1507: 単一食事の生成中の行の確認 (GET /api/ai/menu/meal/pending) の止まりの判定を、cleanup と同じ生存信号
 * (GREATEST(worker_acquired_at, updated_at)・無ければ updated_at・無ければ created_at) と比較つきの更新に揃えた。
 * - 止まった行は、読んだときの状態・生存信号がそのままの行だけを failed にし、応答の requests から外す
 * - claim_menu_request が取り直した直後 (worker_acquired_at が新しく updated_at が古い) の行は failed にしない
 * - 読んでから書くまでに進んだ行 (比較つきの更新が 0 行)・更新が拒まれた行は、生成中の行として返す
 * - 時刻が読めない行は止まったと見なさない (以前は止まったと扱っていた)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WEEKLY_MENU_REQUEST_STALE_MINUTES } from '@/lib/weekly-menu-request-stale';

/** テストの「今」(固定) */
const NOW_MS = Date.parse('2026-10-11T03:00:00.000Z');
const MIN = 60 * 1000;
/** 今から minutes 分前の時刻 (PostgREST が返す形) */
const ago = (minutes: number) => new Date(NOW_MS - minutes * MIN).toISOString();
/** しきい値を超えて止まった時刻 */
const STALE_MINUTES = WEEKLY_MENU_REQUEST_STALE_MINUTES + 10;
/** 「数秒前」(claim_menu_request が取り直した直後) */
const JUST_NOW_MINUTES = 0.05;

const mockGetUser = vi.fn();

// 利用者のクライアント: select(...).eq(...).in(...).in(...).order(...)[.gte().lte()][.eq()].limit(10)
const listResultQueue: Array<{ data: any; error: any }> = [];
const mockLimit = vi.fn(() => Promise.resolve(listResultQueue.shift() ?? { data: [], error: null }));
const mockSelect = vi.fn((..._args: any[]) => {
  const query: Record<string, unknown> = {};
  for (const method of ['eq', 'in', 'order', 'gte', 'lte']) query[method] = () => query;
  query.limit = mockLimit;
  return query;
});

// service role のクライアント: 比較つきの更新
//   from('weekly_menu_requests').update(payload).eq(...).eq(...).eq(...).(eq|is)(...).(eq|is)(...).select('id, generated_data')
type UpdateCall = { payload: Record<string, unknown>; filters: Array<[string, string, unknown]>; returning?: string };
const updateCalls: UpdateCall[] = [];
const updateResultQueue: Array<{ data: Array<{ id: string; generated_data: unknown }> | null; error: unknown }> = [];

function makeUpdateBuilder(call: UpdateCall) {
  const builder = {
    eq: (column: string, value: unknown) => {
      call.filters.push(['eq', column, value]);
      return builder;
    },
    is: (column: string, value: unknown) => {
      call.filters.push(['is', column, value]);
      return builder;
    },
    select: (columns: string) => {
      call.returning = columns;
      return Promise.resolve(updateResultQueue.shift() ?? { data: [], error: null });
    },
  };
  return builder;
}

const mockUpdate = vi.fn((payload: Record<string, unknown>) => {
  const call: UpdateCall = { payload, filters: [] };
  updateCalls.push(call);
  return makeUpdateBuilder(call);
});

// 利用者のクライアントは weekly_menu_requests を読むだけ (#1465: 利用者からは書けない)
const mockFrom = vi.fn((table: string) => {
  if (table === 'weekly_menu_requests') {
    return { select: mockSelect };
  }
  throw new Error(`Unexpected table in test: ${table}`);
});

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

// AI のキューへの書き込みは service role のクライアント (getAiQueueWriter → getSupabaseAdmin) で行う (#1465)
const mockAdminFrom = vi.fn((table: string) => {
  if (table === 'weekly_menu_requests') {
    return { update: mockUpdate };
  }
  throw new Error(`Unexpected table in test (admin): ${table}`);
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => mockSupabase),
  getSupabaseAdmin: vi.fn(() => ({ from: mockAdminFrom })),
}));

const { GET } = await import('@/app/api/ai/menu/meal/pending/route');

const user = { id: 'user-1' };

const makeRequest = () => new Request('http://localhost/api/ai/menu/meal/pending?date=2026-10-11');

/** meal/pending が読む行 (既定は生成中で、進捗が新しい行) */
function mealRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'processing',
    target_date: '2026-10-12',
    target_meal_type: 'dinner',
    target_meal_id: null,
    mode: 'single',
    created_at: ago(60),
    updated_at: ago(1),
    worker_acquired_at: null,
    ...overrides,
  };
}

/** 更新のフィルタから、指定した列の条件を取り出す */
function filterOf(call: UpdateCall, column: string) {
  return call.filters.filter(([, c]) => c === column);
}

/** 応答の requests の requestId */
function requestIdsOf(json: { requests: Array<{ requestId: string }> }) {
  return json.requests.map((r) => r.requestId);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  listResultQueue.length = 0;
  updateResultQueue.length = 0;
  updateCalls.length = 0;
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/ai/menu/meal/pending: 止まりの判定は cleanup と同じ生存信号と比較つきの更新 (#1507)', () => {
  it('止まっていない行はそのまま返し、更新しない。生存信号の列を読む', async () => {
    listResultQueue.push({ data: [mealRow('req-1')], error: null });

    const json = await (await GET(makeRequest())).json();

    expect(json.hasPending).toBe(true);
    expect(requestIdsOf(json)).toEqual(['req-1']);
    expect(mockUpdate).not.toHaveBeenCalled();
    const columns = String(mockSelect.mock.calls[0][0]).split(',').map((c) => c.trim());
    expect(columns).toEqual(expect.arrayContaining(['status', 'created_at', 'updated_at', 'worker_acquired_at']));
  });

  it('止まった行だけを比較つきの更新で failed にし、requests から外す', async () => {
    const staleUpdatedAt = ago(STALE_MINUTES);
    listResultQueue.push({ data: [mealRow('req-stuck', { updated_at: staleUpdatedAt }), mealRow('req-alive')], error: null });
    updateResultQueue.push({ data: [{ id: 'req-stuck', generated_data: null }], error: null });

    const json = await (await GET(makeRequest())).json();

    expect(json.hasPending).toBe(true);
    expect(requestIdsOf(json)).toEqual(['req-alive']);
    expect(mockAdminFrom).toHaveBeenCalledWith('weekly_menu_requests');
    expect(updateCalls).toHaveLength(1);
    const [call] = updateCalls;
    expect(call.payload).toEqual({
      status: 'failed',
      error_message: 'stale_request_timeout',
      updated_at: new Date(NOW_MS).toISOString(),
    });
    expect(filterOf(call, 'id')).toEqual([['eq', 'id', 'req-stuck']]);
    expect(filterOf(call, 'user_id')).toEqual([['eq', 'user_id', user.id]]);
    expect(filterOf(call, 'status')).toEqual([['eq', 'status', 'processing']]);
    expect(filterOf(call, 'updated_at')).toEqual([['eq', 'updated_at', staleUpdatedAt]]);
    expect(filterOf(call, 'worker_acquired_at')).toEqual([['is', 'worker_acquired_at', null]]);
  });

  it('止まった行がすべて failed になったら hasPending:false', async () => {
    listResultQueue.push({ data: [mealRow('req-stuck', { status: 'pending', updated_at: ago(STALE_MINUTES) })], error: null });
    updateResultQueue.push({ data: [{ id: 'req-stuck', generated_data: null }], error: null });

    const json = await (await GET(makeRequest())).json();

    expect(json).toEqual({ hasPending: false, requests: [] });
    expect(filterOf(updateCalls[0], 'status')).toEqual([['eq', 'status', 'pending']]);
  });

  it('claim_menu_request が取り直した直後 (worker_acquired_at が新しく updated_at が古い) の行は failed にしない', async () => {
    listResultQueue.push({
      data: [mealRow('req-1', { created_at: ago(STALE_MINUTES + 5), updated_at: ago(STALE_MINUTES), worker_acquired_at: ago(JUST_NOW_MINUTES) })],
      error: null,
    });

    const json = await (await GET(makeRequest())).json();

    expect(requestIdsOf(json)).toEqual(['req-1']);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('読んでから書くまでに進んだ行 (比較つきの更新が 0 行) は failed にせず、生成中の行として返す', async () => {
    listResultQueue.push({ data: [mealRow('req-1', { updated_at: ago(STALE_MINUTES) })], error: null });
    updateResultQueue.push({ data: [], error: null });

    const json = await (await GET(makeRequest())).json();

    expect(updateCalls).toHaveLength(1);
    expect(json.hasPending).toBe(true);
    expect(requestIdsOf(json)).toEqual(['req-1']);
  });

  it('failed への更新が拒まれた行は、生成中の行として返し、残りの行の更新は続ける', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    listResultQueue.push({
      data: [mealRow('req-rejected', { updated_at: ago(STALE_MINUTES) }), mealRow('req-stuck', { updated_at: ago(STALE_MINUTES) })],
      error: null,
    });
    updateResultQueue.push({ data: null, error: { message: 'update rejected' } });
    updateResultQueue.push({ data: [{ id: 'req-stuck', generated_data: null }], error: null });

    const json = await (await GET(makeRequest())).json();

    expect(updateCalls).toHaveLength(2);
    expect(requestIdsOf(json)).toEqual(['req-rejected']);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('時刻が読めない行 (created_at・updated_at・worker_acquired_at のどれも読めない) は止まったと見なさない', async () => {
    listResultQueue.push({ data: [mealRow('req-1', { created_at: null, updated_at: null, worker_acquired_at: null })], error: null });

    const json = await (await GET(makeRequest())).json();

    expect(json.hasPending).toBe(true);
    expect(requestIdsOf(json)).toEqual(['req-1']);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
