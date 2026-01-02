import { createClient } from "jsr:@supabase/supabase-js@2";
import { Agent, type AgentInputItem, Runner } from "@openai/agents";
import { z } from "zod";
import { buildSearchQueryBase, buildUserContextForPrompt, buildUserSummary } from "../_shared/user-context.ts";
import { detectAllergenHits, summarizeAllergenHits } from "../_shared/allergy.ts";
import { calculateNutritionFromIngredients, emptyNutrition, type NutritionTotals } from "../_shared/nutrition-calculator.ts";

console.log("Generate Single Meal v2 Function loaded (pgvector + dataset driven)");

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

// =========================================================
// Types / Schemas
// =========================================================

const ALLOWED_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "midnight_snack"] as const;
type MealType = (typeof ALLOWED_MEAL_TYPES)[number];

const DailyMenuV2SelectionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  meals: z
    .array(
      z.object({
        mealType: z.enum(ALLOWED_MEAL_TYPES),
        source_menu_set_external_id: z.string().min(1),
      }),
    )
    .min(1)
    .max(5),
  advice: z.string().optional(),
});

type DailyMenuV2Selection = z.infer<typeof DailyMenuV2SelectionSchema>;

// =========================================================
// Helpers (JSON / Retry / Normalization)
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

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function getWeekStart(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day; // Monday start
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split("T")[0];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
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

function pickCandidatesForMealType(
  mealType: MealType,
  all: MenuSetCandidate[],
  opts: { min?: number; max?: number; preferMultipleDishes?: boolean; minDishCount?: number } = {},
): MenuSetCandidate[] {
  const min = opts.min ?? 10;
  const max = opts.max ?? 80;
  // 複数品のセットを優先する（デフォルトtrue）
  const preferMultipleDishes = opts.preferMultipleDishes ?? true;
  // 昼食・夕食は3品以上を優先（1汁3菜の実現のため）
  const minDishCount = opts.minDishCount ?? (mealType === "lunch" || mealType === "dinner" ? 3 : 2);

  const mapped = mapMealTypeForDataset(mealType);
  let typed = all.filter((c) => c.meal_type_hint === mapped);

  // 複数品優先モード: minDishCount品以上のセットを先に並べ替え
  if (preferMultipleDishes && typed.length > 0) {
    const richDish = typed.filter((c) => getDishCount(c) >= minDishCount);
    const mediumDish = typed.filter((c) => getDishCount(c) >= 2 && getDishCount(c) < minDishCount);
    const singleDish = typed.filter((c) => getDishCount(c) < 2);
    typed = [...richDish, ...mediumDish, ...singleDish];
  }

  if (typed.length >= min) return typed.slice(0, max);

  const seen = new Set(typed.map((c) => c.external_id));
  let fallback = all.filter((c) => !seen.has(c.external_id));

  // フォールバックでも複数品優先
  if (preferMultipleDishes && fallback.length > 0) {
    const richDish = fallback.filter((c) => getDishCount(c) >= minDishCount);
    const mediumDish = fallback.filter((c) => getDishCount(c) >= 2 && getDishCount(c) < minDishCount);
    const singleDish = fallback.filter((c) => getDishCount(c) < 2);
    fallback = [...richDish, ...mediumDish, ...singleDish];
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
// LLM: select menu set IDs from candidate pools
// =========================================================

async function runAgentToSelectDailyMenuIds(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  date: string;
  requestedMealTypes: MealType[];
  candidatesByMealType: Record<MealType, MenuSetCandidate[]>;
}): Promise<DailyMenuV2Selection> {
  const systemPrompt =
    `あなたは日本の国家資格「管理栄養士」として行動する、献立作成の専門家です。\n` +
    `このタスクは「指定された食事タイプの献立セットIDを候補から選ぶ」ことです。料理の新規作成や、候補にないIDの捏造はしません。\n` +
    `\n` +
    `【最優先（破ったら失格）】\n` +
    `- 出力は **厳密なJSONのみ**（Markdown/説明文/コードブロック禁止）\n` +
    `- meals は、requestedMealTypes と **同じ集合**（過不足なし）\n` +
    `- source_menu_set_external_id は、**該当mealTypeの候補一覧に含まれる external_id からのみ選ぶ**（候補外ID禁止）\n` +
    `- アレルギー（絶対除外）/禁忌/宗教・食事スタイルを厳守。該当しそうな候補は選ばない\n` +
    `\n` +
    `【品質】\n` +
    `- **昼食・夕食は「1汁3菜」（主菜+副菜+汁物+ご飯/主食）を基本とし、3品以上含む献立セットを優先して選ぶ**\n` +
    `- 候補の dishes 配列の品数（length）を確認し、昼食・夕食は3品以上の候補を優先的に選択する\n` +
    `- 朝食は2品以上（主食+汁物orおかず）を基本とする\n` +
    `- ユーザーの「料理経験」や「調理時間目安」がある場合、**現実的に作れる献立**を優先（初心者/時短=工程が少ない・重すぎない）\n` +
    `- ユーザーの「好みの料理ジャンル」がある場合でも、中華・洋食・エスニックなど特定ジャンルが1日2回以上続かないようにする（和食・家庭料理の連続はOK）\n` +
    `- 服薬情報がある場合は、一般的な食事上の注意点を尊重（例: ワーファリンはビタミンK摂取が極端に偏らないよう配慮）\n` +
    `- なるべく「日本の食卓として自然」な構成にする（重すぎる朝食、同系統の揚げ物連発等は避ける）\n` +
    `- 塩分配慮が必要なら sodium_g が低い候補を優先\n` +
    `- requestedMealTypes 内で external_id が重複しないようにする\n` +
    `\n` +
    `【advice（任意）】\n` +
    `- 1〜2文で具体的に（減塩の工夫/野菜の足し方/作り置きなど）\n`;

  const agent = new Agent({
    name: "single-meal-selector-v2",
    instructions: systemPrompt,
    model: "gpt-5-mini",
    tools: [],
  });

  const compactCandidates: Record<string, any> = {};
  for (const mt of input.requestedMealTypes) {
    compactCandidates[mt] = (input.candidatesByMealType[mt] ?? []).map(formatCandidateForPrompt);
  }

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【ユーザーコンテキスト(JSON)】\n${JSON.stringify(input.userContext)}\n\n` +
    `${input.note ? `【要望】\n${input.note}\n\n` : ""}` +
    `【対象日付】\n${input.date}\n\n` +
    `【対象の食事タイプ】\n${input.requestedMealTypes.join(", ")}\n\n` +
    `【候補】\n${JSON.stringify(compactCandidates)}\n\n` +
    `出力JSONスキーマ:\n` +
    `{\n` +
    `  "date": "YYYY-MM-DD",\n` +
    `  "meals": [\n` +
    `    { "mealType": "breakfast|lunch|dinner|snack|midnight_snack", "source_menu_set_external_id": "..." }\n` +
    `  ],\n` +
    `  "advice": "..." (optional)\n` +
    `}\n`;

  const conversationHistory: AgentInputItem[] = [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }];

  const runner = new Runner({
    traceMetadata: {
      __trace_source__: "generate-single-meal-v2",
      workflow_id: "wf_single_meal_generation_v2",
    },
  });

  const result = await runner.run(agent, conversationHistory);
  const out = result.finalOutput ? String(result.finalOutput) : "";
  if (!out) throw new Error("LLM output is empty");

  const parsed = safeJsonParse(out);
  return DailyMenuV2SelectionSchema.parse(parsed);
}

function repairSelectionToCandidates(input: {
  date: string;
  selection: DailyMenuV2Selection;
  requestedMealTypes: MealType[];
  candidatesByMealType: Record<MealType, MenuSetCandidate[]>;
}): DailyMenuV2Selection {
  const requested = Array.from(new Set(input.requestedMealTypes));
  const map = new Map<string, string>();
  for (const m of input.selection.meals ?? []) {
    if (!m?.mealType || !m?.source_menu_set_external_id) continue;
    map.set(m.mealType, m.source_menu_set_external_id);
  }

  const used = new Set<string>();
  const repairedMeals = requested.map((mealType) => {
    const candidateIds = (input.candidatesByMealType[mealType] ?? []).map((c) => c.external_id);
    const candidateSet = new Set(candidateIds);

    let chosen = map.get(mealType) ?? "";
    if (!chosen || !candidateSet.has(chosen) || used.has(chosen)) {
      chosen = candidateIds.find((id) => id && !used.has(id)) ?? candidateIds[0] ?? "";
    }
    if (!chosen) throw new Error(`No candidate available for ${mealType} on ${input.date}`);
    used.add(chosen);
    return { mealType, source_menu_set_external_id: chosen };
  });

  return {
    date: input.date,
    meals: repairedMeals,
    advice: input.selection.advice,
  };
}

// =========================================================
// Main background task (DB write)
// =========================================================

async function generateSingleMealV2BackgroundTask(args: {
  userId: string;
  dayDate: string;
  mealTypes: MealType[];
  note?: string | null;
  requestId?: string | null;
  targetMealId?: string | null;
  constraints?: unknown;
}): Promise<{ selection: DailyMenuV2Selection; datasetVersion: string }> {
  const serviceRoleKey = Deno.env.get("DATASET_SERVICE_ROLE_KEY") ?? "";
  if (!serviceRoleKey) throw new Error("Missing DATASET_SERVICE_ROLE_KEY");

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceRoleKey);

  const { userId, dayDate, note, requestId, constraints } = args;
  const mealTypes = (args.mealTypes ?? []).filter(Boolean);

  if (requestId) {
    await supabase
      .from("weekly_menu_requests")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", requestId)
      .eq("user_id", userId);
  }

  try {
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

    // meal_plan: まず dayDate を包含する既存プランを優先（無ければ新規作成）
    let mealPlanId: string;
    const { data: containingPlan, error: planErr } = await supabase
      .from("meal_plans")
      .select("id, start_date, end_date, is_active")
      .eq("user_id", userId)
      .lte("start_date", dayDate)
      .gte("end_date", dayDate)
      .order("is_active", { ascending: false })
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (planErr) throw new Error(`Failed to fetch meal_plan: ${planErr.message}`);

    if (containingPlan?.id) {
      mealPlanId = containingPlan.id;
    } else {
      // 週次の開始日は「dayDate基準の週初（月曜）」に寄せる（既存週次生成と整合させる）
      const weekStart = getWeekStart(dayDate);
      const weekEnd = addDays(weekStart, 6);

      // 既に同start_dateのプランがあればそれを使う（重複作成防止）
      const { data: sameStart, error: sameErr } = await supabase
        .from("meal_plans")
        .select("id")
        .eq("user_id", userId)
        .eq("start_date", weekStart)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (sameErr) throw new Error(`Failed to fetch meal_plan by start_date: ${sameErr.message}`);

      if (sameStart?.id) {
        mealPlanId = sameStart.id;
      } else {
        // 既存のactiveを落として新規をactiveにする（UI互換: is_active を正として扱う）
        await supabase
          .from("meal_plans")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("is_active", true);

        const { data: newPlan, error: createErr } = await supabase
          .from("meal_plans")
          .insert({
            user_id: userId,
            title: `${new Date(`${weekStart}T00:00:00.000Z`).getUTCMonth() + 1}月${new Date(`${weekStart}T00:00:00.000Z`).getUTCDate()}日〜の献立`,
            start_date: weekStart,
            end_date: weekEnd,
            status: "active",
            is_active: true,
          })
          .select("id")
          .single();
        if (createErr) throw new Error(`Failed to create meal_plan: ${createErr.message}`);
        mealPlanId = newPlan.id;
      }
    }

    // meal_plan_day
    let mealPlanDayId: string;
    const { data: existingDay, error: dayErr0 } = await supabase
      .from("meal_plan_days")
      .select("id")
      .eq("meal_plan_id", mealPlanId)
      .eq("day_date", dayDate)
      .maybeSingle();
    if (dayErr0) throw new Error(`Failed to fetch meal_plan_day: ${dayErr0.message}`);
    if (existingDay?.id) {
      mealPlanDayId = existingDay.id;
    } else {
      const { data: newDay, error: dayErr } = await supabase
        .from("meal_plan_days")
        .insert({ meal_plan_id: mealPlanId, day_date: dayDate, nutritional_focus: null })
        .select("id")
        .single();
      if (dayErr) throw new Error(`Failed to create meal_plan_day: ${dayErr.message}`);
      mealPlanDayId = newDay.id;
    }

    // candidates
    const requestedMealTypes = Array.from(new Set(mealTypes)).slice(0, 5);
    if (requestedMealTypes.length === 0) throw new Error("mealTypes is required");

    const baseQuery = buildSearchQueryBase({ profile, nutritionTargets: nutritionTargets ?? null, note: note ?? null, constraints });
    const candidatesByMealType = {} as Record<MealType, MenuSetCandidate[]>;

    for (const mt of requestedMealTypes) {
      const ja = mt === "breakfast" ? "朝食" : mt === "lunch" ? "昼食" : mt === "dinner" ? "夕食" : mt === "snack" ? "間食" : "夜食";
      // パフォーマンス改善: 候補数を削減（single mealなので少なくてOK）
      const raw = await searchMenuCandidates(supabase, `${ja}\n${baseQuery}`, mt === "dinner" ? 300 : mt === "lunch" ? 200 : 150);
      let candidates = pickCandidatesForMealType(mt, raw, { min: 10, max: 80 });
      if (allergyTokens.length > 0) {
        const filtered = candidates.filter(candidateSeemsAllergySafe);
        if (filtered.length >= 10) candidates = filtered;
      }
      candidatesByMealType[mt] = candidates;
    }

    // LLM choose ids
    const rawSelection = await runAgentToSelectDailyMenuIds({
      userSummary,
      userContext,
      note: note ?? null,
      date: dayDate,
      requestedMealTypes,
      candidatesByMealType,
    });
    const selection = repairSelectionToCandidates({
      date: dayDate,
      selection: rawSelection,
      requestedMealTypes,
      candidatesByMealType,
    });
    const replacementLog: Array<{ date: string; mealType: MealType; from: string; to: string; reason: string }> = [];

    // fetch selected menu_sets
    const selectedExternalIds = Array.from(new Set(selection.meals.map((m) => m.source_menu_set_external_id))).filter(Boolean);
    const { data: menuSets, error: menuErr } = await supabase.from("dataset_menu_sets").select("*").in("external_id", selectedExternalIds);
    if (menuErr) throw new Error(`Failed to fetch dataset_menu_sets: ${menuErr.message}`);
    const menuSetByExternalId = new Map<string, any>((menuSets ?? []).map((m: any) => [m.external_id, m]));
    const reservedExternalIds = new Set<string>(selectedExternalIds);

    async function getMenuSetByExternalIdSafe(externalId: string): Promise<any | null> {
      const id = String(externalId ?? "").trim();
      if (!id) return null;
      const cached = menuSetByExternalId.get(id);
      if (cached) return cached;
      const { data, error } = await supabase.from("dataset_menu_sets").select("*").eq("external_id", id).maybeSingle();
      if (error) throw new Error(`Failed to fetch dataset_menu_sets(${id}): ${error.message}`);
      if (data?.external_id) menuSetByExternalId.set(String(data.external_id), data);
      return data ?? null;
    }

    // recipe resolver (normalize match -> trgm -> embedding)
    const allDishNames: string[] = [];
    for (const ms of menuSets ?? []) {
      const dishes = Array.isArray(ms.dishes) ? ms.dishes : [];
      for (const d of dishes) if (d?.name) allDishNames.push(String(d.name));
    }
    const uniqNorms = Array.from(new Set(allDishNames.map((n) => normalizeDishNameJs(n)))).filter(Boolean);

    const { data: recipeRows, error: recipeErr } = await supabase
      .from("dataset_recipes")
      .select("id,external_id,name,name_norm,ingredients_text,instructions_text,calories_kcal,protein_g,fat_g,carbs_g,sodium_g,sugar_g,fiber_g")
      .in("name_norm", uniqNorms);
    if (recipeErr) throw new Error(`Failed to fetch dataset_recipes by name_norm: ${recipeErr.message}`);

    const recipeByNorm = new Map<string, any>((recipeRows ?? []).map((r: any) => [String(r.name_norm), r]));

    async function resolveRecipeForDishName(dishName: string) {
      const norm = normalizeDishNameJs(dishName);
      const exact = recipeByNorm.get(norm);
      if (exact) return exact;

      // trgm
      const { data: sims } = await supabase.rpc("search_similar_dataset_recipes", {
        query_name: dishName,
        similarity_threshold: 0.2,
        result_limit: 1,
      });
      const best = Array.isArray(sims) ? sims[0] : null;
      if (best?.id) {
        const { data: r } = await supabase
          .from("dataset_recipes")
          .select(
            "id, external_id, name, name_norm, source_url, ingredients_text, instructions_text, calories_kcal, sodium_g, protein_g, fat_g, carbs_g, sugar_g, fiber_g",
          )
          .eq("id", best.id)
          .maybeSingle();
        if (r?.id) return r;
      }

      return null;
    }

    async function buildMealFromMenuSet(ms: any): Promise<{
      dishDetails: any[];
      aggregatedIngredients: string[];
      dishName: string;
      allergyHits: ReturnType<typeof detectAllergenHits>;
    }> {
      const dishes = Array.isArray(ms?.dishes) ? ms.dishes : [];
      const dishDetails: any[] = [];
      const aggregatedIngredients: string[] = [];

      const allergyTexts: string[] = [];
      allergyTexts.push(String(ms?.title ?? ""));

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
          // 元のテキストも保存（マークダウン表示用）
          ingredientsText: recipe?.ingredients_text ?? null,
          recipeStepsText: recipe?.instructions_text ?? null,
          base_recipe_id: recipe?.id ?? null,
          is_generated_name: false,
        });
      }

      const mainDish = dishDetails.find((x) => x.role === "main") ?? dishDetails[0];
      const allDishNames = dishDetails.map((d: any) => String(d?.name ?? "").trim()).filter(Boolean).join("、");
      const dishName = allDishNames || mainDish?.name || ms?.title || "献立";

      const allergyHits = allergyTokens.length > 0 ? detectAllergenHits(allergyTokens, allergyTexts) : [];

      return { dishDetails, aggregatedIngredients, dishName, allergyHits };
    }

    // write planned_meals
    for (const meal of selection.meals) {
      const mealType = meal.mealType;
      const originalExternalId = String(meal.source_menu_set_external_id ?? "").trim();
      if (!originalExternalId) throw new Error(`Missing source_menu_set_external_id for ${dayDate} ${mealType}`);

      let ms = await getMenuSetByExternalIdSafe(originalExternalId);
      if (!ms) throw new Error(`Selected menu set not found: ${originalExternalId}`);

      let built = await buildMealFromMenuSet(ms);
      let allergyViolationSummary: string | null = null;

      if (allergyTokens.length > 0 && built.allergyHits.length > 0) {
        allergyViolationSummary = summarizeAllergenHits(built.allergyHits);
        reservedExternalIds.delete(originalExternalId);

        const candidatePool = candidatesByMealType[mealType] ?? [];
        let replaced = false;
        for (const cand of candidatePool) {
          const candId = String(cand?.external_id ?? "").trim();
          if (!candId || candId === originalExternalId) continue;
          if (reservedExternalIds.has(candId)) continue;
          if (!candidateSeemsAllergySafe(cand)) continue;

          const ms2 = await getMenuSetByExternalIdSafe(candId);
          if (!ms2) continue;
          const built2 = await buildMealFromMenuSet(ms2);
          if (built2.allergyHits.length === 0) {
            ms = ms2;
            built = built2;
            meal.source_menu_set_external_id = candId;
            reservedExternalIds.add(candId);
            replacementLog.push({
              date: dayDate,
              mealType,
              from: originalExternalId,
              to: candId,
              reason: allergyViolationSummary ?? "allergy",
            });
            replaced = true;
            break;
          }
        }

        if (!replaced) {
          reservedExternalIds.add(originalExternalId);
          throw new Error(
            `Allergy constraint violated for ${dayDate} ${mealType}: ${allergyViolationSummary ?? summarizeAllergenHits(built.allergyHits)}`,
          );
        }
      }

      const dishDetails = built.dishDetails;
      const aggregatedIngredients = built.aggregatedIngredients;
      const dishName = built.dishName;
      const finalExternalId = String(meal.source_menu_set_external_id ?? originalExternalId).trim() || originalExternalId;

      // if targetMealId provided, update that row (regardless of meal_type)
      const targetMealId = args.targetMealId ?? null;
      let existingMealId: string | null = null;
      if (targetMealId) {
        existingMealId = targetMealId;
      } else {
        const { data: existingMeal } = await supabase
          .from("planned_meals")
          .select("id")
          .eq("meal_plan_day_id", mealPlanDayId)
          .eq("meal_type", meal.mealType)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        existingMealId = existingMeal?.id ?? null;
      }

      const mealData: Record<string, any> = {
        meal_plan_day_id: mealPlanDayId,
        meal_type: meal.mealType,
        mode: "cook",
        dish_name: dishName,
        description: null,
        dishes: dishDetails,
        ingredients: aggregatedIngredients.length > 0 ? aggregatedIngredients : null,
        recipe_steps: null,
        is_simple: dishDetails.length <= 1,
        updated_at: new Date().toISOString(),

        // v2 traceability
        source_type: "dataset",
        source_dataset_version: datasetVersion,
        source_menu_set_external_id: ms.external_id,
        generation_metadata: {
          generator: "generate-single-meal-v2",
          llm_model: "gpt-5-mini",
          embeddings_model: "text-embedding-3-small",
          search_query_base: String(baseQuery).slice(0, 1200),
          user_context: userContextForLog,
          constraints: (userContextForLog as any)?.weekly?.constraints ?? null,
          allergy_validation: {
            checked: allergyTokens.length > 0,
            allergy_tokens: allergyTokens.slice(0, 30),
            original_external_id: originalExternalId,
            final_external_id: finalExternalId,
            replaced: finalExternalId !== originalExternalId,
            violation: allergyViolationSummary,
          },
        },

        // 栄養（セット全体＝確定値）
        calories_kcal: toNullableNumber(ms.calories_kcal),
        protein_g: toNullableNumber(ms.protein_g),
        fat_g: toNullableNumber(ms.fat_g),
        carbs_g: toNullableNumber(ms.carbs_g),
        sodium_g: toNullableNumber(ms.sodium_g),
        sugar_g: toNullableNumber(ms.sugar_g),
        fiber_g: toNullableNumber(ms.fiber_g),
        fiber_soluble_g: toNullableNumber(ms.fiber_soluble_g),
        fiber_insoluble_g: toNullableNumber(ms.fiber_insoluble_g),
        potassium_mg: toNullableNumber(ms.potassium_mg),
        calcium_mg: toNullableNumber(ms.calcium_mg),
        magnesium_mg: toNullableNumber(ms.magnesium_mg),
        phosphorus_mg: toNullableNumber(ms.phosphorus_mg),
        iron_mg: toNullableNumber(ms.iron_mg),
        zinc_mg: toNullableNumber(ms.zinc_mg),
        iodine_ug: toNullableNumber(ms.iodine_ug),
        cholesterol_mg: toNullableNumber(ms.cholesterol_mg),
        vitamin_b1_mg: toNullableNumber(ms.vitamin_b1_mg),
        vitamin_b2_mg: toNullableNumber(ms.vitamin_b2_mg),
        vitamin_c_mg: toNullableNumber(ms.vitamin_c_mg),
        vitamin_b6_mg: toNullableNumber(ms.vitamin_b6_mg),
        vitamin_b12_ug: toNullableNumber(ms.vitamin_b12_ug),
        folic_acid_ug: toNullableNumber(ms.folic_acid_ug),
        vitamin_a_ug: toNullableNumber(ms.vitamin_a_ug),
        vitamin_d_ug: toNullableNumber(ms.vitamin_d_ug),
        vitamin_k_ug: toNullableNumber(ms.vitamin_k_ug),
        vitamin_e_mg: toNullableNumber(ms.vitamin_e_mg),
        saturated_fat_g: toNullableNumber(ms.saturated_fat_g),
        monounsaturated_fat_g: toNullableNumber(ms.monounsaturated_fat_g),
        polyunsaturated_fat_g: toNullableNumber(ms.polyunsaturated_fat_g),
      };

      if (existingMealId) {
        const { error: updErr } = await supabase.from("planned_meals").update(mealData).eq("id", existingMealId);
        if (updErr) throw new Error(`Failed to update planned_meal: ${updErr.message}`);
      } else {
        // UI互換: display_order が無いと同日の並びが崩れるため、初回insert時のみデフォルトを入れる
        const insertData = {
          ...mealData,
          display_order: DISPLAY_ORDER_MAP[meal.mealType] ?? 0,
          // UI互換: 新規作成時は未完了として扱う（既存レコード更新時は上書きしない）
          is_completed: false,
        };
        const { error: insErr } = await supabase.from("planned_meals").insert(insertData);
        if (insErr) throw new Error(`Failed to insert planned_meal: ${insErr.message}`);
      }
    }

    if (requestId) {
      const resultJson = {
        ...selection,
        _meta: {
          generator: "generate-single-meal-v2",
          dataset_version: datasetVersion,
          search_query_base: String(baseQuery).slice(0, 1200),
          user_context: userContextForLog,
          constraints: (userContextForLog as any)?.weekly?.constraints ?? null,
          allergy_tokens: allergyTokens.slice(0, 30),
          replacements: replacementLog,
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

    return { selection, datasetVersion };
  } catch (error: any) {
    console.error("❌ generateSingleMealV2BackgroundTask failed:", error?.message ?? error);

    // 失敗時: weekly_menu_requests を failed に更新
    // プレースホルダーは作成していないので、is_generating のクリアは不要
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

    const dayDate = String(body?.dayDate ?? body?.date ?? body?.startDate ?? "").trim();
    const note = typeof body?.note === "string" ? body.note : (typeof body?.prompt === "string" ? body.prompt : null);
    const constraints = body?.constraints ?? body?.preferences ?? null;
    const requestId = body?.requestId ?? null;
    const targetMealId = body?.mealId ?? body?.targetMealId ?? null;
    const bodyUserId = body?.userId ?? null;

    const rawMealType = body?.mealType ?? null;
    const rawMealTypes = Array.isArray(body?.mealTypes) ? body.mealTypes : null;

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

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayDate)) {
      return new Response(JSON.stringify({ error: "dayDate must be YYYY-MM-DD" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const mealTypes: MealType[] = [];
    if (typeof rawMealType === "string" && rawMealType.trim()) {
      const mt = rawMealType.trim();
      if (!ALLOWED_MEAL_TYPES.includes(mt as any)) {
        return new Response(JSON.stringify({ error: `Unsupported mealType: ${mt}` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }
      mealTypes.push(mt as MealType);
    } else if (rawMealTypes) {
      for (const v of rawMealTypes) {
        const mt = String(v ?? "").trim();
        if (!mt) continue;
        if (!ALLOWED_MEAL_TYPES.includes(mt as any)) continue;
        mealTypes.push(mt as MealType);
      }
    }

    const uniqueMealTypes = Array.from(new Set(mealTypes));
    const limitedMealTypes = uniqueMealTypes.slice(0, 5);
    if (limitedMealTypes.length === 0) {
      return new Response(JSON.stringify({ error: "mealType or mealTypes is required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const { selection, datasetVersion } = await generateSingleMealV2BackgroundTask({
      userId,
      dayDate,
      mealTypes: limitedMealTypes,
      note,
      requestId,
      targetMealId: typeof targetMealId === "string" ? targetMealId : null,
      constraints,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Single meal generation v2 completed",
        datasetVersion,
        advice: selection.advice ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("❌ generate-single-meal-v2 failed:", error?.message ?? error);
    return new Response(JSON.stringify({ success: false, error: error?.message ?? String(error) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
