import { createClient } from "jsr:@supabase/supabase-js@2";
import { Agent, type AgentInputItem, Runner } from "@openai/agents";
import { z } from "zod";

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

function pickCandidatesForMealType(mealType: MealType, all: MenuSetCandidate[], opts: { min?: number; max?: number } = {}): MenuSetCandidate[] {
  const min = opts.min ?? 10;
  const max = opts.max ?? 80;
  const mapped = mapMealTypeForDataset(mealType);
  const typed = all.filter((c) => c.meal_type_hint === mapped);
  if (typed.length >= min) return typed.slice(0, max);
  const seen = new Set(typed.map((c) => c.external_id));
  const fallback = all.filter((c) => !seen.has(c.external_id));
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

const CUISINE_LABELS: Record<string, string> = {
  japanese: "和食",
  western: "洋食",
  chinese: "中華",
  italian: "イタリアン",
  ethnic: "エスニック",
  korean: "韓国料理",
};

function formatCuisinePreferences(value: any): string {
  if (!value || typeof value !== "object") return "未設定";
  const entries = Object.entries(value as Record<string, any>)
    .map(([k, v]) => [String(k), Number(v)] as const)
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => CUISINE_LABELS[k] ?? k);
  return entries.slice(0, 6).join("、") || "未設定";
}

function buildProfileSummary(profile: any, nutritionTargets?: any | null): string {
  const allergies = profile?.diet_flags?.allergies?.join(", ") || "なし";
  const dislikes = profile?.diet_flags?.dislikes?.join(", ") || "なし";
  const healthConditions = profile?.health_conditions?.join(", ") || "なし";
  const medications = Array.isArray(profile?.medications) ? profile.medications.join(", ") : (profile?.medications ? String(profile.medications) : null);
  const nutritionGoal = profile?.nutrition_goal ?? null;
  const weightChangeRate = profile?.weight_change_rate ?? null;
  const workStyle = profile?.work_style ?? null;
  const exerciseTypes = Array.isArray(profile?.exercise_types) ? profile.exercise_types.join(", ") : null;
  const exerciseFrequency = profile?.exercise_frequency ?? null;
  const exerciseIntensity = profile?.exercise_intensity ?? null;
  const exerciseDuration = profile?.exercise_duration_per_session ?? null;
  const familySize = profile?.family_size ?? null;
  const cookingExperience = profile?.cooking_experience ?? null;
  const weekdayCookingMinutes = profile?.weekday_cooking_minutes ?? null;
  const weekendCookingMinutes = profile?.weekend_cooking_minutes ?? null;
  const cuisinePrefs = formatCuisinePreferences(profile?.cuisine_preferences);
  const lines = [
    `- ニックネーム: ${profile?.nickname ?? "未設定"}`,
    `- 年齢: ${profile?.age ?? "不明"}歳`,
    `- 性別: ${profile?.gender ?? "不明"}`,
    `- 身長: ${profile?.height ?? "不明"}cm / 体重: ${profile?.weight ?? "不明"}kg`,
    `- 持病・注意点: ${healthConditions}`,
    `- 服薬: ${medications ?? "なし"}`,
    `- アレルギー（絶対除外）: ${allergies}`,
    `- 苦手なもの（避ける）: ${dislikes}`,
    `- 食事スタイル: ${profile?.diet_style ?? "未設定"}`,
    `- 好みの料理ジャンル: ${cuisinePrefs}`,
  ];

  if (nutritionGoal) lines.push(`- 栄養目標: ${nutritionGoal}${weightChangeRate ? `（ペース: ${weightChangeRate}）` : ""}`);
  if (workStyle || exerciseTypes || exerciseFrequency || exerciseIntensity || exerciseDuration != null) {
    const parts: string[] = [];
    if (workStyle) parts.push(`仕事スタイル: ${workStyle}`);
    if (exerciseTypes) parts.push(`運動種別: ${exerciseTypes}`);
    if (exerciseFrequency != null) parts.push(`運動頻度: 週${exerciseFrequency}回`);
    if (exerciseIntensity) parts.push(`運動強度: ${exerciseIntensity}`);
    if (exerciseDuration != null) parts.push(`運動時間: ${exerciseDuration}分/回`);
    if (parts.length) lines.push(`- 活動量: ${parts.join(" / ")}`);
  }

  if (familySize != null) lines.push(`- 家族人数: ${familySize}人分`);
  if (cookingExperience) lines.push(`- 料理経験: ${cookingExperience}`);
  if (weekdayCookingMinutes != null || weekendCookingMinutes != null) {
    lines.push(`- 調理時間目安: 平日${weekdayCookingMinutes ?? "未設定"}分 / 休日${weekendCookingMinutes ?? "未設定"}分`);
  }

  if (nutritionTargets) {
    const t = nutritionTargets;
    const goalLines: string[] = [];
    if (t.daily_calories != null) goalLines.push(`- 目標（1日）カロリー: ${t.daily_calories}kcal`);
    if (t.protein_g != null) goalLines.push(`- 目標（1日）タンパク質: ${t.protein_g}g`);
    if (t.sodium_g != null) goalLines.push(`- 目標（1日）塩分（食塩相当量）: ${t.sodium_g}g`);
    if (goalLines.length > 0) lines.push(`- 栄養目標（目安）:\n  ${goalLines.join("\n  ")}`);
  }
  return lines.join("\n");
}

async function regenerateMealV2BackgroundTask(args: {
  userId: string;
  mealId: string;
  note?: string | null;
  requestId?: string | null;
}): Promise<{ selection: RegenerateV2Selection; datasetVersion: string; plannedMealId: string }> {
  const serviceRoleKey = Deno.env.get("DATASET_SERVICE_ROLE_KEY") ?? "";
  if (!serviceRoleKey) throw new Error("Missing DATASET_SERVICE_ROLE_KEY");
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceRoleKey);

  const { userId, mealId, note, requestId } = args;

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
    const userSummary = buildProfileSummary(profile, nutritionTargets ?? null);

    const datasetVersion = await getActiveDatasetVersion(supabase);

    // candidates
    const ja = mealType === "breakfast" ? "朝食" : mealType === "lunch" ? "昼食" : mealType === "dinner" ? "夕食" : mealType === "snack" ? "間食" : "夜食";
    const baseQuery = `${userSummary}\n目的: 健康的で現実的な献立。\n${note ? `要望: ${note}\n` : ""}`;
    const raw = await searchMenuCandidates(supabase, `${ja}\n${baseQuery}`, mealType === "dinner" ? 1200 : mealType === "lunch" ? 800 : 600);
    let candidates = pickCandidatesForMealType(mealType, raw, { min: 10, max: 80 });

    // exclude current id
    if (currentMenuSetExternalId) candidates = candidates.filter((c) => c.external_id !== currentMenuSetExternalId);
    if (candidates.length < 5) {
      // fall back: keep some raw even if typed was too small
      const fallback = raw.filter((c) => c.external_id !== currentMenuSetExternalId);
      candidates = fallback.slice(0, 50);
    }

    const rawSel = await runAgentToSelectReplacement({
      userSummary,
      note: note ?? null,
      mealType,
      currentMenuSetExternalId,
      candidates,
    });
    const selection = repairSelection({ mealType, selection: rawSel, candidates, currentMenuSetExternalId });

    // load chosen menu_set
    const { data: ms, error: msErr } = await supabase.from("dataset_menu_sets").select("*").eq("external_id", selection.source_menu_set_external_id).maybeSingle();
    if (msErr || !ms?.external_id) throw new Error(`Selected menu set not found: ${selection.source_menu_set_external_id}`);

    // recipe resolver (exact norm -> trgm)
    const dishes = Array.isArray((ms as any).dishes) ? (ms as any).dishes : [];
    const uniqNorms = Array.from(new Set(dishes.map((d: any) => normalizeDishNameJs(String(d?.name ?? ""))).filter(Boolean)));

    const { data: exactRecipes, error: recipeErr } = await supabase
      .from("dataset_recipes")
      .select("id, external_id, name, name_norm, source_url, ingredients_text, instructions_text, calories_kcal, sodium_g, protein_g, fat_g, carbs_g, sugar_g, fiber_g")
      .in("name_norm", uniqNorms);
    if (recipeErr) throw new Error(`Failed to fetch dataset_recipes: ${recipeErr.message}`);
    const recipeByNorm = new Map<string, any>((exactRecipes ?? []).map((r: any) => [String(r.name_norm), r]));

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
        .select("id, external_id, name, name_norm, source_url, ingredients_text, instructions_text, calories_kcal, sodium_g, protein_g, fat_g, carbs_g, sugar_g, fiber_g")
        .eq("id", best.id)
        .maybeSingle();
      if (r2Err) return null;
      if (r2?.name_norm) recipeByNorm.set(String(r2.name_norm), r2);
      return r2 ?? null;
    }

    const dishDetails: any[] = [];
    const aggregatedIngredients: string[] = [];
    for (const d of dishes) {
      const dishName = String(d?.name ?? "").trim();
      if (!dishName) continue;
      const recipe = await resolveRecipeForDishName(dishName);
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
        ingredient: ingredients.slice(0, 3).join("、"),
        ingredients,
        recipeSteps,
        base_recipe_id: recipe?.id ?? null,
        is_generated_name: false,
      });
    }

    const mainDish = dishDetails.find((x) => x.role === "main") ?? dishDetails[0];
    const dishName = mainDish?.name ?? (ms as any).title ?? "献立";

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
        previous_menu_set_external_id: currentMenuSetExternalId,
        advice: selection.advice ?? null,
        note: note ?? null,
      },

      // 栄養（セット全体＝確定値）
      calories_kcal: (ms as any).calories_kcal ?? null,
      protein_g: (ms as any).protein_g ?? null,
      fat_g: (ms as any).fat_g ?? null,
      carbs_g: (ms as any).carbs_g ?? null,
      sodium_g: (ms as any).sodium_g ?? null,
      sugar_g: (ms as any).sugar_g ?? null,
      fiber_g: (ms as any).fiber_g ?? null,
      fiber_soluble_g: (ms as any).fiber_soluble_g ?? null,
      fiber_insoluble_g: (ms as any).fiber_insoluble_g ?? null,
      potassium_mg: (ms as any).potassium_mg ?? null,
      calcium_mg: (ms as any).calcium_mg ?? null,
      magnesium_mg: (ms as any).magnesium_mg ?? null,
      phosphorus_mg: (ms as any).phosphorus_mg ?? null,
      iron_mg: (ms as any).iron_mg ?? null,
      zinc_mg: (ms as any).zinc_mg ?? null,
      iodine_ug: (ms as any).iodine_ug ?? null,
      cholesterol_mg: (ms as any).cholesterol_mg ?? null,
      vitamin_b1_mg: (ms as any).vitamin_b1_mg ?? null,
      vitamin_b2_mg: (ms as any).vitamin_b2_mg ?? null,
      vitamin_c_mg: (ms as any).vitamin_c_mg ?? null,
      vitamin_b6_mg: (ms as any).vitamin_b6_mg ?? null,
      vitamin_b12_ug: (ms as any).vitamin_b12_ug ?? null,
      folic_acid_ug: (ms as any).folic_acid_ug ?? null,
      vitamin_a_ug: (ms as any).vitamin_a_ug ?? null,
      vitamin_d_ug: (ms as any).vitamin_d_ug ?? null,
      vitamin_k_ug: (ms as any).vitamin_k_ug ?? null,
      vitamin_e_mg: (ms as any).vitamin_e_mg ?? null,
      saturated_fat_g: (ms as any).saturated_fat_g ?? null,
      monounsaturated_fat_g: (ms as any).monounsaturated_fat_g ?? null,
      polyunsaturated_fat_g: (ms as any).polyunsaturated_fat_g ?? null,
    };

    const { error: updErr } = await supabase.from("planned_meals").update(mealData).eq("id", mealId);
    if (updErr) throw new Error(`Failed to update planned_meal: ${updErr.message}`);

    if (requestId) {
      await supabase
        .from("weekly_menu_requests")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
          result_json: selection,
        })
        .eq("id", requestId)
        .eq("user_id", userId);
    }

    return { selection, datasetVersion, plannedMealId: mealId };
  } catch (error: any) {
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


