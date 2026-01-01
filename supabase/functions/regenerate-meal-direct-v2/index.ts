import { createClient } from "jsr:@supabase/supabase-js@2";
import { Agent, type AgentInputItem, Runner } from "@openai/agents";
import { z } from "zod";
import { buildSearchQueryBase, buildUserContextForPrompt, buildUserSummary } from "../_shared/user-context.ts";
import { detectAllergenHits, summarizeAllergenHits } from "../_shared/allergy.ts";

console.log("Regenerate Meal Direct v2 Function loaded (pgvector + dataset driven)");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// =========================================================
// Types / Schemas
// =========================================================

const ALLOWED_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "midnight_snack"] as const;
type MealType = (typeof ALLOWED_MEAL_TYPES)[number];

const RegenerateV2SelectionSchema = z.object({
  mealType: z.enum(ALLOWED_MEAL_TYPES),
  source_menu_set_external_id: z.string().min(1),
  advice: z.string().optional(),
});
type RegenerateV2Selection = z.infer<typeof RegenerateV2SelectionSchema>;

// =========================================================
// Helpers
// =========================================================

function stripMarkdownCodeBlock(text: string): string {
  let cleaned = text.trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) cleaned = cleaned.substring(firstNewline + 1);
    if (cleaned.endsWith("```")) cleaned = cleaned.substring(0, cleaned.length - 3).trim();
  }

  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    const jsonStart = cleaned.search(/[\{\[]/);
    if (jsonStart > 0) cleaned = cleaned.substring(jsonStart);
  }

  const lastBrace = cleaned.lastIndexOf("}");
  const lastBracket = cleaned.lastIndexOf("]");
  const jsonEnd = Math.max(lastBrace, lastBracket);
  if (jsonEnd > 0 && jsonEnd < cleaned.length - 1) cleaned = cleaned.substring(0, jsonEnd + 1);

  return cleaned.trim();
}

function safeJsonParse(text: string): unknown {
  let cleaned = stripMarkdownCodeBlock(text);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("JSON parse failed (first attempt):", e);
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, (char) => (char === "\n" || char === "\r" || char === "\t" ? char : ""));
    return JSON.parse(cleaned);
  }
}

function toNullableNumber(value: unknown): number | null {
  const n = Number(value);
  return n ? n : null;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 5;
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

function normalizeDishNameJs(name: string): string {
  return String(name ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

function parseLinesToArray(text: string | null): string[] {
  if (!text) return [];
  return String(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapMealTypeForDataset(mealType: MealType): "breakfast" | "lunch" | "dinner" | "snack" {
  if (mealType === "midnight_snack") return "snack";
  if (mealType === "breakfast" || mealType === "lunch" || mealType === "dinner" || mealType === "snack") return mealType;
  return "lunch";
}

// =========================================================
// Embeddings / Search
// =========================================================

async function embedText(text: string, dimensions = 384): Promise<number[]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await withRetry(
    async () => {
      const r = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text,
          dimensions,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        const err: any = new Error(`Embeddings API error: ${t}`);
        err.status = r.status;
        throw err;
      }
      return await r.json();
    },
    { label: "embeddings" },
  );

  const embedding = res?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error("Embeddings API returned invalid embedding");
  return embedding;
}

type MenuSetCandidate = {
  external_id: string;
  title: string;
  meal_type_hint: string | null;
  theme_tags: string[] | null;
  dishes: any;
  calories_kcal: number | null;
  sodium_g: number | null;
  similarity: number | null;
};

async function searchMenuCandidates(supabase: any, queryText: string, matchCount: number): Promise<MenuSetCandidate[]> {
  const emb = await embedText(queryText, 384);
  const { data, error } = await supabase.rpc("search_menu_examples", {
    query_embedding: emb,
    match_count: matchCount,
    filter_meal_type_hint: null,
    filter_max_sodium: null,
    filter_theme_tags: null,
  });
  if (error) throw new Error(`search_menu_examples failed: ${error.message}`);
  return (data ?? []) as MenuSetCandidate[];
}

function getDishCount(c: MenuSetCandidate): number {
  return Array.isArray(c.dishes) ? c.dishes.length : 0;
}

function pickCandidatesForMealType(mealType: MealType, all: MenuSetCandidate[], opts: { min?: number; max?: number; preferMultipleDishes?: boolean } = {}): MenuSetCandidate[] {
  const min = opts.min ?? 10;
  const max = opts.max ?? 80;
  // 朝食・間食でも複数品のセットを優先する（デフォルトtrue）
  const preferMultipleDishes = opts.preferMultipleDishes ?? true;
  const mapped = mapMealTypeForDataset(mealType);
  let typed = all.filter((c) => c.meal_type_hint === mapped);

  // 複数品優先モード: 2品以上のセットを先に、1品以下を後に並べ替え
  if (preferMultipleDishes && typed.length > 0) {
    const multiDish = typed.filter((c) => getDishCount(c) >= 2);
    const singleDish = typed.filter((c) => getDishCount(c) < 2);
    typed = [...multiDish, ...singleDish];
  }

  if (typed.length >= min) return typed.slice(0, max);
  const seen = new Set(typed.map((c) => c.external_id));
  let fallback = all.filter((c) => !seen.has(c.external_id));

  // フォールバックでも複数品優先
  if (preferMultipleDishes && fallback.length > 0) {
    const multiDish = fallback.filter((c) => getDishCount(c) >= 2);
    const singleDish = fallback.filter((c) => getDishCount(c) < 2);
    fallback = [...multiDish, ...singleDish];
  }

  return typed.concat(fallback).slice(0, Math.max(min, Math.min(max, typed.length + fallback.length)));
}

function formatCandidateForPrompt(c: MenuSetCandidate) {
  const dishes = Array.isArray(c.dishes) ? c.dishes : [];
  const dishText = dishes
    .slice(0, 6)
    .map((d: any) => `${d?.name ?? ""}(${d?.class_raw ?? d?.role ?? ""})`)
    .filter(Boolean)
    .join(" / ");
  const theme = (c.theme_tags ?? []).join(" ");
  const kcal = c.calories_kcal ?? "";
  const salt = c.sodium_g ?? "";
  return {
    external_id: c.external_id,
    title: c.title,
    theme,
    calories_kcal: kcal,
    sodium_g: salt,
    dishes: dishText,
  };
}

// =========================================================
// Dataset version
// =========================================================

async function getActiveDatasetVersion(supabase: any): Promise<string> {
  const { data: setting, error: sErr } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", "menu_dataset_active_version")
    .maybeSingle();
  if (!sErr) {
    const v = setting?.value;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const { data: run, error: rErr } = await supabase
    .from("dataset_import_runs")
    .select("dataset_version")
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rErr) throw new Error(`Failed to load dataset_import_runs: ${rErr.message}`);
  if (!run?.dataset_version) throw new Error("No completed dataset_import_runs found");
  return run.dataset_version;
}

// =========================================================
// LLM selection
// =========================================================

async function runAgentToSelectReplacement(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  mealType: MealType;
  currentMenuSetExternalId: string | null;
  candidates: MenuSetCandidate[];
}): Promise<RegenerateV2Selection> {
  const systemPrompt =
    `あなたは日本の国家資格「管理栄養士」です。\n` +
    `このタスクは「指定の食事タイプの献立を、候補から1つ選んで差し替える」ことです。\n` +
    `\n` +
    `【最優先（破ったら失格）】\n` +
    `- 出力は **厳密なJSONのみ**（Markdown/説明文/コードブロック禁止）\n` +
    `- source_menu_set_external_id は候補一覧の external_id から選ぶ（候補外ID禁止）\n` +
    `- currentMenuSetExternalId と同じIDは選ばない\n` +
    `- アレルギー（絶対除外）/禁忌/健康上の制約を厳守\n` +
    `\n` +
    `【品質】\n` +
    `- ユーザーの「料理経験」や「調理時間目安」がある場合、**現実的に作れる差し替え**を優先（初心者/時短=工程が少ない・重すぎない）\n` +
    `- ユーザーの「好みの料理ジャンル」がある場合、嗜好を尊重\n` +
    `- 服薬情報がある場合は、一般的な食事上の注意点を尊重（例: ワーファリンはビタミンK摂取が極端に偏らないよう配慮）\n` +
    `- 日本の食卓として自然な差し替えにする（極端に重い/偏るものは避ける）\n` +
    `- 減塩が必要なら sodium_g が低い候補を優先\n` +
    `\n` +
    `出力JSON:\n` +
    `{\n` +
    `  "mealType": "${input.mealType}",\n` +
    `  "source_menu_set_external_id": "...",\n` +
    `  "advice": "..." (optional)\n` +
    `}\n`;

  const agent = new Agent({
    name: "regenerate-meal-selector-v2",
    instructions: systemPrompt,
    model: "gpt-5-mini",
    tools: [],
  });

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【ユーザーコンテキスト(JSON)】\n${JSON.stringify(input.userContext)}\n\n` +
    `${input.note ? `【要望】\n${input.note}\n\n` : ""}` +
    `【食事タイプ】\n${input.mealType}\n\n` +
    `${input.currentMenuSetExternalId ? `【現在のID（これは禁止）】\n${input.currentMenuSetExternalId}\n\n` : ""}` +
    `【候補】\n${JSON.stringify(input.candidates.map(formatCandidateForPrompt))}\n\n`;

  const conversationHistory: AgentInputItem[] = [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }];
  const runner = new Runner({
    traceMetadata: {
      __trace_source__: "regenerate-meal-direct-v2",
      workflow_id: "wf_regenerate_meal_direct_v2",
    },
  });

  const result = await runner.run(agent, conversationHistory);
  const out = result.finalOutput ? String(result.finalOutput) : "";
  if (!out) throw new Error("LLM output is empty");
  const parsed = safeJsonParse(out);
  return RegenerateV2SelectionSchema.parse(parsed);
}

function repairSelection(input: {
  mealType: MealType;
  selection: RegenerateV2Selection;
  candidates: MenuSetCandidate[];
  currentMenuSetExternalId: string | null;
}): RegenerateV2Selection {
  const candidateIds = input.candidates.map((c) => c.external_id);
  const candidateSet = new Set(candidateIds);

  let chosen = input.selection.source_menu_set_external_id ?? "";
  if (!chosen || !candidateSet.has(chosen) || (input.currentMenuSetExternalId && chosen === input.currentMenuSetExternalId)) {
    chosen = candidateIds.find((id) => id && id !== input.currentMenuSetExternalId) ?? candidateIds[0] ?? "";
  }
  if (!chosen) throw new Error(`No candidate available for ${input.mealType}`);
  return { mealType: input.mealType, source_menu_set_external_id: chosen, advice: input.selection.advice };
}

// =========================================================
// Main background task
// =========================================================

async function regenerateMealV2BackgroundTask(args: {
  userId: string;
  mealId: string;
  note?: string | null;
  requestId?: string | null;
  constraints?: unknown;
}): Promise<{ selection: RegenerateV2Selection; datasetVersion: string; plannedMealId: string }> {
  const serviceRoleKey = Deno.env.get("DATASET_SERVICE_ROLE_KEY") ?? "";
  if (!serviceRoleKey) throw new Error("Missing DATASET_SERVICE_ROLE_KEY");
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceRoleKey);

  const { userId, mealId, note, requestId, constraints } = args;

  if (requestId) {
    await supabase
      .from("weekly_menu_requests")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", requestId)
      .eq("user_id", userId);
  }

  try {
    // planned_meal ownership check + context
    const { data: existingMeal, error: mealErr } = await supabase
      .from("planned_meals")
      .select(
        "id, meal_type, source_menu_set_external_id, source_type, source_dataset_version, meal_plan_day_id, meal_plan_days!inner(day_date, meal_plans!inner(user_id))",
      )
      .eq("id", mealId)
      .eq("meal_plan_days.meal_plans.user_id", userId)
      .single();
    if (mealErr) throw new Error(`Meal not found or unauthorized: ${mealErr.message}`);

    const mealType = String((existingMeal as any).meal_type ?? "").trim() as MealType;
    if (!ALLOWED_MEAL_TYPES.includes(mealType as any)) throw new Error(`Unsupported mealType: ${mealType}`);

    const currentMenuSetExternalId = (existingMeal as any).source_menu_set_external_id ? String((existingMeal as any).source_menu_set_external_id) : null;

    // profile
    const { data: profile, error: profileError } = await supabase.from("user_profiles").select("*").eq("id", userId).single();
    if (profileError) throw new Error(`Profile not found: ${profileError.message}`);
    const { data: nutritionTargets } = await supabase.from("nutrition_targets").select("*").eq("user_id", userId).maybeSingle();
    const userContext = buildUserContextForPrompt({ profile, nutritionTargets: nutritionTargets ?? null, note: note ?? null, constraints });
    const userSummary = buildUserSummary(profile, nutritionTargets ?? null, note ?? null, constraints);
    const allergyTokens: string[] = Array.isArray((userContext as any)?.hard?.allergies) ? (userContext as any).hard.allergies : [];
    const userContextForLog = {
      ...(userContext as any),
      weekly: {
        ...(((userContext as any)?.weekly ?? {}) as any),
        note: typeof note === "string" ? note.slice(0, 800) : null,
      },
    };

    function candidateText(c: MenuSetCandidate): string[] {
      const dishes = Array.isArray(c?.dishes) ? c.dishes : [];
      const dishNames = dishes.map((d: any) => String(d?.name ?? "").trim()).filter(Boolean);
      return [String(c?.title ?? "").trim(), ...dishNames].filter(Boolean);
    }

    function candidateSeemsAllergySafe(c: MenuSetCandidate): boolean {
      if (allergyTokens.length === 0) return true;
      const hits = detectAllergenHits(allergyTokens, candidateText(c));
      return hits.length === 0;
    }

    const datasetVersion = await getActiveDatasetVersion(supabase);

    // candidates
    const ja = mealType === "breakfast" ? "朝食" : mealType === "lunch" ? "昼食" : mealType === "dinner" ? "夕食" : mealType === "snack" ? "間食" : "夜食";
    const baseQuery = buildSearchQueryBase({ profile, nutritionTargets: nutritionTargets ?? null, note: note ?? null, constraints });
    const raw = await searchMenuCandidates(supabase, `${ja}\n${baseQuery}`, mealType === "dinner" ? 1200 : mealType === "lunch" ? 800 : 600);
    let candidates = pickCandidatesForMealType(mealType, raw, { min: 10, max: 80 });

    // exclude current id
    if (currentMenuSetExternalId) candidates = candidates.filter((c) => c.external_id !== currentMenuSetExternalId);
    if (candidates.length < 5) {
      // fall back: keep some raw even if typed was too small
      const fallback = raw.filter((c) => c.external_id !== currentMenuSetExternalId);
      candidates = fallback.slice(0, 50);
    }

    if (allergyTokens.length > 0) {
      const filtered = candidates.filter(candidateSeemsAllergySafe);
      if (filtered.length >= 5) candidates = filtered;
    }

    const rawSel = await runAgentToSelectReplacement({
      userSummary,
      userContext,
      note: note ?? null,
      mealType,
      currentMenuSetExternalId,
      candidates,
    });
    const selection = repairSelection({ mealType, selection: rawSel, candidates, currentMenuSetExternalId });

    async function buildMealForExternalId(externalId: string): Promise<{
      ms: any;
      dishDetails: any[];
      aggregatedIngredients: string[];
      dishName: string;
      allergyHits: ReturnType<typeof detectAllergenHits>;
    }> {
      const id = String(externalId ?? "").trim();
      if (!id) throw new Error("externalId is required");

      const { data: ms, error: msErr } = await supabase.from("dataset_menu_sets").select("*").eq("external_id", id).maybeSingle();
      if (msErr || !ms?.external_id) throw new Error(`Selected menu set not found: ${id}`);

      const dishes = Array.isArray((ms as any).dishes) ? (ms as any).dishes : [];
      const uniqNorms = Array.from(new Set(dishes.map((d: any) => normalizeDishNameJs(String(d?.name ?? ""))).filter(Boolean)));

      const recipeByNorm = new Map<string, any>();
      if (uniqNorms.length > 0) {
        const { data: exactRecipes, error: recipeErr } = await supabase
          .from("dataset_recipes")
          .select(
            "id, external_id, name, name_norm, source_url, ingredients_text, instructions_text, calories_kcal, sodium_g, protein_g, fat_g, carbs_g, sugar_g, fiber_g",
          )
          .in("name_norm", uniqNorms);
        if (recipeErr) throw new Error(`Failed to fetch dataset_recipes: ${recipeErr.message}`);
        for (const r of exactRecipes ?? []) {
          if (r?.name_norm) recipeByNorm.set(String(r.name_norm), r);
        }
      }

      async function resolveRecipeForDishName(dishName: string): Promise<any | null> {
        const norm = normalizeDishNameJs(dishName);
        if (!norm) return null;
        const exact = recipeByNorm.get(norm);
        if (exact) return exact;
        const { data: sims, error: simErr } = await supabase.rpc("search_similar_dataset_recipes", {
          query_name: dishName,
          similarity_threshold: 0.3,
          result_limit: 1,
        });
        if (simErr) return null;
        const best = Array.isArray(sims) ? sims[0] : null;
        if (!best?.id) return null;
        const { data: r2, error: r2Err } = await supabase
          .from("dataset_recipes")
          .select(
            "id, external_id, name, name_norm, source_url, ingredients_text, instructions_text, calories_kcal, sodium_g, protein_g, fat_g, carbs_g, sugar_g, fiber_g",
          )
          .eq("id", best.id)
          .maybeSingle();
        if (r2Err) return null;
        if (r2?.name_norm) recipeByNorm.set(String(r2.name_norm), r2);
        return r2 ?? null;
      }

      const allergyTexts: string[] = [];
      allergyTexts.push(String((ms as any).title ?? ""));

      const dishDetails: any[] = [];
      const aggregatedIngredients: string[] = [];
      for (const d of dishes) {
        const dishName = String(d?.name ?? "").trim();
        if (!dishName) continue;
        allergyTexts.push(dishName);

        const recipe = await resolveRecipeForDishName(dishName);
        allergyTexts.push(String(recipe?.name ?? ""));
        allergyTexts.push(String(recipe?.ingredients_text ?? ""));

        const ingredients = parseLinesToArray(recipe?.ingredients_text ?? null);
        const recipeSteps = parseLinesToArray(recipe?.instructions_text ?? null);
        aggregatedIngredients.push(...ingredients);

        dishDetails.push({
          name: dishName,
          role: String(d?.role ?? "other"),
          cal: Number(d?.calories_kcal ?? recipe?.calories_kcal ?? 0) || 0,
          protein: Number(recipe?.protein_g ?? 0) || 0,
          fat: Number(recipe?.fat_g ?? 0) || 0,
          carbs: Number(recipe?.carbs_g ?? 0) || 0,
          sodium: Number(d?.sodium_g ?? recipe?.sodium_g ?? 0) || 0,
          sugar: Number(recipe?.sugar_g ?? 0) || 0,
          fiber: Number(recipe?.fiber_g ?? 0) || 0,
          fiberSoluble: 0,
          fiberInsoluble: 0,
          potassium: 0,
          calcium: 0,
          phosphorus: 0,
          iron: 0,
          zinc: 0,
          iodine: 0,
          cholesterol: 0,
          vitaminB1: 0,
          vitaminB2: 0,
          vitaminC: 0,
          vitaminB6: 0,
          vitaminB12: 0,
          folicAcid: 0,
          vitaminA: 0,
          vitaminD: 0,
          vitaminK: 0,
          vitaminE: 0,
          saturatedFat: 0,
          monounsaturatedFat: 0,
          polyunsaturatedFat: 0,
          ingredient: ingredients.slice(0, 3).join("、"),
          ingredients,
          recipeSteps,
          base_recipe_id: recipe?.id ?? null,
          is_generated_name: false,
        });
      }

      const mainDish = dishDetails.find((x) => x.role === "main") ?? dishDetails[0];
      const allDishNames = dishDetails.map((d: any) => String(d?.name ?? "").trim()).filter(Boolean).join("、");
      const dishName = allDishNames || mainDish?.name || (ms as any).title || "献立";

      const allergyHits = allergyTokens.length > 0 ? detectAllergenHits(allergyTokens, allergyTexts) : [];

      return { ms, dishDetails, aggregatedIngredients, dishName, allergyHits };
    }

    const tryExternalIds = Array.from(
      new Set([selection.source_menu_set_external_id, ...candidates.map((c) => c.external_id)].filter(Boolean)),
    ).slice(0, 60);

    const llmChosenExternalId = String(selection.source_menu_set_external_id ?? "").trim();
    let builtMeal: Awaited<ReturnType<typeof buildMealForExternalId>> | null = null;
    let lastHits: ReturnType<typeof detectAllergenHits> = [];
    let allergyViolationSummary: string | null = null;
    for (const externalId of tryExternalIds) {
      const id = String(externalId ?? "").trim();
      if (!id) continue;
      if (currentMenuSetExternalId && id === currentMenuSetExternalId) continue;

      const candObj = candidates.find((c) => c.external_id === id) ?? null;
      if (candObj && !candidateSeemsAllergySafe(candObj)) continue;

      const bm = await buildMealForExternalId(id);
      lastHits = bm.allergyHits;
      if (bm.allergyHits.length > 0 && !allergyViolationSummary) {
        allergyViolationSummary = summarizeAllergenHits(bm.allergyHits);
      }
      if (allergyTokens.length === 0 || bm.allergyHits.length === 0) {
        builtMeal = bm;
        if (id !== selection.source_menu_set_external_id) selection.source_menu_set_external_id = id;
        break;
      }
    }
    if (!builtMeal) {
      throw new Error(`Allergy constraint violated for ${mealType}: ${summarizeAllergenHits(lastHits)}`);
    }

    const ms = builtMeal.ms;
    const dishDetails = builtMeal.dishDetails;
    const aggregatedIngredients = builtMeal.aggregatedIngredients;
    const dishName = builtMeal.dishName;
    const finalExternalId = String((ms as any).external_id ?? selection.source_menu_set_external_id ?? "").trim();

    const mealData: Record<string, any> = {
      dish_name: dishName,
      description: null,
      dishes: dishDetails,
      ingredients: aggregatedIngredients.length > 0 ? aggregatedIngredients : null,
      recipe_steps: null,
      is_simple: dishDetails.length <= 1,
      is_generating: false,
      updated_at: new Date().toISOString(),

      // v2 traceability
      source_type: "dataset",
      source_dataset_version: datasetVersion,
      source_menu_set_external_id: (ms as any).external_id,
      generation_metadata: {
        ...(typeof (existingMeal as any).generation_metadata === "object" ? (existingMeal as any).generation_metadata : {}),
        generator: "regenerate-meal-direct-v2",
        llm_model: "gpt-5-mini",
        embeddings_model: "text-embedding-3-small",
        search_query_base: String(baseQuery).slice(0, 1200),
        user_context: userContextForLog,
        constraints: (userContextForLog as any)?.weekly?.constraints ?? null,
        allergy_validation: {
          checked: allergyTokens.length > 0,
          allergy_tokens: allergyTokens.slice(0, 30),
          llm_chosen_external_id: llmChosenExternalId,
          final_external_id: finalExternalId,
          replaced: Boolean(llmChosenExternalId && finalExternalId && llmChosenExternalId !== finalExternalId),
          violation: allergyViolationSummary,
        },
        previous_menu_set_external_id: currentMenuSetExternalId,
        advice: selection.advice ?? null,
        note: note ?? null,
      },

      // 栄養（セット全体＝確定値）
      calories_kcal: toNullableNumber((ms as any).calories_kcal),
      protein_g: toNullableNumber((ms as any).protein_g),
      fat_g: toNullableNumber((ms as any).fat_g),
      carbs_g: toNullableNumber((ms as any).carbs_g),
      sodium_g: toNullableNumber((ms as any).sodium_g),
      sugar_g: toNullableNumber((ms as any).sugar_g),
      fiber_g: toNullableNumber((ms as any).fiber_g),
      fiber_soluble_g: toNullableNumber((ms as any).fiber_soluble_g),
      fiber_insoluble_g: toNullableNumber((ms as any).fiber_insoluble_g),
      potassium_mg: toNullableNumber((ms as any).potassium_mg),
      calcium_mg: toNullableNumber((ms as any).calcium_mg),
      magnesium_mg: toNullableNumber((ms as any).magnesium_mg),
      phosphorus_mg: toNullableNumber((ms as any).phosphorus_mg),
      iron_mg: toNullableNumber((ms as any).iron_mg),
      zinc_mg: toNullableNumber((ms as any).zinc_mg),
      iodine_ug: toNullableNumber((ms as any).iodine_ug),
      cholesterol_mg: toNullableNumber((ms as any).cholesterol_mg),
      vitamin_b1_mg: toNullableNumber((ms as any).vitamin_b1_mg),
      vitamin_b2_mg: toNullableNumber((ms as any).vitamin_b2_mg),
      vitamin_c_mg: toNullableNumber((ms as any).vitamin_c_mg),
      vitamin_b6_mg: toNullableNumber((ms as any).vitamin_b6_mg),
      vitamin_b12_ug: toNullableNumber((ms as any).vitamin_b12_ug),
      folic_acid_ug: toNullableNumber((ms as any).folic_acid_ug),
      vitamin_a_ug: toNullableNumber((ms as any).vitamin_a_ug),
      vitamin_d_ug: toNullableNumber((ms as any).vitamin_d_ug),
      vitamin_k_ug: toNullableNumber((ms as any).vitamin_k_ug),
      vitamin_e_mg: toNullableNumber((ms as any).vitamin_e_mg),
      saturated_fat_g: toNullableNumber((ms as any).saturated_fat_g),
      monounsaturated_fat_g: toNullableNumber((ms as any).monounsaturated_fat_g),
      polyunsaturated_fat_g: toNullableNumber((ms as any).polyunsaturated_fat_g),
    };

    const { error: updErr } = await supabase.from("planned_meals").update(mealData).eq("id", mealId);
    if (updErr) throw new Error(`Failed to update planned_meal: ${updErr.message}`);

    if (requestId) {
      const resultJson = {
        ...selection,
        _meta: {
          generator: "regenerate-meal-direct-v2",
          dataset_version: datasetVersion,
          search_query_base: String(baseQuery).slice(0, 1200),
          user_context: userContextForLog,
          constraints: (userContextForLog as any)?.weekly?.constraints ?? null,
          allergy_tokens: allergyTokens.slice(0, 30),
          llm_chosen_external_id: llmChosenExternalId,
          final_external_id: finalExternalId,
          replaced: Boolean(llmChosenExternalId && finalExternalId && llmChosenExternalId !== finalExternalId),
          violation: allergyViolationSummary,
          previous_menu_set_external_id: currentMenuSetExternalId,
        },
      };
      await supabase
        .from("weekly_menu_requests")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
          result_json: resultJson,
        })
        .eq("id", requestId)
        .eq("user_id", userId);
    }

    return { selection, datasetVersion, plannedMealId: mealId };
  } catch (error: any) {
    console.error("❌ regenerateMealV2BackgroundTask failed:", error?.message ?? error);

    // 失敗時: mealIdが指定されている場合はそのレコードのis_generatingをクリア
    if (mealId) {
      const { error: updateErr } = await supabase
        .from("planned_meals")
        .update({
          is_generating: false,
          // 既存の料理名は維持（dish_nameは上書きしない）
          updated_at: new Date().toISOString(),
        })
        .eq("id", mealId);

      if (updateErr) {
        console.error("Failed to clear is_generating flag for mealId:", updateErr);
      } else {
        console.log("✅ Cleared is_generating flag for mealId:", mealId);
      }
    }

    if (requestId) {
      await supabase
        .from("weekly_menu_requests")
        .update({
          status: "failed",
          error_message: error?.message ?? String(error),
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId)
        .eq("user_id", userId);
    }
    throw error;
  }
}

// =========================================================
// HTTP handler
// =========================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authorization header required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] ?? authHeader;
    const serviceRoleKey = Deno.env.get("DATASET_SERVICE_ROLE_KEY") ?? "";

    const body = await req.json().catch(() => ({}));
    const mealId = String(body?.mealId ?? "").trim();
    const note = typeof body?.note === "string" ? body.note : (typeof body?.prompt === "string" ? body.prompt : null);
    const constraints = body?.constraints ?? body?.preferences ?? null;
    const requestId = body?.requestId ?? null;
    const bodyUserId = body?.userId ?? null;

    let userId: string;
    if (serviceRoleKey && token === serviceRoleKey) {
      if (!bodyUserId) {
        return new Response(JSON.stringify({ error: "userId is required for service role calls" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }
      userId = String(bodyUserId);
    } else {
      const supabaseAuth = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 401,
        });
      }
      if (bodyUserId && String(bodyUserId) !== user.id) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 403,
        });
      }
      userId = user.id;
    }

    if (!mealId) {
      return new Response(JSON.stringify({ error: "mealId is required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const { selection, datasetVersion, plannedMealId } = await regenerateMealV2BackgroundTask({
      userId,
      mealId,
      note,
      requestId,
      constraints,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Meal regeneration v2 completed",
        datasetVersion,
        plannedMealId,
        selection,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("❌ regenerate-meal-direct-v2 failed:", error?.message ?? error);
    return new Response(JSON.stringify({ success: false, error: error?.message ?? String(error) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
