/**
 * 糖質 (sugar_g) の定義 (#1146)
 *
 * アプリの「糖質」は 炭水化物 − 食物繊維 で求める。
 * 食材 DB (dataset_ingredients) には糖質の列が無く、炭水化物 (carbs_g) と食物繊維 (fiber_g) だけがあるため、
 * 栄養計算のたびにこの式で計算する。式は必ずこのファイルの関数を通し、各所で書き写さない。
 *
 * 栄養目標側 (packages/core の SUGAR_APP_DEFAULT) も同じ定義 (炭水化物の目標 − 食物繊維の目標) にそろえてある。
 */

function toFiniteOrZero(value: number | string | null | undefined): number {
  const num = typeof value === "string" ? parseFloat(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : 0;
}

/**
 * 糖質 (g) = 炭水化物 (g) − 食物繊維 (g)。
 *
 * - 食物繊維が未登録 (null / undefined) のときは 0 として扱い、炭水化物をそのまま糖質とする。
 * - 食物繊維が炭水化物より多い食品 (海藻・寒天など) で負の値にならないよう、0 で下限をとる。
 * - 炭水化物が未登録のときは 0 を返す。「データが無い」ことを区別したい呼び出し側は、
 *   炭水化物が null かどうかを先に確かめること。
 *
 * 材料ごとに計算してから合算する (合計の炭水化物 − 合計の食物繊維 ではない)。
 * 材料単位で下限をとるため、食物繊維の多い食品が他の材料の糖質を打ち消さない。
 */
export function calcSugarG(
  carbsG: number | string | null | undefined,
  fiberG: number | string | null | undefined,
): number {
  return Math.max(0, toFiniteOrZero(carbsG) - toFiniteOrZero(fiberG));
}

/**
 * dataset_recipes の 1 行 (レシピ DB) から糖質 (g) を決める。
 *
 * レシピ DB は取り込み時に 炭水化物 = 糖質 + 食物繊維 としているため、
 * 行に sugar_g があればそれを使い、無ければ 炭水化物 − 食物繊維 で求める (どちらも同じ定義)。
 */
export function resolveRecipeSugarG(row: {
  sugar_g?: number | string | null;
  carbs_g?: number | string | null;
  fiber_g?: number | string | null;
}): number {
  if (row.sugar_g != null) {
    const stored = typeof row.sugar_g === "string" ? parseFloat(row.sugar_g) : row.sugar_g;
    if (Number.isFinite(stored) && stored >= 0) return stored;
  }
  return calcSugarG(row.carbs_g, row.fiber_g);
}
