/**
 * src/__tests__/api/ai/menu/weekly-pending.test.ts
 *
 * #1042: stale sweeper (weekly/pending) が waitUntil 消失等で生成コールバックが
 * 実行されず stale になったリクエストを failed 化するだけで、削除済み献立の
 * スナップショット (generated_data.snapshot) を復元しない問題の修正確認。
 *
 * - stale でない場合はそのまま hasPending を返し、復元は呼ばれないこと
 * - stale かつ snapshot が残っている場合は復元を実行し、結果を response に含めること
 * - stale だが snapshot がない場合は復元を呼ばず、response に restore を含めないこと
 *
 * #1042 性能退行修正: 3秒間隔ポーリングの通常 select から生成中に肥大化する
 * generated_data(jsonb) を外し、止まった行を failed にしたときだけ (更新の戻り値で) 受け取ることの確認。
 * - 非 stale ポーリングでは generated_data を select しないこと
 *
 * #1507: 止まりの判定を cleanup と同じ生存信号 (GREATEST(worker_acquired_at, updated_at)・無ければ updated_at・
 * 無ければ created_at) と比較つきの更新に揃えた。
 * - claim_menu_request が取り直した直後 (worker_acquired_at は新しいが updated_at は古い) の行は failed にしない
 * - 読んでから書くまでに進んだ行 (比較つきの更新が 0 行) は failed にせず、生成中の行として返す
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

// 利用者のクライアント: select(...).eq('user_id', ...).or(...).in(...).order(...).limit(1).single()
const pendingResultQueue: Array<{ data: any; error: any }> = [];
const mockSingle = vi.fn(() => Promise.resolve(pendingResultQueue.shift() ?? { data: null, error: null }));
const mockLimit = vi.fn(() => ({ single: mockSingle }));
const mockOrder = vi.fn(() => ({ limit: mockLimit }));
const mockIn = vi.fn(() => ({ order: mockOrder }));
const mockOr = vi.fn(() => ({ in: mockIn }));
const mockEq = vi.fn(() => ({ or: mockOr }));
const mockSelect = vi.fn((..._args: any[]) => ({ eq: mockEq }));

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

const mockRestoreOwnPlannedMealsSnapshot = vi.fn(async (..._args: any[]) => ({ restored: 0, skipped: 0, failed: 0 }));
vi.mock('@/lib/planned-meals-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planned-meals-snapshot')>();
  return {
    ...actual,
    // 復元は本人の日の確認 + service role の restoreOwnPlannedMealsSnapshot (#2025)
    restoreOwnPlannedMealsSnapshot: mockRestoreOwnPlannedMealsSnapshot,
  };
});

const { GET, maxDuration } = await import('@/app/api/ai/menu/weekly/pending/route');

const user = { id: 'user-1' };
const date = '2026-07-06';

const makeRequest = () => new Request(`http://localhost/api/ai/menu/weekly/pending?date=${date}`);

/** pending が読む行 (既定は生成中で、進捗が新しい行) */
function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    status: 'processing',
    mode: 'v4',
    start_date: date,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  pendingResultQueue.length = 0;
  updateResultQueue.length = 0;
  updateCalls.length = 0;
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/ai/menu/weekly/pending', () => {
  it('stale でない processing リクエストは hasPending:true を返す(復元は呼ばない)', async () => {
    pendingResultQueue.push({ data: pendingRow(), error: null });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.hasPending).toBe(true);
    expect(json.requestId).toBe('req-1');
    expect(mockRestoreOwnPlannedMealsSnapshot).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('非 stale ポーリングでは generated_data を select しない(二次クエリも発行しない)。生存信号の列は読む', async () => {
    pendingResultQueue.push({ data: pendingRow(), error: null });

    await GET(makeRequest());

    // 通常ポーリングでの select は1回のみで、generated_data を含まないこと
    expect(mockSelect).toHaveBeenCalledTimes(1);
    const columns = String(mockSelect.mock.calls[0][0]).split(',').map((c) => c.trim());
    expect(columns).not.toContain('generated_data');
    // 止まったかの判定に使う生存信号の列 (#1507)
    expect(columns).toEqual(expect.arrayContaining(['status', 'created_at', 'updated_at', 'worker_acquired_at']));
  });

  it('stale なリクエストは比較つきの更新で failed 化し、snapshot があれば復元して response に反映する', async () => {
    const snapshotRow = { id: 'meal-1', daily_meal_id: 'day-1', meal_type: 'breakfast' };
    const staleUpdatedAt = ago(STALE_MINUTES);
    pendingResultQueue.push({ data: pendingRow({ created_at: ago(STALE_MINUTES + 5), updated_at: staleUpdatedAt }), error: null });
    // 書き換えた行の generated_data を更新の戻り値で受け取る (#1042: 通常の読み取りでは読まない)
    updateResultQueue.push({ data: [{ id: 'req-1', generated_data: { snapshot: [snapshotRow] } }], error: null });
    mockRestoreOwnPlannedMealsSnapshot.mockResolvedValueOnce({ restored: 1, skipped: 0, failed: 0 });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.hasPending).toBe(false);
    expect(json.restore).toEqual({ restored: 1, skipped: 0, failed: 0 });

    expect(mockRestoreOwnPlannedMealsSnapshot).toHaveBeenCalledTimes(1);
    // 本人の日の確認は利用者のセッション (userDb)、書き戻しは service role (writer = getSupabaseAdmin()) で行う (#2025)
    expect(mockRestoreOwnPlannedMealsSnapshot).toHaveBeenCalledWith({ userDb: mockSupabase, writer: { from: mockAdminFrom }, snapshot: [snapshotRow] });

    // service role で、本人の行に絞って、読んだときの状態・生存信号がそのままの行だけを書き換える (#1465・#1507)
    expect(mockAdminFrom).toHaveBeenCalledWith('weekly_menu_requests');
    expect(updateCalls).toHaveLength(1);
    const [call] = updateCalls;
    expect(call.payload).toEqual({
      status: 'failed',
      error_message: 'stale_request_timeout',
      updated_at: new Date(NOW_MS).toISOString(),
    });
    expect(filterOf(call, 'id')).toEqual([['eq', 'id', 'req-1']]);
    expect(filterOf(call, 'user_id')).toEqual([['eq', 'user_id', user.id]]);
    expect(filterOf(call, 'status')).toEqual([['eq', 'status', 'processing']]);
    expect(filterOf(call, 'updated_at')).toEqual([['eq', 'updated_at', staleUpdatedAt]]);
    expect(filterOf(call, 'worker_acquired_at')).toEqual([['is', 'worker_acquired_at', null]]);
    expect(call.returning).toBe('id, generated_data');

    // 利用者のクライアントでの読み取りは 1 回だけ (generated_data の二次クエリは無い)
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('stale だが snapshot がない場合は復元を呼ばず response に restore を含めない', async () => {
    pendingResultQueue.push({ data: pendingRow({ updated_at: ago(STALE_MINUTES) }), error: null });
    updateResultQueue.push({ data: [{ id: 'req-1', generated_data: null }], error: null });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.hasPending).toBe(false);
    expect(json.restore).toBeUndefined();
    expect(mockRestoreOwnPlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('stale 判定時の復元が打ち切られないよう maxDuration を明示している (#1203)', () => {
    expect(maxDuration).toBe(60);
  });
});

describe('GET /api/ai/menu/weekly/pending: 止まりの判定は cleanup と同じ生存信号と比較つきの更新 (#1507)', () => {
  it('claim_menu_request が取り直した直後 (worker_acquired_at が新しく updated_at が古い) の行は failed にせず、生成中として返す', async () => {
    pendingResultQueue.push({
      data: pendingRow({ created_at: ago(STALE_MINUTES + 5), updated_at: ago(STALE_MINUTES), worker_acquired_at: ago(JUST_NOW_MINUTES) }),
      error: null,
    });

    const json = await (await GET(makeRequest())).json();

    expect(json.hasPending).toBe(true);
    expect(json.requestId).toBe('req-1');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRestoreOwnPlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('読んでから書くまでに進んだ行 (比較つきの更新が 0 行) は failed にせず、生成中の行として返す (復元もしない)', async () => {
    pendingResultQueue.push({ data: pendingRow({ updated_at: ago(STALE_MINUTES) }), error: null });
    updateResultQueue.push({ data: [], error: null });

    const json = await (await GET(makeRequest())).json();

    expect(updateCalls).toHaveLength(1);
    expect(json.hasPending).toBe(true);
    expect(json.requestId).toBe('req-1');
    expect(json.restore).toBeUndefined();
    expect(mockRestoreOwnPlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('failed への更新が拒まれたときは、生成中の行として返し、復元もしない (行は書き換わっていない)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    pendingResultQueue.push({ data: pendingRow({ updated_at: ago(STALE_MINUTES) }), error: null });
    updateResultQueue.push({ data: null, error: { message: 'update rejected' } });

    const json = await (await GET(makeRequest())).json();

    expect(json.hasPending).toBe(true);
    expect(mockRestoreOwnPlannedMealsSnapshot).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('時刻が読めない行 (created_at・updated_at・worker_acquired_at のどれも読めない) は止まったと見なさない', async () => {
    pendingResultQueue.push({ data: pendingRow({ created_at: null, updated_at: null, worker_acquired_at: null }), error: null });

    const json = await (await GET(makeRequest())).json();

    expect(json.hasPending).toBe(true);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('queued の行は、作成からどれだけたっていても止まったと見なさない (cron の順番待ち)', async () => {
    pendingResultQueue.push({
      data: pendingRow({ status: 'queued', created_at: ago(24 * 60), updated_at: ago(24 * 60), worker_acquired_at: null }),
      error: null,
    });

    const json = await (await GET(makeRequest())).json();

    expect(json.hasPending).toBe(true);
    expect(json.status).toBe('queued');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('GET /api/ai/menu/weekly/pending: 究極モードの生成か (ultimateMode) を返す (#1582)', () => {
  it('generated_data 全体は読まず、generated_data.ultimateMode だけを ultimate_mode として読む', async () => {
    pendingResultQueue.push({ data: pendingRow({ ultimate_mode: true }), error: null });

    await GET(makeRequest());

    const columns = String(mockSelect.mock.calls[0][0]).split(',').map((c) => c.trim());
    expect(columns).toContain('ultimate_mode:generated_data->ultimateMode');
    expect(columns).not.toContain('generated_data');
  });

  it.each([
    { label: '通常の v4 の生成', mode: 'v4', ultimate_mode: false, expected: false },
    { label: '通常の v5 の生成', mode: 'v5', ultimate_mode: false, expected: false },
    { label: '「献立を改善」(v4・常に通常モード)', mode: 'v4', ultimate_mode: false, expected: false },
    { label: '究極モードの v4 の生成', mode: 'v4', ultimate_mode: true, expected: true },
    { label: '究極モードの v5 の生成', mode: 'v5', ultimate_mode: true, expected: true },
    { label: 'generated_data が無い行 (古い行)', mode: 'v4', ultimate_mode: null, expected: false },
    { label: '真偽値でない値 (文字列の "true")', mode: 'v4', ultimate_mode: 'true', expected: false },
  ])('$label の待ちは ultimateMode: $expected を返す (mode は v4 / v5 のまま返す)', async ({ mode, ultimate_mode, expected }) => {
    pendingResultQueue.push({ data: pendingRow({ mode, ultimate_mode }), error: null });

    const json = await (await GET(makeRequest())).json();

    expect(json.hasPending).toBe(true);
    expect(json.mode).toBe(mode);
    expect(json.ultimateMode).toBe(expected);
  });

  it('ultimate_mode の列が無い (取り出せなかった) 行は、通常の生成として返す', async () => {
    pendingResultQueue.push({ data: pendingRow({ mode: 'v4' }), error: null });

    const json = await (await GET(makeRequest())).json();

    expect(json.ultimateMode).toBe(false);
  });
});

describe('GET /api/ai/menu/weekly/pending: 他の週の生成中の行は返さない (#1609)', () => {
  // Web の週間献立の画面 (page.tsx) は、この振る舞いを前提に週を切り替えない (以前の週を切り替える分岐は通らなかったので消した)
  it('start_date が date (表示中の週の初日) と違う行は hasPending: false を返す (他の週の生成中は復元しない)', async () => {
    pendingResultQueue.push({ data: pendingRow({ start_date: '2026-07-13' }), error: null });

    const json = await (await GET(makeRequest())).json();

    expect(json).toEqual({ hasPending: false });
  });

  it('start_date が date と同じ行は、その start_date をそのまま返す', async () => {
    pendingResultQueue.push({ data: pendingRow({ start_date: date }), error: null });

    const json = await (await GET(makeRequest())).json();

    expect(json.hasPending).toBe(true);
    expect(json.startDate).toBe(date);
  });

  it('start_date の無い行は、生成中の行として返す (startDate は null)', async () => {
    pendingResultQueue.push({ data: pendingRow({ start_date: null }), error: null });

    const json = await (await GET(makeRequest())).json();

    expect(json.hasPending).toBe(true);
    expect(json.startDate).toBeNull();
  });
});
