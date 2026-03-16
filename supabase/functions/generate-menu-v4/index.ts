/**
 * V4 汎用献立生成エンジン
 * 
 * - 指定されたスロット（targetSlots）のみを生成
 * - 既存データはデフォルトで保護（plannedMealIdがない限り上書きしない）
 * - 季節・イベント・冷蔵庫情報を考慮したLLM生成
 */

import { createClient } from "@supabase/supabase-js";
import {
  buildSearchQueryBase,
  buildUserContextForPrompt,
  buildUserSummary,
  type HealthCheckupForContext,
  type HealthCheckupGuidance,
} from "../_shared/user-context.ts";
import {
  sanitizeGenerationPromptConstraints,
  sanitizeGenerationPromptProfile,
} from "../_shared/generation-serving.ts";
import {
  emptyNutrition,
  type NutritionTotals,
} from "../_shared/nutrition-calculator.ts";
import {
  analyzeNutritionFromIngredientsV4,
  validateAndAdjustNutritionV4,
} from "../_shared/v4-nutrition-adapter.ts";
import { insertMealNutritionDebugLog, type MealNutritionDebugLogInput } from "../_shared/meal-nutrition-debug.ts";
import {
  generateMealWithLLM,
  generateDayMealsWithLLM,
  reviewWeeklyMenus,
  regenerateMealForIssue,
  type GeneratedMeal,
  type MealType,
  type MenuReference,
  type WeeklyMealsSummary,
} from "../_shared/meal-generator.ts";
import {
  DEFAULT_STEP1_DAY_BATCH,
  DEFAULT_STEP2_FIXES_PER_RUN,
  DEFAULT_STEP3_SLOT_BATCH,
  DEFAULT_STEP4_DAY_BATCH,
  DEFAULT_STEP5_DAY_BATCH,
  DEFAULT_STEP6_SLOT_BATCH,
  computeMaxFixesForRange,
  computeNextCursor,
} from "./step-utils.ts";
import {
  generateNutritionFeedback,
  aggregateDayNutrition,
  buildWeekDataFromMeals,
  type NutritionFeedbackResult,
} from "../_shared/nutrition-feedback.ts";
import { withOpenAIUsageContext, generateExecutionId } from "../_shared/llm-usage.ts";
import {
  DATASET_EMBEDDING_API_KEY_ENV,
  DATASET_EMBEDDING_DIMENSIONS,
  DATASET_EMBEDDING_MODEL,
  fetchSingleDatasetEmbedding,
} from "../../../shared/dataset-embedding.mjs";
import {
  extractReferenceSearchKeywords,
  mapMenuReferenceCandidates,
  rerankMenuReferenceCandidates,
  shouldSkipReferenceMenuSearch,
} from "./reference-menu-utils.ts";

console.log("Generate Menu V4 Function loaded (Slot-based generation)");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DISPLAY_ORDER_MAP: Record<string, number> = {
  breakfast: 10,
  lunch: 20,
  dinner: 30,
  snack: 40,
  midnight_snack: 50,
};

function getMinExpectedCaloriesForRole(role: string | undefined): number {
  // V3のカテゴリ別閾値（主菜/ご飯>=100, 副菜>=30, 汁物>=20）を role にマッピング
  switch (role) {
    case "main":
    case "rice":
      return 100;
    case "side":
      return 30;
    case "soup":
      return 20;
    default:
      return 20;
  }
}

// =========================================================
// Types
// =========================================================

interface TargetSlot {
  date: string;
  mealType: MealType;
  plannedMealId?: string;
}

interface ExistingMenuContext {
  date: string;
  mealType: MealType;
  dishName: string;
  status: string;
  isPast: boolean;
}

interface FridgeItemContext {
  name: string;
  expirationDate?: string;
  quantity?: string;
}

interface SeasonalContext {
  month: number;
  seasonalIngredients: {
    vegetables: string[];
    fish: string[];
    fruits: string[];
  };
  events: Array<{
    name: string;
    date: string;
    dishes: string[];
    ingredients: string[];
    note?: string;
  }>;
}

interface ProgressInfo {
  currentStep: number;
  totalSteps: number;
  message: string;
  completedSlots?: number;
  totalSlots?: number;
}

// =========================================================
// Helpers
// =========================================================

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 800;
  const label = opts.label ?? "retryable";

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const status = e?.status ?? e?.response?.status ?? e?.statusCode;
      const retryable = status === 429 || (typeof status === "number" && status >= 500 && status <= 599);
      if (!retryable || attempt === retries) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.log(`⏳ ${label}: retry in ${delay}ms (attempt ${attempt + 1}/${retries}) status=${status}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// =========================================================
// Progress update
// =========================================================

async function updateProgress(
  supabase: any,
  requestId: string | null,
  progress: ProgressInfo,
  currentStep?: number,
) {
  if (!requestId) return;
  try {
    const updateData: any = {
      progress,
      updated_at: new Date().toISOString(),
    };
    if (currentStep !== undefined) {
      updateData.current_step = currentStep;
    }
    await supabase
      .from("weekly_menu_requests")
      .update(updateData)
      .eq("id", requestId);
  } catch (e) {
    console.error("Failed to update progress:", e);
  }
}

// =========================================================
// 次のステップ（または同一ステップの継続）をトリガー
// =========================================================

async function triggerNextStep(
  supabaseUrl: string,
  supabaseServiceKey: string,
  requestId: string,
  userId: string,
) {
  console.log("🔄 Triggering next step...");

  // userIdの検証（undefinedだとJSON.stringifyで省略されてしまう）
  if (!userId) {
    console.error("❌ Cannot trigger next step: userId is missing");
    throw new Error("userId is required to trigger next step");
  }

  const url = `${supabaseUrl}/functions/v1/generate-menu-v4`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseServiceKey}`,
        "apikey": supabaseServiceKey,
      },
      body: JSON.stringify({
        request_id: requestId,
        userId,
        _continue: true,
      }),
    });
    console.log(`✅ Next step triggered: ${res.status}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`❌ Next step response error: ${res.status} - ${text}`);
    }
  } catch (e) {
    console.error("❌ Failed to trigger next step:", e);
  }
}

// =========================================================
// Search reference menus
// =========================================================

async function embedText(text: string, dimensions = DATASET_EMBEDDING_DIMENSIONS): Promise<number[]> {
  const apiKey = Deno.env.get(DATASET_EMBEDDING_API_KEY_ENV) ?? "";
  if (!apiKey) throw new Error(`Missing ${DATASET_EMBEDDING_API_KEY_ENV}`);
  const embedding = await withRetry(
    async () => await fetchSingleDatasetEmbedding(text, { apiKey, inputType: "query" }),
    { retries: 3, label: "embedText" },
  );
  if (!Array.isArray(embedding) || embedding.length !== dimensions) {
    throw new Error("Dataset embedding API returned invalid vector");
  }
  return embedding as number[];
}

async function searchMenuCandidates(
  supabase: any,
  queryText: string,
  matchCount: number,
): Promise<MenuReference[]> {
  try {
    const { count, error: countError } = await supabase
      .from("dataset_menu_sets")
      .select("id", { count: "exact", head: true });
    if (countError) {
      console.warn("Failed to count dataset_menu_sets before reference search:", countError.message);
    } else if (shouldSkipReferenceMenuSearch(count)) {
      console.log("ℹ️ Reference-menu RAG skipped: dataset_menu_sets is empty");
      return [];
    }

    const emb = await embedText(queryText, DATASET_EMBEDDING_DIMENSIONS);
    const expandedMatchCount = Math.min(Math.max(matchCount * 4, 20), 60)
    const { data, error } = await supabase.rpc("search_menu_examples", {
      query_embedding: emb,
      match_count: expandedMatchCount,
      filter_meal_type_hint: null,
      filter_max_sodium: null,
      filter_theme_tags: null,
    });
    if (error) throw new Error(`search_menu_examples failed: ${error.message}`);
    const reranked = rerankMenuReferenceCandidates(queryText, data ?? [], matchCount);
    console.log(`🔎 search_menu_examples: requested=${matchCount} vector=${data?.length ?? 0} reranked=${reranked.length} keywords=${extractReferenceSearchKeywords(queryText).join("|")}`);
    return mapMenuReferenceCandidates(reranked);
  } catch (e) {
    console.error("Failed to search menu candidates:", e);
    return [];
  }
}

// =========================================================
// Resolve recipe from dataset_recipes DB
// =========================================================

interface ResolvedRecipeResult {
  meal: GeneratedMeal;
  nutrition: NutritionTotals;
  source: { type: "dataset_recipe"; id: string; externalId: string };
}

/**
 * レシピDBから直接レシピを取得し、GeneratedMeal形式に変換
 * AIアドバイザーがsearch_recipesで見つけたレシピを使う際に使用
 */
async function resolveRecipeFromDB(
  supabase: any,
  constraints: { recipeId?: string; recipeExternalId?: string },
  mealType: MealType,
): Promise<ResolvedRecipeResult | null> {
  if (!constraints.recipeId && !constraints.recipeExternalId) return null;

  try {
    let query = supabase.from("dataset_recipes").select("*");
    if (constraints.recipeId) {
      query = query.eq("id", constraints.recipeId);
    } else {
      query = query.eq("external_id", constraints.recipeExternalId);
    }

    const { data, error } = await query.single();
    if (error || !data) {
      console.warn(`Recipe not found: ${constraints.recipeId ?? constraints.recipeExternalId}`);
      return null;
    }

    console.log(`📖 Resolved recipe from DB: ${data.name} (${data.id})`);

    // ingredients_text をパース（改行区切り、"食材名 数量g" 形式）
    const ingredients: Array<{ name: string; amount_g: number; note?: string }> = [];
    if (data.ingredients_text) {
      const lines = data.ingredients_text.split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        const trimmed = line.trim();
        // "玉ねぎ 50g" または "玉ねぎ" のパターン
        const match = trimmed.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*g$/);
        if (match) {
          ingredients.push({ name: match[1].trim(), amount_g: parseFloat(match[2]) });
        } else {
          // 数量なしの場合
          ingredients.push({ name: trimmed, amount_g: 0 });
        }
      }
    }

    // instructions_text をパース（改行区切りで手順）
    const instructions: string[] = data.instructions_text
      ? data.instructions_text.split("\n").filter((l: string) => l.trim()).map((l: string) => l.trim())
      : [];

    // GeneratedMeal を構築（主菜として1品のみ）
    const meal: GeneratedMeal = {
      mealType,
      dishes: [
        {
          name: data.name,
          role: "main", // dataset_recipes は主に主菜
          ingredients,
          instructions,
        },
      ],
      advice: `レシピDB「${data.name}」より。`,
    };

    // 栄養データを構築（emptyNutritionをベースに利用可能なデータで上書き）
    const nutrition: NutritionTotals = {
      ...emptyNutrition(),
      calories_kcal: data.calories_kcal ?? 0,
      protein_g: data.protein_g ?? 0,
      fat_g: data.fat_g ?? 0,
      carbs_g: data.carbs_g ?? 0,
      fiber_g: data.fiber_g ?? 0,
      sodium_g: data.sodium_g ?? 0,
      potassium_mg: data.potassium_mg ?? 0,
      calcium_mg: data.calcium_mg ?? 0,
      magnesium_mg: data.magnesium_mg ?? 0,
      iron_mg: data.iron_mg ?? 0,
      zinc_mg: data.zinc_mg ?? 0,
      vitamin_a_ug: data.vitamin_a_ug ?? 0,
      vitamin_b1_mg: data.vitamin_b1_mg ?? 0,
      vitamin_b2_mg: data.vitamin_b2_mg ?? 0,
      vitamin_c_mg: data.vitamin_c_mg ?? 0,
      vitamin_d_ug: data.vitamin_d_ug ?? 0,
    };

    return {
      meal,
      nutrition,
      source: {
        type: "dataset_recipe",
        id: data.id,
        externalId: data.external_id ?? "",
      },
    };
  } catch (e) {
    console.error("Failed to resolve recipe from DB:", e);
    return null;
  }
}

// =========================================================
// Build context for LLM
// =========================================================

function buildV4Context(params: {
  targetSlot: TargetSlot;
  existingMenus: ExistingMenuContext[];
  fridgeItems: FridgeItemContext[];
  seasonalContext: SeasonalContext;
  userProfile: any;
  constraints: any;
  note: string | null;
}): string {
  const { targetSlot, existingMenus, fridgeItems, seasonalContext, constraints, note } = params;

  const lines: string[] = [];

  // Target slot info
  lines.push(`【生成対象】${targetSlot.date} ${targetSlot.mealType}`);
  lines.push("");

  // User request/note
  if (note) {
    lines.push(`【ユーザーの要望】`);
    lines.push(note);
    lines.push("");
  }

  // Constraints
  const constraintFlags: string[] = [];
  if (constraints?.useFridgeFirst) constraintFlags.push("冷蔵庫の食材を優先使用");
  if (constraints?.quickMeals) constraintFlags.push("時短料理中心");
  if (constraints?.japaneseStyle) constraintFlags.push("和食多め");
  if (constraints?.healthy) constraintFlags.push("ヘルシー志向");
  if (constraints?.budgetFriendly) constraintFlags.push("節約重視");
  if (constraintFlags.length > 0) {
    lines.push(`【生成条件】${constraintFlags.join("、")}`);
    lines.push("");
  }

  // Fridge items (prioritize items expiring soon)
  if (fridgeItems.length > 0) {
    const sortedFridge = [...fridgeItems].sort((a, b) => {
      if (!a.expirationDate) return 1;
      if (!b.expirationDate) return -1;
      return a.expirationDate.localeCompare(b.expirationDate);
    });
    const fridgeText = sortedFridge.slice(0, 15).map(item => {
      let text = item.name;
      if (item.quantity) text += ` (${item.quantity})`;
      if (item.expirationDate) text += ` [期限:${item.expirationDate}]`;
      return text;
    }).join("、");
    lines.push(`【冷蔵庫の食材】${fridgeText}`);
    lines.push("");
  }

  // Seasonal ingredients
  if (seasonalContext.seasonalIngredients) {
    const { vegetables, fish, fruits } = seasonalContext.seasonalIngredients;
    lines.push(`【旬の食材（${seasonalContext.month}月）】`);
    if (vegetables.length > 0) lines.push(`野菜: ${vegetables.slice(0, 8).join("、")}`);
    if (fish.length > 0) lines.push(`魚介: ${fish.slice(0, 8).join("、")}`);
    if (fruits.length > 0) lines.push(`果物: ${fruits.slice(0, 5).join("、")}`);
    lines.push("");
  }

  // Seasonal events
  if (seasonalContext.events && seasonalContext.events.length > 0) {
    const relevantEvents = seasonalContext.events.filter(e => {
      if (e.date === "variable") return true;
      const eventMonthDay = e.date;
      const slotMonthDay = targetSlot.date.slice(5); // "MM-DD"
      return eventMonthDay === slotMonthDay;
    });
    if (relevantEvents.length > 0) {
      lines.push(`【イベント・行事】`);
      for (const event of relevantEvents) {
        lines.push(`- ${event.name}: ${event.dishes.join("、")}`);
      }
      lines.push("");
    }
  }

  // Existing menus (for variety)
  const recentMenus = existingMenus.filter(m => {
    const dayDiff = Math.abs(
      (new Date(targetSlot.date).getTime() - new Date(m.date).getTime()) / (1000 * 60 * 60 * 24)
    );
    return dayDiff <= 7;
  });

  if (recentMenus.length > 0) {
    lines.push(`【直近の献立（被り回避のため参照）】`);
    const grouped = new Map<string, string[]>();
    for (const m of recentMenus) {
      const key = `${m.date} ${m.mealType}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(m.dishName);
    }
    for (const [key, dishes] of grouped) {
      lines.push(`- ${key}: ${dishes.join("、")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function mealTypeToJa(mealType: MealType): string {
  return mealType === "breakfast"
    ? "朝食"
    : mealType === "lunch"
    ? "昼食"
    : mealType === "dinner"
    ? "夕食"
    : mealType === "snack"
    ? "間食"
    : "夜食";
}

function buildV4DayContext(params: {
  date: string;
  mealTypes: MealType[];
  slotsForDate: TargetSlot[];
  existingMenus: ExistingMenuContext[];
  fridgeItems: FridgeItemContext[];
  seasonalContext: SeasonalContext;
  userProfile: any;
  constraints: any;
}): string {
  const { date, mealTypes, slotsForDate, existingMenus, fridgeItems, seasonalContext, constraints } = params;

  const lines: string[] = [];
  const mealTypesJa = mealTypes.map(mealTypeToJa).join("、");
  lines.push(`【生成対象】${date}（${mealTypesJa}）`);
  lines.push("");

  // 既存献立の差し替え情報（plannedMealIdがある場合）
  const overwriteInfos: string[] = [];
  for (const mt of mealTypes) {
    const slot = slotsForDate.find((s) => s.mealType === mt);
    if (!slot?.plannedMealId) continue;
    const current = existingMenus.find((m) => m.date === date && m.mealType === mt && m.dishName);
    if (current?.dishName) {
      overwriteInfos.push(`${mealTypeToJa(mt)}: 現在「${current.dishName}」→ 別の献立に差し替え`);
    }
  }
  if (overwriteInfos.length > 0) {
    lines.push(`【差し替え対象】`);
    overwriteInfos.forEach((t) => lines.push(`- ${t}`));
    lines.push("");
  }

  // Constraints
  const constraintFlags: string[] = [];
  if (constraints?.useFridgeFirst) constraintFlags.push("冷蔵庫の食材を優先使用");
  if (constraints?.quickMeals) constraintFlags.push("時短料理中心");
  if (constraints?.japaneseStyle) constraintFlags.push("和食多め");
  if (constraints?.healthy) constraintFlags.push("ヘルシー志向");
  if (constraints?.budgetFriendly) constraintFlags.push("節約重視");
  if (constraintFlags.length > 0) {
    lines.push(`【生成条件】${constraintFlags.join("、")}`);
    lines.push("");
  }

  // Fridge items
  if (fridgeItems.length > 0) {
    const sortedFridge = [...fridgeItems].sort((a, b) => {
      if (!a.expirationDate) return 1;
      if (!b.expirationDate) return -1;
      return a.expirationDate.localeCompare(b.expirationDate);
    });
    const fridgeText = sortedFridge
      .slice(0, 15)
      .map((item) => {
        let text = item.name;
        if (item.quantity) text += ` (${item.quantity})`;
        if (item.expirationDate) text += ` [期限:${item.expirationDate}]`;
        return text;
      })
      .join("、");
    lines.push(`【冷蔵庫の食材】${fridgeText}`);
    lines.push("");
  }

  // Seasonal ingredients
  if (seasonalContext.seasonalIngredients) {
    const { vegetables, fish, fruits } = seasonalContext.seasonalIngredients;
    lines.push(`【旬の食材（${seasonalContext.month}月）】`);
    if (vegetables.length > 0) lines.push(`野菜: ${vegetables.slice(0, 8).join("、")}`);
    if (fish.length > 0) lines.push(`魚介: ${fish.slice(0, 8).join("、")}`);
    if (fruits.length > 0) lines.push(`果物: ${fruits.slice(0, 5).join("、")}`);
    lines.push("");
  }

  // Seasonal events
  if (seasonalContext.events && seasonalContext.events.length > 0) {
    const relevantEvents = seasonalContext.events.filter((e) => {
      if (e.date === "variable") return true;
      const eventMonthDay = e.date;
      const slotMonthDay = date.slice(5); // "MM-DD"
      return eventMonthDay === slotMonthDay;
    });
    if (relevantEvents.length > 0) {
      lines.push(`【イベント・行事】`);
      for (const event of relevantEvents) {
        lines.push(`- ${event.name}: ${event.dishes.join("、")}`);
      }
      lines.push("");
    }
  }

  // Existing menus (for variety)
  const recentMenus = existingMenus.filter((m) => {
    const dayDiff = Math.abs(
      (new Date(date).getTime() - new Date(m.date).getTime()) / (1000 * 60 * 60 * 24),
    );
    return dayDiff <= 7;
  });

  if (recentMenus.length > 0) {
    lines.push(`【直近の献立（被り回避のため参照）】`);
    const grouped = new Map<string, string[]>();
    for (const m of recentMenus) {
      const key = `${m.date} ${m.mealType}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(m.dishName);
    }
    for (const [key, dishes] of grouped) {
      lines.push(`- ${key}: ${dishes.join("、")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function getSlotKey(date: string, mealType: MealType): string {
  return `${date}:${mealType}`;
}

// =========================================================
// Save meal to DB
// =========================================================

async function saveMealToDb(
  supabase: any,
  params: {
    userId: string;
    requestId?: string;
    targetSlot: TargetSlot;
    generatedMeal: GeneratedMeal;
  }
): Promise<void> {
  const { userId, requestId, targetSlot, generatedMeal } = params;

  // user_daily_meals: upsert（日付ベース）
  const { data: dailyMeal, error: dailyMealErr } = await supabase
    .from("user_daily_meals")
    .upsert(
      { 
        user_id: userId, 
        day_date: targetSlot.date,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id,day_date' }
    )
    .select("id")
    .single();

  if (dailyMealErr || !dailyMeal?.id) {
    throw new Error(`Failed to upsert user_daily_meals: ${dailyMealErr?.message}`);
  }
  const dayData = dailyMeal;

  // Calculate nutrition per dish + V3-like validation/adjustment for suspicious low-calorie dishes
  const totalNutrition = emptyNutrition();
  const dishDetails: any[] = [];
  const nutritionDebugEntries: MealNutritionDebugLogInput[] = [];
  const aggregatedIngredients: string[] = [];
  const allSteps: string[] = [];

  const round1 = (v: number | null | undefined) => (v != null ? Math.round(v * 10) / 10 : null);
  const round2 = (v: number | null | undefined) => (v != null ? Math.round(v * 100) / 100 : null);

  // レシピDBから解決された栄養データがある場合はそれを使用
  const resolvedNutrition = (generatedMeal as any)._resolvedNutrition as NutritionTotals | undefined;
  const recipeSource = (generatedMeal as any)._recipeSource as { type: string; id: string; externalId: string } | undefined;

  for (let idx = 0; idx < generatedMeal.dishes.length; idx++) {
    const dish = generatedMeal.dishes[idx];

    const inputIngredients = (dish.ingredients ?? []).map((ingredient: any) => ({
      name: String(ingredient?.name ?? "").trim(),
      amount_g: Number(ingredient?.amount_g ?? 0),
    }));
    let normalizedIngredients = inputIngredients;
    let ingredientMatches: MealNutritionDebugLogInput["ingredientMatches"] = [];
    let calculatedNutrition: NutritionTotals = emptyNutrition();
    let nutrition: NutritionTotals = emptyNutrition();
    let sourceKind: MealNutritionDebugLogInput["sourceKind"] = "ingredient_match";
    const minExpectedCal = getMinExpectedCaloriesForRole(dish.role);
    let validationDebug: MealNutritionDebugLogInput["validation"] = {
      attempted: false,
      min_expected_calories: minExpectedCal,
      calculated_calories: 0,
      reference_calories: 0,
      deviation_percent: 0,
      used_reference_adjustment: false,
      message: "未検証",
      reference_source: "none",
      reference_recipe: null,
      reference_candidates: [],
    };

    // レシピDBからの事前計算済み栄養データがある場合はそれを使用
    if (resolvedNutrition && idx === 0) {
      sourceKind = "resolved_recipe_db";
      calculatedNutrition = resolvedNutrition;
      nutrition = resolvedNutrition;
      console.log(`📊 Using pre-calculated nutrition from recipe DB for ${dish.name}`);
    } else {
      try {
        const analysis = await analyzeNutritionFromIngredientsV4(supabase, dish.name, dish.role, dish.ingredients);
        normalizedIngredients = analysis.normalizedIngredients;
        ingredientMatches = analysis.ingredientMatches;
        calculatedNutrition = analysis.calculatedNutrition;
        nutrition = analysis.calculatedNutrition;
      } catch (e) {
        console.warn(`Nutrition calc failed for ${dish.name}:`, e);
        calculatedNutrition = emptyNutrition();
        nutrition = emptyNutrition();
      }
    }

    // V3同様: 低カロリーなど怪しい料理のみ参照レシピで検証・補正
    if ((nutrition.calories_kcal ?? 0) < minExpectedCal) {
      validationDebug = {
        attempted: true,
        min_expected_calories: minExpectedCal,
        calculated_calories: nutrition.calories_kcal ?? 0,
        reference_calories: 0,
        deviation_percent: 0,
        used_reference_adjustment: false,
        message: "検証開始",
        reference_source: "none",
        reference_recipe: null,
        reference_candidates: [],
      };
      try {
        const before = nutrition.calories_kcal ?? 0;
        const validation = await validateAndAdjustNutritionV4(
          supabase,
          dish.name,
          nutrition,
          { maxDeviationPercent: 70, useReferenceIfInvalid: true },
        );
        validationDebug = {
          attempted: true,
          min_expected_calories: minExpectedCal,
          calculated_calories: validation.calculatedCalories,
          reference_calories: validation.referenceCalories,
          deviation_percent: validation.deviationPercent,
          used_reference_adjustment: Boolean(validation.appliedAdjustment),
          message: validation.message,
          reference_source: validation.referenceSource,
          reference_recipe: validation.referenceRecipe,
          reference_candidates: validation.referenceCandidates,
        };
        if (validation.adjustedNutrition) {
          nutrition = validation.adjustedNutrition;
          const after = nutrition.calories_kcal ?? 0;
          console.log(
            `📝 Adjusted \"${dish.name}\": ${Math.round(before)}kcal → ${Math.round(after)}kcal (${validation.message})`,
          );
        }
      } catch (e: any) {
        console.warn(`Validation failed for ${dish.name}:`, e?.message ?? e);
        validationDebug.message = `検証失敗: ${e?.message ?? String(e)}`;
      }
    } else {
      validationDebug = {
        attempted: false,
        min_expected_calories: minExpectedCal,
        calculated_calories: nutrition.calories_kcal ?? 0,
        reference_calories: 0,
        deviation_percent: 0,
        used_reference_adjustment: false,
        message: "閾値以上のため検証スキップ",
        reference_source: "none",
        reference_recipe: null,
        reference_candidates: [],
      };
    }

    nutritionDebugEntries.push({
      requestId: requestId ?? null,
      userId,
      dailyMealId: dayData.id,
      targetDate: targetSlot.date,
      mealType: targetSlot.mealType,
      dishName: dish.name,
      dishRole: dish.role ?? null,
      sourceFunction: "generate-menu-v4",
      sourceKind,
      inputIngredients,
      normalizedIngredients,
      ingredientMatches,
      calculatedNutrition,
      finalNutrition: nutrition,
      validation: validationDebug,
      metadata: {
        generated_meal_type: generatedMeal.mealType,
        recipe_source: idx === 0 && recipeSource ? recipeSource : null,
      },
    });

    // 合算
    for (const key of Object.keys(totalNutrition) as (keyof NutritionTotals)[]) {
      totalNutrition[key] = (totalNutrition[key] || 0) + (nutrition[key] || 0);
    }

    // dishes(JSON) をV3寄せの形式で保存（買い物リスト・表示の精度向上）
    let ingredientsMd = "| 材料 | 分量 |\n|------|------|\n";
    const ingredients = dish.ingredients.map((i: any) => {
      const line = `${i.name} ${i.amount_g}g${i.note ? ` (${i.note})` : ""}`;
      ingredientsMd += `| ${i.name} | ${i.amount_g}g${i.note ? ` (${i.note})` : ""} |\n`;
      aggregatedIngredients.push(line);
      return line;
    });

    const recipeSteps = dish.instructions ?? [];
    const recipeStepsMd = recipeSteps.map((step: string, i: number) => `${i + 1}. ${step}`).join("\n\n");
    allSteps.push(...recipeSteps);

    dishDetails.push({
      name: dish.name,
      role: dish.role,
      ingredient: dish.ingredients.slice(0, 3).map((i: any) => i.name).join("、"),
      ingredients,
      recipeSteps,
      ingredientsMd,
      recipeStepsMd,
      displayOrder: idx,

      // 栄養素（単位付きの統一形式）
      calories_kcal: nutrition?.calories_kcal != null ? Math.round(nutrition.calories_kcal) : null,
      protein_g: round1(nutrition?.protein_g),
      fat_g: round1(nutrition?.fat_g),
      carbs_g: round1(nutrition?.carbs_g),
      fiber_g: round1(nutrition?.fiber_g),
      sugar_g: round1(nutrition?.sugar_g),
      sodium_g: round1(nutrition?.sodium_g),
      fiber_soluble_g: round1(nutrition?.fiber_soluble_g),
      fiber_insoluble_g: round1(nutrition?.fiber_insoluble_g),

      // ミネラル
      potassium_mg: round1(nutrition?.potassium_mg),
      calcium_mg: round1(nutrition?.calcium_mg),
      phosphorus_mg: round1(nutrition?.phosphorus_mg),
      magnesium_mg: round1(nutrition?.magnesium_mg),
      iron_mg: round1(nutrition?.iron_mg),
      zinc_mg: round1(nutrition?.zinc_mg),
      iodine_ug: round1(nutrition?.iodine_ug),
      cholesterol_mg: round1(nutrition?.cholesterol_mg),

      // ビタミン
      vitamin_a_ug: round1(nutrition?.vitamin_a_ug),
      vitamin_b1_mg: round2(nutrition?.vitamin_b1_mg),
      vitamin_b2_mg: round2(nutrition?.vitamin_b2_mg),
      vitamin_b6_mg: round2(nutrition?.vitamin_b6_mg),
      vitamin_b12_ug: round1(nutrition?.vitamin_b12_ug),
      vitamin_c_mg: round1(nutrition?.vitamin_c_mg),
      vitamin_d_ug: round1(nutrition?.vitamin_d_ug),
      vitamin_e_mg: round1(nutrition?.vitamin_e_mg),
      vitamin_k_ug: round1(nutrition?.vitamin_k_ug),
      folic_acid_ug: round1(nutrition?.folic_acid_ug),

      // 脂肪酸
      saturated_fat_g: round1(nutrition?.saturated_fat_g),
      monounsaturated_fat_g: round1(nutrition?.monounsaturated_fat_g),
      polyunsaturated_fat_g: round1(nutrition?.polyunsaturated_fat_g),

      // レシピDBソース（AIアドバイザーからの検索時）
      recipe_source: idx === 0 && recipeSource ? recipeSource : undefined,
    });
  }

  const dishName = dishDetails.length === 1
    ? String(dishDetails[0]?.name ?? "献立")
    : (() => {
        const names = dishDetails
          .slice(0, 3)
          .map((d: any) => String(d?.name ?? "").trim())
          .filter(Boolean);
        const base = names.join("、") || "献立";
        return base + (dishDetails.length > 3 ? " など" : "");
      })();

  const plannedMealData = {
    daily_meal_id: dayData.id,
    meal_type: targetSlot.mealType,
    dish_name: dishName,
    ingredients: aggregatedIngredients,
    recipe_steps: allSteps,
    dishes: dishDetails,
    mode: "ai_creative",
    is_simple: false,
    display_order: DISPLAY_ORDER_MAP[targetSlot.mealType] ?? 0,
    is_generating: false,
    is_completed: false,
    // Nutrition fields (丸めてDB保存 - 整数型や小数精度に合わせる)
    calories_kcal: Math.round(totalNutrition.calories_kcal ?? 0),
    protein_g: Math.round((totalNutrition.protein_g ?? 0) * 10) / 10,
    fat_g: Math.round((totalNutrition.fat_g ?? 0) * 10) / 10,
    carbs_g: Math.round((totalNutrition.carbs_g ?? 0) * 10) / 10,
    sodium_g: Math.round((totalNutrition.sodium_g ?? 0) * 10) / 10,
    sugar_g: Math.round((totalNutrition.sugar_g ?? 0) * 10) / 10,
    fiber_g: Math.round((totalNutrition.fiber_g ?? 0) * 10) / 10,
    fiber_soluble_g: Math.round((totalNutrition.fiber_soluble_g ?? 0) * 10) / 10,
    fiber_insoluble_g: Math.round((totalNutrition.fiber_insoluble_g ?? 0) * 10) / 10,
    potassium_mg: Math.round((totalNutrition.potassium_mg ?? 0) * 10) / 10,
    calcium_mg: Math.round((totalNutrition.calcium_mg ?? 0) * 10) / 10,
    magnesium_mg: Math.round((totalNutrition.magnesium_mg ?? 0) * 10) / 10,
    phosphorus_mg: Math.round((totalNutrition.phosphorus_mg ?? 0) * 10) / 10,
    iron_mg: Math.round((totalNutrition.iron_mg ?? 0) * 10) / 10,
    zinc_mg: Math.round((totalNutrition.zinc_mg ?? 0) * 10) / 10,
    iodine_ug: Math.round((totalNutrition.iodine_ug ?? 0) * 10) / 10,
    cholesterol_mg: Math.round((totalNutrition.cholesterol_mg ?? 0) * 10) / 10,
    vitamin_a_ug: Math.round((totalNutrition.vitamin_a_ug ?? 0) * 10) / 10,
    vitamin_b1_mg: Math.round((totalNutrition.vitamin_b1_mg ?? 0) * 10) / 10,
    vitamin_b2_mg: Math.round((totalNutrition.vitamin_b2_mg ?? 0) * 10) / 10,
    vitamin_b6_mg: Math.round((totalNutrition.vitamin_b6_mg ?? 0) * 10) / 10,
    vitamin_b12_ug: Math.round((totalNutrition.vitamin_b12_ug ?? 0) * 10) / 10,
    vitamin_c_mg: Math.round((totalNutrition.vitamin_c_mg ?? 0) * 10) / 10,
    vitamin_d_ug: Math.round((totalNutrition.vitamin_d_ug ?? 0) * 10) / 10,
    vitamin_e_mg: Math.round((totalNutrition.vitamin_e_mg ?? 0) * 10) / 10,
    vitamin_k_ug: Math.round((totalNutrition.vitamin_k_ug ?? 0) * 10) / 10,
    folic_acid_ug: Math.round((totalNutrition.folic_acid_ug ?? 0) * 10) / 10,
    saturated_fat_g: Math.round((totalNutrition.saturated_fat_g ?? 0) * 10) / 10,
    monounsaturated_fat_g: Math.round((totalNutrition.monounsaturated_fat_g ?? 0) * 10) / 10,
    polyunsaturated_fat_g: Math.round((totalNutrition.polyunsaturated_fat_g ?? 0) * 10) / 10,
    updated_at: new Date().toISOString(),
  };

  let plannedMealId = targetSlot.plannedMealId ?? null;

  // If plannedMealId is specified, update existing record
  if (targetSlot.plannedMealId) {
    const { error: updateError } = await supabase
      .from("planned_meals")
      .update(plannedMealData)
      .eq("id", targetSlot.plannedMealId);
    if (updateError) {
      console.error(`Failed to update planned_meal ${targetSlot.plannedMealId}:`, updateError);
      throw updateError;
    }
    console.log(`✅ Updated planned_meal ${targetSlot.plannedMealId}`);
  } else {
    // Check if slot already exists (should not happen if API validated correctly)
    const { data: existingMeal } = await supabase
      .from("planned_meals")
      .select("id")
      .eq("daily_meal_id", dayData.id)
      .eq("meal_type", targetSlot.mealType)
      .maybeSingle();

    if (existingMeal) {
      // This should not happen in V4 (empty slots only), log warning
      console.warn(`⚠️ Slot ${targetSlot.date}/${targetSlot.mealType} already exists, skipping to protect data`);
      return;
    }

    const { data: insertedMeal, error: insertError } = await supabase
      .from("planned_meals")
      .insert(plannedMealData)
      .select("id")
      .single();
    if (insertError) {
      console.error(`Failed to insert planned_meal:`, insertError);
      throw insertError;
    }
    plannedMealId = insertedMeal?.id ?? null;
    console.log(`✅ Created new planned_meal for ${targetSlot.date}/${targetSlot.mealType}`);
  }

  await Promise.all(
    nutritionDebugEntries.map((entry) =>
      insertMealNutritionDebugLog(supabase, {
        ...entry,
        plannedMealId,
        metadata: {
          ...(entry.metadata ?? {}),
          planned_meal_id: plannedMealId,
          meal_title: dishName,
        },
      }),
    ),
  );
}

// =========================================================
// Step execution (V3-compatible self-trigger)
// =========================================================

type V4GeneratedData = {
  version?: string;
  mealPlanId?: string;
  dates?: string[];
  targetSlots?: TargetSlot[];

  // Ultimate Mode flag
  ultimateMode?: boolean;

  // Context (persisted for continuation calls)
  existingMenus?: ExistingMenuContext[];
  fridgeItems?: FridgeItemContext[];
  userProfile?: any;
  seasonalContext?: SeasonalContext;
  constraints?: any;
  note?: string | null;
  familySize?: number;

  // LLM context
  nutritionTargets?: any | null;
  userContext?: any;
  userSummary?: string;
  references?: MenuReference[];

  // Health checkup data (for nutrition guidance in LLM context)
  healthCheckups?: HealthCheckupForContext[] | null;
  healthGuidance?: HealthCheckupGuidance | null;

  // Generated meals (key: YYYY-MM-DD:mealType)
  generatedMeals?: Record<string, GeneratedMeal>;

  // cursors
  step1?: { cursor?: number; batchSize?: number };
  step2?: {
    reviewResult?: any;
    issuesToFix?: any[];
    fixCursor?: number;
    maxFixes?: number;
    fixesPerRun?: number;
    swapsApplied?: boolean;
  };
  step3?: {
    cursor?: number;
    savedCount?: number;
    batchSize?: number;
    errors?: Array<{ key: string; error: string }>;
    nutritionCalculated?: boolean; // Ultimate mode: 栄養計算済みフラグ
  };
  // Ultimate Mode steps
  step4?: {
    cursor?: number;
    batchSize?: number;
    feedbackByDate?: Record<string, NutritionFeedbackResult & { issuesFound: string[] }>;
    daysNeedingImprovement?: string[];
  };
  step5?: {
    cursor?: number;
    batchSize?: number;
    regeneratedDates?: string[];
  };
  step6?: {
    cursor?: number;
    savedCount?: number;
    batchSize?: number;
    errors?: Array<{ key: string; error: string }>;
  };
};

function normalizeTargetSlots(dbSlots: any[]): TargetSlot[] {
  if (!Array.isArray(dbSlots)) return [];
  return dbSlots
    .map((s: any) => ({
      date: String(s?.date ?? "").slice(0, 10),
      mealType: String(s?.meal_type ?? s?.mealType ?? "") as MealType,
      plannedMealId: s?.planned_meal_id ?? s?.plannedMealId ?? undefined,
    }))
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && Boolean(s.mealType));
}

function uniqDatesFromSlots(slots: TargetSlot[]): string[] {
  const set = new Set<string>();
  for (const s of slots) set.add(s.date);
  return Array.from(set).sort();
}

function sortTargetSlots(slots: TargetSlot[]): TargetSlot[] {
  const order = (mt: MealType) => DISPLAY_ORDER_MAP[mt] ?? 999;
  return [...slots].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return order(a.mealType) - order(b.mealType);
  });
}

function countGeneratedTargetSlots(targetSlots: TargetSlot[], generatedMeals: Record<string, GeneratedMeal>): number {
  let n = 0;
  for (const s of targetSlots) {
    const key = getSlotKey(s.date, s.mealType);
    if (generatedMeals[key]) n++;
  }
  return n;
}

async function loadRequestRow(supabase: any, requestId: string) {
  const { data, error } = await supabase
    .from("weekly_menu_requests")
    .select("id, user_id, start_date, prompt, constraints, target_slots, generated_data, current_step, status")
    .eq("id", requestId)
    .single();
  if (error || !data) throw new Error(`Request not found: ${error?.message ?? "no data"}`);
  return data as any;
}

async function executeStep(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
  body: any,
  currentStep: number,
) {
  // LLMトークン使用量計測（各ステップごとにexecutionIdを生成）
  const executionId = generateExecutionId();

  await withOpenAIUsageContext({
    functionName: `generate-menu-v4-step${currentStep}`,
    executionId,
    requestId,
    userId,
    supabaseClient: supabase,
  }, async () => {
    switch (currentStep) {
      case 1:
        await executeStep1_Generate(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, body);
        break;
      case 2:
        await executeStep2_Review(supabase, supabaseUrl, supabaseServiceKey, userId, requestId);
        break;
      case 3:
        await executeStep3_Complete(supabase, supabaseUrl, supabaseServiceKey, userId, requestId);
        break;
      case 4:
        await executeStep4_NutritionFeedback(supabase, supabaseUrl, supabaseServiceKey, userId, requestId);
        break;
      case 5:
        await executeStep5_RegenerateWithAdvice(supabase, supabaseUrl, supabaseServiceKey, userId, requestId);
        break;
      case 6:
        await executeStep6_FinalSave(supabase, supabaseUrl, supabaseServiceKey, userId, requestId);
        break;
      default:
        throw new Error(`Unknown step: ${currentStep}`);
    }
  });
}

// =========================================================
// Step 1: Generate (batch by day)
// =========================================================

async function executeStep1_Generate(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
  body: any,
) {
  console.log("📝 V4 Step 1: Generating meals...");
  console.time("⏱️ Step1_Total");

  const reqRow = await loadRequestRow(supabase, requestId);
  if (reqRow.user_id && String(reqRow.user_id) !== String(userId)) {
    throw new Error("userId mismatch for request");
  }

  const generatedData: V4GeneratedData = (reqRow.generated_data ?? {}) as any;

  // targetSlots (prefer DB)
  const targetSlotsDb = normalizeTargetSlots(reqRow.target_slots ?? []);
  const targetSlotsBody = Array.isArray(body?.targetSlots) ? (body.targetSlots as TargetSlot[]) : [];
  const targetSlots = targetSlotsDb.length > 0 ? targetSlotsDb : targetSlotsBody;
  if (targetSlots.length === 0) throw new Error("targetSlots is empty");

  const dates = generatedData.dates?.length ? generatedData.dates : uniqDatesFromSlots(targetSlots);

  // Persisted contexts (prefer generated_data, else initial body)
  // Note: mealPlanId は日付ベースモデルでは不要（user_daily_meals を直接使用）

  const note: string | null = generatedData.note ?? (typeof body?.note === "string" ? body.note : null) ?? (typeof reqRow.prompt === "string" ? reqRow.prompt : null);
  const constraintsRaw = generatedData.constraints ?? body?.constraints ?? reqRow.constraints ?? {};

  const seasonalContext: SeasonalContext =
    (generatedData.seasonalContext ?? body?.seasonalContext) ??
    { month: new Date().getMonth() + 1, seasonalIngredients: { vegetables: [], fish: [], fruits: [] }, events: [] };

  const existingMenus: ExistingMenuContext[] = (generatedData.existingMenus ?? body?.existingMenus ?? []) as any[];
  const fridgeItems: FridgeItemContext[] = (generatedData.fridgeItems ?? body?.fridgeItems ?? []) as any[];
  const userProfile = generatedData.userProfile ?? body?.userProfile ?? {};

  const familySize = Number.isFinite(generatedData.familySize)
    ? Number(generatedData.familySize)
    : (Number.isFinite(body?.familySize) ? Number(body.familySize) : null) ??
      (Number.isFinite(userProfile?.family_size) ? Number(userProfile.family_size) : 1);

  const constraintsForContext = { ...(constraintsRaw ?? {}), familySize };
  const promptProfile = sanitizeGenerationPromptProfile(userProfile);
  const promptConstraints = sanitizeGenerationPromptConstraints(constraintsForContext);

  // Build (or reuse) LLM context
  const nutritionTargets =
    generatedData.nutritionTargets ??
    (await supabase.from("nutrition_goals").select("*").eq("user_id", userId).maybeSingle()).data ??
    null;

  // Fetch health checkup data (last 3 checkups + longitudinal review guidance)
  let healthCheckups: HealthCheckupForContext[] | null =
    generatedData.healthCheckups ?? null;
  let healthGuidance: HealthCheckupGuidance | null =
    generatedData.healthGuidance ?? null;

  if (!healthCheckups || !healthGuidance) {
    try {
      // Fetch recent 3 health checkups
      const { data: checkupsData } = await supabase
        .from("health_checkups")
        .select(`
          checkup_date,
          blood_pressure_systolic,
          blood_pressure_diastolic,
          hba1c,
          fasting_glucose,
          ldl_cholesterol,
          hdl_cholesterol,
          triglycerides,
          uric_acid,
          gamma_gtp,
          individual_review
        `)
        .eq("user_id", userId)
        .order("checkup_date", { ascending: false })
        .limit(3);

      healthCheckups = (checkupsData ?? []) as HealthCheckupForContext[];

      // Fetch longitudinal review for nutrition guidance
      const { data: reviewData } = await supabase
        .from("health_checkup_longitudinal_reviews")
        .select("nutrition_guidance")
        .eq("user_id", userId)
        .single();

      healthGuidance = (reviewData?.nutrition_guidance ?? null) as HealthCheckupGuidance | null;

      if (healthCheckups.length > 0) {
        console.log(`📋 Loaded ${healthCheckups.length} health checkups for context`);
      }
      if (healthGuidance) {
        console.log(`📋 Loaded health guidance: ${healthGuidance.generalDirection ?? "(no guidance)"}`);
      }
    } catch (e: any) {
      console.warn("Failed to fetch health checkup data (non-fatal):", e?.message);
      healthCheckups = null;
      healthGuidance = null;
    }
  }

  const userContext =
    generatedData.userContext ??
    buildUserContextForPrompt({
      profile: promptProfile,
      nutritionTargets,
      note,
      constraints: promptConstraints,
      healthCheckups,
      healthGuidance,
    });

  const userSummary =
    generatedData.userSummary ??
    buildUserSummary(promptProfile, nutritionTargets, note, promptConstraints, healthCheckups, healthGuidance);

  const references: MenuReference[] =
    generatedData.references ??
    await (async () => {
      await updateProgress(
        supabase,
        requestId,
        { currentStep: 0, totalSteps: targetSlots.length, message: "参考レシピを検索中...", completedSlots: 0, totalSlots: targetSlots.length },
        1,
      );
      const searchQuery = buildSearchQueryBase({
        profile: promptProfile,
        nutritionTargets,
        note,
        constraints: promptConstraints,
      });
      console.time("⏱️ searchMenuCandidates");
      const result = await searchMenuCandidates(supabase, searchQuery, 150);
      console.timeEnd("⏱️ searchMenuCandidates");
      return result;
    })();

  // Generated meals map (persisted)
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;

  // Cursor / batching
  const DAY_BATCH = Number(generatedData.step1?.batchSize ?? DEFAULT_STEP1_DAY_BATCH);
  const cursor = Number(generatedData.step1?.cursor ?? 0);
  const nextCursor = computeNextCursor({ cursor, batchSize: DAY_BATCH, length: dates.length });

  // Group slots by date (for this execution)
  const slotsByDate = new Map<string, TargetSlot[]>();
  for (const s of targetSlots) {
    if (!slotsByDate.has(s.date)) slotsByDate.set(s.date, []);
    slotsByDate.get(s.date)!.push(s);
  }

  await updateProgress(
    supabase,
    requestId,
    {
      currentStep: cursor,
      totalSteps: dates.length,
      message: `献立を生成中...（${cursor}/${dates.length}日）`,
      completedSlots: countGeneratedTargetSlots(targetSlots, generatedMeals),
      totalSlots: targetSlots.length,
    },
    1,
  );

  // ===== レシピDB直接指定の場合: LLM生成をスキップ =====
  // AIアドバイザーの search_recipes で見つけたレシピを直接使用
  if (constraintsForContext.recipeId || constraintsForContext.recipeExternalId) {
    console.log("📖 Recipe ID specified, resolving from database...");
    for (const slot of targetSlots) {
      const key = getSlotKey(slot.date, slot.mealType);
      if (generatedMeals[key]) continue; // 既に生成済み

      const resolved = await resolveRecipeFromDB(supabase, constraintsForContext, slot.mealType as MealType);
      if (resolved) {
        generatedMeals[key] = resolved.meal;
        // 栄養データとソース情報を拡張プロパティとして保存
        (generatedMeals[key] as any)._resolvedNutrition = resolved.nutrition;
        (generatedMeals[key] as any)._recipeSource = resolved.source;
        console.log(`✅ Resolved ${slot.date} ${slot.mealType}: ${resolved.meal.dishes[0]?.name ?? "(unknown)"}`);
      }
    }
  }

  const CONCURRENCY = 4; // 高速化: 2→4日並列
  for (let i = cursor; i < nextCursor; i += CONCURRENCY) {
    const batchDates = dates.slice(i, Math.min(i + CONCURRENCY, nextCursor));
    await Promise.all(
      batchDates.map(async (date) => {
        const slotsForDate = slotsByDate.get(date) ?? [];
        if (slotsForDate.length === 0) return;

        const uniqueMealTypes = Array.from(new Set(slotsForDate.map((s) => s.mealType))) as MealType[];
        const coreTypes = uniqueMealTypes.filter((t) => t === "breakfast" || t === "lunch" || t === "dinner");
        const otherTypes = uniqueMealTypes.filter((t) => !(t === "breakfast" || t === "lunch" || t === "dinner"));

        // core (day-based)
        if (coreTypes.length > 0) {
          const dayContext = buildV4DayContext({
            date,
            mealTypes: coreTypes,
            slotsForDate,
            existingMenus,
            fridgeItems,
            seasonalContext,
            userProfile,
            constraints: constraintsForContext,
          });
          const noteForDay = [note, dayContext].filter(Boolean).join("\n\n");

          console.time(`⏱️ generateDayMealsWithLLM[${date}]`);
          const dayMeals = await generateDayMealsWithLLM({
            userSummary,
            userContext,
            note: noteForDay,
            date,
            mealTypes: coreTypes,
            referenceMenus: references,
          });
          console.timeEnd(`⏱️ generateDayMealsWithLLM[${date}]`);

          for (const meal of dayMeals.meals ?? []) {
            const key = getSlotKey(date, meal.mealType);
            generatedMeals[key] = meal;
          }
        }

        // snack / midnight (slot-based)
        for (const mt of otherTypes) {
          const slot = slotsForDate.find((s) => s.mealType === mt);
          if (!slot) continue;
          const key = getSlotKey(slot.date, slot.mealType);
          if (generatedMeals[key]) continue;

          const contextText = buildV4Context({
            targetSlot: slot,
            existingMenus,
            fridgeItems,
            seasonalContext,
            userProfile,
            constraints: constraintsForContext,
            note: null,
          });
          const noteForMeal = [note, contextText].filter(Boolean).join("\n\n");

          const currentDishName =
            slot.plannedMealId
              ? existingMenus.find((m) => m.date === slot.date && m.mealType === slot.mealType)?.dishName ?? null
              : null;

          const meal = await generateMealWithLLM({
            userSummary,
            userContext,
            note: noteForMeal,
            mealType: slot.mealType as MealType,
            currentDishName,
            referenceMenus: references,
          });

          generatedMeals[key] = meal;
        }
      }),
    );
  }

  const generatedCount = countGeneratedTargetSlots(targetSlots, generatedMeals);
  const step1Done = nextCursor >= dates.length;

  // ultimateModeフラグを取得（body優先、なければgeneratedDataから）
  const ultimateMode = body?.ultimateMode ?? generatedData.ultimateMode ?? false;
  const totalSteps = ultimateMode ? 6 : 3;

  const updatedGeneratedData: V4GeneratedData = {
    ...generatedData,
    version: "v4",
    ultimateMode,
    dates,
    targetSlots,
    existingMenus,
    fridgeItems,
    userProfile,
    seasonalContext,
    constraints: constraintsForContext,
    note,
    familySize,
    nutritionTargets,
    userContext,
    userSummary,
    references,
    healthCheckups,
    healthGuidance,
    generatedMeals,
    step1: { cursor: nextCursor, batchSize: DAY_BATCH },
  };

  await supabase
    .from("weekly_menu_requests")
    .update({
      generated_data: updatedGeneratedData,
      current_step: step1Done ? 2 : 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  await updateProgress(
    supabase,
    requestId,
    {
      currentStep: step1Done ? 2 : 1,
      totalSteps,
      message: step1Done ? "生成完了。レビュー開始..." : `生成中...（${nextCursor}/${dates.length}日）`,
      completedSlots: generatedCount,
      totalSlots: targetSlots.length,
    },
    step1Done ? 2 : 1,
  );

  console.timeEnd("⏱️ Step1_Total");

  // Continue or next step
  await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId, userId);
}

// =========================================================
// Step 2: Review & Fix (batch by issues)
// =========================================================

async function executeStep2_Review(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
) {
  console.log("🔍 V4 Step 2: Reviewing meals...");

  const reqRow = await loadRequestRow(supabase, requestId);
  if (reqRow.user_id && String(reqRow.user_id) !== String(userId)) {
    throw new Error("userId mismatch for request");
  }

  const generatedData: V4GeneratedData = (reqRow.generated_data ?? {}) as any;
  const ultimateMode = generatedData.ultimateMode ?? false;
  const totalSteps = ultimateMode ? 6 : 3;

  const targetSlots = generatedData.targetSlots ?? normalizeTargetSlots(reqRow.target_slots ?? []);
  const dates = generatedData.dates ?? uniqDatesFromSlots(targetSlots);
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;

  const existingMenus: ExistingMenuContext[] = (generatedData.existingMenus ?? []) as any[];
  const fridgeItems: FridgeItemContext[] = (generatedData.fridgeItems ?? []) as any[];
  const seasonalContext: SeasonalContext =
    generatedData.seasonalContext ??
    { month: new Date().getMonth() + 1, seasonalIngredients: { vegetables: [], fish: [], fruits: [] }, events: [] };
  const userProfile = generatedData.userProfile ?? {};
  const constraints = generatedData.constraints ?? {};
  const note: string | null = generatedData.note ?? null;
  const userContext = generatedData.userContext;
  const userSummary = generatedData.userSummary ?? "";
  const references: MenuReference[] = (generatedData.references ?? []) as any[];

  const targetKeySet = new Set<string>(targetSlots.map((s) => getSlotKey(s.date, s.mealType)));

  let step2 = generatedData.step2 ?? {};

  // Review once (persist)
  if (!step2.reviewResult) {
    await updateProgress(
      supabase,
      requestId,
      { currentStep: 2, totalSteps, message: "献立の重複・バランスをAIがチェック中...", completedSlots: 0, totalSlots: targetSlots.length },
      2,
    );

    const existingByKey = new Map<string, string[]>();
    for (const m of existingMenus) {
      const key = getSlotKey(m.date, m.mealType);
      if (!existingByKey.has(key)) existingByKey.set(key, []);
      if (m.dishName) existingByKey.get(key)!.push(m.dishName);
    }

    const allTypes: MealType[] = ["breakfast", "lunch", "dinner", "snack", "midnight_snack"];
    const weeklyMealsSummary: WeeklyMealsSummary[] = dates
      .map((date) => {
        const meals: Array<{ mealType: MealType; dishNames: string[] }> = [];
        for (const mt of allTypes) {
          const key = getSlotKey(date, mt);
          const gm = generatedMeals[key];
          if (gm) {
            meals.push({ mealType: mt, dishNames: (gm.dishes ?? []).map((d: any) => String(d?.name ?? "").trim()).filter(Boolean) });
            continue;
          }
          const ex = existingByKey.get(key);
          if (ex && ex.length > 0) {
            meals.push({ mealType: mt, dishNames: ex });
          }
        }
        return { date, meals };
      })
      .filter((d) => d.meals.length > 0);

    const reviewResult = await reviewWeeklyMenus({
      weeklyMeals: weeklyMealsSummary,
      userSummary,
    });

    const issuesToFix = (reviewResult.issues ?? []).filter((iss: any) => {
      const key = getSlotKey(String(iss.date), String(iss.mealType) as MealType);
      return targetKeySet.has(key) && Boolean(generatedMeals[key]);
    });

    // Fix budget: V3「2件/週（=7日）」を期間に応じてスケール（capあり）
    const maxFixes = computeMaxFixesForRange({
      days: dates.length,
      issuesCount: issuesToFix.length,
    });

    step2 = {
      reviewResult,
      issuesToFix,
      fixCursor: 0,
      maxFixes,
      fixesPerRun: DEFAULT_STEP2_FIXES_PER_RUN,
      swapsApplied: false,
    };
  }

  const issuesToFix: any[] = Array.isArray(step2.issuesToFix) ? step2.issuesToFix : [];
  const maxFixes = Number.isFinite(step2.maxFixes)
    ? Number(step2.maxFixes)
    : computeMaxFixesForRange({ days: dates.length, issuesCount: issuesToFix.length });
  const fixesPerRun = Number.isFinite(step2.fixesPerRun) ? Number(step2.fixesPerRun) : DEFAULT_STEP2_FIXES_PER_RUN;
  const fixCursor = Number.isFinite(step2.fixCursor) ? Number(step2.fixCursor) : 0;

  const end = Math.min(fixCursor + fixesPerRun, maxFixes, issuesToFix.length);

  if (end > fixCursor) {
    await updateProgress(
      supabase,
      requestId,
      { currentStep: 2, totalSteps, message: `改善中...（${fixCursor}/${maxFixes}）`, completedSlots: 0, totalSlots: targetSlots.length },
      2,
    );

    // Index slots by key for context
    const slotByKey = new Map<string, TargetSlot>();
    for (const s of targetSlots) slotByKey.set(getSlotKey(s.date, s.mealType), s);

    for (let i = fixCursor; i < end; i++) {
      const issue = issuesToFix[i];
      const date = String(issue.date);
      const mealType = String(issue.mealType) as MealType;
      const key = getSlotKey(date, mealType);
      const current = generatedMeals[key];
      if (!current) continue;

      const currentDishes = (current.dishes ?? []).map((d: any) => String(d?.name ?? "").trim()).filter(Boolean);
      const slot = slotByKey.get(key);
      if (!slot) continue;

      const contextText = buildV4Context({
        targetSlot: slot,
        existingMenus,
        fridgeItems,
        seasonalContext,
        userProfile,
        constraints,
        note: null,
      });
      const noteForFix = [note, contextText].filter(Boolean).join("\n\n");

      const fixedMeal = await regenerateMealForIssue({
        userSummary,
        userContext,
        note: noteForFix,
        date,
        mealType,
        currentDishes,
        issue: String(issue.issue ?? ""),
        suggestion: String(issue.suggestion ?? ""),
        referenceMenus: references,
      });

      generatedMeals[key] = fixedMeal;
    }
  }

  const newFixCursor = end;

  // Persist intermediate state
  const updatedGeneratedData: V4GeneratedData = {
    ...generatedData,
    generatedMeals,
    step2: {
      ...step2,
      fixCursor: newFixCursor,
    },
  };

  // Continue fixing?
  if (newFixCursor < maxFixes && newFixCursor < issuesToFix.length) {
    await supabase
      .from("weekly_menu_requests")
      .update({
        generated_data: updatedGeneratedData,
        current_step: 2,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);

    await updateProgress(
      supabase,
      requestId,
      { currentStep: 2, totalSteps, message: `改善中...（${newFixCursor}/${maxFixes}）`, completedSlots: 0, totalSlots: targetSlots.length },
      2,
    );

    await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  // Apply swaps once (only when both slots are target + generated)
  if (!step2.swapsApplied && step2.reviewResult?.swaps?.length) {
    for (const swap of step2.reviewResult.swaps as any[]) {
      if (swap.date1 !== swap.date2) continue;
      const date = String(swap.date1);
      const mt1 = String(swap.mealType1) as MealType;
      const mt2 = String(swap.mealType2) as MealType;
      const k1 = getSlotKey(date, mt1);
      const k2 = getSlotKey(date, mt2);
      if (!targetKeySet.has(k1) || !targetKeySet.has(k2)) continue;
      if (!generatedMeals[k1] || !generatedMeals[k2]) continue;

      const temp = generatedMeals[k1];
      generatedMeals[k1] = { ...generatedMeals[k2], mealType: mt1 };
      generatedMeals[k2] = { ...temp, mealType: mt2 };
      console.log(`Swapped ${date} ${mt1} <-> ${mt2}`);
    }
    updatedGeneratedData.step2 = { ...updatedGeneratedData.step2, swapsApplied: true };
  }

  // Move to Step 3
  await supabase
    .from("weekly_menu_requests")
    .update({
      generated_data: updatedGeneratedData,
      current_step: 3,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  await updateProgress(
    supabase,
    requestId,
    { currentStep: 3, totalSteps, message: "レビュー完了。栄養計算・保存開始...", completedSlots: 0, totalSlots: targetSlots.length },
    3,
  );

  await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId, userId);
}

// =========================================================
// Step 3: Nutrition & Save (batch by slots)
// Ultimate Mode: 栄養計算のみ（保存しない）→ Step 4へ
// Normal Mode: 栄養計算 + 保存 → 完了
// =========================================================

async function executeStep3_Complete(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
) {
  console.log("💾 V4 Step 3: Nutrition & saving...");

  const reqRow = await loadRequestRow(supabase, requestId);
  if (reqRow.user_id && String(reqRow.user_id) !== String(userId)) {
    throw new Error("userId mismatch for request");
  }

  const generatedData: V4GeneratedData = (reqRow.generated_data ?? {}) as any;
  const ultimateMode = generatedData.ultimateMode ?? false;
  const totalSteps = ultimateMode ? 6 : 3;

  const targetSlots = sortTargetSlots(generatedData.targetSlots ?? normalizeTargetSlots(reqRow.target_slots ?? []));
  const totalSlots = targetSlots.length;
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;

  const step3 = generatedData.step3 ?? {};
  const BATCH = Number(step3.batchSize ?? DEFAULT_STEP3_SLOT_BATCH);
  const cursor = Number(step3.cursor ?? 0);
  const savedCountStart = Number(step3.savedCount ?? 0);
  const errors: Array<{ key: string; error: string }> = Array.isArray(step3.errors) ? step3.errors : [];

  const end = Math.min(cursor + BATCH, totalSlots);
  let savedCount = savedCountStart;

  const stepMessage = ultimateMode ? "栄養計算中..." : "保存中...";
  await updateProgress(
    supabase,
    requestId,
    { currentStep: 3, totalSteps, message: `${stepMessage}（${cursor}/${totalSlots}）`, completedSlots: cursor, totalSlots },
    3,
  );

  for (let i = cursor; i < end; i++) {
    const slot = targetSlots[i];
    const key = getSlotKey(slot.date, slot.mealType);
    const meal = generatedMeals[key];
    if (!meal) {
      errors.push({ key, error: "No generated meal" });
      continue;
    }
    try {
      if (ultimateMode) {
        // Ultimate Mode: 栄養計算のみ（保存はStep 6で行う）
        // saveMealToDbの栄養計算部分だけを実行し、generatedMealsに栄養情報を付加
        // Note: 実際の栄養計算はStep 6で行うので、ここでは進捗だけ更新
        savedCount++;
      } else {
        // Normal Mode: 栄養計算 + 保存
        await saveMealToDb(supabase, { userId, requestId, targetSlot: slot, generatedMeal: meal });
        savedCount++;
      }
    } catch (e: any) {
      errors.push({ key, error: e?.message ?? String(e) });
    }

    const processedCount = i + 1;
    await updateProgress(
      supabase,
      requestId,
      { currentStep: 3, totalSteps, message: `${stepMessage}（${processedCount}/${totalSlots}）`, completedSlots: processedCount, totalSlots },
      3,
    );
  }

  const newCursor = end;

  const updatedGeneratedData: V4GeneratedData = {
    ...generatedData,
    step3: {
      cursor: newCursor,
      batchSize: BATCH,
      savedCount,
      errors: errors.slice(-200),
      nutritionCalculated: newCursor >= totalSlots,
    },
  };

  // Continue?
  if (newCursor < totalSlots) {
    await supabase
      .from("weekly_menu_requests")
      .update({
        generated_data: updatedGeneratedData,
        current_step: 3,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);

    await updateProgress(
      supabase,
      requestId,
      { currentStep: 3, totalSteps, message: `${stepMessage}（${newCursor}/${totalSlots}）`, completedSlots: savedCount, totalSlots },
      3,
    );

    await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  // Ultimate Mode: Step 4へ進む
  if (ultimateMode) {
    await supabase
      .from("weekly_menu_requests")
      .update({
        generated_data: updatedGeneratedData,
        current_step: 4,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);

    await updateProgress(
      supabase,
      requestId,
      { currentStep: 4, totalSteps: 6, message: "栄養バランスを分析中...", completedSlots: 0, totalSlots },
      4,
    );

    await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  // Normal Mode: Done
  const hasErrors = errors.length > 0;
  const finalStatus = hasErrors ? (savedCount > 0 ? "completed" : "failed") : "completed";
  const finalMessage = hasErrors
    ? `保存完了（成功${savedCount}/${totalSlots}、エラー${errors.length}）`
    : `全${totalSlots}件の献立が完成しました！`;

  await supabase
    .from("weekly_menu_requests")
    .update({
      status: finalStatus,
      generated_data: updatedGeneratedData,
      current_step: 3,
      progress: {
        currentStep: 3,
        totalSteps, // Normal mode: 3, Ultimate mode won't reach here
        message: finalMessage,
        completedSlots: savedCount,
        totalSlots,
      },
      error_message: hasErrors ? errors.slice(0, 20).map((e) => `${e.key}: ${e.error}`).join("; ") : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);
}

// =========================================================
// Step 4: Nutrition Feedback Analysis (Ultimate Mode only)
// 各日の栄養バランスを分析し、改善アドバイスを生成
// =========================================================

async function executeStep4_NutritionFeedback(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
) {
  console.log("📊 V4 Step 4: Nutrition feedback analysis...");

  const reqRow = await loadRequestRow(supabase, requestId);
  if (reqRow.user_id && String(reqRow.user_id) !== String(userId)) {
    throw new Error("userId mismatch for request");
  }

  const generatedData: V4GeneratedData = (reqRow.generated_data ?? {}) as any;
  const dates = generatedData.dates ?? [];
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;
  const userSummary = generatedData.userSummary ?? "";

  const step4 = generatedData.step4 ?? {};
  const BATCH = Number(step4.batchSize ?? DEFAULT_STEP4_DAY_BATCH);
  const cursor = Number(step4.cursor ?? 0);
  const feedbackByDate: Record<string, NutritionFeedbackResult & { issuesFound: string[] }> =
    (step4.feedbackByDate ?? {}) as any;
  const daysNeedingImprovement: string[] = step4.daysNeedingImprovement ?? [];

  const end = Math.min(cursor + BATCH, dates.length);

  await updateProgress(
    supabase,
    requestId,
    { currentStep: 4, totalSteps: 6, message: `栄養バランスを分析中...（${cursor}/${dates.length}日）`, completedSlots: cursor, totalSlots: dates.length },
    4,
  );

  // 週間データを構築
  const weekData = buildWeekDataFromMeals(generatedMeals, dates);

  for (let i = cursor; i < end; i++) {
    const date = dates[i];

    // その日の栄養データを集計
    const dayNutrition = aggregateDayNutrition(generatedMeals, date);

    // その日の食事数をカウント
    const mealCount = Object.keys(generatedMeals).filter(key => key.startsWith(`${date}:`)).length;

    try {
      // フィードバック生成
      const feedback = await generateNutritionFeedback(
        date,
        dayNutrition,
        mealCount,
        weekData,
        userSummary
      );

      // 問題点を抽出（adviceから簡易抽出）
      const issuesFound: string[] = [];
      if (feedback.advice.includes("不足")) issuesFound.push("栄養素不足");
      if (feedback.advice.includes("過剰")) issuesFound.push("栄養素過剰");
      if (feedback.advice.includes("バランス")) issuesFound.push("バランス改善");

      feedbackByDate[date] = {
        ...feedback,
        issuesFound,
      };

      // 改善が必要な日かどうか判定（アドバイスがある場合）
      if (feedback.advice && feedback.advice.length > 50) {
        if (!daysNeedingImprovement.includes(date)) {
          daysNeedingImprovement.push(date);
        }
      }

      console.log(`📊 [${date}] Feedback generated: ${issuesFound.join(", ") || "良好"}`);
    } catch (e: any) {
      console.error(`❌ [${date}] Feedback generation failed:`, e?.message);
      // フォールバック
      feedbackByDate[date] = {
        praiseComment: "バランスの良い食事を心がけていますね✨",
        advice: "",
        nutritionTip: "",
        issuesFound: [],
      };
    }
  }

  const newCursor = end;

  const updatedGeneratedData: V4GeneratedData = {
    ...generatedData,
    step4: {
      cursor: newCursor,
      batchSize: BATCH,
      feedbackByDate,
      daysNeedingImprovement,
    },
  };

  // Continue?
  if (newCursor < dates.length) {
    await supabase
      .from("weekly_menu_requests")
      .update({
        generated_data: updatedGeneratedData,
        current_step: 4,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);

    await updateProgress(
      supabase,
      requestId,
      { currentStep: 4, totalSteps: 6, message: `栄養バランスを分析中...（${newCursor}/${dates.length}日）`, completedSlots: newCursor, totalSlots: dates.length },
      4,
    );

    await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  // Move to Step 5
  console.log(`📊 Step 4 完了: ${daysNeedingImprovement.length}日が改善対象`);

  await supabase
    .from("weekly_menu_requests")
    .update({
      generated_data: updatedGeneratedData,
      current_step: 5,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  await updateProgress(
    supabase,
    requestId,
    { currentStep: 5, totalSteps: 6, message: "アドバイスを反映して献立を改善中...", completedSlots: 0, totalSlots: daysNeedingImprovement.length },
    5,
  );

  await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId, userId);
}

// =========================================================
// Step 5: Regenerate with Advice (Ultimate Mode only)
// アドバイスを反映した献立を再生成
// =========================================================

async function executeStep5_RegenerateWithAdvice(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
) {
  console.log("🔄 V4 Step 5: Regenerating meals with advice...");

  const reqRow = await loadRequestRow(supabase, requestId);
  if (reqRow.user_id && String(reqRow.user_id) !== String(userId)) {
    throw new Error("userId mismatch for request");
  }

  const generatedData: V4GeneratedData = (reqRow.generated_data ?? {}) as any;
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;
  const targetSlots = generatedData.targetSlots ?? [];

  const existingMenus = generatedData.existingMenus ?? [];
  const fridgeItems = generatedData.fridgeItems ?? [];
  const seasonalContext = generatedData.seasonalContext ?? { month: new Date().getMonth() + 1, seasonalIngredients: { vegetables: [], fish: [], fruits: [] }, events: [] };
  const userProfile = generatedData.userProfile ?? {};
  const constraints = generatedData.constraints ?? {};
  const note = generatedData.note ?? null;
  const userContext = generatedData.userContext;
  const userSummary = generatedData.userSummary ?? "";
  const references = generatedData.references ?? [];

  const step4 = generatedData.step4 ?? {};
  const feedbackByDate = step4.feedbackByDate ?? {};
  const daysNeedingImprovement = step4.daysNeedingImprovement ?? [];

  const step5 = generatedData.step5 ?? {};
  const BATCH = Number(step5.batchSize ?? DEFAULT_STEP5_DAY_BATCH);
  const cursor = Number(step5.cursor ?? 0);
  const regeneratedDates: string[] = step5.regeneratedDates ?? [];

  const end = Math.min(cursor + BATCH, daysNeedingImprovement.length);

  await updateProgress(
    supabase,
    requestId,
    { currentStep: 5, totalSteps: 6, message: `献立を改善中...（${cursor}/${daysNeedingImprovement.length}日）`, completedSlots: cursor, totalSlots: daysNeedingImprovement.length },
    5,
  );

  // Group slots by date
  const slotsByDate = new Map<string, TargetSlot[]>();
  for (const s of targetSlots) {
    if (!slotsByDate.has(s.date)) slotsByDate.set(s.date, []);
    slotsByDate.get(s.date)!.push(s);
  }

  for (let i = cursor; i < end; i++) {
    const date = daysNeedingImprovement[i];
    const feedback = feedbackByDate[date];
    if (!feedback || !feedback.advice) {
      regeneratedDates.push(date);
      continue;
    }

    const slotsForDate = slotsByDate.get(date) ?? [];
    if (slotsForDate.length === 0) {
      regeneratedDates.push(date);
      continue;
    }

    const mealTypes = Array.from(new Set(slotsForDate.map(s => s.mealType))) as MealType[];
    const coreTypes = mealTypes.filter(t => t === "breakfast" || t === "lunch" || t === "dinner");

    if (coreTypes.length > 0) {
      // アドバイスを含めたコンテキストを構築
      const dayContext = buildV4DayContext({
        date,
        mealTypes: coreTypes,
        slotsForDate,
        existingMenus: existingMenus as ExistingMenuContext[],
        fridgeItems: fridgeItems as FridgeItemContext[],
        seasonalContext: seasonalContext as SeasonalContext,
        userProfile,
        constraints,
      });

      // アドバイスを追加したnote（置換指示を優先）
      const mealTypeLabels: Record<string, string> = {
        breakfast: '朝食',
        lunch: '昼食',
        dinner: '夕食',
      };
      const replacementInstructions = feedback.replacements?.map(r =>
        `- ${mealTypeLabels[r.meal] || r.meal}の「${r.target}」→「${r.replacement}」${r.nutrientGain ? `（${r.nutrientGain}）` : ''}`
      ).join('\n');

      const adviceNote = replacementInstructions
        ? `【献立改善指示】
以下の置換を反映した献立を生成してください。カロリーは現状を維持すること。

${replacementInstructions}

重要: 上記の置換指示に従い、カロリーを増やさずに栄養バランスを改善してください。`
        : `【栄養士からのアドバイス】
${feedback.advice}

上記アドバイスを反映した献立を生成してください。カロリーを増やさないように注意。`;

      const noteForDay = [note, dayContext, adviceNote].filter(Boolean).join("\n\n");

      try {
        console.time(`⏱️ regenerateDayMeals[${date}]`);
        const dayMeals = await generateDayMealsWithLLM({
          userSummary,
          userContext,
          note: noteForDay,
          date,
          mealTypes: coreTypes,
          referenceMenus: references as MenuReference[],
        });
        console.timeEnd(`⏱️ regenerateDayMeals[${date}]`);

        // generatedMealsを更新
        for (const meal of dayMeals.meals ?? []) {
          const key = getSlotKey(date, meal.mealType);
          generatedMeals[key] = meal;
        }

        console.log(`🔄 [${date}] Regenerated ${coreTypes.length} meals with advice`);
      } catch (e: any) {
        console.error(`❌ [${date}] Regeneration failed:`, e?.message);
        // 失敗しても既存の献立を維持
      }
    }

    regeneratedDates.push(date);
  }

  const newCursor = end;

  const updatedGeneratedData: V4GeneratedData = {
    ...generatedData,
    generatedMeals,
    step5: {
      cursor: newCursor,
      batchSize: BATCH,
      regeneratedDates,
    },
  };

  // Continue?
  if (newCursor < daysNeedingImprovement.length) {
    await supabase
      .from("weekly_menu_requests")
      .update({
        generated_data: updatedGeneratedData,
        current_step: 5,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);

    await updateProgress(
      supabase,
      requestId,
      { currentStep: 5, totalSteps: 6, message: `献立を改善中...（${newCursor}/${daysNeedingImprovement.length}日）`, completedSlots: newCursor, totalSlots: daysNeedingImprovement.length },
      5,
    );

    await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  // Move to Step 6
  console.log(`🔄 Step 5 完了: ${regeneratedDates.length}日を再生成`);

  await supabase
    .from("weekly_menu_requests")
    .update({
      generated_data: updatedGeneratedData,
      current_step: 6,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  const totalSlots = targetSlots.length;
  await updateProgress(
    supabase,
    requestId,
    { currentStep: 6, totalSteps: 6, message: "最終調整・保存中...", completedSlots: 0, totalSlots },
    6,
  );

  await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId, userId);
}

// =========================================================
// Step 6: Final Save (Ultimate Mode only)
// 最終的な献立を保存
// =========================================================

async function executeStep6_FinalSave(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
) {
  console.log("💾 V4 Step 6: Final save...");

  const reqRow = await loadRequestRow(supabase, requestId);
  if (reqRow.user_id && String(reqRow.user_id) !== String(userId)) {
    throw new Error("userId mismatch for request");
  }

  const generatedData: V4GeneratedData = (reqRow.generated_data ?? {}) as any;
  const targetSlots = sortTargetSlots(generatedData.targetSlots ?? normalizeTargetSlots(reqRow.target_slots ?? []));
  const totalSlots = targetSlots.length;
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;

  const step6 = generatedData.step6 ?? {};
  const BATCH = Number(step6.batchSize ?? DEFAULT_STEP6_SLOT_BATCH);
  const cursor = Number(step6.cursor ?? 0);
  const savedCountStart = Number(step6.savedCount ?? 0);
  const errors: Array<{ key: string; error: string }> = Array.isArray(step6.errors) ? step6.errors : [];

  const end = Math.min(cursor + BATCH, totalSlots);
  let savedCount = savedCountStart;

  await updateProgress(
    supabase,
    requestId,
    { currentStep: 6, totalSteps: 6, message: `最終保存中...（${cursor}/${totalSlots}）`, completedSlots: cursor, totalSlots },
    6,
  );

  for (let i = cursor; i < end; i++) {
    const slot = targetSlots[i];
    const key = getSlotKey(slot.date, slot.mealType);
    const meal = generatedMeals[key];
    if (!meal) {
      errors.push({ key, error: "No generated meal" });
      continue;
    }
    try {
      await saveMealToDb(supabase, { userId, requestId, targetSlot: slot, generatedMeal: meal });
      savedCount++;
    } catch (e: any) {
      errors.push({ key, error: e?.message ?? String(e) });
    }

    const processedCount = i + 1;
    await updateProgress(
      supabase,
      requestId,
      { currentStep: 6, totalSteps: 6, message: `最終保存中...（${processedCount}/${totalSlots}）`, completedSlots: processedCount, totalSlots },
      6,
    );
  }

  const newCursor = end;

  const updatedGeneratedData: V4GeneratedData = {
    ...generatedData,
    step6: {
      cursor: newCursor,
      batchSize: BATCH,
      savedCount,
      errors: errors.slice(-200),
    },
  };

  // Continue?
  if (newCursor < totalSlots) {
    await supabase
      .from("weekly_menu_requests")
      .update({
        generated_data: updatedGeneratedData,
        current_step: 6,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);

    await updateProgress(
      supabase,
      requestId,
      { currentStep: 6, totalSteps: 6, message: `最終保存中...（${newCursor}/${totalSlots}）`, completedSlots: savedCount, totalSlots },
      6,
    );

    await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  // Done - Ultimate Mode completed!
  const hasErrors = errors.length > 0;
  const finalStatus = hasErrors ? (savedCount > 0 ? "completed" : "failed") : "completed";

  // 最終フィードバックを取得
  const step4 = generatedData.step4 ?? {};
  const feedbackByDate = step4.feedbackByDate ?? {};
  const firstFeedback = Object.values(feedbackByDate)[0];
  const praiseComment = firstFeedback?.praiseComment ?? "";

  const finalMessage = hasErrors
    ? `保存完了（成功${savedCount}/${totalSlots}、エラー${errors.length}）`
    : `全${totalSlots}件の献立が完成しました！${praiseComment ? ` ${praiseComment}` : ""}`;

  await supabase
    .from("weekly_menu_requests")
    .update({
      status: finalStatus,
      generated_data: updatedGeneratedData,
      current_step: 6,
      progress: {
        currentStep: 6,
        totalSteps: 6,
        message: finalMessage,
        completedSlots: savedCount,
        totalSlots,
      },
      error_message: hasErrors ? errors.slice(0, 20).map((e) => `${e.key}: ${e.error}`).join("; ") : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  console.log(`✅ Ultimate Mode completed: ${savedCount}/${totalSlots} meals saved`);
}

// =========================================================
// Main Handler
// =========================================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceKey = Deno.env.get("SERVICE_ROLE_JWT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let requestId: string | null = null;
  let userId: string | null = null;

  try {
    const body = await req.json().catch(() => ({}));
    requestId = body.request_id ?? body.requestId ?? null;
    const isContinue = body._continue === true;

    const authHeader = req.headers.get("Authorization") ?? "";
    const accessToken = authHeader.replace(/^Bearer\\s+/i, "").trim();
    if (!accessToken) throw new Error("Missing access token");
    if (!requestId) throw new Error("request_id is required");

    // 継続呼び出し（_continue=true）の場合、SERVICE_ROLE_KEYで呼ばれるので getUser()は使えない
    if (isContinue) {
      if (!body.userId) throw new Error("userId is required for continuation calls");
      userId = body.userId;
      console.log(`📍 Continuation call with userId: ${userId}`);
    } else if (body.userId) {
      userId = body.userId;
    } else {
      const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
      if (userErr || !userData?.user) throw new Error(`Auth failed: ${userErr?.message ?? "no user"}`);
      userId = userData.user.id;
    }

    // 現在のステップを取得
    let currentStep = 1;
    if (requestId && isContinue) {
      const { data: reqData } = await supabase
        .from("weekly_menu_requests")
        .select("current_step")
        .eq("id", requestId)
        .single();
      currentStep = reqData?.current_step ?? 1;
    }

    console.log(`📍 Starting step ${currentStep} for request ${requestId}`);

    const wrappedBackgroundTask = async () => {
      console.log(`🚀 Step ${currentStep} starting...`);
      try {
        await executeStep(supabase, supabaseUrl, supabaseServiceKey, userId!, requestId!, body, currentStep);
        console.log(`✅ Step ${currentStep} completed successfully`);
      } catch (bgErr: any) {
        console.error(`❌ Step ${currentStep} error:`, bgErr?.message ?? String(bgErr), bgErr);
        if (requestId) {
          await supabase
            .from("weekly_menu_requests")
            .update({
              status: "failed",
              error_message: bgErr?.message ?? String(bgErr) ?? "Step error",
              updated_at: new Date().toISOString(),
            })
            .eq("id", requestId);
        }
      }
    };

    // @ts-ignore EdgeRuntime
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      console.log("📤 Using EdgeRuntime.waitUntil for background processing");
      // @ts-ignore EdgeRuntime
      EdgeRuntime.waitUntil(wrappedBackgroundTask());
      return new Response(
        JSON.stringify({ status: "processing", request_id: requestId, step: currentStep, message: `Step ${currentStep} を実行中...` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log("⚠️ EdgeRuntime.waitUntil not available, running synchronously");
    await wrappedBackgroundTask();
    return new Response(
      JSON.stringify({ status: "completed", request_id: requestId, message: "完了" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    const errorMessage = err?.message ?? String(err) ?? "Unknown error";
    console.error("Request error:", errorMessage, err);
    
    if (requestId) {
      await supabase
        .from("weekly_menu_requests")
        .update({
          status: "failed",
          error_message: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);
    }

    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
