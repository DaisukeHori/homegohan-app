/**
 * 献立生成v2 - LLMレスポンススキーマ
 *
 * OpenAI GPT-5-mini に要求するJSON出力の構造
 */
import { z } from "zod";
import { DishRoleSchema } from "./dish";

/**
 * 食事タイプ
 */
export const MealTypeSchema = z.enum(["breakfast", "lunch", "dinner"]);
export type MealType = z.infer<typeof MealTypeSchema>;

/**
 * LLMが出力する料理（名前とroleのみ、詳細はproxy解決で後付け）
 */
export const LLMDishOutputSchema = z.object({
  name: z.string().min(1).max(50),
  role: DishRoleSchema,
});

export type LLMDishOutput = z.infer<typeof LLMDishOutputSchema>;

/**
 * LLMが行った調整の記録
 */
export const AdjustmentSchema = z.object({
  day: z.number().int().min(1).max(7).nullable(),
  meal_type: MealTypeSchema.nullable(),
  original_request: z.string(),
  changed_to: z.string(),
  reason: z.string(),
});

export type Adjustment = z.infer<typeof AdjustmentSchema>;

// ============================================================
// 週次献立生成（generate-weekly-menu）
// ============================================================

/**
 * 週次献立 - 1食分
 */
export const WeeklyMealItemSchema = z.object({
  day: z.number().int().min(1).max(7), // 1=月曜 … 7=日曜
  meal_type: MealTypeSchema,
  dishes: z.array(LLMDishOutputSchema).min(1).max(6),
  theme: z.string().max(30).nullable(),
});

export type WeeklyMealItem = z.infer<typeof WeeklyMealItemSchema>;

/**
 * 週次献立生成 - LLMレスポンス全体
 */
export const WeeklyMenuResponseSchema = z.object({
  meals: z.array(WeeklyMealItemSchema).length(21), // 7日×3食
  adjustments: z.array(AdjustmentSchema).nullable(),
  weekly_advice: z.string().max(500).nullable(),
});

export type WeeklyMenuResponse = z.infer<typeof WeeklyMenuResponseSchema>;

// ============================================================
// 単発生成（generate-single-meal）
// ============================================================

/**
 * 単発生成用の調整記録
 */
export const SingleAdjustmentSchema = z.object({
  original_request: z.string(),
  changed_to: z.string(),
  reason: z.string(),
});

export type SingleAdjustment = z.infer<typeof SingleAdjustmentSchema>;

/**
 * 単発生成 - LLMレスポンス
 */
export const SingleMealResponseSchema = z.object({
  dishes: z.array(LLMDishOutputSchema).min(1).max(6),
  adjustments: z.array(SingleAdjustmentSchema).nullable(),
  advice: z.string().max(300).nullable(),
});

export type SingleMealResponse = z.infer<typeof SingleMealResponseSchema>;

// ============================================================
// 差し替え（regenerate-meal-direct）
// ============================================================

/**
 * 差し替え用の料理出力（変更フラグ付き）
 */
export const RegenerateDishOutputSchema = z.object({
  name: z.string().min(1).max(50),
  role: DishRoleSchema,
  is_changed: z.boolean(),
});

export type RegenerateDishOutput = z.infer<typeof RegenerateDishOutputSchema>;

/**
 * 差し替え - LLMレスポンス
 */
export const RegenerateMealResponseSchema = z.object({
  dishes: z.array(RegenerateDishOutputSchema).min(1).max(6),
  change_summary: z.string().max(200),
  reason: z.string().max(300),
});

export type RegenerateMealResponse = z.infer<
  typeof RegenerateMealResponseSchema
>;

// ============================================================
// バリデーションヘルパー
// ============================================================

/**
 * LLMレスポンスをパース＆バリデーション
 */
export function parseWeeklyMenuResponse(json: unknown) {
  return WeeklyMenuResponseSchema.safeParse(json);
}

export function parseSingleMealResponse(json: unknown) {
  return SingleMealResponseSchema.safeParse(json);
}

export function parseRegenerateMealResponse(json: unknown) {
  return RegenerateMealResponseSchema.safeParse(json);
}

