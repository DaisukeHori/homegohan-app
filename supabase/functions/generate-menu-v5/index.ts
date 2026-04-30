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
  reviewWeeklyMenus,
  type GeneratedMeal,
  type MealType,
  type MenuReference,
  type ReviewResult,
  type WeeklyMealsSummary,
} from "../_shared/meal-generator.ts";
import {
  generateDayMealsWithLLM_V5,
  generateMealWithLLM_V5,
  regenerateMealForIssue_V5,
} from "../_shared/meal-generator-v5.ts";
import { generateExecutionId, withOpenAIUsageContext } from "../_shared/llm-usage.ts";
import { setV4FastLLMOverride } from "../_shared/v4-fast-llm.ts";
import {
  emptyNutrition,
  type NutritionTotals,
} from "../_shared/nutrition-calculator.ts";
import {
  generateNutritionFeedback,
  aggregateDayNutrition,
  buildWeekDataFromMeals,
  type NutritionFeedbackResult,
} from "../_shared/nutrition-feedback.ts";
import { createLogger } from "../_shared/db-logger.ts";
import {
  fetchWithRetry,
  isRetryableError,
  withRetry,
  withTimeout,
} from "../_shared/network-retry.ts";
import {
  DATASET_EMBEDDING_API_KEY_ENV,
  DATASET_EMBEDDING_DIMENSIONS,
  fetchSingleDatasetEmbedding,
} from "../../../shared/dataset-embedding.mjs";
import {
  buildReferenceMenuSummary,
  computeReferenceSearchMatchCount,
  rerankMenuReferenceCandidates,
  shouldSkipReferenceMenuSearch,
} from "../generate-menu-v4/reference-menu-utils.ts";
import { selectRecentMenusForVariety } from "../generate-menu-v4/context-utils.ts";
import {
  DEFAULT_STEP1_DAY_BATCH,
  DEFAULT_STEP2_FIXES_PER_RUN,
  DEFAULT_STEP3_SLOT_BATCH,
  DEFAULT_STEP4_DAY_BATCH,
  DEFAULT_STEP5_DAY_BATCH,
  DEFAULT_STEP6_SLOT_BATCH,
  computeMaxFixesForRange,
  countGeneratedTargetSlots,
  getSlotKey,
  normalizeTargetSlots,
  sortTargetSlots,
  summarizeSaveResults,
  uniqDatesFromSlots,
  type PostNutritionIssue,
  type SaveIssue,
  type TargetSlot,
} from "../generate-menu-v4/step-utils.ts";
import {
  saveMealToDb,
  ensureDailyMealIdsForDates,
  deserializeIngredientMatchCache,
  serializeIngredientMatchCache,
  type PersistedIngredientMatchCache,
} from "../_shared/save-meal.ts";
import {
  buildTemplateCatalog,
  type DatasetMenuSetRaw,
  type MenuTemplate,
} from "./template-catalog.ts";
import {
  normalizeSlotPlanForPrompt,
  normalizeSlotPlansForPrompt,
  planDiversityForRange,
  type SlotPlan,
} from "./diversity-scheduler.ts";
import {
  fingerprintExistingMenu,
  fingerprintGeneratedMeal,
  fingerprintTemplate,
} from "./diversity-fingerprint.ts";
import { inferSodiumMode } from "./diversity-taxonomy.ts";
import {
  validateGeneratedMeals,
  type DiversityViolation,
} from "./diversity-validator.ts";

console.log("Generate Menu V5 Function loaded (template-anchored generation)");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_V5_INVOCATION_SOFT_BUDGET_MS = Number(Deno.env.get("V5_INVOCATION_SOFT_BUDGET_MS") ?? 18000);
const STEP1_WAVE_RESERVE_MS = 9000;
const STEP2_FIX_RESERVE_MS = 7000;
const STEP4_DAY_RESERVE_MS = 5000;
const STEP5_DAY_RESERVE_MS = 9000;
const STEP6_SLOT_RESERVE_MS = 9000;

type ExistingMenuContext = {
  date: string;
  mealType: MealType;
  dishName: string;
  status: string;
  isPast: boolean;
};

type FridgeItemContext = {
  name: string;
  expirationDate?: string;
  quantity?: string;
};

type SeasonalContext = {
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
};

type ProgressInfo = {
  currentStep: number;
  totalSteps: number;
  message: string;
  completedSlots?: number;
  totalSlots?: number;
};

type V5InvocationContext = {
  startedAtMs: number;
  softBudgetMs: number;
};

type SeedTemplateMap = Record<string, MenuTemplate>;

type V5GeneratedData = {
  version?: string;
  dates?: string[];
  targetSlots?: TargetSlot[];
  ultimateMode?: boolean;
  existingMenus?: ExistingMenuContext[];
  fridgeItems?: FridgeItemContext[];
  userProfile?: any;
  seasonalContext?: SeasonalContext;
  constraints?: any;
  note?: string | null;
  familySize?: number;
  nutritionTargets?: any | null;
  userContext?: unknown;
  userSummary?: string;
  /** お気に入りレシピ名一覧 (#104) */
  likedRecipes?: string[];
  references?: MenuReference[];
  referenceSummary?: string;
  healthCheckups?: HealthCheckupForContext[] | null;
  healthGuidance?: HealthCheckupGuidance | null;
  generatedMeals?: Record<string, GeneratedMeal>;
  step1?: { cursor?: number; batchSize?: number };
  step2?: {
    reviewCompleted?: boolean;
    softIssues?: Array<{ date: string; mealType: MealType; issue: string; suggestion: string }>;
    fixCursor?: number;
    fixesPerRun?: number;
    maxFixes?: number;
    hardAttemptCounts?: Record<string, number>;
  };
  step3?: {
    cursor?: number;
    batchSize?: number;
    savedCount?: number;
    errors?: SaveIssue[];
    skipped?: SaveIssue[];
    ingredientMatchCache?: PersistedIngredientMatchCache;
    postNutritionIssues?: PostNutritionIssue[];
    postNutritionFixAttempts?: number;
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
    errors?: SaveIssue[];
    skipped?: SaveIssue[];
    ingredientMatchCache?: PersistedIngredientMatchCache;
  };
  v5?: {
    slotPlans?: Record<string, SlotPlan>;
    seedTemplatesById?: SeedTemplateMap;
    templateCatalog?: MenuTemplate[];
    hardViolations?: DiversityViolation[];
    softViolations?: DiversityViolation[];
    postNutritionIssues?: PostNutritionIssue[];
    slotsToRegenerate?: Array<{ date: string; mealType: string }>;
  };
};

function hasTimeBudgetRemaining(context: V5InvocationContext, reserveMs = 0): boolean {
  return Date.now() - context.startedAtMs + reserveMs < context.softBudgetMs;
}

function scheduleBackgroundTask(label: string, task: () => Promise<void>): void {
  const promise = Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error(`[background] ${label} failed:`, error);
    });

  // @ts-ignore EdgeRuntime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore EdgeRuntime
    EdgeRuntime.waitUntil(promise);
    return;
  }

  void promise;
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
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

function createSupabaseQueryError(label: string, error: any): Error & { status?: number } {
  const err = new Error(`${label}: ${error?.message ?? "unknown error"}`) as Error & { status?: number };
  err.status =
    isRetryableError(error) || /timeout|temporar|unavailable|connection|fetch failed/i.test(String(error?.message ?? ""))
      ? 503
      : 400;
  return err;
}

async function runSupabaseQuery<T>(
  queryFactory: () => Promise<{ data: T | null; error: any }>,
  label: string,
  defaultValue: T,
  timeoutMs = 15000,
  retries = 2,
): Promise<T> {
  return await withRetry(async () => {
    const result = await withTimeout(queryFactory(), { label, timeoutMs });
    if (result.error) {
      throw createSupabaseQueryError(label, result.error);
    }
    return (result.data ?? defaultValue) as T;
  }, { label, retries });
}

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
    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update(updateData)
        .eq("id", requestId),
      `weekly_menu_requests.updateProgress:${requestId}`,
      null,
      10000,
      1,
    );
  } catch (error) {
    console.error("Failed to update progress:", error);
  }
}

async function triggerNextV5Step(
  supabaseUrl: string,
  supabaseServiceKey: string,
  requestId: string,
  userId: string,
) {
  const url = `${supabaseUrl}/functions/v1/generate-menu-v5`;
  await fetchWithRetry(url, {
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
  }, {
    label: `triggerNextV5Step:${requestId}`,
    retries: 2,
    timeoutMs: 10000,
  });
}

/** V5 Step3 前に既存の planned_meals をクリアする（同一 request の再保存を妨げないため） */
async function clearExistingPlannedMeals(supabase: any, userId: string, targetSlots: TargetSlot[]) {
  const dates = [...new Set(targetSlots.map((s) => s.date))];
  if (dates.length === 0) return;
  const dailyMealsRes = await supabase
    .from("user_daily_meals")
    .select("id")
    .eq("user_id", userId)
    .in("day_date", dates);
  if (dailyMealsRes.error) {
    console.warn("clearExistingPlannedMeals: failed to load daily meals:", dailyMealsRes.error.message);
    return;
  }
  const dailyMealIds = (dailyMealsRes.data || []).map((row: any) => row.id);
  if (dailyMealIds.length === 0) return;
  const delRes = await supabase.from("planned_meals").delete().in("daily_meal_id", dailyMealIds);
  if (delRes.error) {
    console.warn("clearExistingPlannedMeals: failed to delete planned_meals:", delRes.error.message);
  } else {
    console.log(`🧹 Cleared existing planned_meals for ${dailyMealIds.length} daily_meal records before save`);
  }
}

function shouldEmitProgressUpdate(processedCount: number, totalCount: number, interval = 5): boolean {
  if (totalCount <= 0) return true;
  return processedCount === 1 || processedCount === totalCount || processedCount % interval === 0;
}

// =========================================================
// V5 Step 3: 栄養計算 + DB保存（V4 HTTP呼び出しを排除して直接実行）
// =========================================================

async function executeStep3_Save(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
  invocationContext: V5InvocationContext,
) {
  console.log("💾 V5 Step 3: Nutrition & saving (direct)...");

  const reqRow = await loadRequestRow(supabase, requestId);
  const generatedData: V5GeneratedData = (reqRow.generated_data ?? {}) as any;
  const ultimateMode = generatedData.ultimateMode ?? false;
  const totalSteps = ultimateMode ? 6 : 3;

  const targetSlots = sortTargetSlots(generatedData.targetSlots ?? normalizeTargetSlots(reqRow.target_slots ?? []));
  const totalSlots = targetSlots.length;
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;

  const step3 = generatedData.step3 ?? {};
  const BATCH = Number(step3.batchSize ?? DEFAULT_STEP3_SLOT_BATCH);
  const cursor = Number(step3.cursor ?? 0);
  const savedCountStart = Number(step3.savedCount ?? 0);
  const errors: SaveIssue[] = Array.isArray(step3.errors) ? step3.errors : [];
  const skipped: SaveIssue[] = Array.isArray(step3.skipped) ? step3.skipped : [];
  const ingredientMatchMemo = deserializeIngredientMatchCache(step3.ingredientMatchCache);
  const targetSlotsForRun = targetSlots.slice(cursor, Math.min(cursor + BATCH, totalSlots));
  const dailyMealIdByDate = await ensureDailyMealIdsForDates(
    supabase,
    userId,
    targetSlotsForRun.map((slot) => slot.date),
  );
  let savedCount = savedCountStart;
  const postNutritionIssues: PostNutritionIssue[] = Array.isArray(step3.postNutritionIssues) ? [...step3.postNutritionIssues] : [];

  await updateProgress(
    supabase,
    requestId,
    { currentStep: 3, totalSteps, message: `保存中...（${cursor}/${totalSlots}）`, completedSlots: cursor, totalSlots },
    3,
  );

  const STEP3_CONCURRENCY = 5;
  const STEP3_SLOT_RESERVE_MS = 9000;
  let newCursor = cursor;
  const batchEnd = Math.min(cursor + BATCH, totalSlots);

  while (newCursor < batchEnd) {
    if (newCursor > cursor && !hasTimeBudgetRemaining(invocationContext, STEP3_SLOT_RESERVE_MS)) {
      break;
    }

    const batchSlots: Array<{ index: number; slot: TargetSlot; key: string; meal: GeneratedMeal | null }> = [];
    for (let b = 0; b < STEP3_CONCURRENCY && newCursor + b < batchEnd; b++) {
      const idx = newCursor + b;
      const slot = targetSlots[idx];
      const key = getSlotKey(slot.date, slot.mealType);
      const meal = generatedMeals[key] ?? null;
      batchSlots.push({ index: idx, slot, key, meal });
    }

    const batchResults = await Promise.all(batchSlots.map(async ({ index, slot, key, meal }) => {
      if (!meal) {
        return { index, key, type: "no_meal" as const };
      }
      try {
        if (ultimateMode) {
          return { index, key, type: "ultimate_skip" as const };
        }
        const saveResult = await saveMealToDb(supabase, {
          userId,
          requestId,
          targetSlot: slot,
          generatedMeal: meal,
          dailyMealIdByDate,
          ingredientMatchMemo,
          sourceFunction: "generate-menu-v5",
        });
        return { index, key, type: "saved" as const, saveResult };
      } catch (e: any) {
        return { index, key, type: "error" as const, error: e?.message ?? String(e) };
      }
    }));

    for (const result of batchResults) {
      if (result.type === "no_meal") {
        errors.push({ key: result.key, error: "No generated meal" });
      } else if (result.type === "error") {
        errors.push({ key: result.key, error: result.error });
      } else if (result.type === "saved" && result.saveResult) {
        if (result.saveResult.outcome === "skipped_existing") {
          skipped.push({ key: result.key, error: result.saveResult.reason ?? "既存献立を保護したため未保存" });
        } else {
          savedCount++;
          if (result.saveResult.qualityIssues?.length) {
            postNutritionIssues.push(...result.saveResult.qualityIssues);
          }
        }
      }
    }

    newCursor += batchSlots.length;

    if (shouldEmitProgressUpdate(newCursor, totalSlots)) {
      await updateProgress(
        supabase,
        requestId,
        { currentStep: 3, totalSteps, message: `保存中...（${newCursor}/${totalSlots}）`, completedSlots: newCursor, totalSlots },
        3,
      );
    }
  }

  const updatedGeneratedData: V5GeneratedData = {
    ...generatedData,
    step3: {
      cursor: newCursor,
      batchSize: BATCH,
      savedCount,
      errors: errors.slice(-200),
      skipped: skipped.slice(-200),
      ingredientMatchCache: serializeIngredientMatchCache(ingredientMatchMemo),
      postNutritionIssues: postNutritionIssues.slice(-100),
      postNutritionFixAttempts: Number(step3.postNutritionFixAttempts ?? 0),
    },
  };

  // Continue if more slots remain
  if (newCursor < totalSlots) {
    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update({
          generated_data: updatedGeneratedData,
          current_step: 3,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId),
      `weekly_menu_requests.v5_step3_continue:${requestId}`,
      null,
      10000,
      1,
    );

    await updateProgress(
      supabase,
      requestId,
      { currentStep: 3, totalSteps, message: `保存中...（${newCursor}/${totalSlots}）`, completedSlots: newCursor, totalSlots },
      3,
    );

    await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  // Post-nutrition fix: 保存後の実栄養に外れ値がある場合、V5 Step2 へ差し戻す
  const MAX_POST_NUTRITION_FIX_ATTEMPTS = 2;
  const postFixAttempts = Number(updatedGeneratedData.step3?.postNutritionFixAttempts ?? 0);

  if (postNutritionIssues.length > 0 && postFixAttempts < MAX_POST_NUTRITION_FIX_ATTEMPTS) {
    console.log(`🔄 V5 post-nutrition fix: ${postNutritionIssues.length} issues found (attempt ${postFixAttempts + 1}/${MAX_POST_NUTRITION_FIX_ATTEMPTS})`);

    const issueKeys = new Set(postNutritionIssues.map((i) => i.key));
    const slotsToRegenerate: TargetSlot[] = [];

    for (const slot of targetSlots) {
      const key = getSlotKey(slot.date, slot.mealType);
      if (!issueKeys.has(key)) continue;

      const dailyMealId = dailyMealIdByDate.get(slot.date);
      if (dailyMealId) {
        await runSupabaseQuery(
          () => supabase
            .from("planned_meals")
            .delete()
            .eq("daily_meal_id", dailyMealId)
            .eq("meal_type", slot.mealType),
          `planned_meals.delete_for_refix:${key}`,
          null,
          10000,
          1,
        ).catch((e: any) => console.warn(`Failed to delete planned_meal for ${key}:`, e?.message));
      }

      delete (updatedGeneratedData.generatedMeals as any)?.[key];
      slotsToRegenerate.push(slot);
    }

    updatedGeneratedData.step3 = {
      ...updatedGeneratedData.step3,
      postNutritionFixAttempts: postFixAttempts + 1,
      postNutritionIssues: postNutritionIssues.slice(-100),
      cursor: 0,
      savedCount: 0,
      errors: [],
      skipped: [],
    };

    updatedGeneratedData.v5 = {
      ...(updatedGeneratedData.v5 ?? {}),
      postNutritionIssues,
      slotsToRegenerate: slotsToRegenerate.map((s) => ({ date: s.date, mealType: s.mealType })),
    };

    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update({
          generated_data: updatedGeneratedData,
          current_step: 2,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId),
      `weekly_menu_requests.v5_step3_back_to_step2:${requestId}`,
      null,
      10000,
      1,
    );

    await updateProgress(
      supabase,
      requestId,
      {
        currentStep: 2,
        totalSteps,
        message: `栄養外れ値 ${postNutritionIssues.length} 件を再修正中...`,
        completedSlots: totalSlots - slotsToRegenerate.length,
        totalSlots,
      },
      2,
    );

    await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  // Ultimate Mode: Step 4へ進む
  if (ultimateMode) {
    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update({
          generated_data: updatedGeneratedData,
          current_step: 4,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId),
      `weekly_menu_requests.v5_step3_to_step4:${requestId}`,
      null,
      10000,
      1,
    );

    await updateProgress(
      supabase,
      requestId,
      { currentStep: 4, totalSteps: 6, message: "栄養バランスを分析中...", completedSlots: 0, totalSlots },
      4,
    );

    await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  // Done (通常モード)
  const finalSummary = summarizeSaveResults({
    totalSlots,
    savedCount,
    skipped,
    errors,
    successMessage: `全${totalSlots}件の献立が完成しました！`,
  });

  await runSupabaseQuery(
    () => supabase
      .from("weekly_menu_requests")
      .update({
        status: finalSummary.status,
        generated_data: updatedGeneratedData,
        current_step: 3,
        progress: {
          currentStep: 3,
          totalSteps,
          message: finalSummary.message,
          completedSlots: totalSlots,
          totalSlots,
        },
        error_message: finalSummary.errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId),
    `weekly_menu_requests.v5_step3_final:${requestId}`,
    null,
    10000,
    1,
  );
}

// =========================================================
// Resolve recipe from dataset_recipes DB
// (AIアドバイザーがsearch_recipesで見つけたレシピを直接使用)
// =========================================================

interface ResolvedRecipeResult {
  meal: GeneratedMeal;
  nutrition: NutritionTotals;
  source: { type: "dataset_recipe"; id: string; externalId: string };
}

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

    const data = await runSupabaseQuery<any | null>(
      () => query.single(),
      `dataset_recipes.resolve:${constraints.recipeId ?? constraints.recipeExternalId}`,
      null,
    );
    if (!data) {
      console.warn(`Recipe not found: ${constraints.recipeId ?? constraints.recipeExternalId}`);
      return null;
    }

    console.log(`📖 Resolved recipe from DB: ${data.name} (${data.id})`);

    const ingredients: Array<{ name: string; amount_g: number; note?: string }> = [];
    if (data.ingredients_text) {
      const lines = data.ingredients_text.split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*g$/);
        if (match) {
          ingredients.push({ name: match[1].trim(), amount_g: parseFloat(match[2]) });
        } else {
          ingredients.push({ name: trimmed, amount_g: 0 });
        }
      }
    }

    const instructions: string[] = data.instructions_text
      ? data.instructions_text.split("\n").filter((l: string) => l.trim()).map((l: string) => l.trim())
      : [];

    const meal: GeneratedMeal = {
      mealType,
      dishes: [
        {
          name: data.name,
          role: "main",
          ingredients,
          instructions,
        },
      ],
      advice: `レシピDB「${data.name}」より。`,
    };

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

function dedupeDatasetMenuSets(rows: DatasetMenuSetRaw[]): DatasetMenuSetRaw[] {
  const seen = new Set<string>();
  const deduped: DatasetMenuSetRaw[] = [];
  for (const row of rows) {
    const key = String(row.id ?? row.external_id ?? row.title ?? "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function templateToReferenceForSearch(template: MenuTemplate): MenuReference {
  return {
    title: template.title,
    dishes: template.dishes.map((dish) => ({
      name: String(dish.name ?? ""),
      role: String(dish.role ?? "other"),
    })),
  };
}

function dedupeTemplatesByContent(templates: MenuTemplate[]): MenuTemplate[] {
  const seen = new Set<string>();
  const deduped: MenuTemplate[] = [];
  for (const template of templates) {
    const key = [
      template.mealType,
      template.clusterId,
      template.signature,
      template.title.trim(),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(template);
  }
  return deduped;
}

// 季節イベント名と対応する月のマッピング
const SEASONAL_EVENT_KEYWORDS: Array<{ keywords: string[]; months: number[] }> = [
  { keywords: ["クリスマス", "Christmas"], months: [12] },
  { keywords: ["お正月", "おせち", "お雑煮", "正月"], months: [1] },
  { keywords: ["バレンタイン"], months: [2] },
  { keywords: ["ひな祭り", "ひなまつり"], months: [3] },
  { keywords: ["七夕"], months: [7] },
  { keywords: ["ハロウィン", "Halloween"], months: [10] },
  { keywords: ["恵方巻", "節分"], months: [2] },
  { keywords: ["お花見", "花見"], months: [3, 4] },
  { keywords: ["七草"], months: [1] },
  { keywords: ["土用の丑", "うなぎ"], months: [7, 8] },
];

function isSeasonallyAppropriate(template: MenuTemplate, month: number): boolean {
  const text = [template.title, template.mainDishName, ...(template.themeTags ?? [])].join(" ");
  for (const event of SEASONAL_EVENT_KEYWORDS) {
    if (event.keywords.some((kw) => text.includes(kw))) {
      if (!event.months.includes(month)) return false;
    }
  }
  return true;
}

function selectTemplatesForTargetSlots(templates: MenuTemplate[], targetSlots: TargetSlot[]): MenuTemplate[] {
  const requestedTypes = new Set<string>(targetSlots.map((slot) => slot.mealType));
  const selected: MenuTemplate[] = [];
  const usedIds = new Set<string>();

  for (const template of templates) {
    if (usedIds.has(template.id)) continue;
    const mt = String(template.mealType);
    const isBreakfastRelated = requestedTypes.has("breakfast") &&
      template.breakfastTemplate != null &&
      template.breakfastTemplate !== "other_breakfast";
    if (requestedTypes.has(mt) || isBreakfastRelated) {
      usedIds.add(template.id);
      selected.push(template);
    }
  }

  return selected;
}

async function searchMenuCandidates(
  supabase: any,
  queryText: string,
  matchCount: number,
  targetSlots: TargetSlot[],
  month?: number,
): Promise<{
  references: MenuReference[];
  templates: MenuTemplate[];
}> {
  try {
    let count: number | null = null;
    let countError: any = null;
    try {
      const countResult: any = await withRetry(
        async () => await withTimeout(
          supabase
            .from("dataset_menu_sets")
            .select("id", { count: "exact", head: true }),
          { label: "dataset_menu_sets.count", timeoutMs: 10000 },
        ),
        { label: "dataset_menu_sets.count", retries: 1 },
      );
      count = countResult.count ?? null;
      countError = countResult.error;
    } catch (error) {
      countError = error;
    }

    if (countError) {
      console.warn("Failed to count dataset_menu_sets before reference search:", countError?.message ?? countError);
    } else if (shouldSkipReferenceMenuSearch(count)) {
      return { references: [], templates: [] };
    }

    const requestedMealTypes = [...new Set(
      targetSlots
        .map((slot) => slot.mealType)
        .filter((mealType): mealType is MealType => mealType === "breakfast" || mealType === "lunch" || mealType === "dinner"),
    )];
    const perTypeCount = Math.max(8, Math.ceil(matchCount / Math.max(requestedMealTypes.length, 1)));

    // --- 大きなプールを検索 → ランダムサンプリングで多様性を確保 ---
    const POOL_MULTIPLIER = 20;
    const poolPerType = Math.min(perTypeCount * POOL_MULTIPLIER, 200);
    const biasedEmb = await embedText(queryText, DATASET_EMBEDDING_DIMENSIONS);

    const searchVariants = requestedMealTypes.map((mealType) => ({
      label: `pool:${mealType}`,
      mealTypeHint: mealType as string | null,
      matchCount: poolPerType,
    }));

    const resultSets = await Promise.all(searchVariants.map(async (variant) => {
      return await withRetry(async () => {
        const rpcResult: any = await withTimeout(supabase.rpc("search_menu_examples", {
          query_embedding: biasedEmb,
          match_count: variant.matchCount,
          filter_meal_type_hint: variant.mealTypeHint,
          filter_max_sodium: null,
          filter_theme_tags: null,
        }), {
          label: `search_menu_examples:${variant.label}`,
          timeoutMs: 15000,
        });

        if (rpcResult.error) {
          const err = new Error(`search_menu_examples failed (${variant.label}): ${rpcResult.error.message}`) as Error & { status?: number };
          if (isRetryableError(rpcResult.error) || /timeout|temporar|unavailable|connection|fetch failed/i.test(rpcResult.error.message ?? "")) {
            err.status = 503;
          } else {
            err.status = 400;
          }
          throw err;
        }

        return (rpcResult.data ?? []) as DatasetMenuSetRaw[];
      }, {
        label: `search_menu_examples:${variant.label}`,
        retries: 2,
      });
    }));

    const mergedRows = dedupeDatasetMenuSets(resultSets.flat());

    // プールからランダムサンプリング: 必要数を各 mealType ごとにランダム抽出
    const allTemplatesRaw = dedupeTemplatesByContent(buildTemplateCatalog(mergedRows as unknown as DatasetMenuSetRaw[]));
    // 季節外れのテンプレートを除外（クリスマス料理が4月に出るなど）
    const currentMonth = month ?? new Date().getMonth() + 1;
    const allTemplates = allTemplatesRaw.filter((t) => isSeasonallyAppropriate(t, currentMonth));
    const sampledTemplates: MenuTemplate[] = [];
    for (const mealType of requestedMealTypes) {
      const pool = allTemplates.filter((t) => t.mealType === mealType);
      const needed = perTypeCount;
      if (pool.length <= needed) {
        sampledTemplates.push(...pool);
      } else {
        // Fisher-Yates shuffle して先頭 needed 件を取る
        const shuffled = [...pool];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        sampledTemplates.push(...shuffled.slice(0, needed));
      }
    }

    const templates = selectTemplatesForTargetSlots(sampledTemplates, targetSlots);
    return {
      references: templates.map(templateToReferenceForSearch),
      templates,
    };
  } catch (error) {
    console.error("Failed to search menu candidates:", error);
    return { references: [], templates: [] };
  }
}

function buildSlotContext(params: {
  targetSlot: TargetSlot;
  existingMenus: ExistingMenuContext[];
  fridgeItems: FridgeItemContext[];
  seasonalContext: SeasonalContext;
  constraints: any;
  note: string | null;
}): string {
  const { targetSlot, existingMenus, fridgeItems, seasonalContext, constraints, note } = params;
  const lines: string[] = [];
  lines.push(`【生成対象】${targetSlot.date} ${mealTypeToJa(targetSlot.mealType)}`);
  lines.push("");

  if (note) {
    lines.push("【ユーザーの要望】");
    lines.push(note);
    lines.push("");
  }

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

  if (fridgeItems.length > 0) {
    const fridgeText = fridgeItems.slice(0, 12).map((item) => {
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
    if (vegetables.length > 0 || fish.length > 0 || fruits.length > 0) {
      lines.push(`【旬の食材（${seasonalContext.month}月）】`);
      if (vegetables.length > 0) lines.push(`野菜: ${vegetables.slice(0, 8).join("、")}`);
      if (fish.length > 0) lines.push(`魚介: ${fish.slice(0, 8).join("、")}`);
      if (fruits.length > 0) lines.push(`果物: ${fruits.slice(0, 5).join("、")}`);
      lines.push("");
    }
  }

  if (seasonalContext.events?.length) {
    const relevantEvents = seasonalContext.events.filter((event) => event.date === "variable" || event.date === targetSlot.date.slice(5));
    if (relevantEvents.length > 0) {
      lines.push("【イベント・行事】");
      relevantEvents.forEach((event) => lines.push(`- ${event.name}: ${event.dishes.join("、")}`));
      lines.push("");
    }
  }

  const recentMenus = selectRecentMenusForVariety({
    targetDate: targetSlot.date,
    existingMenus,
    targetSlots: [targetSlot],
  });

  if (recentMenus.length > 0) {
    lines.push("【直近の献立（被り回避のため参照）】");
    recentMenus.forEach((menu) => lines.push(`- ${menu.date} ${mealTypeToJa(menu.mealType)}: ${menu.dishName}`));
    lines.push("");
  }

  return lines.join("\n");
}

function buildDayContext(params: {
  date: string;
  mealTypes: MealType[];
  slotsForDate: TargetSlot[];
  existingMenus: ExistingMenuContext[];
  fridgeItems: FridgeItemContext[];
  seasonalContext: SeasonalContext;
  constraints: any;
}): string {
  const lines: string[] = [];
  lines.push(`【生成対象】${params.date}（${params.mealTypes.map(mealTypeToJa).join("、")}）`);
  lines.push("");

  const overwriteInfos: string[] = [];
  for (const mealType of params.mealTypes) {
    const slot = params.slotsForDate.find((candidate) => candidate.mealType === mealType);
    if (!slot?.plannedMealId) continue;
    const current = params.existingMenus.find((menu) => menu.date === params.date && menu.mealType === mealType);
    if (current?.dishName) {
      overwriteInfos.push(`${mealTypeToJa(mealType)}: 現在「${current.dishName}」→ 別案に差し替え`);
    }
  }
  if (overwriteInfos.length > 0) {
    lines.push("【差し替え対象】");
    overwriteInfos.forEach((info) => lines.push(`- ${info}`));
    lines.push("");
  }

  const constraintFlags: string[] = [];
  if (params.constraints?.useFridgeFirst) constraintFlags.push("冷蔵庫の食材を優先使用");
  if (params.constraints?.quickMeals) constraintFlags.push("時短料理中心");
  if (params.constraints?.japaneseStyle) constraintFlags.push("和食多め");
  if (params.constraints?.healthy) constraintFlags.push("ヘルシー志向");
  if (params.constraints?.budgetFriendly) constraintFlags.push("節約重視");
  if (constraintFlags.length > 0) {
    lines.push(`【生成条件】${constraintFlags.join("、")}`);
    lines.push("");
  }

  if (params.fridgeItems.length > 0) {
    const fridgeText = params.fridgeItems.slice(0, 15).map((item) => {
      let text = item.name;
      if (item.quantity) text += ` (${item.quantity})`;
      if (item.expirationDate) text += ` [期限:${item.expirationDate}]`;
      return text;
    }).join("、");
    lines.push(`【冷蔵庫の食材】${fridgeText}`);
    lines.push("");
  }

  // Seasonal ingredients
  if (params.seasonalContext.seasonalIngredients) {
    const { vegetables, fish, fruits } = params.seasonalContext.seasonalIngredients;
    if (vegetables.length > 0 || fish.length > 0 || fruits.length > 0) {
      lines.push(`【旬の食材（${params.seasonalContext.month}月）】`);
      if (vegetables.length > 0) lines.push(`野菜: ${vegetables.slice(0, 8).join("、")}`);
      if (fish.length > 0) lines.push(`魚介: ${fish.slice(0, 8).join("、")}`);
      if (fruits.length > 0) lines.push(`果物: ${fruits.slice(0, 5).join("、")}`);
      lines.push("");
    }
  }

  const recentMenus = selectRecentMenusForVariety({
    targetDate: params.date,
    existingMenus: params.existingMenus,
    targetSlots: params.slotsForDate,
  });
  if (recentMenus.length > 0) {
    lines.push("【直近の献立（被り回避のため参照）】");
    recentMenus.forEach((menu) => lines.push(`- ${menu.date} ${mealTypeToJa(menu.mealType)}: ${menu.dishName}`));
    lines.push("");
  }

  return lines.join("\n");
}

function buildWeeklyMealsSummaryForDates(params: {
  dates: string[];
  generatedMeals: Record<string, GeneratedMeal>;
  existingMenus: ExistingMenuContext[];
}): WeeklyMealsSummary[] {
  const existingByKey = new Map<string, string[]>();
  for (const menu of params.existingMenus) {
    const key = getSlotKey(menu.date, menu.mealType);
    if (!existingByKey.has(key)) existingByKey.set(key, []);
    existingByKey.get(key)!.push(menu.dishName);
  }

  const allTypes: MealType[] = ["breakfast", "lunch", "dinner", "snack", "midnight_snack"];
  return params.dates
    .map((date) => {
      const meals: Array<{ mealType: MealType; dishNames: string[] }> = [];
      for (const mealType of allTypes) {
        const key = getSlotKey(date, mealType);
        const generatedMeal = params.generatedMeals[key];
        if (generatedMeal) {
          meals.push({
            mealType,
            dishNames: (generatedMeal.dishes ?? []).map((dish) => String(dish?.name ?? "").trim()).filter(Boolean),
          });
          continue;
        }
        const existingDishNames = existingByKey.get(key);
        if (existingDishNames?.length) {
          meals.push({ mealType, dishNames: existingDishNames });
        }
      }
      return { date, meals };
    })
    .filter((day) => day.meals.length > 0);
}

function templateToReference(template: MenuTemplate): MenuReference {
  return {
    title: template.title,
    dishes: template.dishes.map((dish) => ({
      name: String(dish.name ?? ""),
      role: String(dish.role ?? "other"),
    })),
  };
}

function dedupeReferenceMenus(referenceMenus: MenuReference[]): MenuReference[] {
  const seen = new Set<string>();
  const deduped: MenuReference[] = [];
  for (const menu of referenceMenus) {
    const signature = [
      String(menu.title ?? "").trim(),
      ...(Array.isArray(menu.dishes) ? menu.dishes.map((dish) => `${String(dish?.role ?? "other")}:${String(dish?.name ?? "").trim()}`) : []),
    ].join("|");
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(menu);
  }
  return deduped;
}

function selectReferenceMenusForPlan(params: {
  plan: SlotPlan | undefined;
  seedTemplate: MenuTemplate | undefined;
  templateCatalog: MenuTemplate[];
  fallbackReferences: MenuReference[];
  limit: number;
}): MenuReference[] {
  const plan = params.plan;
  if (!plan) return params.fallbackReferences.slice(0, params.limit);

  const seeded = params.seedTemplate ? [templateToReference(params.seedTemplate)] : [];
  const exactFamilyMatches = params.templateCatalog
    .filter((template) => template.id !== params.seedTemplate?.id)
    .filter((template) => {
      if (plan.mealType === "breakfast") {
        return template.mealType === "breakfast"
          && template.breakfastTemplate === plan.requiredBreakfastTemplate;
      }
      return template.mainDishFamily === plan.requiredMainDishFamily;
    })
    .map(templateToReference);
  const proteinFallbackMatches = exactFamilyMatches.length >= Math.max(params.limit - seeded.length, 0)
    ? []
    : params.templateCatalog
      .filter((template) => template.id !== params.seedTemplate?.id)
      .filter((template) => template.mainDishFamily !== plan.requiredMainDishFamily)
      .filter((template) => {
        if (plan.mealType === "breakfast") return false;
        return template.proteinFamily === plan.requiredProteinFamily;
      })
      .map(templateToReference);

  const combined = dedupeReferenceMenus([
    ...seeded,
    ...exactFamilyMatches,
    ...proteinFallbackMatches,
    ...params.fallbackReferences,
  ]);

  return combined.slice(0, params.limit);
}

function buildSeedTemplateMap(slotPlans: Record<string, SlotPlan>, templates: MenuTemplate[]): SeedTemplateMap {
  const byId = new Map<string, MenuTemplate>(templates.map((template) => [template.id, template]));
  const selected = new Map<string, MenuTemplate>();
  for (const slotPlan of Object.values(slotPlans)) {
    const template = byId.get(slotPlan.seedTemplateId);
    if (template) selected.set(template.id, template);
  }
  return Object.fromEntries(selected.entries());
}

function buildPlanSummaryForSlot(plan: SlotPlan | undefined, template: MenuTemplate | undefined): string {
  if (!plan) return "";
  const effectivePlan = normalizeSlotPlanForPrompt(plan, template);
  const lines: string[] = [];
  lines.push("【V5 sample 方針】");
  lines.push(`- seed sample: ${template?.title ?? effectivePlan.templateTitle}`);
  lines.push(`- 主菜 family: ${effectivePlan.requiredMainDishFamily}`);
  if (effectivePlan.mealType === "breakfast") {
    lines.push(`- 朝食 template: ${effectivePlan.requiredBreakfastTemplate}`);
  }
  lines.push("- sample を強く参考にしてよいが、完全一致コピーは禁止");
  lines.push("- 少なくとも主菜名または副菜/汁物の構成を変える");
  if (effectivePlan.forbiddenDishNames.length > 0) {
    lines.push(`- 再出力禁止の料理名: ${effectivePlan.forbiddenDishNames.slice(0, 8).join("、")}`);
  }
  if (effectivePlan.sodiumMode === "low") {
    lines.push("- 減塩モード: 味噌汁・照り焼き・濃い汁物の重ねを避ける");
  }
  return lines.join("\n");
}

function buildPlanSummaryForDate(params: {
  mealTypes: MealType[];
  date: string;
  slotPlans: Record<string, SlotPlan>;
  seedTemplatesById: SeedTemplateMap;
}): string {
  const lines: string[] = [];
  lines.push("【V5 sample 方針】");
  for (const mealType of params.mealTypes) {
    const key = getSlotKey(params.date, mealType);
    const rawPlan = params.slotPlans[key];
    const template = rawPlan ? params.seedTemplatesById[rawPlan.seedTemplateId] : undefined;
    const plan = rawPlan ? normalizeSlotPlanForPrompt(rawPlan, template) : undefined;
    if (!plan) continue;
    lines.push(`- ${mealTypeToJa(mealType)} seed: ${template?.title ?? plan.templateTitle}`);
    lines.push(`  - 主菜 family: ${plan.requiredMainDishFamily}`);
    if (mealType === "breakfast") {
      lines.push(`  - 朝食 template: ${plan.requiredBreakfastTemplate}`);
    }
    if (plan.forbiddenDishNames.length > 0) {
      lines.push(`  - 再出力禁止: ${plan.forbiddenDishNames.slice(0, 5).join("、")}`);
    }
  }
  lines.push("- sample を強く参考にしてよいが、同じ献立のコピーは禁止");
  lines.push("- 主菜 family は指定に従い、副菜/汁物で変化を出す");
  return lines.join("\n");
}

function buildPromptBriefForPlan(plan: SlotPlan | undefined, template: MenuTemplate | undefined) {
  if (!plan) {
    return {
      sampleSeed: null,
      forbiddenDishNames: undefined,
      forbiddenMainDishFamilies: undefined,
      forbiddenBreakfastTemplates: undefined,
      requiredMainDishFamily: undefined,
      requiredBreakfastTemplate: undefined,
      sodiumMode: undefined,
    };
  }

  const effectivePlan = normalizeSlotPlanForPrompt(plan, template);
  const usesSyntheticBreakfastPlan = effectivePlan.mealType === "breakfast"
    && (!template || template.mealType !== "breakfast" || template.breakfastTemplate === "other_breakfast");

  return {
    sampleSeed: usesSyntheticBreakfastPlan ? null : template ? templateToReference(template) : null,
    forbiddenDishNames: effectivePlan.forbiddenDishNames,
    forbiddenMainDishFamilies: undefined,
    forbiddenBreakfastTemplates: undefined,
    requiredMainDishFamily: effectivePlan.requiredMainDishFamily,
    requiredBreakfastTemplate: effectivePlan.requiredBreakfastTemplate,
    sodiumMode: effectivePlan.sodiumMode,
  };
}

function collectForbiddenMainDishFamiliesForViolation(params: {
  violation: DiversityViolation;
  slot: TargetSlot;
  currentMeal: GeneratedMeal;
  currentPlan: SlotPlan | undefined;
  relatedSlotKeys: string[];
  generatedMeals: Record<string, GeneratedMeal>;
  slotPlans: Record<string, SlotPlan>;
}): Array<SlotPlan["requiredMainDishFamily"]> {
  const families = new Set<SlotPlan["requiredMainDishFamily"]>();
  const currentFingerprint = fingerprintGeneratedMeal({
    date: params.slot.date,
    mealType: params.slot.mealType,
    meal: params.currentMeal,
    templateId: params.currentPlan?.seedTemplateId,
    clusterId: params.currentPlan?.seedClusterId,
    sodiumMode: params.currentPlan?.sodiumMode,
  });
  families.add(currentFingerprint.mainDishFamily);

  for (const relatedKey of params.relatedSlotKeys) {
    const relatedPlan = params.slotPlans[relatedKey];
    const relatedMeal = params.generatedMeals[relatedKey];
    if (relatedMeal) {
      const [relatedDate, relatedMealType] = relatedKey.split(":");
      families.add(
        fingerprintGeneratedMeal({
          date: relatedDate,
          mealType: relatedMealType as MealType,
          meal: relatedMeal,
          templateId: relatedPlan?.seedTemplateId,
          clusterId: relatedPlan?.seedClusterId,
          sodiumMode: relatedPlan?.sodiumMode,
        }).mainDishFamily,
      );
      continue;
    }
    if (relatedPlan?.requiredMainDishFamily) {
      families.add(relatedPlan.requiredMainDishFamily);
    }
  }

  return [...families].filter(Boolean);
}

function collectForbiddenBreakfastTemplatesForViolation(params: {
  violation: DiversityViolation;
  slot: TargetSlot;
  currentMeal: GeneratedMeal;
  currentPlan: SlotPlan | undefined;
  relatedSlotKeys: string[];
  generatedMeals: Record<string, GeneratedMeal>;
  slotPlans: Record<string, SlotPlan>;
}): Array<SlotPlan["requiredBreakfastTemplate"]> {
  const templates = new Set<SlotPlan["requiredBreakfastTemplate"]>();
  const currentFingerprint = fingerprintGeneratedMeal({
    date: params.slot.date,
    mealType: params.slot.mealType,
    meal: params.currentMeal,
    templateId: params.currentPlan?.seedTemplateId,
    clusterId: params.currentPlan?.seedClusterId,
    sodiumMode: params.currentPlan?.sodiumMode,
  });
  if (params.slot.mealType === "breakfast" && currentFingerprint.breakfastTemplate !== "other_breakfast") {
    templates.add(currentFingerprint.breakfastTemplate);
  }

  for (const relatedKey of params.relatedSlotKeys) {
    const relatedPlan = params.slotPlans[relatedKey];
    const relatedMeal = params.generatedMeals[relatedKey];
    if (relatedMeal) {
      const [relatedDate, relatedMealType] = relatedKey.split(":");
      const relatedFingerprint = fingerprintGeneratedMeal({
        date: relatedDate,
        mealType: relatedMealType as MealType,
        meal: relatedMeal,
        templateId: relatedPlan?.seedTemplateId,
        clusterId: relatedPlan?.seedClusterId,
        sodiumMode: relatedPlan?.sodiumMode,
      });
      if (relatedFingerprint.breakfastTemplate !== "other_breakfast") {
        templates.add(relatedFingerprint.breakfastTemplate);
      }
      continue;
    }
    if (relatedPlan?.requiredBreakfastTemplate && relatedPlan.requiredBreakfastTemplate !== "other_breakfast") {
      templates.add(relatedPlan.requiredBreakfastTemplate);
    }
  }

  return [...templates].filter(Boolean);
}

function getHardViolationAttemptKey(violation: DiversityViolation): string {
  return `${violation.slotKey}|${violation.code}`;
}

function collectPreviousDayMeals(date: string, generatedMeals: Record<string, GeneratedMeal>, existingMenus: ExistingMenuContext[]): string[] {
  const previousDate = addDays(date, -1);
  const dishes: string[] = [];
  for (const mealType of ["breakfast", "lunch", "dinner"] as MealType[]) {
    const key = getSlotKey(previousDate, mealType);
    const meal = generatedMeals[key];
    if (meal) {
      dishes.push(...(meal.dishes ?? []).map((dish) => String(dish?.name ?? "").trim()).filter(Boolean));
    }
  }
  if (dishes.length > 0) return dishes;
  return existingMenus
    .filter((menu) => menu.date === previousDate)
    .map((menu) => menu.dishName)
    .filter(Boolean);
}

function shouldReplanForViolation(violation: DiversityViolation): boolean {
  return violation.code === "exact_duplicate_signature"
    || violation.code === "exact_duplicate_dish_name"
    || violation.code === "breakfast_structure_too_light"
    || violation.code === "heavy_main_overbuilt"
    || violation.code === "stacked_salty_items"
    || violation.code === "same_day_main_family_duplicate"
    || violation.code === "adjacent_main_family_duplicate"
    || violation.code === "adjacent_breakfast_template_duplicate"
    || violation.code === "seed_template_reused";
}

function getTemplateCalories(template: MenuTemplate): number | null {
  const calories = Number(template.nutrients?.calories_kcal);
  return Number.isFinite(calories) ? calories : null;
}

function getTemplateSodium(template: MenuTemplate): number | null {
  const sodium = Number(template.nutrients?.sodium_g);
  return Number.isFinite(sodium) ? sodium : null;
}

function replanSlotForViolation(params: {
  slot: TargetSlot;
  violation: DiversityViolation;
  slotPlans: Record<string, SlotPlan>;
  seedTemplatesById: SeedTemplateMap;
  templateCatalog: MenuTemplate[];
  targetSlots: TargetSlot[];
  generatedMeals: Record<string, GeneratedMeal>;
  existingMenus: ExistingMenuContext[];
}): SlotPlan | null {
  if (!shouldReplanForViolation(params.violation) || params.templateCatalog.length === 0) {
    return null;
  }

  const slotKey = getSlotKey(params.slot.date, params.slot.mealType);
  const currentPlan = params.slotPlans[slotKey];
  if (!currentPlan) return null;

  const usedTemplateIds = new Set(
    Object.entries(params.slotPlans)
      .filter(([otherKey]) => otherKey !== slotKey)
      .map(([, plan]) => plan.seedTemplateId),
  );
  usedTemplateIds.add(currentPlan.seedTemplateId);
  for (const templateId of currentPlan.forbiddenTemplateIds ?? []) {
    usedTemplateIds.add(templateId);
  }
  const usedClusterIds = new Set(
    Object.entries(params.slotPlans)
      .filter(([otherKey]) => otherKey !== slotKey)
      .map(([, plan]) => plan.seedClusterId),
  );
  usedClusterIds.add(currentPlan.seedClusterId);
  for (const clusterId of currentPlan.forbiddenClusterIds ?? []) {
    usedClusterIds.add(clusterId);
  }
  const relatedFamilies = new Set<string>();
  const currentMeal = params.generatedMeals[slotKey];
  if (currentMeal) {
    relatedFamilies.add(
      fingerprintGeneratedMeal({
        date: params.slot.date,
        mealType: params.slot.mealType,
        meal: currentMeal,
        templateId: currentPlan.seedTemplateId,
        clusterId: currentPlan.seedClusterId,
        sodiumMode: currentPlan.sodiumMode,
      }).mainDishFamily,
    );
  }
  for (const relatedKey of params.violation.relatedSlotKeys ?? []) {
    const relatedPlan = params.slotPlans[relatedKey];
    const relatedMeal = params.generatedMeals[relatedKey];
    if (relatedMeal) {
      relatedFamilies.add(
        fingerprintGeneratedMeal({
          date: relatedKey.split(":")[0],
          mealType: relatedKey.split(":")[1] as MealType,
          meal: relatedMeal,
          templateId: relatedPlan?.seedTemplateId,
          clusterId: relatedPlan?.seedClusterId,
          sodiumMode: relatedPlan?.sodiumMode,
        }).mainDishFamily,
      );
      continue;
    }
    if (relatedPlan?.requiredMainDishFamily) {
      relatedFamilies.add(relatedPlan.requiredMainDishFamily);
    }
  }

  const planningFingerprints = params.existingMenus.map((menu) => fingerprintExistingMenu(menu));
  for (const targetSlot of params.targetSlots) {
    const otherKey = getSlotKey(targetSlot.date, targetSlot.mealType);
    if (otherKey === slotKey) continue;

    const otherPlan = params.slotPlans[otherKey];
    const otherMeal = params.generatedMeals[otherKey];
    if (otherMeal) {
      planningFingerprints.push(
        fingerprintGeneratedMeal({
          date: targetSlot.date,
          mealType: targetSlot.mealType,
          meal: otherMeal,
          templateId: otherPlan?.seedTemplateId,
          clusterId: otherPlan?.seedClusterId,
          sodiumMode: otherPlan?.sodiumMode,
        }),
      );
      continue;
    }

    if (otherPlan) {
      const otherTemplate = params.seedTemplatesById[otherPlan.seedTemplateId]
        ?? params.templateCatalog.find((template) => template.id === otherPlan.seedTemplateId);
      if (otherTemplate) {
        planningFingerprints.push(
          fingerprintTemplate({
            date: targetSlot.date,
            mealType: targetSlot.mealType,
            template: otherTemplate,
            sodiumMode: otherPlan.sodiumMode,
          }),
        );
      }
    }
  }

  const filteredTemplates = params.templateCatalog.filter((template) => {
    if (usedTemplateIds.has(template.id)) return false;
    if (relatedFamilies.size > 0 && relatedFamilies.has(template.mainDishFamily)) return false;
    if (params.slot.mealType === "breakfast" && template.breakfastTemplate === "other_breakfast" && template.mealType !== "breakfast") {
      return false;
    }
    if (params.violation.code === "breakfast_structure_too_light") {
      const calories = getTemplateCalories(template);
      if (params.slot.mealType !== "breakfast") return false;
      if (template.breakfastTemplate === "other_breakfast") return false;
      if (template.dishCount < 3) return false;
      if (calories != null && calories < 320) return false;
    }
    if (params.violation.code === "heavy_main_overbuilt") {
      const calories = getTemplateCalories(template);
      if (template.mainDishFamily === "curry_main"
        || template.mainDishFamily === "gratin_main"
        || template.mainDishFamily === "rice_bowl"
        || template.mainDishFamily === "noodle_soup") {
        if (template.dishCount > 3) return false;
        if (calories != null && calories > 900) return false;
      }
    }
    if (params.violation.code === "stacked_salty_items") {
      const sodium = getTemplateSodium(template);
      if (params.slot.mealType === "breakfast" && sodium != null && sodium > 2.0) return false;
      if ((params.slot.mealType === "lunch" || params.slot.mealType === "dinner") && sodium != null && sodium > 3.8) return false;
    }
    return true;
  });

  const result = planDiversityForRange({
    targetSlots: [{ date: params.slot.date, mealType: params.slot.mealType }],
    templates: filteredTemplates.length > 0 ? filteredTemplates : params.templateCatalog.filter((template) => !usedTemplateIds.has(template.id)),
    existingFingerprints: planningFingerprints,
    sodiumMode: currentPlan.sodiumMode,
  });
  const replanned = result.slotPlans[slotKey];
  if (!replanned) return null;

  return normalizeSlotPlanForPrompt({
    ...replanned,
    forbiddenTemplateIds: [...new Set([...(currentPlan.forbiddenTemplateIds ?? []), ...usedTemplateIds])],
    forbiddenClusterIds: [...new Set([...(currentPlan.forbiddenClusterIds ?? []), ...usedClusterIds])],
    forbiddenDishNames: [...new Set([...(currentPlan.forbiddenDishNames ?? []), ...planningFingerprints.flatMap((fingerprint) => fingerprint.dishNames)])],
  }, params.templateCatalog.find((template) => template.id === replanned.seedTemplateId));
}

function buildSuggestionFromViolation(violation: DiversityViolation, plan: SlotPlan | undefined): string {
  switch (violation.code) {
    case "exact_duplicate_signature":
      return "主菜名か副菜/汁物の構成を変え、同一セットを避けてください。";
    case "exact_duplicate_dish_name":
      return "主菜名を別名・別調理法へ変えてください。";
    case "duplicate_bread_staples":
      return "朝食のパン系主食は1種類に絞り、サンドとトーストの重複を避けてください。";
    case "breakfast_structure_too_light":
      return "朝食は主食1つ・主たんぱく1つ・補助1品の3要素を揃え、軽すぎる2品構成を避けてください。";
    case "heavy_main_overbuilt":
      return "カレー・ドリア・丼・麺類のような重い主菜の日は 2〜3品に抑え、追加主食や重い副菜を外してください。";
    case "stacked_salty_items":
      return "味噌・照り焼き・煮付け・ポン酢など濃い味の要素を1つ減らし、汁物か副菜を薄味へ置き換えてください。";
    case "same_day_main_family_duplicate":
    case "adjacent_main_family_duplicate":
      return plan?.requiredMainDishFamily
        ? `主菜 family を ${plan.requiredMainDishFamily} に戻し、近い family の重複を避けてください。`
        : "主菜 family を変えてください。";
    case "adjacent_breakfast_template_duplicate":
      return plan?.requiredBreakfastTemplate
        ? `朝食 template を ${plan.requiredBreakfastTemplate} に合わせ、前日と異なる朝食にしてください。`
        : "朝食 template を変えてください。";
    case "seed_template_reused":
      return "同じ sample seed の再利用を避け、別のアレンジにしてください。";
    case "brief_mismatch":
      return "sample plan で指定した主菜 family に合わせて再生成してください。";
    default:
      return "重複や偏りを避けるよう献立を改善してください。";
  }
}

function shouldRunSoftReview(reviewCompleted: boolean, hardViolations: DiversityViolation[]): boolean {
  return !reviewCompleted && hardViolations.length === 0;
}

async function loadRequestRow(supabase: any, requestId: string) {
  const row = await runSupabaseQuery<any | null>(
    () => supabase
      .from("weekly_menu_requests")
      .select("id, user_id, prompt, constraints, target_slots, generated_data, current_step, status")
      .eq("id", requestId)
      .single(),
    `weekly_menu_requests.load:${requestId}`,
    null,
  );
  if (!row) throw new Error("Request not found");
  return row;
}

async function executeStep(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
  body: any,
  currentStep: number,
  invocationContext: V5InvocationContext,
) {
  const executionId = generateExecutionId();
  await withOpenAIUsageContext({
    functionName: `generate-menu-v5-step${currentStep}`,
    executionId,
    requestId,
    userId,
    supabaseClient: supabase,
  }, async () => {
    if (currentStep === 1) {
      await executeStep1_Generate(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, body, invocationContext);
      return;
    }
    if (currentStep === 2) {
      await executeStep2_Review(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, invocationContext);
      return;
    }
    if (currentStep === 3) {
      await executeStep3_Save(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, invocationContext);
      return;
    }
    if (currentStep === 4) {
      await executeStep4_NutritionFeedback(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, invocationContext);
      return;
    }
    if (currentStep === 5) {
      await executeStep5_RegenerateWithAdvice(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, invocationContext);
      return;
    }
    if (currentStep === 6) {
      await executeStep6_FinalSave(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, invocationContext);
      return;
    }
    throw new Error(`Unknown step ${currentStep}`);
  });
}

async function executeStep1_Generate(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
  body: any,
  invocationContext: V5InvocationContext,
) {
  console.log("🧩 V5 Step 1: Template planning and generation...");
  const reqRow = await loadRequestRow(supabase, requestId);
  if (String(reqRow.user_id) !== String(userId)) throw new Error("userId mismatch for request");

  const generatedData: V5GeneratedData = (reqRow.generated_data ?? {}) as any;
  const targetSlots = normalizeTargetSlots(reqRow.target_slots ?? []).length
    ? normalizeTargetSlots(reqRow.target_slots ?? [])
    : (Array.isArray(body?.targetSlots) ? body.targetSlots : []);
  if (targetSlots.length === 0) throw new Error("targetSlots is empty");

  // デフォルトの LLM プロバイダーを使用（XAI_API_KEY があれば Grok）
  setV4FastLLMOverride(undefined);

  const dates = generatedData.dates?.length ? generatedData.dates : uniqDatesFromSlots(targetSlots);
  const note = generatedData.note ?? (typeof body?.note === "string" ? body.note : null) ?? (typeof reqRow.prompt === "string" ? reqRow.prompt : null);
  let existingMenus: ExistingMenuContext[] = (generatedData.existingMenus ?? body?.existingMenus ?? []) as any[];
  let fridgeItems: FridgeItemContext[] = (generatedData.fridgeItems ?? body?.fridgeItems ?? []) as any[];
  let userProfile = generatedData.userProfile ?? body?.userProfile ?? {};
  const seasonalContext: SeasonalContext =
    (generatedData.seasonalContext ?? body?.seasonalContext) ??
    { month: new Date().getMonth() + 1, seasonalIngredients: { vegetables: [], fish: [], fruits: [] }, events: [] };
  const constraintsRaw = generatedData.constraints ?? body?.constraints ?? reqRow.constraints ?? {};

  const hasUserProfile = userProfile && typeof userProfile === "object" && Object.keys(userProfile).length > 0;
  if (existingMenus.length === 0 || fridgeItems.length === 0 || !hasUserProfile) {
    const contextStartDate = addDays(dates[0], -7);
    const contextEndDate = addDays(dates[dates.length - 1], 7);
    const todayStr = getTodayStr();
    const [existingMealsResult, pantryResult, profileResult] = await Promise.all([
      existingMenus.length === 0
        ? runSupabaseQuery<any[]>(
            () => supabase
              .from("user_daily_meals")
              .select(`
                day_date,
                planned_meals (
                  id,
                  meal_type,
                  dish_name,
                  is_completed,
                  mode
                )
              `)
              .eq("user_id", userId)
              .gte("day_date", contextStartDate)
              .lte("day_date", contextEndDate),
            `user_daily_meals.context:${userId}:${contextStartDate}:${contextEndDate}`,
            [],
          )
        : Promise.resolve([]),
      fridgeItems.length === 0
        ? runSupabaseQuery<any[]>(
            () => supabase
              .from("pantry_items")
              .select("name, amount, expiration_date")
              .eq("user_id", userId)
              .gte("expiration_date", todayStr)
              .order("expiration_date", { ascending: true }),
            `pantry_items.context:${userId}:${todayStr}`,
            [],
          )
        : Promise.resolve([]),
      !hasUserProfile
        ? runSupabaseQuery<any | null>(
            () => supabase.from("user_profiles").select("*").eq("id", userId).maybeSingle(),
            `user_profiles.context:${userId}`,
            null,
          )
        : Promise.resolve(null),
    ]);

    if (existingMenus.length === 0) {
      const fetched: ExistingMenuContext[] = [];
      for (const day of existingMealsResult as any[]) {
        const dayDate = String(day.day_date ?? "");
        const isPast = dayDate < todayStr;
        for (const meal of Array.isArray(day.planned_meals) ? day.planned_meals : []) {
          if (!meal?.dish_name) continue;
          const mode = String(meal.mode ?? "");
          fetched.push({
            date: dayDate,
            mealType: meal.meal_type as MealType,
            dishName: String(meal.dish_name),
            status: meal.is_completed ? "completed" : mode === "skip" ? "skip" : mode.startsWith("ai") ? "ai" : "manual",
            isPast,
          });
        }
      }
      existingMenus = fetched;
    }

    if (fridgeItems.length === 0) {
      fridgeItems = (pantryResult as any[]).map((item) => ({
        name: item.name,
        quantity: item.amount || undefined,
        expirationDate: item.expiration_date || undefined,
      }));
    }

    if (!hasUserProfile && profileResult) {
      userProfile = profileResult;
    }
  }

  const familySize = Number.isFinite(generatedData.familySize)
    ? Number(generatedData.familySize)
    : (Number.isFinite(body?.familySize) ? Number(body.familySize) : null) ??
      (Number.isFinite(userProfile?.family_size) ? Number(userProfile.family_size) : 1);

  const constraintsForContext = { ...(constraintsRaw ?? {}), familySize };
  const promptProfile = sanitizeGenerationPromptProfile(userProfile);
  const promptConstraints = sanitizeGenerationPromptConstraints(constraintsForContext);

  const nutritionTargets =
    generatedData.nutritionTargets ??
    (await runSupabaseQuery<any | null>(
      () => supabase.from("nutrition_goals").select("*").eq("user_id", userId).maybeSingle(),
      `nutrition_goals.context:${userId}`,
      null,
    ).catch(() => null)) ??
    null;

  let healthCheckups: HealthCheckupForContext[] | null = generatedData.healthCheckups ?? null;
  let healthGuidance: HealthCheckupGuidance | null = generatedData.healthGuidance ?? null;

  if (!healthCheckups || !healthGuidance) {
    try {
      const checkupsData = await runSupabaseQuery<any[]>(
        () => supabase
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
          .limit(3),
        `health_checkups.context:${userId}`,
        [],
      );
      healthCheckups = checkupsData as HealthCheckupForContext[];
      const reviewData = await runSupabaseQuery<any | null>(
        () => supabase
          .from("health_checkup_longitudinal_reviews")
          .select("nutrition_guidance")
          .eq("user_id", userId)
          .single(),
        `health_checkup_longitudinal_reviews.context:${userId}`,
        null,
      );
      healthGuidance = (reviewData?.nutrition_guidance ?? null) as HealthCheckupGuidance | null;
    } catch {
      healthCheckups = null;
      healthGuidance = null;
    }
  }

  // お気に入りレシピ取得 (#104)
  let likedRecipes: string[] = generatedData.likedRecipes ?? [];
  if (likedRecipes.length === 0) {
    try {
      const likedData = await runSupabaseQuery<any[]>(
        () => supabase
          .from("recipe_likes")
          .select("recipe_id")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(30),
        `recipe_likes.context:${userId}`,
        [],
      );
      likedRecipes = (likedData as any[]).map((r) => String(r.recipe_id)).filter(Boolean);
    } catch {
      likedRecipes = [];
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

  const baseSummary =
    generatedData.userSummary ??
    buildUserSummary(promptProfile, nutritionTargets, note, promptConstraints, healthCheckups, healthGuidance);

  // お気に入りレシピをプロンプトに追加（#104 + #113: 週内重複防止）
  const todayForDedup = getTodayStr();
  const weekStartForDedup = dates[0] ? addDays(dates[0], -7) : addDays(todayForDedup, -7);
  // 今週すでに献立に含まれているお気に入りレシピ（重複防止 #113）
  const usedLikedRecipesThisWeek = new Set(
    existingMenus
      .filter((m) => m.date >= weekStartForDedup && m.date <= todayForDedup)
      .map((m) => m.dishName),
  );
  const availableLikedRecipes = likedRecipes.filter((r) => !usedLikedRecipesThisWeek.has(r));
  const alreadyUsedLiked = likedRecipes.filter((r) => usedLikedRecipesThisWeek.has(r));

  let likedRecipesSection = "";
  if (availableLikedRecipes.length > 0) {
    likedRecipesSection += `\n\n【お気に入りレシピ（積極的に取り入れてください）】\n${availableLikedRecipes.slice(0, 20).join("、")}`;
  }
  if (alreadyUsedLiked.length > 0) {
    likedRecipesSection += `\n\n【お気に入りレシピ（今週すでに使用済み・重複を避けてください）】\n${alreadyUsedLiked.slice(0, 10).join("、")}`;
  }
  const userSummary = baseSummary + likedRecipesSection;

  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;
  let references: MenuReference[] = (generatedData.references ?? []) as any[];
  let referenceSummary = generatedData.referenceSummary ?? "";
  let slotPlans = generatedData.v5?.slotPlans ?? {};
  let seedTemplatesById = generatedData.v5?.seedTemplatesById ?? {};
  let templateCatalog = generatedData.v5?.templateCatalog ?? [];

  if (
    references.length === 0
    || Object.keys(slotPlans).length === 0
    || Object.keys(seedTemplatesById).length === 0
    || templateCatalog.length === 0
  ) {
    const searchQuery = buildSearchQueryBase({
      profile: promptProfile,
      nutritionTargets,
      note,
      constraints: promptConstraints,
    });
    const searchResult = await searchMenuCandidates(
      supabase,
      searchQuery,
      computeReferenceSearchMatchCount(targetSlots.length),
      targetSlots,
      seasonalContext.month,
    );
    references = searchResult.references;
    referenceSummary = buildReferenceMenuSummary(references, {
      maxPerRole: Math.max(6, Math.min(12, targetSlots.length * 2)),
    });

    const existingFingerprints = existingMenus.map((menu) => fingerprintExistingMenu(menu));
    const sodiumMode = inferSodiumMode({
      preferLowSodium: Boolean(constraintsForContext?.healthy),
      targetDailySodiumG: Number.isFinite(nutritionTargets?.sodium_g) ? Number(nutritionTargets.sodium_g) : null,
    });
    const planResult = planDiversityForRange({
      targetSlots: sortTargetSlots(targetSlots) as any,
      templates: searchResult.templates,
      existingFingerprints,
      sodiumMode,
    });
    slotPlans = planResult.slotPlans;
    seedTemplatesById = buildSeedTemplateMap(slotPlans, searchResult.templates);
    templateCatalog = searchResult.templates;
  }

  slotPlans = normalizeSlotPlansForPrompt(slotPlans, seedTemplatesById);

  const dayBatch = Number(generatedData.step1?.batchSize ?? DEFAULT_STEP1_DAY_BATCH);
  const cursor = Number(generatedData.step1?.cursor ?? 0);
  let nextCursor = cursor;

  const slotsByDate = new Map<string, TargetSlot[]>();
  for (const slot of targetSlots) {
    if (!slotsByDate.has(slot.date)) slotsByDate.set(slot.date, []);
    slotsByDate.get(slot.date)!.push(slot);
  }

  await updateProgress(
    supabase,
    requestId,
    {
      currentStep: 1,
      totalSteps: 2,
      message: `V5 生成中...（${cursor}/${dates.length}日）`,
      completedSlots: countGeneratedTargetSlots(targetSlots, generatedMeals),
      totalSlots: targetSlots.length,
    },
    1,
  );

  // ===== レシピDB直接指定の場合: LLM生成をスキップ =====
  if (constraintsForContext.recipeId || constraintsForContext.recipeExternalId) {
    console.log("📖 Recipe ID specified, resolving from database...");
    for (const slot of targetSlots) {
      const key = getSlotKey(slot.date, slot.mealType);
      if (generatedMeals[key]) continue;

      const resolved = await resolveRecipeFromDB(supabase, constraintsForContext, slot.mealType as MealType);
      if (resolved) {
        generatedMeals[key] = resolved.meal;
        (generatedMeals[key] as any)._resolvedNutrition = resolved.nutrition;
        (generatedMeals[key] as any)._recipeSource = resolved.source;
        console.log(`✅ Resolved ${slot.date} ${slot.mealType}: ${resolved.meal.dishes[0]?.name ?? "(unknown)"}`);
      }
    }
  }

  const CONCURRENCY = 3;
  let processedDays = 0;

  while (nextCursor < dates.length && processedDays < dayBatch) {
    if (processedDays > 0 && !hasTimeBudgetRemaining(invocationContext, STEP1_WAVE_RESERVE_MS)) {
      break;
    }

    const batchEnd = Math.min(nextCursor + CONCURRENCY, dates.length, cursor + dayBatch);
    const batchDates = dates.slice(nextCursor, batchEnd);
    if (batchDates.length === 0) break;

    await Promise.all(batchDates.map(async (date) => {
      const slotsForDate = slotsByDate.get(date) ?? [];
      if (slotsForDate.length === 0) return;

      const uniqueMealTypes = Array.from(new Set(slotsForDate.map((slot) => slot.mealType))) as MealType[];
      const coreTypes = uniqueMealTypes.filter((mealType) => mealType === "breakfast" || mealType === "lunch" || mealType === "dinner");
      const otherTypes = uniqueMealTypes.filter((mealType) => !(mealType === "breakfast" || mealType === "lunch" || mealType === "dinner"));

      if (coreTypes.length > 0) {
        const planSummary = buildPlanSummaryForDate({
          date,
          mealTypes: coreTypes,
          slotPlans,
          seedTemplatesById,
        });
        const dayContext = buildDayContext({
          date,
          mealTypes: coreTypes,
          slotsForDate,
          existingMenus,
          fridgeItems,
          seasonalContext,
          constraints: constraintsForContext,
        });
        const briefEntries = coreTypes.map((mealType) => {
          const plan = slotPlans[getSlotKey(date, mealType)];
          const seedTemplate = plan ? seedTemplatesById[plan.seedTemplateId] : undefined;
          const referenceExamples = selectReferenceMenusForPlan({
            plan,
            seedTemplate,
            templateCatalog,
            fallbackReferences: references,
            limit: 2,
          });
          return [
            mealType,
            {
              ...buildPromptBriefForPlan(plan, seedTemplate),
              referenceExamples,
            },
          ] as const;
        });
        const briefByMealType = Object.fromEntries(
          briefEntries,
        );
        const noteForDay = [note, dayContext, planSummary].filter(Boolean).join("\n\n");
        const previousDayMeals = collectPreviousDayMeals(date, generatedMeals, existingMenus);

        const dayMeals = await generateDayMealsWithLLM_V5({
          userSummary,
          userContext,
          note: noteForDay,
          date,
          mealTypes: coreTypes,
          referenceMenus: [],
          referenceSummary: [referenceSummary, planSummary].filter(Boolean).join("\n\n"),
          previousDayMeals,
          briefByMealType,
        });

        for (const meal of dayMeals.meals ?? []) {
          generatedMeals[getSlotKey(date, meal.mealType)] = meal;
        }

        // 欠けた mealType を個別再生成
        const missingCoreTypes = coreTypes.filter((mt) => !generatedMeals[getSlotKey(date, mt)]);
        if (missingCoreTypes.length > 0) {
          console.warn(`⚠️ ${date}: LLM output missing ${missingCoreTypes.join(",")} — retrying individually`);
          for (const missingType of missingCoreTypes) {
            const missingSlot = slotsForDate.find((s) => s.mealType === missingType);
            if (!missingSlot) continue;
            const missingKey = getSlotKey(date, missingType);
            const missingPlan = slotPlans[missingKey];
            const missingSeedTemplate = missingPlan ? seedTemplatesById[missingPlan.seedTemplateId] : undefined;
            const missingRefs = selectReferenceMenusForPlan({
              plan: missingPlan,
              seedTemplate: missingSeedTemplate,
              templateCatalog,
              fallbackReferences: references,
              limit: 3,
            });
            const missingBrief = {
              ...buildPromptBriefForPlan(missingPlan, missingSeedTemplate),
              referenceExamples: missingRefs,
            };
            const missingNote = [
              note,
              buildSlotContext({ targetSlot: missingSlot, existingMenus, fridgeItems, seasonalContext, constraints: constraintsForContext, note: null }),
              buildPlanSummaryForSlot(missingPlan, missingSeedTemplate),
            ].filter(Boolean).join("\n\n");
            const currentDishName = missingSlot.plannedMealId
              ? existingMenus.find((m) => m.date === date && m.mealType === missingType)?.dishName ?? null
              : null;
            try {
              generatedMeals[missingKey] = await generateMealWithLLM_V5({
                userSummary,
                userContext,
                note: missingNote,
                mealType: missingType,
                currentDishName,
                ...missingBrief,
                referenceMenus: missingRefs,
                referenceSummary: [referenceSummary, buildPlanSummaryForSlot(missingPlan, missingSeedTemplate)].filter(Boolean).join("\n\n"),
              });
              console.log(`✅ ${date}/${missingType}: recovered via individual generation`);
            } catch (e: any) {
              console.error(`❌ ${date}/${missingType}: individual generation failed: ${e?.message ?? e}`);
            }
          }
        }
      }

      for (const mealType of otherTypes) {
        const slot = slotsForDate.find((candidate) => candidate.mealType === mealType);
        if (!slot) continue;
        const key = getSlotKey(slot.date, slot.mealType);
        if (generatedMeals[key]) continue;

        const plan = slotPlans[key];
        const seedTemplate = plan ? seedTemplatesById[plan.seedTemplateId] : undefined;
        const referenceMenusForPlan = selectReferenceMenusForPlan({
          plan,
          seedTemplate,
          templateCatalog,
          fallbackReferences: references,
          limit: 3,
        });
        const promptBrief = {
          ...buildPromptBriefForPlan(plan, seedTemplate),
          referenceExamples: referenceMenusForPlan,
        };
        const noteForMeal = [
          note,
          buildSlotContext({
            targetSlot: slot,
            existingMenus,
            fridgeItems,
            seasonalContext,
            constraints: constraintsForContext,
            note: null,
          }),
          buildPlanSummaryForSlot(plan, seedTemplate),
        ].filter(Boolean).join("\n\n");

        const currentDishName = slot.plannedMealId
          ? existingMenus.find((menu) => menu.date === slot.date && menu.mealType === slot.mealType)?.dishName ?? null
          : null;

        generatedMeals[key] = await generateMealWithLLM_V5({
          userSummary,
          userContext,
          note: noteForMeal,
          mealType: slot.mealType,
          currentDishName,
          ...promptBrief,
          referenceMenus: referenceMenusForPlan,
          referenceSummary: [referenceSummary, buildPlanSummaryForSlot(plan, seedTemplate)].filter(Boolean).join("\n\n"),
        });
      }
    }));

    processedDays += batchDates.length;
    nextCursor += batchDates.length;
  }

  const step1Done = nextCursor >= dates.length;

  const updatedGeneratedData: V5GeneratedData = {
    ...generatedData,
    version: "v5",
    ultimateMode: body?.ultimateMode ?? generatedData.ultimateMode ?? false,
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
    likedRecipes,
    references,
    referenceSummary,
    healthCheckups,
    healthGuidance,
    generatedMeals,
    step1: {
      cursor: nextCursor,
      batchSize: dayBatch,
    },
    v5: {
      ...generatedData.v5,
      slotPlans,
      seedTemplatesById,
      templateCatalog,
    },
  };

  await runSupabaseQuery(
    () => supabase
      .from("weekly_menu_requests")
      .update({
        generated_data: updatedGeneratedData,
        current_step: step1Done ? 2 : 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId),
    `weekly_menu_requests.v5_step1:${requestId}`,
    null,
    10000,
    1,
  );

  await updateProgress(
    supabase,
    requestId,
    {
      currentStep: step1Done ? 2 : 1,
      totalSteps: 2,
      message: step1Done ? "V5 生成完了。ルール検証へ..." : `V5 生成中...（${nextCursor}/${dates.length}日）`,
      completedSlots: countGeneratedTargetSlots(targetSlots, generatedMeals),
      totalSlots: targetSlots.length,
    },
    step1Done ? 2 : 1,
  );

  await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
}

async function executeStep2_Review(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
  invocationContext: V5InvocationContext,
) {
  console.log("🧪 V5 Step 2: Rule validation and targeted fixes...");
  const reqRow = await loadRequestRow(supabase, requestId);
  if (String(reqRow.user_id) !== String(userId)) throw new Error("userId mismatch for request");

  const generatedData: V5GeneratedData = (reqRow.generated_data ?? {}) as any;
  const targetSlots = sortTargetSlots(generatedData.targetSlots ?? normalizeTargetSlots(reqRow.target_slots ?? []));
  const dates = generatedData.dates ?? uniqDatesFromSlots(targetSlots);
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;
  const existingMenus: ExistingMenuContext[] = (generatedData.existingMenus ?? []) as any[];
  const fridgeItems: FridgeItemContext[] = (generatedData.fridgeItems ?? []) as any[];
  const seasonalContext = generatedData.seasonalContext ?? { month: new Date().getMonth() + 1, seasonalIngredients: { vegetables: [], fish: [], fruits: [] }, events: [] };
  const constraints = generatedData.constraints ?? {};
  const note = generatedData.note ?? null;
  const userContext = generatedData.userContext;
  const userSummary = generatedData.userSummary ?? "";
  const references: MenuReference[] = (generatedData.references ?? []) as any[];
  const referenceSummary = generatedData.referenceSummary ?? buildReferenceMenuSummary(references);
  const slotPlans = normalizeSlotPlansForPrompt(
    generatedData.v5?.slotPlans ?? {},
    generatedData.v5?.seedTemplatesById ?? {},
  );
  const seedTemplatesById = generatedData.v5?.seedTemplatesById ?? {};
  const templateCatalog = generatedData.v5?.templateCatalog ?? Object.values(seedTemplatesById);

  // 穴埋め: Step1 で生成されなかったスロットを個別再生成
  const missingSlots = targetSlots.filter((slot) => {
    const key = getSlotKey(slot.date, slot.mealType);
    return !generatedMeals[key];
  });
  if (missingSlots.length > 0) {
    console.warn(`⚠️ Step2 start: ${missingSlots.length} slots missing, recovering...`);
    for (const missingSlot of missingSlots) {
      const missingKey = getSlotKey(missingSlot.date, missingSlot.mealType);
      const missingPlan = slotPlans[missingKey];
      const missingSeedTemplate = missingPlan ? seedTemplatesById[missingPlan.seedTemplateId] : undefined;
      const missingRefs = selectReferenceMenusForPlan({
        plan: missingPlan,
        seedTemplate: missingSeedTemplate,
        templateCatalog,
        fallbackReferences: references,
        limit: 3,
      });
      const missingBrief = {
        ...buildPromptBriefForPlan(missingPlan, missingSeedTemplate),
        referenceExamples: missingRefs,
      };
      const constraintsForContext = typeof constraints === "object" && constraints !== null ? constraints as Record<string, unknown> : {};
      const missingNote = [
        note,
        buildSlotContext({ targetSlot: missingSlot, existingMenus, fridgeItems, seasonalContext, constraints: constraintsForContext, note: null }),
        buildPlanSummaryForSlot(missingPlan, missingSeedTemplate),
      ].filter(Boolean).join("\n\n");
      const currentDishName = missingSlot.plannedMealId
        ? existingMenus.find((m) => m.date === missingSlot.date && m.mealType === missingSlot.mealType)?.dishName ?? null
        : null;
      try {
        generatedMeals[missingKey] = await generateMealWithLLM_V5({
          userSummary,
          userContext,
          note: missingNote,
          mealType: missingSlot.mealType as MealType,
          currentDishName,
          ...missingBrief,
          referenceMenus: missingRefs,
          referenceSummary: [referenceSummary, buildPlanSummaryForSlot(missingPlan, missingSeedTemplate)].filter(Boolean).join("\n\n"),
        });
        console.log(`✅ ${missingSlot.date}/${missingSlot.mealType}: recovered in Step2`);
      } catch (e: any) {
        console.error(`❌ ${missingSlot.date}/${missingSlot.mealType}: recovery failed: ${e?.message ?? e}`);
      }
    }
    // generatedMeals を DB に保存
    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update({ generated_data: { ...generatedData, generatedMeals } })
        .eq("id", requestId),
      `weekly_menu_requests.recovery_save:${requestId}`,
    );
  }

  // Post-nutrition fix: V4 Step3 から差し戻された栄養外れ値スロットを再生成
  const postNutritionIssues: PostNutritionIssue[] = Array.isArray(generatedData.v5?.postNutritionIssues) ? generatedData.v5.postNutritionIssues : [];
  const slotsToRegenerate: Array<{ date: string; mealType: string }> = Array.isArray(generatedData.v5?.slotsToRegenerate) ? generatedData.v5.slotsToRegenerate : [];

  if (slotsToRegenerate.length > 0) {
    console.log(`🔄 V5 Step 2: Post-nutrition re-generation for ${slotsToRegenerate.length} slots`);

    await updateProgress(
      supabase,
      requestId,
      {
        currentStep: 2,
        totalSteps: 2,
        message: `栄養外れ値 ${slotsToRegenerate.length} 件を再生成中...`,
        completedSlots: 0,
        totalSlots: targetSlots.length,
      },
      2,
    );

    let regeneratedCount = 0;
    for (const regenSlot of slotsToRegenerate) {
      if (regeneratedCount > 0 && !hasTimeBudgetRemaining(invocationContext, STEP2_FIX_RESERVE_MS)) {
        break;
      }

      const slotKey = getSlotKey(regenSlot.date, regenSlot.mealType as MealType);
      const slot = targetSlots.find((s) => s.date === regenSlot.date && s.mealType === regenSlot.mealType);
      if (!slot) continue;

      const issue = postNutritionIssues.find((i) => i.key === slotKey);
      const plan = slotPlans[slotKey];
      const seedTemplate = plan ? (seedTemplatesById[plan.seedTemplateId] ?? templateCatalog.find((t) => t.id === plan.seedTemplateId)) : undefined;
      const referenceMenusForPlan = selectReferenceMenusForPlan({
        plan,
        seedTemplate,
        templateCatalog,
        fallbackReferences: references,
        limit: 3,
      });
      const basePromptBrief = buildPromptBriefForPlan(plan, seedTemplate);
      const promptBrief = {
        ...basePromptBrief,
        referenceExamples: referenceMenusForPlan,
      };
      const noteForFix = [
        note,
        buildSlotContext({
          targetSlot: slot,
          existingMenus,
          fridgeItems,
          seasonalContext,
          constraints,
          note: null,
        }),
        buildPlanSummaryForSlot(plan, seedTemplate),
      ].filter(Boolean).join("\n\n");

      const fixedMeal = await regenerateMealForIssue_V5({
        userSummary,
        userContext,
        note: noteForFix,
        date: slot.date,
        mealType: slot.mealType,
        currentDishes: [],
        issue: issue?.issue ?? `${slot.mealType} の栄養バランスが基準外です。`,
        suggestion: issue?.suggestion ?? "量と味付けのバランスを見直してください。",
        ...promptBrief,
        referenceMenus: referenceMenusForPlan,
        referenceSummary: [referenceSummary, buildPlanSummaryForSlot(plan, seedTemplate)].filter(Boolean).join("\n\n"),
      });
      generatedMeals[slotKey] = fixedMeal;
      regeneratedCount++;
    }

    // postNutritionIssues と slotsToRegenerate をクリアして Step3 へ戻す
    const updatedGeneratedData: V5GeneratedData = {
      ...generatedData,
      generatedMeals,
      v5: {
        ...generatedData.v5,
        slotPlans,
        seedTemplatesById,
        templateCatalog,
        postNutritionIssues: [],
        slotsToRegenerate: [],
      },
    };

    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update({
          generated_data: updatedGeneratedData,
          current_step: 3,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId),
      `weekly_menu_requests.v5_post_nutrition_fix:${requestId}`,
      null,
      10000,
      1,
    );

    await updateProgress(
      supabase,
      requestId,
      {
        currentStep: 3,
        totalSteps: generatedData.ultimateMode ? 6 : 3,
        message: `栄養外れ値を修正完了。保存に戻ります...`,
        completedSlots: countGeneratedTargetSlots(targetSlots, generatedMeals),
        totalSlots: targetSlots.length,
      },
      3,
    );

    await clearExistingPlannedMeals(supabase, userId, targetSlots);
    await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  const validation = validateGeneratedMeals({
    targetSlots,
    generatedMeals,
    slotPlans,
    existingFingerprints: existingMenus.map((menu) => fingerprintExistingMenu(menu)),
  });
  const hardViolations = validation.violations.filter((violation) => violation.severity === "hard");
  const softViolations = validation.violations.filter((violation) => violation.severity === "soft");
  const step2 = generatedData.step2 ?? {};
  const fixesPerRun = Number(step2.fixesPerRun ?? DEFAULT_STEP2_FIXES_PER_RUN);
  const hardAttemptCounts = { ...(step2.hardAttemptCounts ?? {}) };

  if (hardViolations.length > 0) {
    await updateProgress(
      supabase,
      requestId,
      {
        currentStep: 2,
        totalSteps: 2,
        message: `V5 ルール違反を修正中...（${Math.min(fixesPerRun, hardViolations.length)}/${hardViolations.length}）`,
        completedSlots: 0,
        totalSlots: targetSlots.length,
      },
      2,
    );

    let fixedCount = 0;
    while (fixedCount < fixesPerRun) {
      if (fixedCount > 0 && !hasTimeBudgetRemaining(invocationContext, STEP2_FIX_RESERVE_MS)) {
        break;
      }

      const refreshedValidation = validateGeneratedMeals({
        targetSlots,
        generatedMeals,
        slotPlans,
        existingFingerprints: existingMenus.map((menu) => fingerprintExistingMenu(menu)),
      });
      const pendingHardViolations = refreshedValidation.violations.filter((violation) => violation.severity === "hard");
      if (pendingHardViolations.length === 0) {
        break;
      }

      const violation = pendingHardViolations[0];

      const slot = targetSlots.find((candidate) => getSlotKey(candidate.date, candidate.mealType) === violation.slotKey);
      const currentMeal = generatedMeals[violation.slotKey];
      if (!slot || !currentMeal) continue;

      const attemptKey = `${violation.code}:${violation.slotKey}`;
      const nextAttempt = Number(hardAttemptCounts[attemptKey] ?? 0) + 1;
      hardAttemptCounts[attemptKey] = nextAttempt;
      if (nextAttempt > 4) {
        // 4回試行しても収束しない場合は、そのスロットのバイオレーションを受け入れて続行する
        // (throwするとEdge Functionがサイレント失敗し、ユーザーには何も届かないため)
        console.warn(
          `[V5] hard violation did not converge after ${nextAttempt - 1} retries, accepting slot as-is:`,
          violation.code,
          violation.slotKey,
        );
        fixedCount++;
        continue;
      }

      const replanned = replanSlotForViolation({
        slot,
        violation,
        slotPlans,
        seedTemplatesById,
        templateCatalog,
        targetSlots,
        generatedMeals,
        existingMenus,
      });
      if (replanned) {
        slotPlans[violation.slotKey] = replanned;
        const replannedTemplate = templateCatalog.find((template) => template.id === replanned.seedTemplateId);
        if (replannedTemplate) {
          seedTemplatesById[replannedTemplate.id] = replannedTemplate;
        }
      }

      const plan = slotPlans[violation.slotKey];
      const seedTemplate = plan ? (seedTemplatesById[plan.seedTemplateId] ?? templateCatalog.find((template) => template.id === plan.seedTemplateId)) : undefined;
      const referenceMenusForPlan = selectReferenceMenusForPlan({
        plan,
        seedTemplate,
        templateCatalog,
        fallbackReferences: references,
        limit: 3,
      });
      const basePromptBrief = buildPromptBriefForPlan(plan, seedTemplate);
      const promptBrief = {
        ...basePromptBrief,
        referenceExamples: referenceMenusForPlan,
        forbiddenDishNames: [
          ...new Set([
            ...(basePromptBrief.forbiddenDishNames ?? []),
            ...(currentMeal.dishes ?? []).map((dish) => String(dish?.name ?? "").trim()).filter(Boolean),
          ]),
        ],
        forbiddenMainDishFamilies: [
          ...new Set([
            ...(basePromptBrief.forbiddenMainDishFamilies ?? []),
            ...collectForbiddenMainDishFamiliesForViolation({
              violation,
              slot,
              currentMeal,
              currentPlan: plan,
              relatedSlotKeys: violation.relatedSlotKeys ?? [],
              generatedMeals,
              slotPlans,
            }),
          ]),
        ],
        forbiddenBreakfastTemplates: [
          ...new Set([
            ...(basePromptBrief.forbiddenBreakfastTemplates ?? []),
            ...collectForbiddenBreakfastTemplatesForViolation({
              violation,
              slot,
              currentMeal,
              currentPlan: plan,
              relatedSlotKeys: violation.relatedSlotKeys ?? [],
              generatedMeals,
              slotPlans,
            }),
          ]),
        ],
      };
      const noteForFix = [
        note,
        buildSlotContext({
          targetSlot: slot,
          existingMenus,
          fridgeItems,
          seasonalContext,
          constraints,
          note: null,
        }),
        buildPlanSummaryForSlot(plan, seedTemplate),
      ].filter(Boolean).join("\n\n");

      const fixedMeal = await regenerateMealForIssue_V5({
        userSummary,
        userContext,
        note: noteForFix,
        date: slot.date,
        mealType: slot.mealType,
        currentDishes: (currentMeal.dishes ?? []).map((dish) => String(dish?.name ?? "")).filter(Boolean),
        issue: violation.message,
        suggestion: buildSuggestionFromViolation(violation, plan),
        ...promptBrief,
        referenceMenus: referenceMenusForPlan,
        referenceSummary: [referenceSummary, buildPlanSummaryForSlot(plan, seedTemplate)].filter(Boolean).join("\n\n"),
      });
      generatedMeals[violation.slotKey] = fixedMeal;
      fixedCount++;
    }

    const postFixValidation = validateGeneratedMeals({
      targetSlots,
      generatedMeals,
      slotPlans,
      existingFingerprints: existingMenus.map((menu) => fingerprintExistingMenu(menu)),
    });

    const updatedGeneratedData: V5GeneratedData = {
      ...generatedData,
      generatedMeals,
      step2: {
        ...step2,
        fixesPerRun,
        hardAttemptCounts,
      },
      v5: {
        ...generatedData.v5,
        slotPlans,
        seedTemplatesById,
        templateCatalog,
        hardViolations: postFixValidation.violations.filter((violation) => violation.severity === "hard").slice(0, 100),
        softViolations: postFixValidation.violations.filter((violation) => violation.severity === "soft").slice(0, 100),
      },
    };

    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update({
          generated_data: updatedGeneratedData,
          current_step: 2,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId),
      `weekly_menu_requests.v5_step2_hard:${requestId}`,
      null,
      10000,
      1,
    );

    await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  let softIssues = Array.isArray(step2.softIssues) ? step2.softIssues : [];
  const reviewCompleted = Boolean(step2.reviewCompleted);
  if (shouldRunSoftReview(reviewCompleted, hardViolations)) {
    const reviewResult = await reviewWeeklyMenus({
      weeklyMeals: buildWeeklyMealsSummaryForDates({ dates, generatedMeals, existingMenus }),
      userSummary,
    }).catch((): ReviewResult => ({ hasIssues: false, issues: [], swaps: [] }));
    softIssues = (reviewResult.issues ?? []).map((issue) => ({
      date: String(issue.date).slice(0, 10),
      mealType: issue.mealType,
      issue: issue.issue,
      suggestion: issue.suggestion,
    }));
  }

  const maxFixes = computeMaxFixesForRange({
    days: dates.length,
    issuesCount: softIssues.length,
  });
  let fixCursor = Number(step2.fixCursor ?? 0);

  if (fixCursor < softIssues.length && fixCursor < maxFixes) {
    let fixedCount = 0;
    while (fixCursor < softIssues.length && fixCursor < maxFixes && fixedCount < fixesPerRun) {
      if (fixedCount > 0 && !hasTimeBudgetRemaining(invocationContext, STEP2_FIX_RESERVE_MS)) {
        break;
      }

      const issue = softIssues[fixCursor];
      const slotKey = getSlotKey(issue.date, issue.mealType);
      const slot = targetSlots.find((candidate) => candidate.date === issue.date && candidate.mealType === issue.mealType);
      const currentMeal = generatedMeals[slotKey];
      if (!slot || !currentMeal) {
        fixCursor++;
        continue;
      }

      const plan = slotPlans[slotKey];
      const seedTemplate = plan ? seedTemplatesById[plan.seedTemplateId] : undefined;
      const referenceMenusForPlan = selectReferenceMenusForPlan({
        plan,
        seedTemplate,
        templateCatalog,
        fallbackReferences: references,
        limit: 3,
      });
      const basePromptBrief = buildPromptBriefForPlan(plan, seedTemplate);
      const promptBrief = {
        ...basePromptBrief,
        referenceExamples: referenceMenusForPlan,
        forbiddenDishNames: [
          ...new Set([
            ...(basePromptBrief.forbiddenDishNames ?? []),
            ...(currentMeal.dishes ?? []).map((dish) => String(dish?.name ?? "").trim()).filter(Boolean),
          ]),
        ],
      };
      const noteForFix = [
        note,
        buildSlotContext({
          targetSlot: slot,
          existingMenus,
          fridgeItems,
          seasonalContext,
          constraints,
          note: null,
        }),
        buildPlanSummaryForSlot(plan, seedTemplate),
      ].filter(Boolean).join("\n\n");

      generatedMeals[slotKey] = await regenerateMealForIssue_V5({
        userSummary,
        userContext,
        note: noteForFix,
        date: slot.date,
        mealType: slot.mealType,
        currentDishes: (currentMeal.dishes ?? []).map((dish) => String(dish?.name ?? "")).filter(Boolean),
        issue: issue.issue,
        suggestion: issue.suggestion,
        ...promptBrief,
        referenceMenus: referenceMenusForPlan,
        referenceSummary: [referenceSummary, buildPlanSummaryForSlot(plan, seedTemplate)].filter(Boolean).join("\n\n"),
      });

      fixCursor++;
      fixedCount++;
    }

    const updatedGeneratedData: V5GeneratedData = {
      ...generatedData,
      generatedMeals,
      step2: {
        reviewCompleted: true,
        softIssues,
        fixCursor,
        fixesPerRun,
        maxFixes,
        hardAttemptCounts,
      },
      v5: {
        ...generatedData.v5,
        slotPlans,
        seedTemplatesById,
        templateCatalog,
        hardViolations: [],
        softViolations: softViolations.slice(0, 100),
      },
    };

    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update({
          generated_data: updatedGeneratedData,
          current_step: 2,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId),
      `weekly_menu_requests.v5_step2_soft:${requestId}`,
      null,
      10000,
      1,
    );

    await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  const finalGeneratedData: V5GeneratedData = {
    ...generatedData,
    generatedMeals,
    step2: {
      reviewCompleted: true,
      softIssues,
      fixCursor,
      fixesPerRun,
      maxFixes,
      hardAttemptCounts,
    },
    v5: {
      ...generatedData.v5,
      slotPlans,
      seedTemplatesById,
      templateCatalog,
      hardViolations: [],
      softViolations: softViolations.slice(0, 100),
    },
  };

  await runSupabaseQuery(
    () => supabase
      .from("weekly_menu_requests")
      .update({
        generated_data: finalGeneratedData,
        current_step: 3,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId),
    `weekly_menu_requests.v5_handoff:${requestId}`,
    null,
    10000,
    1,
  );

  await updateProgress(
    supabase,
    requestId,
    {
      currentStep: 3,
      totalSteps: finalGeneratedData.ultimateMode ? 6 : 3,
      message: "V5 生成完了。栄養計算・保存へ移行します...",
      completedSlots: countGeneratedTargetSlots(targetSlots, generatedMeals),
      totalSlots: targetSlots.length,
    },
    3,
  );

  await clearExistingPlannedMeals(supabase, userId, targetSlots);
  await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
}

// =========================================================
// Step 4: Nutrition Feedback (Ultimate Mode only)
// 栄養データを分析してフィードバックを生成
// =========================================================

async function executeStep4_NutritionFeedback(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string,
  invocationContext: V5InvocationContext,
) {
  console.log("📊 V5 Step 4: Nutrition feedback analysis...");

  const reqRow = await loadRequestRow(supabase, requestId);
  const generatedData: V5GeneratedData = (reqRow.generated_data ?? {}) as any;
  const dates = generatedData.dates ?? [];
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;
  const userSummary = generatedData.userSummary ?? "";

  const step4 = generatedData.step4 ?? {};
  const BATCH = Number(step4.batchSize ?? DEFAULT_STEP4_DAY_BATCH);
  const cursor = Number(step4.cursor ?? 0);
  const feedbackByDate: Record<string, NutritionFeedbackResult & { issuesFound: string[] }> =
    (step4.feedbackByDate ?? {}) as any;
  const daysNeedingImprovement: string[] = step4.daysNeedingImprovement ?? [];

  await updateProgress(
    supabase,
    requestId,
    { currentStep: 4, totalSteps: 6, message: `栄養バランスを分析中...（${cursor}/${dates.length}日）`, completedSlots: cursor, totalSlots: dates.length },
    4,
  );

  const weekData = buildWeekDataFromMeals(generatedMeals, dates);

  let newCursor = cursor;
  while (newCursor < dates.length && newCursor - cursor < BATCH) {
    if (newCursor > cursor && !hasTimeBudgetRemaining(invocationContext, STEP4_DAY_RESERVE_MS)) {
      break;
    }
    const date = dates[newCursor];
    const dayNutrition = aggregateDayNutrition(generatedMeals, date);
    const mealCount = Object.keys(generatedMeals).filter(key => key.startsWith(`${date}:`)).length;

    try {
      const feedback = await generateNutritionFeedback(
        date,
        dayNutrition,
        mealCount,
        weekData,
        userSummary,
      );

      const issuesFound: string[] = [];
      if (feedback.advice.includes("不足")) issuesFound.push("栄養素不足");
      if (feedback.advice.includes("過剰")) issuesFound.push("栄養素過剰");
      if (feedback.advice.includes("バランス")) issuesFound.push("バランス改善");

      feedbackByDate[date] = { ...feedback, issuesFound };

      if (feedback.advice && feedback.advice.length > 50) {
        if (!daysNeedingImprovement.includes(date)) {
          daysNeedingImprovement.push(date);
        }
      }

      console.log(`📊 [${date}] Feedback generated: ${issuesFound.join(", ") || "良好"}`);
    } catch (e: any) {
      console.error(`❌ [${date}] Feedback generation failed:`, e?.message);
      feedbackByDate[date] = {
        praiseComment: "バランスの良い食事を心がけていますね✨",
        advice: "",
        nutritionTip: "",
        issuesFound: [],
      };
    }
    newCursor++;
  }

  const updatedGeneratedData: V5GeneratedData = {
    ...generatedData,
    step4: { cursor: newCursor, batchSize: BATCH, feedbackByDate, daysNeedingImprovement },
  };

  if (newCursor < dates.length) {
    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update({ generated_data: updatedGeneratedData, current_step: 4, updated_at: new Date().toISOString() })
        .eq("id", requestId),
      `weekly_menu_requests.v5_step4_continue:${requestId}`,
      null, 10000, 1,
    );

    await updateProgress(supabase, requestId,
      { currentStep: 4, totalSteps: 6, message: `栄養バランスを分析中...（${newCursor}/${dates.length}日）`, completedSlots: newCursor, totalSlots: dates.length },
      4,
    );

    await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  console.log(`📊 Step 4 完了: ${daysNeedingImprovement.length}日が改善対象`);

  await runSupabaseQuery(
    () => supabase
      .from("weekly_menu_requests")
      .update({ generated_data: updatedGeneratedData, current_step: 5, updated_at: new Date().toISOString() })
      .eq("id", requestId),
    `weekly_menu_requests.v5_step4_to_step5:${requestId}`,
    null, 10000, 1,
  );

  await updateProgress(supabase, requestId,
    { currentStep: 5, totalSteps: 6, message: "アドバイスを反映して献立を改善中...", completedSlots: 0, totalSlots: daysNeedingImprovement.length },
    5,
  );

  await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
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
  invocationContext: V5InvocationContext,
) {
  console.log("🔄 V5 Step 5: Regenerating meals with advice...");

  const reqRow = await loadRequestRow(supabase, requestId);
  const generatedData: V5GeneratedData = (reqRow.generated_data ?? {}) as any;
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;
  const targetSlots = generatedData.targetSlots ?? [];

  const existingMenus = (generatedData.existingMenus ?? []) as ExistingMenuContext[];
  const fridgeItems = (generatedData.fridgeItems ?? []) as FridgeItemContext[];
  const seasonalContext: SeasonalContext = (generatedData.seasonalContext as any) ??
    { month: new Date().getMonth() + 1, seasonalIngredients: { vegetables: [], fish: [], fruits: [] }, events: [] };
  const constraints = generatedData.constraints ?? {};
  const note = generatedData.note ?? null;
  const userContext = generatedData.userContext;
  const userSummary = generatedData.userSummary ?? "";
  const references = (generatedData.references ?? []) as MenuReference[];
  const referenceSummary = generatedData.referenceSummary ?? buildReferenceMenuSummary(references);

  const slotPlans = generatedData.v5?.slotPlans ?? {};
  const seedTemplatesById = generatedData.v5?.seedTemplatesById ?? {};

  const step4 = generatedData.step4 ?? {};
  const feedbackByDate = step4.feedbackByDate ?? {};
  const daysNeedingImprovement = step4.daysNeedingImprovement ?? [];

  const step5 = generatedData.step5 ?? {};
  const BATCH = Number(step5.batchSize ?? DEFAULT_STEP5_DAY_BATCH);
  const cursor = Number(step5.cursor ?? 0);
  const regeneratedDates: string[] = step5.regeneratedDates ?? [];

  await updateProgress(supabase, requestId,
    { currentStep: 5, totalSteps: 6, message: `献立を改善中...（${cursor}/${daysNeedingImprovement.length}日）`, completedSlots: cursor, totalSlots: daysNeedingImprovement.length },
    5,
  );

  const slotsByDate = new Map<string, TargetSlot[]>();
  for (const s of targetSlots) {
    if (!slotsByDate.has(s.date)) slotsByDate.set(s.date, []);
    slotsByDate.get(s.date)!.push(s);
  }

  let newCursor = cursor;
  while (newCursor < daysNeedingImprovement.length && newCursor - cursor < BATCH) {
    if (newCursor > cursor && !hasTimeBudgetRemaining(invocationContext, STEP5_DAY_RESERVE_MS)) {
      break;
    }
    const date = daysNeedingImprovement[newCursor];
    const feedback = feedbackByDate[date];
    if (!feedback || !feedback.advice) {
      regeneratedDates.push(date);
      newCursor++;
      continue;
    }

    const slotsForDate = slotsByDate.get(date) ?? [];
    if (slotsForDate.length === 0) {
      regeneratedDates.push(date);
      newCursor++;
      continue;
    }

    const mealTypes = Array.from(new Set(slotsForDate.map(s => s.mealType))) as MealType[];
    const coreTypes = mealTypes.filter(t => t === "breakfast" || t === "lunch" || t === "dinner");

    if (coreTypes.length > 0) {
      const dayContext = buildDayContext({
        date,
        mealTypes: coreTypes,
        slotsForDate,
        existingMenus,
        fridgeItems,
        seasonalContext,
        constraints,
      });

      const mealTypeLabels: Record<string, string> = { breakfast: "朝食", lunch: "昼食", dinner: "夕食" };
      const replacementInstructions = (feedback as any).replacements?.map((r: any) =>
        `- ${mealTypeLabels[r.meal] || r.meal}の「${r.target}」→「${r.replacement}」${r.nutrientGain ? `（${r.nutrientGain}）` : ""}`
      ).join("\n");

      const adviceNote = replacementInstructions
        ? `【献立改善指示】\n以下の置換を反映した献立を生成してください。カロリーは現状を維持すること。\n\n${replacementInstructions}\n\n重要: 上記の置換指示に従い、カロリーを増やさずに栄養バランスを改善してください。`
        : `【栄養士からのアドバイス】\n${feedback.advice}\n\n上記アドバイスを反映した献立を生成してください。カロリーを増やさないように注意。`;

      const planSummary = buildPlanSummaryForDate({
        date,
        mealTypes: coreTypes,
        slotPlans,
        seedTemplatesById,
      });
      const noteForDay = [note, dayContext, planSummary, adviceNote].filter(Boolean).join("\n\n");
      const previousDayMeals = collectPreviousDayMeals(date, generatedMeals, existingMenus);

      const briefEntries = coreTypes.map((mealType) => {
        const plan = slotPlans[getSlotKey(date, mealType)];
        const seedTemplate = plan ? seedTemplatesById[plan.seedTemplateId] : undefined;
        return [mealType, buildPromptBriefForPlan(plan, seedTemplate)] as const;
      });
      const briefByMealType = Object.fromEntries(briefEntries);

      try {
        const dayMeals = await generateDayMealsWithLLM_V5({
          userSummary,
          userContext,
          note: noteForDay,
          date,
          mealTypes: coreTypes,
          referenceMenus: [],
          referenceSummary: [referenceSummary, planSummary].filter(Boolean).join("\n\n"),
          previousDayMeals,
          briefByMealType,
        });

        for (const meal of dayMeals.meals ?? []) {
          generatedMeals[getSlotKey(date, meal.mealType)] = meal;
        }

        console.log(`🔄 [${date}] Regenerated ${coreTypes.length} meals with advice`);
      } catch (e: any) {
        console.error(`❌ [${date}] Regeneration failed:`, e?.message);
      }
    }

    regeneratedDates.push(date);
    newCursor++;
  }

  const updatedGeneratedData: V5GeneratedData = {
    ...generatedData,
    generatedMeals,
    step5: { cursor: newCursor, batchSize: BATCH, regeneratedDates },
  };

  if (newCursor < daysNeedingImprovement.length) {
    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update({ generated_data: updatedGeneratedData, current_step: 5, updated_at: new Date().toISOString() })
        .eq("id", requestId),
      `weekly_menu_requests.v5_step5_continue:${requestId}`,
      null, 10000, 1,
    );

    await updateProgress(supabase, requestId,
      { currentStep: 5, totalSteps: 6, message: `献立を改善中...（${newCursor}/${daysNeedingImprovement.length}日）`, completedSlots: newCursor, totalSlots: daysNeedingImprovement.length },
      5,
    );

    await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  console.log(`🔄 Step 5 完了: ${regeneratedDates.length}日を再生成`);

  const totalSlots = targetSlots.length;
  await runSupabaseQuery(
    () => supabase
      .from("weekly_menu_requests")
      .update({ generated_data: updatedGeneratedData, current_step: 6, updated_at: new Date().toISOString() })
      .eq("id", requestId),
    `weekly_menu_requests.v5_step5_to_step6:${requestId}`,
    null, 10000, 1,
  );

  await updateProgress(supabase, requestId,
    { currentStep: 6, totalSteps: 6, message: "最終調整・保存中...", completedSlots: 0, totalSlots },
    6,
  );

  await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
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
  invocationContext: V5InvocationContext,
) {
  console.log("💾 V5 Step 6: Final save...");

  const reqRow = await loadRequestRow(supabase, requestId);
  const generatedData: V5GeneratedData = (reqRow.generated_data ?? {}) as any;
  const targetSlots = sortTargetSlots(generatedData.targetSlots ?? normalizeTargetSlots(reqRow.target_slots ?? []));
  const totalSlots = targetSlots.length;
  const generatedMeals: Record<string, GeneratedMeal> = (generatedData.generatedMeals ?? {}) as any;

  const step6 = generatedData.step6 ?? {};
  const BATCH = Number(step6.batchSize ?? DEFAULT_STEP6_SLOT_BATCH);
  const cursor = Number(step6.cursor ?? 0);
  const savedCountStart = Number(step6.savedCount ?? 0);
  const errors: SaveIssue[] = Array.isArray(step6.errors) ? step6.errors : [];
  const skipped: SaveIssue[] = Array.isArray(step6.skipped) ? step6.skipped : [];
  const ingredientMatchMemo = deserializeIngredientMatchCache(
    step6.ingredientMatchCache ?? generatedData.step3?.ingredientMatchCache,
  );
  const targetSlotsForRun = targetSlots.slice(cursor, Math.min(cursor + BATCH, totalSlots));
  const dailyMealIdByDate = await ensureDailyMealIdsForDates(
    supabase,
    userId,
    targetSlotsForRun.map((slot) => slot.date),
  );
  let savedCount = savedCountStart;

  await updateProgress(supabase, requestId,
    { currentStep: 6, totalSteps: 6, message: `最終保存中...（${cursor}/${totalSlots}）`, completedSlots: cursor, totalSlots },
    6,
  );

  const STEP6_CONCURRENCY = 5;
  let newCursor = cursor;
  const batchEnd = Math.min(cursor + BATCH, totalSlots);

  while (newCursor < batchEnd) {
    if (newCursor > cursor && !hasTimeBudgetRemaining(invocationContext, STEP6_SLOT_RESERVE_MS)) {
      break;
    }

    const batchSlots: Array<{ index: number; slot: TargetSlot; key: string; meal: GeneratedMeal | null }> = [];
    for (let b = 0; b < STEP6_CONCURRENCY && newCursor + b < batchEnd; b++) {
      const idx = newCursor + b;
      const slot = targetSlots[idx];
      const key = getSlotKey(slot.date, slot.mealType);
      const meal = generatedMeals[key] ?? null;
      batchSlots.push({ index: idx, slot, key, meal });
    }

    const batchResults = await Promise.all(batchSlots.map(async ({ index, slot, key, meal }) => {
      if (!meal) {
        return { index, key, type: "no_meal" as const };
      }
      try {
        const saveResult = await saveMealToDb(supabase, {
          userId,
          requestId,
          targetSlot: slot,
          generatedMeal: meal,
          dailyMealIdByDate,
          ingredientMatchMemo,
          sourceFunction: "generate-menu-v5",
        });
        return { index, key, type: "saved" as const, saveResult };
      } catch (e: any) {
        return { index, key, type: "error" as const, error: e?.message ?? String(e) };
      }
    }));

    for (const result of batchResults) {
      if (result.type === "no_meal") {
        errors.push({ key: result.key, error: "No generated meal" });
      } else if (result.type === "error") {
        errors.push({ key: result.key, error: result.error });
      } else if (result.type === "saved" && result.saveResult) {
        if (result.saveResult.outcome === "skipped_existing") {
          skipped.push({ key: result.key, error: result.saveResult.reason ?? "既存献立を保護したため未保存" });
        } else {
          savedCount++;
        }
      }
    }

    newCursor += batchSlots.length;

    if (shouldEmitProgressUpdate(newCursor, totalSlots)) {
      await updateProgress(supabase, requestId,
        { currentStep: 6, totalSteps: 6, message: `最終保存中...（${newCursor}/${totalSlots}）`, completedSlots: newCursor, totalSlots },
        6,
      );
    }
  }

  const updatedGeneratedData: V5GeneratedData = {
    ...generatedData,
    step6: {
      cursor: newCursor,
      batchSize: BATCH,
      savedCount,
      errors: errors.slice(-200),
      skipped: skipped.slice(-200),
      ingredientMatchCache: serializeIngredientMatchCache(ingredientMatchMemo),
    },
  };

  if (newCursor < totalSlots) {
    await runSupabaseQuery(
      () => supabase
        .from("weekly_menu_requests")
        .update({ generated_data: updatedGeneratedData, current_step: 6, updated_at: new Date().toISOString() })
        .eq("id", requestId),
      `weekly_menu_requests.v5_step6_continue:${requestId}`,
      null, 10000, 1,
    );

    await updateProgress(supabase, requestId,
      { currentStep: 6, totalSteps: 6, message: `最終保存中...（${newCursor}/${totalSlots}）`, completedSlots: newCursor, totalSlots },
      6,
    );

    await triggerNextV5Step(supabaseUrl, supabaseServiceKey, requestId, userId);
    return;
  }

  // Done - Ultimate Mode completed!
  const step4 = generatedData.step4 ?? {};
  const feedbackByDate = step4.feedbackByDate ?? {};
  const firstFeedback = Object.values(feedbackByDate)[0];
  const praiseComment = (firstFeedback as any)?.praiseComment ?? "";

  const finalSummary = summarizeSaveResults({
    totalSlots,
    savedCount,
    skipped,
    errors,
    successMessage: `全${totalSlots}件の献立が完成しました！`,
    successSuffix: praiseComment ? ` ${praiseComment}` : "",
  });

  await runSupabaseQuery(
    () => supabase
      .from("weekly_menu_requests")
      .update({
        status: finalSummary.status,
        generated_data: updatedGeneratedData,
        current_step: 6,
        progress: {
          currentStep: 6,
          totalSteps: 6,
          message: finalSummary.message,
          completedSlots: totalSlots,
          totalSlots,
        },
        error_message: finalSummary.errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId),
    `weekly_menu_requests.v5_step6_final:${requestId}`,
    null, 10000, 1,
  );

  console.log(`✅ V5 Ultimate Mode completed: ${savedCount}/${totalSlots} meals saved`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceKey = Deno.env.get("SERVICE_ROLE_JWT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase: any = createClient(supabaseUrl, supabaseServiceKey);

  let requestId: string | null = null;
  let userId: string | null = null;

  try {
    const body = await req.json().catch(() => ({}));
    requestId = body.request_id ?? body.requestId ?? null;
    const isContinue = body._continue === true;

    const authHeader = req.headers.get("Authorization") ?? "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!requestId) throw new Error("request_id is required");

    if (isContinue) {
      if (!body.userId) throw new Error("userId is required for continuation calls");
      userId = body.userId;
    } else if (body.userId) {
      userId = body.userId;
    } else {
      if (!accessToken) throw new Error("Missing access token");
      const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
      if (userErr || !userData?.user) throw new Error(`Auth failed: ${userErr?.message ?? "no user"}`);
      userId = userData.user.id;
    }

    let currentStep = 1;
    if (requestId && isContinue) {
      const reqData = await runSupabaseQuery<{ current_step: number } | null>(
        () => supabase
          .from("weekly_menu_requests")
          .select("current_step")
          .eq("id", requestId)
          .single(),
        `weekly_menu_requests.current_step:${requestId}`,
        null,
      );
      currentStep = reqData?.current_step ?? 1;
    }

    const invocationContext: V5InvocationContext = {
      startedAtMs: Date.now(),
      softBudgetMs: DEFAULT_V5_INVOCATION_SOFT_BUDGET_MS,
    };

    scheduleBackgroundTask(`generate-menu-v5:${requestId}`, async () => {
      try {
        await executeStep(
          supabase,
          supabaseUrl,
          supabaseServiceKey,
          userId!,
          requestId!,
          body,
          currentStep,
          invocationContext,
        );
      } catch (error: any) {
        console.error("generate-menu-v5 background error:", error);
        createLogger("generate-menu-v5", requestId ?? undefined).withUser(userId ?? "unknown").error(
          "バックグラウンド処理でエラーが発生しました",
          error,
          { requestId, step: currentStep },
        );
        await runSupabaseQuery(
          () => supabase
            .from("weekly_menu_requests")
            .update({
              status: "failed",
              error_message: error?.message ?? String(error),
              updated_at: new Date().toISOString(),
            })
            .eq("id", requestId!),
          `weekly_menu_requests.fail_background:${requestId}`,
          null,
          10000,
          1,
        ).catch((persistError) => {
          console.error("Failed to persist V5 background failure:", persistError);
          return null;
        });
        throw error;
      }
    });

    return new Response(
      JSON.stringify({
        status: "processing",
        request_id: requestId,
        step: currentStep,
        message: `Step ${currentStep} を実行中...`,
      }),
      {
        status: 202,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error: any) {
    console.error("generate-menu-v5 handler error:", error);
    createLogger("generate-menu-v5", requestId ?? undefined).withUser(userId ?? "unknown").error(
      "ハンドラでエラーが発生しました",
      error,
      { requestId },
    );
    if (requestId) {
      try {
        await runSupabaseQuery(
          () => supabase
            .from("weekly_menu_requests")
            .update({
              status: "failed",
              error_message: error?.message ?? String(error),
              updated_at: new Date().toISOString(),
            })
            .eq("id", requestId),
          `weekly_menu_requests.fail:${requestId}`,
          null,
          10000,
          1,
        );
      } catch (persistError) {
        console.error("Failed to persist V5 failure:", persistError);
      }
    }

    return new Response(
      JSON.stringify({ error: error?.message ?? "Unexpected error" }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
