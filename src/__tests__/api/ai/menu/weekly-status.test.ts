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
 * generated_data(jsonb) を外し、stale 判定成立時のみ二次クエリで取得することの確認。
 * - 非 stale ポーリングでは generated_data を select しないこと
 * - stale 判定成立時は generated_data のみを対象にした二次クエリを発行すること
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();

const selectResultQueue: Array<{ data: any; error: any }> = [];
const mockMaybeSingle = vi.fn(() => Promise.resolve(selectResultQueue.shift() ?? { data: null, error: null }));
const mockSelectEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelectEq1 = vi.fn(() => ({ eq: mockSelectEq2 }));
const mockSelect = vi.fn((..._args: any[]) => ({ eq: mockSelectEq1 }));

const updateEqQueue: Array<{ error: any }> = [];
const mockUpdateEq2 = vi.fn(() => Promise.resolve(updateEqQueue.shift() ?? { error: null }));
const mockUpdateEq1 = vi.fn(() => ({ eq: mockUpdateEq2 }));
const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq1 }));

const mockFrom = vi.fn((table: string) => {
  if (table === 'weekly_menu_requests') {
    return { select: mockSelect, update: mockUpdate };
  }
  throw new Error(`Unexpected table in test: ${table}`);
});

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => mockSupabase),
}));

const mockRestorePlannedMealsSnapshot = vi.fn(async (..._args: any[]) => ({ restored: 0, skipped: 0, failed: 0 }));
vi.mock('@/lib/planned-meals-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planned-meals-snapshot')>();
  return {
    ...actual,
    restorePlannedMealsSnapshot: mockRestorePlannedMealsSnapshot,
  };
});

const { GET, maxDuration } = await import('@/app/api/ai/menu/weekly/status/route');
const { AI_CONSENT_REQUIRED_MESSAGE, AI_CONSENT_CHECK_FAILED_MESSAGE } = await import('../../../../../supabase/functions/_shared/ai-consent');
const { WEEKLY_MENU_REQUEST_FAILED_MESSAGE } = await import('@/lib/weekly-menu-request-error');

const user = { id: 'user-1' };

const makeRequest = (requestId: string) =>
  new Request(`http://localhost/api/ai/menu/weekly/status?requestId=${requestId}`);

beforeEach(() => {
  vi.clearAllMocks();
  selectResultQueue.length = 0;
  updateEqQueue.length = 0;
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
});

describe('GET /api/ai/menu/weekly/status', () => {
  it('stale でない processing リクエストはそのまま状態を返す(復元は呼ばない)', async () => {
    selectResultQueue.push({
      data: {
        id: 'req-1',
        status: 'processing',
        error_message: null,
        updated_at: new Date().toISOString(),
        mode: 'v4',
        start_date: '2026-07-06',
        target_meal_id: null,
        progress: 5,
      },
      error: null,
    });

    const res = await GET(makeRequest('req-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('processing');
    expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('非 stale ポーリングでは generated_data を select しない(二次クエリも発行しない)', async () => {
    selectResultQueue.push({
      data: {
        id: 'req-1',
        status: 'processing',
        error_message: null,
        updated_at: new Date().toISOString(),
        mode: 'v4',
        start_date: '2026-07-06',
        target_meal_id: null,
        progress: 5,
      },
      error: null,
    });

    await GET(makeRequest('req-1'));

    // 通常ポーリングでの select は1回のみで、generated_data を含まないこと
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSelect.mock.calls[0][0]).not.toContain('generated_data');
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('stale な processing リクエストは failed 化し、snapshot があれば復元して response に反映する', async () => {
    const snapshotRow = { id: 'meal-1', daily_meal_id: 'day-1', meal_type: 'breakfast' };
    const staleDate = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    selectResultQueue.push({
      data: {
        id: 'req-1',
        status: 'processing',
        error_message: null,
        updated_at: staleDate,
        mode: 'v4',
        start_date: '2026-07-06',
        target_meal_id: null,
        progress: 5,
      },
      error: null,
    });
    // stale 判定成立後に発行される generated_data 専用の二次クエリの結果
    selectResultQueue.push({
      data: { generated_data: { snapshot: [snapshotRow] } },
      error: null,
    });
    mockRestorePlannedMealsSnapshot.mockResolvedValueOnce({ restored: 1, skipped: 0, failed: 0 });

    const res = await GET(makeRequest('req-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('failed');
    expect(json.errorMessage).toBe('stale_request_timeout');
    expect(json.restore).toEqual({ restored: 1, skipped: 0, failed: 0 });

    expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledTimes(1);
    expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledWith(mockSupabase, [snapshotRow]);

    // stale リクエストを failed に更新する呼び出しが行われていること
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error_message: 'stale_request_timeout' }),
    );

    // stale 判定成立時のみ generated_data 専用の二次クエリが発行されること
    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(mockSelect.mock.calls[0][0]).not.toContain('generated_data');
    expect(mockSelect.mock.calls[1][0]).toContain('generated_data');
  });

  it('stale だが snapshot がない場合は復元を呼ばず response に restore を含めない', async () => {
    const staleDate = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    selectResultQueue.push({
      data: {
        id: 'req-1',
        status: 'pending',
        error_message: null,
        updated_at: staleDate,
        mode: 'v4',
        start_date: '2026-07-06',
        target_meal_id: null,
        progress: null,
      },
      error: null,
    });
    // stale 判定成立後に発行される generated_data 専用の二次クエリの結果(snapshot なし)
    selectResultQueue.push({
      data: { generated_data: null },
      error: null,
    });

    const res = await GET(makeRequest('req-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('failed');
    expect(json.restore).toBeUndefined();
    expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('stale 判定時の復元が打ち切られないよう maxDuration を明示している (#1203)', () => {
    expect(maxDuration).toBe(60);
  });
});

// #1172: 行の error_message には、この変更より前に書かれた行や Edge Function が自分で書いた行の、
// 生のエラー文 (DB・例外・Edge Function の応答の本文) が入っていることがある。画面はこの応答の文をそのまま出すので、
// こちらで書いた文 (同意・stale・中止) だけをそのまま返し、それ以外は固定の文にする
describe('GET /api/ai/menu/weekly/status: 失敗の文 (#1172)', () => {
  function failedRow(errorMessage: string | null) {
    return {
      id: 'req-1',
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

    const res = await GET(makeRequest('req-1'));
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
    ['進まなくなった行の文', 'stale_request_timeout'],
    ['中止の文', '中止しました'],
    ['固定の文', WEEKLY_MENU_REQUEST_FAILED_MESSAGE],
  ])('こちらで書いた文 (%s) は、画面が見分けられるようそのまま返す', async (_label, stored) => {
    selectResultQueue.push({ data: failedRow(stored), error: null });

    const json = await (await GET(makeRequest('req-1'))).json();

    expect(json.errorMessage).toBe(stored);
    expect(json.error_message).toBe(stored);
  });

  it('error_message が空 (null) なら null のまま返す (画面は自分の既定の文を出す)', async () => {
    selectResultQueue.push({ data: failedRow(null), error: null });

    const json = await (await GET(makeRequest('req-1'))).json();

    expect(json.errorMessage).toBeNull();
    expect(json.error_message).toBeNull();
  });
});
