/**
 * src/__tests__/api/ai/menu/weekly-cleanup.test.ts
 *
 * #1042: stale sweeper (weekly/cleanup) が waitUntil 消失等で生成コールバックが
 * 実行されず stuck になったリクエストを failed 化するだけで、削除済み献立の
 * スナップショット (generated_data.snapshot) を復元しない問題の修正確認。
 *
 * - stuck リクエストが無い場合は復元を呼ばないこと
 * - stuck リクエストのうち snapshot を持つものだけ復元し、結果を集計して response に含めること
 * - failed への更新自体が失敗した場合は復元を呼ばず 500 を返すこと
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();

const fetchResultQueue: Array<{ data: any; error: any }> = [];
const mockLt = vi.fn(() => Promise.resolve(fetchResultQueue.shift() ?? { data: [], error: null }));
const mockSelectIn = vi.fn(() => ({ lt: mockLt }));
const mockSelectEq = vi.fn(() => ({ in: mockSelectIn }));
const mockSelect = vi.fn(() => ({ eq: mockSelectEq }));

const updateResultQueue: Array<{ error: any }> = [];
const mockUpdateIn = vi.fn(() => Promise.resolve(updateResultQueue.shift() ?? { error: null }));
const mockUpdate = vi.fn(() => ({ in: mockUpdateIn }));

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

const { POST } = await import('@/app/api/ai/menu/weekly/cleanup/route');

const user = { id: 'user-1' };

beforeEach(() => {
  vi.clearAllMocks();
  fetchResultQueue.length = 0;
  updateResultQueue.length = 0;
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
});

describe('POST /api/ai/menu/weekly/cleanup', () => {
  it('stuck リクエストが無い場合は復元を呼ばず No stuck requests found を返す', async () => {
    fetchResultQueue.push({ data: [], error: null });

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.message).toBe('No stuck requests found');
    expect(json.cleaned).toBe(0);
    expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('snapshot を持つ stuck リクエストのみ復元し、結果を集計して返す', async () => {
    const snapshotRowA = { id: 'meal-a', daily_meal_id: 'day-a', meal_type: 'breakfast' };
    fetchResultQueue.push({
      data: [
        { id: 'req-1', status: 'processing', created_at: '2026-07-06T00:00:00Z', generated_data: { snapshot: [snapshotRowA] } },
        { id: 'req-2', status: 'pending', created_at: '2026-07-06T00:00:00Z', generated_data: null },
      ],
      error: null,
    });
    updateResultQueue.push({ error: null });
    mockRestorePlannedMealsSnapshot.mockResolvedValueOnce({ restored: 1, skipped: 0, failed: 0 });

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.cleaned).toBe(2);
    expect(json.ids).toEqual(['req-1', 'req-2']);
    expect(json.restoredMeals).toBe(1);
    expect(json.skippedMeals).toBe(0);
    expect(json.failedMeals).toBe(0);

    // snapshot を持つ req-1 分のみ復元が呼ばれる
    expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledTimes(1);
    expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledWith(mockSupabase, [snapshotRowA]);

    // failed への一括更新が呼ばれていること
    expect(mockUpdateIn).toHaveBeenCalledWith('id', ['req-1', 'req-2']);
  });

  it('failed への更新自体が失敗した場合は復元を呼ばず 500 を返す', async () => {
    fetchResultQueue.push({
      data: [{ id: 'req-1', status: 'processing', created_at: '2026-07-06T00:00:00Z', generated_data: { snapshot: [{ id: 'm', daily_meal_id: 'd', meal_type: 'lunch' }] } }],
      error: null,
    });
    updateResultQueue.push({ error: { message: 'update failed' } });

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('update failed');
    expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
  });
});
