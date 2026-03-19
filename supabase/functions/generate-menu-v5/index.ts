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
  computeMaxFixesForRange,
  countGeneratedTargetSlots,
  getSlotKey,
  normalizeTargetSlots,
  sortTargetSlots,
  uniqDatesFromSlots,
  type PostNutritionIssue,
  type TargetSlot,
} from "../generate-menu-v4/step-utils.ts";
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

async function handoffToV4(
  supabaseUrl: string,
  supabaseServiceKey: string,
  requestId: string,
  userId: string,
) {
  const url = `${supabaseUrl}/functions/v1/generate-menu-v4`;
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
    label: `handoffToV4:${requestId}`,
    retries: 2,
    timeoutMs: 10000,
  });
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

function selectTemplatesForTargetSlots(templates: MenuTemplate[], targetSlots: TargetSlot[]): MenuTemplate[] {
  const requestedTypes = new Set(targetSlots.map((slot) => slot.mealType));
  const selected: MenuTemplate[] = [];
  const usedIds = new Set<string>();

  const addTemplates = (candidates: MenuTemplate[], limit: number) => {
    for (const candidate of candidates) {
      if (selected.length >= 48 || limit <= 0) break;
      if (usedIds.has(candidate.id)) continue;
      usedIds.add(candidate.id);
      selected.push(candidate);
      limit--;
    }
  };

  if (requestedTypes.has("breakfast")) {
    addTemplates(
      templates.filter((template) => template.breakfastTemplate !== "other_breakfast" || template.mealType === "breakfast"),
      12,
    );
  }
  if (requestedTypes.has("lunch")) {
    addTemplates(templates.filter((template) => template.mealType === "lunch"), 12);
  }
  if (requestedTypes.has("dinner")) {
    addTemplates(templates.filter((template) => template.mealType === "dinner"), 12);
  }
  if (requestedTypes.has("snack")) {
    addTemplates(templates.filter((template) => template.mealType === "snack"), 6);
  }
  if (requestedTypes.has("midnight_snack")) {
    addTemplates(templates.filter((template) => template.mealType === "midnight_snack"), 4);
  }

  addTemplates(templates, Math.max(0, 36 - selected.length));
  return selected;
}

async function searchMenuCandidates(
  supabase: any,
  queryText: string,
  matchCount: number,
  targetSlots: TargetSlot[],
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

    const emb = await embedText(queryText, DATASET_EMBEDDING_DIMENSIONS);
    const expandedMatchCount = Math.min(Math.max(matchCount * 4, 20), 60);
    const requestedMealTypes = [...new Set(
      targetSlots
        .map((slot) => slot.mealType)
        .filter((mealType): mealType is MealType => mealType === "breakfast" || mealType === "lunch" || mealType === "dinner"),
    )];
    const focusedMatchCount = Math.min(20, Math.max(8, Math.ceil(matchCount / Math.max(requestedMealTypes.length, 1))));

    const searchVariants = [
      { label: "all", mealTypeHint: null as string | null, matchCount: expandedMatchCount },
      ...requestedMealTypes.map((mealType) => ({
        label: `meal:${mealType}`,
        mealTypeHint: mealType,
        matchCount: focusedMatchCount,
      })),
    ];

    const resultSets = await Promise.all(searchVariants.map(async (variant) => {
      return await withRetry(async () => {
        const rpcResult: any = await withTimeout(supabase.rpc("search_menu_examples", {
          query_embedding: emb,
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
    const reranked = rerankMenuReferenceCandidates(
      queryText,
      mergedRows as unknown as any[],
      Math.min(Math.max(matchCount + requestedMealTypes.length * 8, 24), 60),
    ) as unknown as DatasetMenuSetRaw[];
    const templates = selectTemplatesForTargetSlots(
      dedupeTemplatesByContent(buildTemplateCatalog(reranked)),
      targetSlots,
    );
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
    if (currentStep >= 3) {
      await handoffToV4(supabaseUrl, supabaseServiceKey, requestId, userId);
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

    await handoffToV4(supabaseUrl, supabaseServiceKey, requestId, userId);
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
        throw new Error(`V5 hard violation did not converge: ${violation.code} ${violation.slotKey}`);
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

  await handoffToV4(supabaseUrl, supabaseServiceKey, requestId, userId);
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
