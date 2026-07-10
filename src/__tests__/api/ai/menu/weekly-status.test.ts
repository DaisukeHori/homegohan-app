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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();

const selectResultQueue: Array<{ data: any; error: any }> = [];
const mockMaybeSingle = vi.fn(() => Promise.resolve(selectResultQueue.shift() ?? { data: null, error: null }));
const mockSelectEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelectEq1 = vi.fn(() => ({ eq: mockSelectEq2 }));
const mockSelect = vi.fn(() => ({ eq: mockSelectEq1 }));

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

const { GET } = await import('@/app/api/ai/menu/weekly/status/route');

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
        generated_data: { snapshot: [] },
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
        generated_data: { snapshot: [snapshotRow] },
      },
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
        generated_data: null,
      },
      error: null,
    });

    const res = await GET(makeRequest('req-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('failed');
    expect(json.restore).toBeUndefined();
    expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
  });
});
