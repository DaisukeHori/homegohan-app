/**
 * src/__tests__/api/ai/menu/weekly-status.test.ts
 *
 * #1042: stale sweeper (weekly/status) が waitUntil 消失等で生成コールバックが
 * 実行されず stale になったリクエストを failed 化するだけで、削除済み献立の
 * スナップショット (generated_data.snapshot) を復元しない問題の修正確認。
 *
 * - stale でない場合はそのまま状態を返し、復元は呼ばれないこと
 * - stale かつ snapshot が残っている場合は復元を実行し、結果を response に含めること
 * - stale だが snapshot がない場合は復元を呼ばず、response に restore を含めないこと
 *
 * #1042 性能退行修正: 3秒間隔ポーリングの通常 select から生成中に肥大化する
 * generated_data(jsonb) を外し、止まった行を failed にしたときだけ (更新の戻り値で) 受け取ることの確認。
 * - 非 stale ポーリングでは generated_data を select しないこと
 *
 * #1507: 止まりの判定を cleanup と同じ生存信号 (GREATEST(worker_acquired_at, updated_at)・無ければ updated_at・
 * 無ければ created_at) と比較つきの更新に揃えた。以前は updated_at だけで判定していたので、claim_menu_request が
 * 取り直した直後 (worker_acquired_at は新しいが updated_at は古い) の行を、3 秒ごとのポーリングが failed にしえた。
 * - 取り直した直後の行は failed にしない
 * - 読んでから書くまでに進んだ行 (比較つきの更新が 0 行) は failed と返さず、復元もしない
 * - 時刻が読めない行は止まったと見なさない
 * - failed への更新が拒まれたときは failed と返さず、復元もしない (次のポーリングでやり直す)
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

const selectResultQueue: Array<{ data: any; error: any }> = [];
const mockMaybeSingle = vi.fn(() => Promise.resolve(selectResultQueue.shift() ?? { data: null, error: null }));
const mockSelectEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelectEq1 = vi.fn(() => ({ eq: mockSelectEq2 }));
const mockSelect = vi.fn((..._args: any[]) => ({ eq: mockSelectEq1 }));

// service role のクライアント: 比較つきの更新
//   from('weekly_menu_requests').update(payload).eq(...).eq(...).eq(...).(eq|is)(...).(eq|is)(...).select('id, generated_data')
// 呼ばれたフィルタを記録し、select の戻り値は updateResultQueue から返す
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

const { GET, maxDuration } = await import('@/app/api/ai/menu/weekly/status/route');
const { AI_CONSENT_REQUIRED_MESSAGE, AI_CONSENT_CHECK_FAILED_MESSAGE } = await import('../../../../../supabase/functions/_shared/ai-consent');
const { WEEKLY_MENU_REQUEST_FAILED_MESSAGE, WEEKLY_MENU_REQUEST_STALE_DISPLAY_MESSAGE } = await import('@/lib/weekly-menu-request-error');

const user = { id: 'user-1' };

/** 献立の生成の受付の id (weekly_menu_requests.id は uuid の列。UUID の形でない requestId は DB に渡さず not_found を返すので、UUID の形にする。#1917 の続き) */
const REQUEST_ID = '60000000-0000-4000-8000-0000000000a1';

const makeRequest = (requestId: string) =>
  new Request(`http://localhost/api/ai/menu/weekly/status?requestId=${requestId}`);

/** status が読む行 (既定は生成中で、進捗が新しい行) */
function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    status: 'processing',
    error_message: null,
    created_at: ago(60),
    updated_at: ago(1),
    worker_acquired_at: null,
    mode: 'v4',
    start_date: '2026-07-06',
    target_meal_id: null,
    progress: 5,
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
  selectResultQueue.length = 0;
  updateResultQueue.length = 0;
  updateCalls.length = 0;
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/ai/menu/weekly/status', () => {
  it('stale でない processing リクエストはそのまま状態を返す(復元は呼ばない)', async () => {
    selectResultQueue.push({ data: requestRow(), error: null });

    const res = await GET(makeRequest(REQUEST_ID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('processing');
    expect(json.progress).toBe(5);
    expect(mockRestoreOwnPlannedMealsSnapshot).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('非 stale ポーリングでは generated_data を select しない(二次クエリも発行しない)。生存信号の列は読む', async () => {
    selectResultQueue.push({ data: requestRow(), error: null });

    await GET(makeRequest(REQUEST_ID));

    // 通常ポーリングでの select は1回のみで、generated_data を含まないこと
    expect(mockSelect).toHaveBeenCalledTimes(1);
    const columns = String(mockSelect.mock.calls[0][0]).split(',').map((c) => c.trim());
    expect(columns).not.toContain('generated_data');
    // 止まったかの判定に使う生存信号の列 (#1507)
    expect(columns).toEqual(expect.arrayContaining(['status', 'created_at', 'updated_at', 'worker_acquired_at']));
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('stale な processing リクエストは比較つきの更新で failed 化し、snapshot があれば復元して response に反映する', async () => {
    const snapshotRow = { id: 'meal-1', daily_meal_id: 'day-1', meal_type: 'breakfast' };
    const staleUpdatedAt = ago(STALE_MINUTES);
    selectResultQueue.push({ data: requestRow({ updated_at: staleUpdatedAt }), error: null });
    // 書き換えた行の generated_data を更新の戻り値で受け取る (#1042: 通常の読み取りでは読まない)
    updateResultQueue.push({ data: [{ id: REQUEST_ID, generated_data: { snapshot: [snapshotRow] } }], error: null });
    mockRestoreOwnPlannedMealsSnapshot.mockResolvedValueOnce({ restored: 1, skipped: 0, failed: 0 });

    const res = await GET(makeRequest(REQUEST_ID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('failed');
    // 行には英語の印を書くが、本文には日本語の文を返す (#1576)
    expect(json.errorMessage).toBe(WEEKLY_MENU_REQUEST_STALE_DISPLAY_MESSAGE);
    expect(json.error_message).toBe(WEEKLY_MENU_REQUEST_STALE_DISPLAY_MESSAGE);
    expect(JSON.stringify(json)).not.toContain('stale_request_timeout');
    expect(json.updatedAt).toBe(new Date(NOW_MS).toISOString());
    expect(json.restore).toEqual({ restored: 1, skipped: 0, failed: 0 });

    expect(mockRestoreOwnPlannedMealsSnapshot).toHaveBeenCalledTimes(1);
    // 本人の日の確認は利用者のセッション (userDb)、書き戻しは service role (writer = getSupabaseAdmin()) で行う (#2025)
    expect(mockRestoreOwnPlannedMealsSnapshot).toHaveBeenCalledWith({ userDb: mockSupabase, writer: { from: mockAdminFrom }, snapshot: [snapshotRow] });

    // failed への更新は service role で、本人の行に絞って、読んだときの状態・生存信号がそのままの行だけに行う (#1465・#1507)
    expect(mockAdminFrom).toHaveBeenCalledWith('weekly_menu_requests');
    expect(updateCalls).toHaveLength(1);
    const [call] = updateCalls;
    expect(call.payload).toEqual({
      status: 'failed',
      error_message: 'stale_request_timeout',
      updated_at: new Date(NOW_MS).toISOString(),
    });
    expect(filterOf(call, 'id')).toEqual([['eq', 'id', REQUEST_ID]]);
    expect(filterOf(call, 'user_id')).toEqual([['eq', 'user_id', user.id]]);
    expect(filterOf(call, 'status')).toEqual([['eq', 'status', 'processing']]);
    expect(filterOf(call, 'updated_at')).toEqual([['eq', 'updated_at', staleUpdatedAt]]);
    expect(filterOf(call, 'worker_acquired_at')).toEqual([['is', 'worker_acquired_at', null]]);
    expect(call.returning).toBe('id, generated_data');

    // 利用者のクライアントでの読み取りは 1 回だけ (generated_data の二次クエリは無い)
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('stale だが snapshot がない場合は復元を呼ばず response に restore を含めない', async () => {
    selectResultQueue.push({ data: requestRow({ status: 'pending', updated_at: ago(STALE_MINUTES), progress: null }), error: null });
    updateResultQueue.push({ data: [{ id: REQUEST_ID, generated_data: null }], error: null });

    const res = await GET(makeRequest(REQUEST_ID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('failed');
    expect(json.restore).toBeUndefined();
    expect(mockRestoreOwnPlannedMealsSnapshot).not.toHaveBeenCalled();
    expect(filterOf(updateCalls[0], 'status')).toEqual([['eq', 'status', 'pending']]);
  });

  it('stale 判定時の復元が打ち切られないよう maxDuration を明示している (#1203)', () => {
    expect(maxDuration).toBe(60);
  });
});

describe('GET /api/ai/menu/weekly/status: 止まりの判定は cleanup と同じ生存信号と比較つきの更新 (#1507)', () => {
  it('claim_menu_request が取り直した直後 (worker_acquired_at が新しく updated_at が古い) の行は failed にしない', async () => {
    // 20 分を超えて順番待ちした queued の行を cron が processing にした直後。Edge Function はまだ進捗を書いていない
    selectResultQueue.push({
      data: requestRow({ created_at: ago(STALE_MINUTES + 5), updated_at: ago(STALE_MINUTES), worker_acquired_at: ago(JUST_NOW_MINUTES), progress: null }),
      error: null,
    });

    const json = await (await GET(makeRequest(REQUEST_ID))).json();

    expect(json.status).toBe('processing');
    expect(json.errorMessage).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRestoreOwnPlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('worker_acquired_at も updated_at もしきい値より古い行は止まった行として failed にする (worker_acquired_at も比較の条件に入れる)', async () => {
    const workerAcquiredAt = ago(STALE_MINUTES);
    const updatedAt = ago(STALE_MINUTES + 5);
    selectResultQueue.push({ data: requestRow({ updated_at: updatedAt, worker_acquired_at: workerAcquiredAt }), error: null });
    updateResultQueue.push({ data: [{ id: REQUEST_ID, generated_data: null }], error: null });

    const json = await (await GET(makeRequest(REQUEST_ID))).json();

    expect(json.status).toBe('failed');
    expect(filterOf(updateCalls[0], 'updated_at')).toEqual([['eq', 'updated_at', updatedAt]]);
    expect(filterOf(updateCalls[0], 'worker_acquired_at')).toEqual([['eq', 'worker_acquired_at', workerAcquiredAt]]);
  });

  it('読んでから書くまでに進んだ行 (比較つきの更新が 0 行) は failed と返さず、復元もしない', async () => {
    selectResultQueue.push({ data: requestRow({ updated_at: ago(STALE_MINUTES) }), error: null });
    // 更新までのあいだに Edge Function が進捗を書いた: 読んだときの updated_at と一致する行が無い
    updateResultQueue.push({ data: [], error: null });

    const json = await (await GET(makeRequest(REQUEST_ID))).json();

    expect(updateCalls).toHaveLength(1);
    expect(json.status).toBe('processing');
    expect(json.errorMessage).toBeNull();
    expect(json.restore).toBeUndefined();
    expect(mockRestoreOwnPlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('failed への更新が拒まれたときは failed と返さず、復元もしない (行は書き換わっていない。次のポーリングでやり直す)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    selectResultQueue.push({ data: requestRow({ updated_at: ago(STALE_MINUTES) }), error: null });
    updateResultQueue.push({ data: null, error: { message: 'update rejected' } });

    const res = await GET(makeRequest(REQUEST_ID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('processing');
    expect(mockRestoreOwnPlannedMealsSnapshot).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('時刻が読めない行 (created_at・updated_at・worker_acquired_at のどれも読めない) は止まったと見なさない', async () => {
    selectResultQueue.push({ data: requestRow({ created_at: null, updated_at: null, worker_acquired_at: null }), error: null });

    const json = await (await GET(makeRequest(REQUEST_ID))).json();

    expect(json.status).toBe('processing');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('updated_at が無い行は created_at で判定する (しきい値を超えていれば failed にし、updated_at は NULL で比べる)', async () => {
    selectResultQueue.push({
      data: requestRow({ status: 'pending', created_at: ago(STALE_MINUTES), updated_at: null, worker_acquired_at: null }),
      error: null,
    });
    updateResultQueue.push({ data: [{ id: REQUEST_ID, generated_data: null }], error: null });

    const json = await (await GET(makeRequest(REQUEST_ID))).json();

    expect(json.status).toBe('failed');
    expect(filterOf(updateCalls[0], 'updated_at')).toEqual([['is', 'updated_at', null]]);
  });

  it('queued の行は、作成からどれだけたっていても止まったと見なさない (cron の順番待ち)', async () => {
    selectResultQueue.push({
      data: requestRow({ status: 'queued', created_at: ago(24 * 60), updated_at: ago(24 * 60), worker_acquired_at: null }),
      error: null,
    });

    const json = await (await GET(makeRequest(REQUEST_ID))).json();

    expect(json.status).toBe('queued');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// #1172: 行の error_message には、この変更より前に書かれた行や Edge Function が自分で書いた行の、
// 生のエラー文 (DB・例外・Edge Function の応答の本文) が入っていることがある。画面はこの応答の文をそのまま出すので、
// こちらで書いた文 (同意・stale・中止) だけをそのまま返し、それ以外は固定の文にする
describe('GET /api/ai/menu/weekly/status: 失敗の文 (#1172)', () => {
  function failedRow(errorMessage: string | null) {
    return {
      id: REQUEST_ID,
      status: 'failed',
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
      mode: 'v4',
      start_date: '2026-07-06',
      target_meal_id: null,
      progress: null,
    };
  }

  it.each([
    ['DB (PostgREST) の生のエラー文', 'new row violates row-level security policy for table "weekly_menus"'],
    [
      'Next.js が書いていた Edge Function の失敗の文 (状態コードと本文)',
      'generate-menu-v4 failed after 3/3 attempts: status 500, body={"error":"relation \\"planned_meals\\" does not exist"}',
    ],
    ['cron が書いていた Edge Function の失敗の文', 'V5 returned 500: {"error":"duplicate key value violates unique constraint"}'],
    ['Edge Function が自分で書く例外の文面', 'TypeError: Cannot read properties of undefined (reading \'dishes\')'],
  ])('%s は返さず、固定の文を返す (errorMessage / error_message の両方)', async (_label, stored) => {
    selectResultQueue.push({ data: failedRow(stored), error: null });

    const res = await GET(makeRequest(REQUEST_ID));
    const text = await res.text();
    const json = JSON.parse(text);

    expect(res.status).toBe(200);
    expect(json.status).toBe('failed');
    expect(json.errorMessage).toBe(WEEKLY_MENU_REQUEST_FAILED_MESSAGE);
    expect(json.error_message).toBe(WEEKLY_MENU_REQUEST_FAILED_MESSAGE);
    expect(text).not.toContain(stored);
  });

  it.each([
    ['同意が無くて止めた文', AI_CONSENT_REQUIRED_MESSAGE],
    ['同意の状況を読めなくて止めた文', AI_CONSENT_CHECK_FAILED_MESSAGE],
    ['中止の文', '中止しました'],
    ['固定の文', WEEKLY_MENU_REQUEST_FAILED_MESSAGE],
  ])('こちらで書いた文 (%s) は、画面が見分けられるようそのまま返す', async (_label, stored) => {
    selectResultQueue.push({ data: failedRow(stored), error: null });

    const json = await (await GET(makeRequest(REQUEST_ID))).json();

    expect(json.errorMessage).toBe(stored);
    expect(json.error_message).toBe(stored);
  });

  // #1576: 進まなくなった行の英語の印は、利用者に英語のまま出さない
  it('行の error_message が進まなくなった行の印なら、日本語の文にして返す (#1576)', async () => {
    selectResultQueue.push({ data: failedRow('stale_request_timeout'), error: null });

    const json = await (await GET(makeRequest(REQUEST_ID))).json();

    expect(json.errorMessage).toBe(WEEKLY_MENU_REQUEST_STALE_DISPLAY_MESSAGE);
    expect(json.error_message).toBe(WEEKLY_MENU_REQUEST_STALE_DISPLAY_MESSAGE);
  });

  it('error_message が空 (null) なら null のまま返す (画面は自分の既定の文を出す)', async () => {
    selectResultQueue.push({ data: failedRow(null), error: null });

    const json = await (await GET(makeRequest(REQUEST_ID))).json();

    expect(json.errorMessage).toBeNull();
    expect(json.error_message).toBeNull();
  });
});
