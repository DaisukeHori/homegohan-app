/**
 * 写真で献立を上書きするときに planned_meals へ書く栄養の列 (analyze-meal-photo, #1146)
 *
 * 写真の解析結果で、栄養の列をまとめて上書きする。
 * 列を 1 つ書き忘れると、上書き前の献立の値だけが残り、ほかの栄養素と食い違って表示される。
 * 例: AI 献立が糖質を保存するようになったあと、写真で上書きしても sugar_g だけ古いまま残り、
 *     「炭水化物 40g / 食物繊維 3g / 糖質 85.3g」のように糖質が炭水化物より大きく表示された。
 * そのため、どの列を書くかをこの関数に 1 か所へまとめ、tests/analyze-meal-photo-sugar.test.ts で確かめる。
 *
 * 型の import だけで、実行時の依存は無い (単体テストで読み込める)。
 */
import type { NutritionPipelineResult } from './nutrition-pipeline.ts'

export type PhotoOverwriteNutritionSource = Pick<
  NutritionPipelineResult,
  'totalCalories' | 'totalProtein' | 'totalFat' | 'totalCarbs' | 'nutrition'
>

/**
 * 写真の解析結果から、planned_meals の栄養の列 (基本・拡張・糖質) を組み立てる。
 *
 * 糖質は、炭水化物・食物繊維と同じ解析結果 (nutrition-pipeline の mealTotals) から求めた値を書く。
 * 値が無いときに undefined のまま渡すと、supabase-js は列を送らず、古い値が残ってしまう。
 * それを避けるため、無いときは null を明示して古い値を消す。
 */
export function buildPhotoOverwriteNutrition(result: PhotoOverwriteNutritionSource) {
  const n = result.nutrition
  return {
    // 基本栄養素
    calories_kcal: result.totalCalories,
    protein_g: result.totalProtein,
    fat_g: result.totalFat,
    carbs_g: result.totalCarbs,
    // 拡張栄養素
    sodium_g: n.sodiumG,
    fiber_g: n.fiberG,
    // 糖質 = 炭水化物 − 食物繊維 (炭水化物・食物繊維と一緒に上書きする)
    sugar_g: n.sugarG ?? null,
    potassium_mg: n.potassiumMg,
    calcium_mg: n.calciumMg,
    phosphorus_mg: n.phosphorusMg,
    iron_mg: n.ironMg,
    zinc_mg: n.zincMg,
    iodine_ug: n.iodineUg,
    cholesterol_mg: n.cholesterolMg,
    vitamin_a_ug: n.vitaminAUg,
    vitamin_d_ug: n.vitaminDUg,
    vitamin_e_mg: n.vitaminEMg,
    vitamin_k_ug: n.vitaminKUg,
    vitamin_b1_mg: n.vitaminB1Mg,
    vitamin_b2_mg: n.vitaminB2Mg,
    vitamin_b6_mg: n.vitaminB6Mg,
    vitamin_b12_ug: n.vitaminB12Ug,
    folic_acid_ug: n.folicAcidUg,
    vitamin_c_mg: n.vitaminCMg,
    magnesium_mg: n.magnesiumMg,
  }
}
