/**
 * src/__tests__/lib/planned-meals-snapshot.test.ts
 *
 * #1042: 破壊的な献立操作 (削除→再生成) のデータ消失防止。
 * restorePlannedMealsSnapshot の失敗注入テスト:
 * - 生成失敗時、削除前スナップショットから旧データが復元されること
 * - 既に新しいデータが書き込まれているスロットは上書きしない(スキップ)こと
 * - 復元自体が失敗した行は failed としてカウントされ、他の行の復元を止めないこと
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { restorePlannedMealsSnapshot, type PlannedMealSnapshotRow } from '@/lib/planned-meals-snapshot';

type LookupResult = { data: { id: string } | null; error: { message: string } | null };

function buildMockSupabase(params: {
  lookupResults: LookupResult[];
  insertResults?: Array<{ error: { message: string } | null }>;
}) {
  const lookupQueue = [...params.lookupResults];
  const insertQueue = [...(params.insertResults ?? [])];

  const mockMaybeSingle = vi.fn(() => Promise.resolve(lookupQueue.shift() ?? { data: null, error: null }));
  const mockEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
  const mockEq1 = vi.fn(() => ({ eq: mockEq2 }));
  const mockSelect = vi.fn(() => ({ eq: mockEq1 }));

  const mockInsert = vi.fn(() => Promise.resolve(insertQueue.shift() ?? { error: null }));

  const mockFrom = vi.fn(() => ({
    select: mockSelect,
    insert: mockInsert,
  }));

  return {
    supabase: { from: mockFrom } as any,
    mockFrom,
    mockSelect,
    mockEq1,
    mockEq2,
    mockMaybeSingle,
    mockInsert,
  };
}

const makeRow = (overrides: Partial<PlannedMealSnapshotRow> = {}): PlannedMealSnapshotRow => ({
  id: 'meal-1',
  daily_meal_id: 'day-1',
  meal_type: 'breakfast',
  dish_name: '元の朝食',
  ...overrides,
});

describe('restorePlannedMealsSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('スロットが空いていれば旧データを復元する (restored++)', async () => {
    const snapshot = [makeRow()];
    const { supabase, mockInsert } = buildMockSupabase({
      lookupResults: [{ data: null, error: null }], // 既存データなし = 空きスロット
      insertResults: [{ error: null }],
    });

    const result = await restorePlannedMealsSnapshot(supabase, snapshot);

    expect(result).toEqual({ restored: 1, skipped: 0, failed: 0 });
    expect(mockInsert).toHaveBeenCalledWith(snapshot[0]);
  });

  it('生成処理が部分的に成功し既にスロットが埋まっていれば上書きせずスキップする (他者による更新の検知)', async () => {
    const snapshot = [makeRow({ id: 'meal-old' })];
    const { supabase, mockInsert } = buildMockSupabase({
      lookupResults: [{ data: { id: 'meal-new' }, error: null }], // 既に新しいデータが書き込み済み
    });

    const result = await restorePlannedMealsSnapshot(supabase, snapshot);

    expect(result).toEqual({ restored: 0, skipped: 1, failed: 0 });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('復元insertが失敗した行は failed としてカウントし、他の行は継続処理する', async () => {
    const snapshot = [makeRow({ id: 'meal-1', meal_type: 'breakfast' }), makeRow({ id: 'meal-2', meal_type: 'lunch' })];
    const { supabase, mockInsert } = buildMockSupabase({
      lookupResults: [
        { data: null, error: null },
        { data: null, error: null },
      ],
      insertResults: [{ error: { message: 'insert failed' } }, { error: null }],
    });

    const result = await restorePlannedMealsSnapshot(supabase, snapshot);

    expect(result).toEqual({ restored: 1, skipped: 0, failed: 1 });
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  it('スロット確認(lookup)自体が失敗した行は failed としてカウントし、insertは行わない', async () => {
    const snapshot = [makeRow()];
    const { supabase, mockInsert } = buildMockSupabase({
      lookupResults: [{ data: null, error: { message: 'lookup failed' } }],
    });

    const result = await restorePlannedMealsSnapshot(supabase, snapshot);

    expect(result).toEqual({ restored: 0, skipped: 0, failed: 1 });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('daily_meal_id / meal_type を欠いた行は failed としてカウントしクエリを発行しない', async () => {
    const snapshot = [{ id: 'broken', daily_meal_id: '', meal_type: '' } as PlannedMealSnapshotRow];
    const { supabase, mockFrom } = buildMockSupabase({ lookupResults: [] });

    const result = await restorePlannedMealsSnapshot(supabase, snapshot);

    expect(result).toEqual({ restored: 0, skipped: 0, failed: 1 });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('複数行を混在で処理し、restored/skipped/failed を正しく集計する', async () => {
    const snapshot = [
      makeRow({ id: 'meal-1', meal_type: 'breakfast' }),
      makeRow({ id: 'meal-2', meal_type: 'lunch' }),
      makeRow({ id: 'meal-3', meal_type: 'dinner' }),
    ];
    const { supabase } = buildMockSupabase({
      lookupResults: [
        { data: null, error: null }, // breakfast: 空き -> restore
        { data: { id: 'meal-new' }, error: null }, // lunch: 既に埋まっている -> skip
        { data: null, error: null }, // dinner: 空きだが insert 失敗 -> failed
      ],
      insertResults: [{ error: null }, { error: { message: 'insert failed' } }],
    });

    const result = await restorePlannedMealsSnapshot(supabase, snapshot);

    expect(result).toEqual({ restored: 1, skipped: 1, failed: 1 });
  });

  it('空のスナップショットは何もせず全て0を返す', async () => {
    const { supabase, mockFrom } = buildMockSupabase({ lookupResults: [] });
    const result = await restorePlannedMealsSnapshot(supabase, []);
    expect(result).toEqual({ restored: 0, skipped: 0, failed: 0 });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
