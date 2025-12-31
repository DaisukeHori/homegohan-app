/**
 * 献立生成v2 - 料理（Dish）スキーマ
 *
 * planned_meals.dishes JSONB に格納される個別料理の構造
 */
import { z } from "zod";

/**
 * 材料の構造
 */
export const IngredientSchema = z.object({
  name: z.string(),
  amount: z.string().nullable(),
  category: z.string().nullable(),
});

export type Ingredient = z.infer<typeof IngredientSchema>;

/**
 * 料理のデータソース
 * - dataset: DBの既存レシピに完全一致
 * - proxy: DBの近傍レシピをベースに採用（名前は異なる可能性あり）
 * - generated: DB内に近傍が見つからず、LLM生成データを使用（非推奨、最終手段）
 */
export const DishSourceSchema = z.enum(["dataset", "proxy", "generated"]);
export type DishSource = z.infer<typeof DishSourceSchema>;

/**
 * 料理の役割
 */
export const DishRoleSchema = z.enum([
  "main", // 主菜
  "side", // 副菜
  "soup", // 汁物
  "rice", // 主食
  "small_dish", // 小鉢
  "dessert", // デザート
  "other", // その他
]);
export type DishRole = z.infer<typeof DishRoleSchema>;

/**
 * 個別料理スキーマ（planned_meals.dishes[]の要素）
 */
export const DishSchema = z.object({
  // 基本情報
  name: z.string().min(1).max(100),
  role: DishRoleSchema,

  // トレーサビリティ（データ元）
  source: DishSourceSchema,
  base_recipe_id: z.string().uuid().nullable(),
  base_recipe_name: z.string().nullable(),
  source_url: z.string().url().nullable().or(z.literal("")),
  similarity_score: z.number().min(0).max(1).nullable(),

  // 栄養（DBから取得した確定値）
  calories_kcal: z.number().int().nonnegative().nullable(),
  protein_g: z.number().nonnegative().nullable(),
  fat_g: z.number().nonnegative().nullable(),
  carbs_g: z.number().nonnegative().nullable(),
  sodium_g: z.number().nonnegative().nullable(),
  fiber_g: z.number().nonnegative().nullable(),

  // 詳細（DBから取得）
  ingredients: z.array(IngredientSchema).nullable(),
  steps: z.array(z.string()).nullable(),
  cooking_time_minutes: z.number().int().nonnegative().nullable(),
  servings: z.number().int().positive().nullable(),
});

export type Dish = z.infer<typeof DishSchema>;

/**
 * planned_meals.dishes の配列スキーマ
 */
export const PlannedMealDishesSchema = z.array(DishSchema);
export type PlannedMealDishes = z.infer<typeof PlannedMealDishesSchema>;

/**
 * proxy解決の閾値定数
 */
export const PROXY_THRESHOLDS = {
  EXACT_MATCH: 1.0,
  HIGH_SIMILARITY: 0.85,
  MEDIUM_SIMILARITY: 0.7,
  LOW_SIMILARITY: 0.5,
  NO_MATCH: 0.0,
} as const;

/**
 * similarity値からsourceを判定
 */
export function determineSourceFromSimilarity(
  similarity: number,
  isExactMatch: boolean
): DishSource {
  if (isExactMatch || similarity >= PROXY_THRESHOLDS.EXACT_MATCH) {
    return "dataset";
  }
  if (similarity >= PROXY_THRESHOLDS.LOW_SIMILARITY) {
    return "proxy";
  }
  return "generated";
}

