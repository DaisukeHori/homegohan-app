import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * #1042: 破壊的な献立操作 (削除→再生成) のデータ消失防止。
 *
 * 「先に削除→後で書き込み」型の再生成フローでは、生成処理が失敗すると
 * 旧データが復元されないまま消失する。本モジュールは削除前に旧値を
 * スナップショットし、失敗時に安全に復元するためのヘルパーを提供する。
 * （設計基準: 一括書き込みは旧値スナップショット→書き込み→失敗時ロールバック）
 */

// planned_meals の 1 行分（select('*') の結果をそのまま保持する）
export type PlannedMealSnapshotRow = Record<string, unknown> & {
  id: string;
  daily_meal_id: string;
  meal_type: string;
};

export type RestorePlannedMealsResult = {
  restored: number;
  skipped: number;
  failed: number;
};

/**
 * 空きスロット確認 (.in() クエリ) 1 回に含める daily_meal_id の上限。
 *
 * .in() の値は PostgREST への GET の URL に載るため、増えすぎると URL 長の上限に当たる。
 * 週間生成のスナップショットは高々 7 日分 (= 7 件) なので、通常は 1 回の問い合わせで済む。
 */
export const SLOT_LOOKUP_CHUNK_SIZE = 50;

type SlotRow = { daily_meal_id: string; meal_type: string };

/**
 * 指定した daily_meal_id の planned_meals を .in() でまとめて引き、
 * いま埋まっているスロット (daily_meal_id → meal_type の集合) を返す。
 *
 * 問い合わせに失敗した分は failedDailyMealIds に入れる。空きかどうか分からない
 * スロットへ書き込むと上書き・二重登録になりうるため、呼び出し側は書き込まない。
 */
async function fetchOccupiedSlots(
  supabase: Pick<SupabaseClient, 'from'>,
  dailyMealIds: string[],
): Promise<{ occupied: Map<string, Set<string>>; failedDailyMealIds: Set<string> }> {
  const occupied = new Map<string, Set<string>>();
  const failedDailyMealIds = new Set<string>();

  const chunks: string[][] = [];
  for (let i = 0; i < dailyMealIds.length; i += SLOT_LOOKUP_CHUNK_SIZE) {
    chunks.push(dailyMealIds.slice(i, i + SLOT_LOOKUP_CHUNK_SIZE));
  }

  await Promise.all(
    chunks.map(async (ids) => {
      const { data, error } = await supabase
        .from('planned_meals')
        .select('daily_meal_id, meal_type')
        .in('daily_meal_id', ids);

      if (error) {
        console.error(
          `[restorePlannedMealsSnapshot] lookup failed for daily_meals ${ids.join(',')}:`,
          error.message,
        );
        for (const id of ids) failedDailyMealIds.add(id);
        return;
      }

      for (const slot of (data ?? []) as SlotRow[]) {
        let mealTypes = occupied.get(slot.daily_meal_id);
        if (!mealTypes) {
          mealTypes = new Set<string>();
          occupied.set(slot.daily_meal_id, mealTypes);
        }
        mealTypes.add(slot.meal_type);
      }
    }),
  );

  return { occupied, failedDailyMealIds };
}

/**
 * 削除前に退避したスナップショットから planned_meals を復元する。
 *
 * 復元前に同一スロット (daily_meal_id + meal_type) が既に埋まっていないかを
 * 確認し、埋まっていればスキップする（生成処理が部分的に成功して新しい
 * データを書き込んでいた場合に、それを上書きしないため = 他者による更新の検知）。
 *
 * #1203: 以前は 1 行ずつ「空きスロット確認 SELECT → INSERT」を直列に await しており、
 * 最大 (行数 × 2) 回の DB 往復が 1 リクエストに積み上がっていた。
 * 今は次の 3 段で処理し、往復回数を行数に依存させない (通常は SELECT 1 回 + INSERT 1 回)。
 *   1. daily_meal_id / meal_type が欠けた行を弾く (failed。DB へは問い合わせない)
 *   2. 対象の daily_meal_id を重複排除して .in() で 1 回引き、埋まっているスロットを調べる
 *   3. 空きスロットの行だけを 1 回の bulk insert で書き戻す。
 *      bulk insert は 1 行でも失敗すると全行が入らないため、失敗したときだけ
 *      行単位の insert にやり直し、restored / failed を行ごとに数える (集計の粒度は従来どおり)。
 *
 * 同じスロットに複数行あるスナップショット (おやつ等) は、スロットが空なら全行を復元する。
 * 以前は 1 行目の復元で埋まったスロットを 2 行目が「埋まっている」と誤判定して取りこぼしていた。
 */
export async function restorePlannedMealsSnapshot(
  supabase: Pick<SupabaseClient, 'from'>,
  snapshot: PlannedMealSnapshotRow[],
): Promise<RestorePlannedMealsResult> {
  let restored = 0;
  let skipped = 0;
  let failed = 0;

  // 1. 復元先のスロットを決められない行は問い合わせずに failed とする
  const validRows: PlannedMealSnapshotRow[] = [];
  for (const row of snapshot) {
    if (!row?.daily_meal_id || !row?.meal_type) {
      failed++;
      continue;
    }
    validRows.push(row);
  }
  if (validRows.length === 0) {
    return { restored, skipped, failed };
  }

  // 2. 空きスロットの確認 (daily_meal_id ごとではなく、まとめて問い合わせる)
  const dailyMealIds = Array.from(new Set(validRows.map((row) => row.daily_meal_id)));
  const { occupied, failedDailyMealIds } = await fetchOccupiedSlots(supabase, dailyMealIds);

  const rowsToInsert: PlannedMealSnapshotRow[] = [];
  for (const row of validRows) {
    if (failedDailyMealIds.has(row.daily_meal_id)) {
      failed++;
      continue;
    }
    if (occupied.get(row.daily_meal_id)?.has(row.meal_type)) {
      // 他の書き込み（部分的に成功した生成結果など）が既にこのスロットを
      // 埋めている。旧データで上書きしない。
      skipped++;
      continue;
    }
    rowsToInsert.push(row);
  }
  if (rowsToInsert.length === 0) {
    return { restored, skipped, failed };
  }

  // 3. 空きスロットの行をまとめて書き戻す
  const { error: bulkError } = await supabase.from('planned_meals').insert(rowsToInsert);
  if (!bulkError) {
    restored += rowsToInsert.length;
    return { restored, skipped, failed };
  }

  // bulk insert は 1 つの文として all-or-nothing のため、ここでは 1 行も入っていない。
  // 行単位にやり直して、入る行だけでも復元する。
  console.error(
    `[restorePlannedMealsSnapshot] bulk restore insert failed for ${rowsToInsert.length} rows, retrying row by row:`,
    bulkError.message,
  );
  for (const row of rowsToInsert) {
    const { error: insertError } = await supabase.from('planned_meals').insert(row);
    if (insertError) {
      console.error(
        `[restorePlannedMealsSnapshot] restore insert failed for planned_meal ${row.id}:`,
        insertError.message,
      );
      failed++;
      continue;
    }
    restored++;
  }

  return { restored, skipped, failed };
}

/**
 * weekly_menu_requests.generated_data (jsonb, request/route.ts が
 * `{ snapshot: PlannedMealSnapshotRow[] }` の形で保存) から復元用スナップショットを
 * 安全に取り出す。
 *
 * #1042: 生成が waitUntil 消失等で止まり stale sweeper (status/pending/cleanup)
 * が status='failed' にするだけで終わっていたケースの救済に使う。
 * 想定外の形（null / 他フィールドのみ等）の場合は空配列を返す。
 */
export function extractPlannedMealsSnapshot(generatedData: unknown): PlannedMealSnapshotRow[] {
  if (!generatedData || typeof generatedData !== 'object') return [];
  const snapshot = (generatedData as Record<string, unknown>).snapshot;
  if (!Array.isArray(snapshot)) return [];
  return snapshot.filter(
    (row): row is PlannedMealSnapshotRow =>
      !!row &&
      typeof row === 'object' &&
      typeof (row as Record<string, unknown>).id === 'string' &&
      typeof (row as Record<string, unknown>).daily_meal_id === 'string' &&
      typeof (row as Record<string, unknown>).meal_type === 'string',
  );
}
