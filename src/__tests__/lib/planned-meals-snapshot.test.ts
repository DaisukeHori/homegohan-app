/**
 * src/__tests__/lib/planned-meals-snapshot.test.ts
 *
 * #1042: 破壊的な献立操作 (削除→再生成) のデータ消失防止。
 * restorePlannedMealsSnapshot の失敗注入テスト:
 * - 生成失敗時、削除前スナップショットから旧データが復元されること
 * - 既に新しいデータが書き込まれているスロットは上書きしない(スキップ)こと
 * - 復元自体が失敗した行は failed としてカウントされ、他の行の復元を止めないこと
 *
 * #1203: 行ごとの「空きスロット確認 SELECT → INSERT」直列 await を、
 * .in() 一括 SELECT + bulk insert に置き換えた。追加の確認事項:
 * - DB 往復が行数に依存しないこと (SELECT 1 回 + INSERT 1 回)
 * - 検証 NG 行 / lookup 失敗 / bulk insert 失敗 (→ 行単位フォールバック) で
 *   restored / skipped / failed の行単位の集計が保たれること
 * - 同一スロットに複数行あるケースが壊れないこと
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  restorePlannedMealsSnapshot,
  extractPlannedMealsSnapshot,
  SLOT_LOOKUP_CHUNK_SIZE,
  type PlannedMealSnapshotRow,
} from '@/lib/planned-meals-snapshot';

type StoredRow = { id: string; daily_meal_id: string; meal_type: string };

/**
 * planned_meals を最小限に再現したインメモリの Supabase モック。
 *
 * - select('daily_meal_id, meal_type').in(...) は、保持している行から該当 daily_meal_id の行を返す
 * - insert(...) は配列 (bulk) / 単発のどちらも受け付け、成功すれば保持している行に追加する
 * - Postgres の INSERT は 1 文として all-or-nothing なので、reject 対象の id を 1 つでも含む
 *   insert は (bulk / 単発を問わず) 文ごと失敗し、1 行も追加されない
 */
function buildFakeSupabase(
  params: {
    /** 復元前から入っている行 (= 生成処理が先に書き込んだスロット) */
    existing?: StoredRow[];
    /** これを含む .in() の問い合わせは丸ごと失敗する */
    lookupFailDailyMealIds?: string[];
    /** この id を含む insert は文ごと失敗する */
    rejectInsertIds?: string[];
  } = {},
) {
  const table: StoredRow[] = [...(params.existing ?? [])];
  const lookupFailIds = new Set(params.lookupFailDailyMealIds ?? []);
  const rejectIds = new Set(params.rejectInsertIds ?? []);

  const mockIn = vi.fn(async (_column: string, values: string[]) => {
    if (values.some((value) => lookupFailIds.has(value))) {
      return { data: null, error: { message: 'lookup failed' } };
    }
    const data = table
      .filter((row) => values.includes(row.daily_meal_id))
      .map((row) => ({ daily_meal_id: row.daily_meal_id, meal_type: row.meal_type }));
    return { data, error: null };
  });
  const mockSelect = vi.fn((_columns: string) => ({ in: mockIn }));

  const mockInsert = vi.fn(async (payload: StoredRow | StoredRow[]) => {
    const rows = Array.isArray(payload) ? payload : [payload];
    if (rows.some((row) => rejectIds.has(row.id))) {
      return { error: { message: 'insert failed' } };
    }
    table.push(...rows);
    return { error: null };
  });

  const mockFrom = vi.fn((_table: string) => ({ select: mockSelect, insert: mockInsert }));

  return {
    supabase: { from: mockFrom } as any,
    table,
    mockFrom,
    mockSelect,
    mockIn,
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

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'] as const;

// days 日分 × 3 食のスナップショット (週間生成のスナップショットと同じ形)
const makeWeekSnapshot = (days: number): PlannedMealSnapshotRow[] =>
  Array.from({ length: days }, (_, dayIndex) =>
    MEAL_TYPES.map((mealType) =>
      makeRow({
        id: `meal-${dayIndex + 1}-${mealType}`,
        daily_meal_id: `day-${dayIndex + 1}`,
        meal_type: mealType,
      }),
    ),
  ).flat();

describe('restorePlannedMealsSnapshot', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // 失敗系のテストで console.error が大量に出力されるのを抑える (呼ばれたことは個別に検証する)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('スロットが空いていれば旧データを復元する (restored++)', async () => {
    const snapshot = [makeRow()];
    const { supabase, mockInsert, table } = buildFakeSupabase();

    const result = await restorePlannedMealsSnapshot(supabase, snapshot);

    expect(result).toEqual({ restored: 1, skipped: 0, failed: 0 });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(snapshot);
    expect(table.map((row) => row.id)).toEqual(['meal-1']);
  });

  it('生成処理が部分的に成功し既にスロットが埋まっていれば上書きせずスキップする (他者による更新の検知)', async () => {
    const snapshot = [makeRow({ id: 'meal-old' })];
    const { supabase, mockInsert, table } = buildFakeSupabase({
      existing: [{ id: 'meal-new', daily_meal_id: 'day-1', meal_type: 'breakfast' }], // 既に新しいデータが書き込み済み
    });

    const result = await restorePlannedMealsSnapshot(supabase, snapshot);

    expect(result).toEqual({ restored: 0, skipped: 1, failed: 0 });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(table.map((row) => row.id)).toEqual(['meal-new']);
  });

  describe('DB 往復回数 (#1203)', () => {
    // 行数 (3 / 21 / 42) が増えても from() の呼び出しは SELECT 1 回 + INSERT 1 回の 2 回で一定
    it.each([1, 7, 14])('%i 日分 (×3 食) でも SELECT 1 回 + bulk INSERT 1 回で復元する', async (days) => {
      const snapshot = makeWeekSnapshot(days);
      const { supabase, mockFrom, mockSelect, mockIn, mockInsert, table } = buildFakeSupabase();

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: days * 3, skipped: 0, failed: 0 });
      expect(mockFrom).toHaveBeenCalledTimes(2);
      expect(mockFrom.mock.calls.every(([name]) => name === 'planned_meals')).toBe(true);
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(mockSelect).toHaveBeenCalledWith('daily_meal_id, meal_type');
      expect(mockIn).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledTimes(1);
      // bulk insert には全行が 1 回の配列で渡される
      expect(mockInsert).toHaveBeenCalledWith(snapshot);
      expect(table).toHaveLength(days * 3);
    });

    it('daily_meal_id は重複排除して 1 回の .in() に渡す', async () => {
      const snapshot = makeWeekSnapshot(2); // day-1 x3 + day-2 x3
      const { supabase, mockIn } = buildFakeSupabase();

      await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(mockIn).toHaveBeenCalledTimes(1);
      expect(mockIn).toHaveBeenCalledWith('daily_meal_id', ['day-1', 'day-2']);
    });

    it('daily_meal_id が多いときは .in() を上限ごとに分割して問い合わせる', async () => {
      const dayCount = SLOT_LOOKUP_CHUNK_SIZE * 2 + 1;
      const snapshot = Array.from({ length: dayCount }, (_, i) =>
        makeRow({ id: `meal-${i}`, daily_meal_id: `day-${i}`, meal_type: 'dinner' }),
      );
      const { supabase, mockIn, mockInsert } = buildFakeSupabase();

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: dayCount, skipped: 0, failed: 0 });
      expect(mockIn).toHaveBeenCalledTimes(3);
      const queriedIds = mockIn.mock.calls.flatMap(([, values]) => values);
      for (const [, values] of mockIn.mock.calls) {
        expect(values.length).toBeLessThanOrEqual(SLOT_LOOKUP_CHUNK_SIZE);
      }
      expect([...queriedIds].sort()).toEqual(snapshot.map((row) => row.daily_meal_id).sort());
      // 分割するのは SELECT だけで、書き戻しは 1 回の bulk insert のまま
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('スロットの埋まり具合', () => {
    it('埋まっているスロットだけスキップし、空きスロットの行だけを bulk insert する', async () => {
      const snapshot = [
        makeRow({ id: 'meal-1', meal_type: 'breakfast' }),
        makeRow({ id: 'meal-2', meal_type: 'lunch' }),
        makeRow({ id: 'meal-3', meal_type: 'dinner' }),
      ];
      const { supabase, mockInsert, table } = buildFakeSupabase({
        existing: [{ id: 'meal-new', daily_meal_id: 'day-1', meal_type: 'lunch' }],
      });

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: 2, skipped: 1, failed: 0 });
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledWith([snapshot[0], snapshot[2]]);
      expect(table.map((row) => row.id).sort()).toEqual(['meal-1', 'meal-3', 'meal-new']);
    });

    it('別の日の同じ meal_type が埋まっていても、その日のスロットは空きとして復元する', async () => {
      const snapshot = [
        makeRow({ id: 'meal-d1', daily_meal_id: 'day-1', meal_type: 'dinner' }),
        makeRow({ id: 'meal-d2', daily_meal_id: 'day-2', meal_type: 'dinner' }),
      ];
      const { supabase } = buildFakeSupabase({
        existing: [{ id: 'meal-new', daily_meal_id: 'day-2', meal_type: 'dinner' }],
      });

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: 1, skipped: 1, failed: 0 });
    });

    it('同一スロットに複数行あるスナップショットは、スロットが空なら全行を復元する', async () => {
      const snapshot = [
        makeRow({ id: 'snack-1', meal_type: 'snack' }),
        makeRow({ id: 'snack-2', meal_type: 'snack' }),
        makeRow({ id: 'meal-1', meal_type: 'breakfast' }),
      ];
      const { supabase, mockInsert, table } = buildFakeSupabase();

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      // 1 行目の復元で埋まったスロットを 2 行目が「埋まっている」と誤判定して取りこぼさない
      expect(result).toEqual({ restored: 3, skipped: 0, failed: 0 });
      expect(mockInsert).toHaveBeenCalledWith(snapshot);
      expect(table.map((row) => row.id).sort()).toEqual(['meal-1', 'snack-1', 'snack-2']);
    });

    it('復元先のスロットに既に複数行あっても failed にならず skipped になる', async () => {
      // 以前の .maybeSingle() は複数行ヒットでエラーになり、その行が failed 扱いで復元もされなかった
      const snapshot = [makeRow({ id: 'snack-old', meal_type: 'snack' })];
      const { supabase, mockInsert } = buildFakeSupabase({
        existing: [
          { id: 'snack-new-1', daily_meal_id: 'day-1', meal_type: 'snack' },
          { id: 'snack-new-2', daily_meal_id: 'day-1', meal_type: 'snack' },
        ],
      });

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: 0, skipped: 1, failed: 0 });
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe('検証 NG の行', () => {
    it('daily_meal_id / meal_type を欠いた行は failed としてカウントしクエリを発行しない', async () => {
      const snapshot = [{ id: 'broken', daily_meal_id: '', meal_type: '' } as PlannedMealSnapshotRow];
      const { supabase, mockFrom } = buildFakeSupabase();

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: 0, skipped: 0, failed: 1 });
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('検証 NG の行が混ざっていても、正常な行だけを問い合わせ・復元する', async () => {
      const valid = makeRow({ id: 'meal-ok', daily_meal_id: 'day-1', meal_type: 'dinner' });
      const snapshot = [
        { id: 'broken-1', daily_meal_id: '', meal_type: 'lunch' } as PlannedMealSnapshotRow,
        valid,
        { id: 'broken-2', daily_meal_id: 'day-2' } as unknown as PlannedMealSnapshotRow,
        null as unknown as PlannedMealSnapshotRow,
      ];
      const { supabase, mockIn, mockInsert, table } = buildFakeSupabase();

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: 1, skipped: 0, failed: 3 });
      // 検証 NG の行の daily_meal_id ('' / 'day-2') は問い合わせにも書き込みにも含まれない
      expect(mockIn).toHaveBeenCalledWith('daily_meal_id', ['day-1']);
      expect(mockInsert).toHaveBeenCalledWith([valid]);
      expect(table.map((row) => row.id)).toEqual(['meal-ok']);
    });
  });

  describe('スロット確認 (lookup) の失敗', () => {
    it('lookup 自体が失敗した行は failed としてカウントし、insert は行わない', async () => {
      const snapshot = [makeRow()];
      const { supabase, mockInsert } = buildFakeSupabase({ lookupFailDailyMealIds: ['day-1'] });

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: 0, skipped: 0, failed: 1 });
      expect(mockInsert).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('lookup が一部の問い合わせ (分割した 1 つ) だけ失敗しても、成功した分の行は復元する', async () => {
      // day-0 .. day-(CHUNK+4): 先頭の SLOT_LOOKUP_CHUNK_SIZE 件が 1 つ目の問い合わせ、残り 5 件が 2 つ目
      const dayCount = SLOT_LOOKUP_CHUNK_SIZE + 5;
      const snapshot = Array.from({ length: dayCount }, (_, i) =>
        makeRow({ id: `meal-${i}`, daily_meal_id: `day-${i}`, meal_type: 'lunch' }),
      );
      const { supabase, mockInsert, table } = buildFakeSupabase({ lookupFailDailyMealIds: ['day-0'] });

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: 5, skipped: 0, failed: SLOT_LOOKUP_CHUNK_SIZE });
      // 空きかどうか分からない行は書き込まない
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledWith(snapshot.slice(SLOT_LOOKUP_CHUNK_SIZE));
      expect(table).toHaveLength(5);
    });
  });

  describe('復元 insert の失敗', () => {
    it('bulk insert が失敗したら行単位の insert にやり直し、入る行だけ復元する (部分失敗)', async () => {
      const snapshot = [
        makeRow({ id: 'meal-1', meal_type: 'breakfast' }),
        makeRow({ id: 'meal-2', meal_type: 'lunch' }),
        makeRow({ id: 'meal-3', meal_type: 'dinner' }),
      ];
      const { supabase, mockInsert, table } = buildFakeSupabase({ rejectInsertIds: ['meal-2'] });

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: 2, skipped: 0, failed: 1 });
      // bulk 1 回 (失敗) + 行単位 3 回
      expect(mockInsert).toHaveBeenCalledTimes(4);
      expect(mockInsert.mock.calls[0][0]).toEqual(snapshot);
      expect(mockInsert.mock.calls.slice(1).map(([row]) => (row as StoredRow).id)).toEqual([
        'meal-1',
        'meal-2',
        'meal-3',
      ]);
      expect(table.map((row) => row.id)).toEqual(['meal-1', 'meal-3']);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('bulk insert も行単位の insert も全て失敗したら全行 failed としてカウントする', async () => {
      const snapshot = [
        makeRow({ id: 'meal-1', meal_type: 'breakfast' }),
        makeRow({ id: 'meal-2', meal_type: 'lunch' }),
      ];
      const { supabase, mockInsert, table } = buildFakeSupabase({ rejectInsertIds: ['meal-1', 'meal-2'] });

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: 0, skipped: 0, failed: 2 });
      expect(mockInsert).toHaveBeenCalledTimes(3);
      expect(table).toHaveLength(0);
    });

    it('復元insertが失敗した行があっても、他の行の復元は止まらない', async () => {
      const snapshot = [makeRow({ id: 'meal-1', meal_type: 'breakfast' }), makeRow({ id: 'meal-2', meal_type: 'lunch' })];
      const { supabase, table } = buildFakeSupabase({ rejectInsertIds: ['meal-1'] });

      const result = await restorePlannedMealsSnapshot(supabase, snapshot);

      expect(result).toEqual({ restored: 1, skipped: 0, failed: 1 });
      expect(table.map((row) => row.id)).toEqual(['meal-2']);
    });
  });

  it('複数行を混在で処理し、restored/skipped/failed を行単位で正しく集計する', async () => {
    const snapshot = [
      makeRow({ id: 'meal-1', meal_type: 'breakfast' }), // 空き -> restore
      makeRow({ id: 'meal-2', meal_type: 'lunch' }), // 既に埋まっている -> skip
      makeRow({ id: 'meal-3', meal_type: 'dinner' }), // 空きだが insert 失敗 -> failed
      { id: 'meal-4', daily_meal_id: 'day-1', meal_type: '' } as PlannedMealSnapshotRow, // 検証 NG -> failed
    ];
    const { supabase, mockInsert } = buildFakeSupabase({
      existing: [{ id: 'meal-new', daily_meal_id: 'day-1', meal_type: 'lunch' }],
      rejectInsertIds: ['meal-3'],
    });

    const result = await restorePlannedMealsSnapshot(supabase, snapshot);

    expect(result).toEqual({ restored: 1, skipped: 1, failed: 2 });
    // bulk (breakfast + dinner) が失敗 -> 行単位 2 回
    expect(mockInsert).toHaveBeenCalledTimes(3);
  });

  it('空のスナップショットは何もせず全て0を返す', async () => {
    const { supabase, mockFrom } = buildFakeSupabase();
    const result = await restorePlannedMealsSnapshot(supabase, []);
    expect(result).toEqual({ restored: 0, skipped: 0, failed: 0 });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('extractPlannedMealsSnapshot', () => {
  // #1042: sweeper (status/pending/cleanup) が weekly_menu_requests.generated_data
  // から復元用スナップショットを安全に取り出せることを確認する。

  it('request/route.ts が保存する { snapshot: [...] } 形式から配列を取り出す', () => {
    const snapshot = [makeRow()];
    expect(extractPlannedMealsSnapshot({ snapshot })).toEqual(snapshot);
  });

  it('generated_data が null の場合は空配列を返す', () => {
    expect(extractPlannedMealsSnapshot(null)).toEqual([]);
  });

  it('generated_data が snapshot を持たないオブジェクトの場合は空配列を返す', () => {
    expect(extractPlannedMealsSnapshot({ version: 'v4', someOtherField: 1 })).toEqual([]);
  });

  it('snapshot が配列でない場合は空配列を返す', () => {
    expect(extractPlannedMealsSnapshot({ snapshot: 'not-an-array' })).toEqual([]);
  });

  it('id/daily_meal_id/meal_type を欠いた不正な行は除外する', () => {
    const validRow = makeRow({ id: 'valid-1' });
    const invalidRow = { id: 'broken' }; // daily_meal_id / meal_type 欠如
    expect(extractPlannedMealsSnapshot({ snapshot: [validRow, invalidRow] })).toEqual([validRow]);
  });

  it('generated_data がオブジェクトでない場合(文字列・数値等)は空配列を返す', () => {
    expect(extractPlannedMealsSnapshot('unexpected-string')).toEqual([]);
    expect(extractPlannedMealsSnapshot(42)).toEqual([]);
  });
});
