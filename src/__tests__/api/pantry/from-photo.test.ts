/**
 * src/__tests__/api/pantry/from-photo.test.ts
 *
 * #1042 (F1a-15): pantry/from-photo の mode='replace' が「全削除→逐次insert」
 * で部分失敗時に欠損する問題の修正確認（失敗注入テスト）。
 *
 * - replace モードで insert が部分的に失敗した場合、今回挿入した分をロールバックし
 *   削除前の旧データを復元すること（既存データが無傷であること）
 * - 全て成功した場合はロールバックが発生しないこと
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();

const selectEqQueue: Array<{ data: any; error: any }> = [];
const mockPantryItemsSelect = vi.fn(() => ({
  eq: vi.fn(() => Promise.resolve(selectEqQueue.shift() ?? { data: [], error: null })),
}));

const deleteEqQueue: Array<{ error: any }> = [];
const deleteInQueue: Array<{ error: any }> = [];
const mockPantryItemsDelete = vi.fn(() => ({
  eq: vi.fn(() => Promise.resolve(deleteEqQueue.shift() ?? { error: null })),
  in: vi.fn(() => Promise.resolve(deleteInQueue.shift() ?? { error: null })),
}));

const singleInsertQueue: Array<{ data: any; error: any }> = [];
const bulkInsertQueue: Array<{ error: any }> = [];
const mockPantryItemsInsert = vi.fn((payload: unknown) => {
  if (Array.isArray(payload)) {
    return Promise.resolve(bulkInsertQueue.shift() ?? { error: null });
  }
  return {
    select: () => ({
      single: () => Promise.resolve(singleInsertQueue.shift() ?? { data: null, error: null }),
    }),
  };
});

const mockFridgeSnapshotsInsert = vi.fn(() => Promise.resolve({ data: null, error: null }));

const mockFrom = vi.fn((table: string) => {
  if (table === 'pantry_items') {
    return {
      select: mockPantryItemsSelect,
      delete: mockPantryItemsDelete,
      insert: mockPantryItemsInsert,
    };
  }
  if (table === 'fridge_snapshots') {
    return { insert: mockFridgeSnapshotsInsert };
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

const { POST } = await import('@/app/api/pantry/from-photo/route');

const user = { id: 'user-1' };
const previousPantryItems = [
  { id: 'old-1', user_id: 'user-1', name: '既存の卵', category: 'dairy', amount: '6個', expiration_date: null, added_at: '2026-07-01', created_at: null, updated_at: null },
];

const makeRequest = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/pantry/from-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  selectEqQueue.length = 0;
  deleteEqQueue.length = 0;
  deleteInQueue.length = 0;
  singleInsertQueue.length = 0;
  bulkInsertQueue.length = 0;

  mockGetUser.mockResolvedValue({ data: { user }, error: null });
});

describe('POST /api/pantry/from-photo (mode=replace)', () => {
  it('insertが部分的に失敗したら新規分を削除し旧データを復元してロールバックする', async () => {
    selectEqQueue.push({ data: previousPantryItems, error: null }); // 削除前スナップショット
    deleteEqQueue.push({ error: null }); // 全削除 成功
    singleInsertQueue.push({ data: { id: 'new-1', name: 'にんじん' }, error: null }); // 1件目 成功
    singleInsertQueue.push({ data: null, error: { message: 'insert failed' } }); // 2件目 失敗
    deleteInQueue.push({ error: null }); // ロールバック削除 成功
    bulkInsertQueue.push({ error: null }); // 旧データ復元 成功

    const res = await POST(
      makeRequest({
        mode: 'replace',
        ingredients: [{ name: 'にんじん' }, { name: 'たまねぎ' }],
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toContain('ロールバック');
    expect(json.results.created).toBe(1);
    expect(json.results.skipped).toBe(1);

    // ロールバック削除: 今回新規挿入した new-1 のみ対象
    expect(mockPantryItemsDelete).toHaveBeenCalledTimes(2); // 1回目=全削除, 2回目=ロールバック削除
    const rollbackDeleteCall = mockPantryItemsDelete.mock.results[1].value;
    expect(rollbackDeleteCall.in).toHaveBeenCalledWith('id', ['new-1']);

    // 旧データ復元: スナップショットした previousPantryItems がそのまま insert されること
    const bulkInsertCall = mockPantryItemsInsert.mock.calls.find((call) => Array.isArray(call[0]));
    expect(bulkInsertCall?.[0]).toEqual(previousPantryItems);

    // 失敗時は fridge_snapshots への履歴保存は行わない
    expect(mockFridgeSnapshotsInsert).not.toHaveBeenCalled();
  });

  it('全て成功すればロールバックせず通常のレスポンスを返す', async () => {
    selectEqQueue.push({ data: previousPantryItems, error: null });
    deleteEqQueue.push({ error: null });
    singleInsertQueue.push({ data: { id: 'new-1', name: 'にんじん' }, error: null });
    singleInsertQueue.push({ data: { id: 'new-2', name: 'たまねぎ' }, error: null });

    const res = await POST(
      makeRequest({
        mode: 'replace',
        ingredients: [{ name: 'にんじん' }, { name: 'たまねぎ' }],
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.results.created).toBe(2);
    // ロールバック用の delete().in(...) や 復元 insert(array) は呼ばれない
    const bulkInsertCall = mockPantryItemsInsert.mock.calls.find((call) => Array.isArray(call[0]));
    expect(bulkInsertCall).toBeUndefined();
    expect(mockPantryItemsDelete).toHaveBeenCalledTimes(1); // 全削除のみ
  });
});
