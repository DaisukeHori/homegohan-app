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
 * 削除前に退避したスナップショットから planned_meals を復元する。
 *
 * 復元前に同一スロット (daily_meal_id + meal_type) が既に埋まっていないかを
 * 確認し、埋まっていればスキップする（生成処理が部分的に成功して新しい
 * データを書き込んでいた場合に、それを上書きしないため = 他者による更新の検知）。
 */
export async function restorePlannedMealsSnapshot(
  supabase: Pick<SupabaseClient, 'from'>,
  snapshot: PlannedMealSnapshotRow[],
): Promise<RestorePlannedMealsResult> {
  let restored = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of snapshot) {
    if (!row?.daily_meal_id || !row?.meal_type) {
      failed++;
      continue;
    }

    const { data: occupied, error: lookupError } = await supabase
      .from('planned_meals')
      .select('id')
      .eq('daily_meal_id', row.daily_meal_id)
      .eq('meal_type', row.meal_type)
      .maybeSingle();

    if (lookupError) {
      console.error(
        `[restorePlannedMealsSnapshot] lookup failed for ${row.daily_meal_id}/${row.meal_type}:`,
        lookupError.message,
      );
      failed++;
      continue;
    }

    if (occupied) {
      // 他の書き込み（部分的に成功した生成結果など）が既にこのスロットを
      // 埋めている。旧データで上書きしない。
      skipped++;
      continue;
    }

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
