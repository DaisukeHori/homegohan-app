import { createClient } from "jsr:@supabase/supabase-js@2";
import { Agent, type AgentInputItem, Runner } from "@openai/agents";
import { z } from "zod";
import { buildSearchQueryBase, buildUserContextForPrompt, buildUserSummary } from "../_shared/user-context.ts";

console.log("Generate Weekly Menu v2 Function loaded (pgvector + dataset driven)");

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

const REQUIRED_MEAL_TYPES = ["breakfast", "lunch", "dinner"] as const;
type MealType = (typeof REQUIRED_MEAL_TYPES)[number];

const WeeklyMenuV2SelectionSchema = z.object({
  days: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        meals: z.array(
          z.object({
            mealType: z.enum(REQUIRED_MEAL_TYPES),
            source_menu_set_external_id: z.string().min(1),
          }),
        ),
      }),
    )
    .length(7),
  overall_advice: z.string().optional(),
});

type WeeklyMenuV2Selection = z.infer<typeof WeeklyMenuV2SelectionSchema>;

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
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
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

function getWeekDates(startDate: string): string[] {
  // startDate は YYYY-MM-DD 前提
  const base = new Date(`${startDate}T00:00:00.000Z`);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// =========================================================
// Embeddings / Candidate search
// =========================================================

async function embedText(text: string, dimensions = 384): Promise<number[]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OpenAI API Key is missing (OPENAI_API_KEY)");

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
  // NOTE: search_menu_examples の返却に含まれる範囲で拡張してよい（現状は kcal/sodium のみ）
  similarity: number | null;
};

async function searchMenuCandidates(
  supabase: any,
  queryText: string,
  matchCount: number,
): Promise<MenuSetCandidate[]> {
  const emb = await embedText(queryText, 384);
  const { data, error } = await supabase.rpc("search_menu_examples", {
    query_embedding: emb,
    match_count: matchCount,
    // NOTE:
    // HNSW/ANN index は WHERE 句の追加フィルタを「後段で適用」するため、
    // filter_meal_type_hint を使うと LIMIT 件数を満たさず少件数になることがある。
    // そのためまずはフィルタ無しで多めに取得し、JS側で meal_type_hint を振り分ける。
    filter_meal_type_hint: null,
    filter_max_sodium: null,
    filter_theme_tags: null,
  });
  if (error) throw new Error(`search_menu_examples failed: ${error.message}`);
  return (data ?? []) as MenuSetCandidate[];
}

function pickCandidatesForMealType(
  mealType: MealType,
  all: MenuSetCandidate[],
  opts: { min?: number; max?: number } = {},
): MenuSetCandidate[] {
  const min = opts.min ?? 10;
  const max = opts.max ?? 60;

  const typed = all.filter((c) => c.meal_type_hint === mealType);
  if (typed.length >= min) return typed.slice(0, max);

  // meal_type_hint の推定が弱い/検索の上位が偏る場合に備えて、
  // どうしても足りない分は「型不一致でも」補充する（生成を止めない）
  const seen = new Set(typed.map((c) => c.external_id));
  const fallback = all.filter((c) => !seen.has(c.external_id));
  return typed.concat(fallback).slice(0, Math.max(min, Math.min(max, typed.length + fallback.length)));
}

// =========================================================
// Dataset version
// =========================================================

async function getActiveDatasetVersion(supabase: any): Promise<string> {
  // 1) system_settings.menu_dataset_active_version があれば優先
  const { data: setting, error: sErr } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", "menu_dataset_active_version")
    .maybeSingle();
  if (!sErr) {
    const v = setting?.value;
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  // 2) なければ最新の completed import_run
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

async function runAgentToSelectWeeklyMenuIds(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  dates: string[];
  candidatesByMealType: Record<MealType, MenuSetCandidate[]>;
}): Promise<WeeklyMenuV2Selection> {
  const systemPrompt =
    `あなたは日本の国家資格「管理栄養士」として行動する、献立作成の専門家です。\n` +
    `このタスクは「7日×3食（朝/昼/夕）の献立セットIDを候補から選ぶ」ことです。料理の新規作成や、候補にないIDの捏造はしません。\n` +
    `\n` +
    `【最優先（破ったら失格）】\n` +
    `- 出力は **厳密なJSONのみ**（Markdown/説明文/コードブロック禁止）\n` +
    `- days は **ちょうど7日**。各 day.meals は **breakfast/lunch/dinner の3件ちょうど**\n` +
    `- source_menu_set_external_id は、**該当mealTypeの候補一覧に含まれる external_id からのみ選ぶ**（候補外ID禁止）\n` +
    `- アレルギー（絶対除外）/禁忌/宗教・食事スタイルを厳守。該当しそうな候補は選ばない\n` +
    `\n` +
    `【品質（管理栄養士としての判断基準）】\n` +
    `- ユーザーの「料理経験」や「調理時間目安」がある場合、**現実的に作れる献立**を優先（初心者/時短=工程が少ない・重すぎない）\n` +
    `- ユーザーの「好みの料理ジャンル」がある場合、嗜好を尊重しつつ週のバリエーションも確保\n` +
    `- 服薬情報がある場合は、一般的な食事上の注意点を尊重（例: ワーファリンはビタミンK摂取が極端に偏らないよう配慮）\n` +
    `- 週全体で同じ external_id の重複を極力避ける（ただし候補が足りない場合は無理に破綻させない）\n` +
    `- 朝は軽め、昼は活動を支える、夜は満足感＋過剰にならない（候補の calories_kcal/sodium_g を参考にする）\n` +
    `- 塩分配慮が必要（高血圧/減塩指示など）な場合は、**sodium_g が低い候補を優先**し、週を通して平準化する\n` +
    `- 味付け・調理法・主材料（肉/魚/卵/大豆）・料理ジャンルのバリエーションを確保し、連続で似すぎない\n` +
    `- 「日本の食卓として自然」であること（重たい朝食の連発、同系統の揚げ物続き等は避ける）\n` +
    `\n` +
    `【overall_advice（任意）】\n` +
    `- 1〜3文で具体的に（例：減塩の工夫、野菜/タンパク質の取り方、作り置きのコツ）。抽象論だけは避ける。\n`;

  const agent = new Agent({
    name: "weekly-menu-selector-v2",
    instructions: systemPrompt,
    model: "gpt-5-mini",
    tools: [],
  });

  const compactCandidates = {
    breakfast: input.candidatesByMealType.breakfast.map(formatCandidateForPrompt),
    lunch: input.candidatesByMealType.lunch.map(formatCandidateForPrompt),
    dinner: input.candidatesByMealType.dinner.map(formatCandidateForPrompt),
  };

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【ユーザーコンテキスト(JSON)】\n${JSON.stringify(input.userContext)}\n\n` +
    `${input.note ? `【要望】\n${input.note}\n\n` : ""}` +
    `【対象日付】\n${input.dates.join("\n")}\n\n` +
    `【候補（朝食）】\n${JSON.stringify(compactCandidates.breakfast)}\n\n` +
    `【候補（昼食）】\n${JSON.stringify(compactCandidates.lunch)}\n\n` +
    `【候補（夕食）】\n${JSON.stringify(compactCandidates.dinner)}\n\n` +
    `出力JSONスキーマ:\n` +
    `{\n` +
    `  "days": [\n` +
    `    { "date": "YYYY-MM-DD", "meals": [\n` +
    `      { "mealType": "breakfast", "source_menu_set_external_id": "..." },\n` +
    `      { "mealType": "lunch", "source_menu_set_external_id": "..." },\n` +
    `      { "mealType": "dinner", "source_menu_set_external_id": "..." }\n` +
    `    ] }\n` +
    `  ],\n` +
    `  "overall_advice": "..." (optional)\n` +
    `}\n`;

  const conversationHistory: AgentInputItem[] = [
    { role: "user", content: [{ type: "input_text", text: userPrompt }] },
  ];

  const runner = new Runner({
    traceMetadata: {
      __trace_source__: "generate-weekly-menu-v2",
      workflow_id: "wf_weekly_menu_generation_v2",
    },
  });

  const result = await runner.run(agent, conversationHistory);
  const out = result.finalOutput ? String(result.finalOutput) : "";
  if (!out) throw new Error("LLM output is empty");

  const parsed = safeJsonParse(out);
  const validated = WeeklyMenuV2SelectionSchema.parse(parsed);

  // mealTypeの重複/欠損を補正する（LLMが順序を乱してもOK）
  for (const day of validated.days) {
    const map = new Map(day.meals.map((m) => [m.mealType, m.source_menu_set_external_id] as const));
    day.meals = REQUIRED_MEAL_TYPES.map((t) => ({
      mealType: t,
      source_menu_set_external_id: map.get(t) ?? day.meals[0]?.source_menu_set_external_id ?? "",
    }));
  }

  return validated;
}

function repairSelectionToCandidates(input: {
  dates: string[];
  selection: WeeklyMenuV2Selection;
  candidatesByMealType: Record<MealType, MenuSetCandidate[]>;
}): WeeklyMenuV2Selection {
  const candidateIdSets: Record<MealType, Set<string>> = {
    breakfast: new Set(input.candidatesByMealType.breakfast.map((c) => c.external_id)),
    lunch: new Set(input.candidatesByMealType.lunch.map((c) => c.external_id)),
    dinner: new Set(input.candidatesByMealType.dinner.map((c) => c.external_id)),
  };

  const rankedIds: Record<MealType, string[]> = {
    breakfast: input.candidatesByMealType.breakfast.map((c) => c.external_id),
    lunch: input.candidatesByMealType.lunch.map((c) => c.external_id),
    dinner: input.candidatesByMealType.dinner.map((c) => c.external_id),
  };

  const dayByDate = new Map<string, WeeklyMenuV2Selection["days"][number]>();
  for (const d of input.selection.days) dayByDate.set(d.date, d);

  const used = new Set<string>();

  const repairedDays = input.dates.map((date) => {
    const srcDay = dayByDate.get(date) ?? input.selection.days[0];
    const srcMap = new Map(srcDay.meals.map((m) => [m.mealType, m.source_menu_set_external_id] as const));

    const meals = REQUIRED_MEAL_TYPES.map((mealType) => {
      const requested = srcMap.get(mealType) ?? "";
      const allowedSet = candidateIdSets[mealType];
      const candidates = rankedIds[mealType];

      let chosen = "";
      const requestedOk = requested && allowedSet.has(requested) && !used.has(requested);
      if (requestedOk) {
        chosen = requested;
      } else {
        chosen = candidates.find((id) => id && !used.has(id)) ?? candidates[0] ?? "";
      }

      if (!chosen) {
        throw new Error(`No candidate available for ${mealType} on ${date}`);
      }
      used.add(chosen);
      return { mealType, source_menu_set_external_id: chosen };
    });

    return { date, meals };
  });

  return {
    days: repairedDays,
    overall_advice: input.selection.overall_advice,
  };
}

// =========================================================
// Main background task (DB write)
// =========================================================

async function generateMenuV2BackgroundTask(args: {
  userId: string;
  startDate: string;
  note?: string | null;
  requestId?: string | null;
}): Promise<{ selection: WeeklyMenuV2Selection; datasetVersion: string }> {
  // NOTE:
  // Supabase CLI は `SUPABASE_*` プレフィックスの secrets 設定を禁止するため、
  // service role key は `DATASET_SERVICE_ROLE_KEY` に格納して利用する。
  const serviceRoleKey = Deno.env.get("DATASET_SERVICE_ROLE_KEY") ?? "";
  if (!serviceRoleKey) {
    throw new Error("Missing DATASET_SERVICE_ROLE_KEY (required for dataset access under RLS)");
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceRoleKey);

  const { userId, startDate, note, requestId } = args;

  if (requestId) {
    await supabase
      .from("weekly_menu_requests")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", requestId)
      .eq("user_id", userId);
  }

  try {
    const { data: profile, error: profileError } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("id", userId)
      .single();
    if (profileError) throw new Error(`Profile not found: ${profileError.message}`);

    const { data: nutritionTargets } = await supabase
      .from("nutrition_targets")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    const datasetVersion = await getActiveDatasetVersion(supabase);

    const dates = getWeekDates(startDate);
    const userContext = buildUserContextForPrompt({ profile, nutritionTargets: nutritionTargets ?? null, note: note ?? null });
    const userSummary = buildUserSummary(profile, nutritionTargets ?? null, note ?? null);

    // 1) pgvectorで候補抽出（mealTypeごとに一度）
    const searchQueryBase = buildSearchQueryBase({ profile, nutritionTargets: nutritionTargets ?? null, note: note ?? null });
    // NOTE: まずは多めに取得し、meal_type_hint で振り分ける
    const breakfastRaw = await searchMenuCandidates(supabase, `朝食\n${searchQueryBase}`, 600);
    const lunchRaw = await searchMenuCandidates(supabase, `昼食\n${searchQueryBase}`, 800);
    const dinnerRaw = await searchMenuCandidates(supabase, `夕食\n${searchQueryBase}`, 1200);

    const candidatesByMealType: Record<MealType, MenuSetCandidate[]> = {
      breakfast: pickCandidatesForMealType("breakfast", breakfastRaw, { min: 10, max: 60 }),
      lunch: pickCandidatesForMealType("lunch", lunchRaw, { min: 10, max: 80 }),
      dinner: pickCandidatesForMealType("dinner", dinnerRaw, { min: 10, max: 80 }),
    };

    for (const mt of REQUIRED_MEAL_TYPES) {
      if ((candidatesByMealType[mt] ?? []).length < 10) {
        throw new Error(`Not enough candidates for ${mt}: ${candidatesByMealType[mt]?.length ?? 0}`);
      }
    }

    // 2) LLMで「候補からID選択」だけ実施（設計通り）
    const rawSelection = await runAgentToSelectWeeklyMenuIds({
      userSummary,
      userContext,
      note: note ?? null,
      dates,
      candidatesByMealType,
    });
    const selection = repairSelectionToCandidates({ dates, selection: rawSelection, candidatesByMealType });

    // 3) 選ばれたmenu_setをDBから取得
    const selectedExternalIds = Array.from(
      new Set(selection.days.flatMap((d) => d.meals.map((m) => m.source_menu_set_external_id))),
    ).filter(Boolean);

    const { data: menuSets, error: menuErr } = await supabase
      .from("dataset_menu_sets")
      .select("*")
      .in("external_id", selectedExternalIds);
    if (menuErr) throw new Error(`Failed to fetch dataset_menu_sets: ${menuErr.message}`);

    const menuSetByExternalId = new Map<string, any>((menuSets ?? []).map((m: any) => [m.external_id, m]));

    // 4) dish名→recipeを引く（まず正規化一致をまとめて取得）
    const allDishNames: string[] = [];
    for (const ms of menuSets ?? []) {
      const dishes = Array.isArray(ms.dishes) ? ms.dishes : [];
      for (const d of dishes) {
        if (d?.name) allDishNames.push(String(d.name));
      }
    }
    const uniqNorms = Array.from(new Set(allDishNames.map((n) => normalizeDishNameJs(n)))).filter(Boolean);

    const { data: exactRecipes, error: recipeErr } = await supabase
      .from("dataset_recipes")
      .select(
        "id, external_id, name, name_norm, source_url, ingredients_text, instructions_text, calories_kcal, sodium_g, protein_g, fat_g, carbs_g, sugar_g, fiber_g",
      )
      .in("name_norm", uniqNorms);
    if (recipeErr) throw new Error(`Failed to fetch dataset_recipes: ${recipeErr.message}`);

    const recipeByNorm = new Map<string, any>((exactRecipes ?? []).map((r: any) => [r.name_norm, r]));

    async function resolveRecipeForDishName(dishName: string): Promise<any | null> {
      const norm = normalizeDishNameJs(dishName);
      if (!norm) return null;
      const exact = recipeByNorm.get(norm);
      if (exact) return exact;

      // fallback: pg_trgm
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
      if (r2?.name_norm) recipeByNorm.set(r2.name_norm, r2);
      return r2 ?? null;
    }

    // 5) meal_plans / meal_plan_days / planned_meals 保存
    const endDate = dates[6];

    // meal_plan: 既存があれば再利用（無ければ作成）
    const { data: existingPlan, error: planFetchErr } = await supabase
      .from("meal_plans")
      .select("id")
      .eq("user_id", userId)
      .eq("start_date", startDate)
      .maybeSingle();
    if (planFetchErr) throw new Error(`Failed to fetch meal_plan: ${planFetchErr.message}`);

    let mealPlanId: string;
    if (existingPlan?.id) {
      mealPlanId = existingPlan.id;
      // UI互換: is_active を正として扱う箇所があるため、この週をアクティブに寄せる
      await supabase
        .from("meal_plans")
        .update({ end_date: endDate, status: "active", is_active: true, updated_at: new Date().toISOString() })
        .eq("id", mealPlanId)
        .eq("user_id", userId);
    } else {
      // 他のプランを非アクティブ化（アクティブは1つに揃える）
      await supabase.from("meal_plans").update({ is_active: false }).eq("user_id", userId);

      const { data: newPlan, error: planErr } = await supabase
        .from("meal_plans")
        .insert({
          user_id: userId,
          title: `${new Date(`${startDate}T00:00:00.000Z`).getUTCMonth() + 1}月${new Date(`${startDate}T00:00:00.000Z`).getUTCDate()}日〜の献立`,
          start_date: startDate,
          end_date: endDate,
          status: "active",
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (planErr) throw new Error(`Failed to create meal_plan: ${planErr.message}`);
      mealPlanId = newPlan.id;
    }

    // 他のプランを非アクティブ化（アクティブは1つに揃える）
    await supabase.from("meal_plans").update({ is_active: false }).eq("user_id", userId).neq("id", mealPlanId);

    for (const day of selection.days) {
      const dayDate = day.date;

      const { data: existingDay } = await supabase
        .from("meal_plan_days")
        .select("id")
        .eq("meal_plan_id", mealPlanId)
        .eq("day_date", dayDate)
        .maybeSingle();

      let mealPlanDayId: string;
      if (existingDay?.id) {
        mealPlanDayId = existingDay.id;
      } else {
        const { data: newDay, error: dayErr } = await supabase
          .from("meal_plan_days")
          .insert({
            meal_plan_id: mealPlanId,
            day_date: dayDate,
            nutritional_focus: null,
          })
          .select("id")
          .single();
        if (dayErr) throw new Error(`Failed to create meal_plan_day: ${dayErr.message}`);
        mealPlanDayId = newDay.id;
      }

      for (const meal of day.meals) {
        const ms = menuSetByExternalId.get(meal.source_menu_set_external_id);
        if (!ms) {
          throw new Error(`Selected menu set not found: ${meal.source_menu_set_external_id}`);
        }

        const dishes = Array.isArray(ms.dishes) ? ms.dishes : [];
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
            // UI互換: dish.cal を使うので cal を必ず入れる
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
        const dishName = mainDish?.name ?? ms.title ?? "献立";

        // 既存が複数あるケースでも安全に「先頭1件」を更新する（重複増殖を防ぐ）
        const { data: existingMeal } = await supabase
          .from("planned_meals")
          .select("id")
          .eq("meal_plan_day_id", mealPlanDayId)
          .eq("meal_type", meal.mealType)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

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
          is_completed: false,
          is_generating: false,
          updated_at: new Date().toISOString(),

          // v2 traceability
          source_type: "dataset",
          source_dataset_version: datasetVersion,
          source_menu_set_external_id: ms.external_id,
          generation_metadata: {
            generator: "generate-weekly-menu-v2",
            llm_model: "gpt-5-mini",
            embeddings_model: "text-embedding-3-small",
            candidate_counts: {
              breakfast: candidatesByMealType.breakfast.length,
              lunch: candidatesByMealType.lunch.length,
              dinner: candidatesByMealType.dinner.length,
            },
          },

          // 栄養（セット全体＝確定値）
          calories_kcal: ms.calories_kcal ?? null,
          protein_g: ms.protein_g ?? null,
          fat_g: ms.fat_g ?? null,
          carbs_g: ms.carbs_g ?? null,
          sodium_g: ms.sodium_g ?? null,
          sugar_g: ms.sugar_g ?? null,
          fiber_g: ms.fiber_g ?? null,
          fiber_soluble_g: ms.fiber_soluble_g ?? null,
          potassium_mg: ms.potassium_mg ?? null,
          calcium_mg: ms.calcium_mg ?? null,
          magnesium_mg: ms.magnesium_mg ?? null,
          phosphorus_mg: ms.phosphorus_mg ?? null,
          iron_mg: ms.iron_mg ?? null,
          zinc_mg: ms.zinc_mg ?? null,
          iodine_ug: ms.iodine_ug ?? null,
          cholesterol_mg: ms.cholesterol_mg ?? null,
          vitamin_b1_mg: ms.vitamin_b1_mg ?? null,
          vitamin_b2_mg: ms.vitamin_b2_mg ?? null,
          vitamin_c_mg: ms.vitamin_c_mg ?? null,
          vitamin_b6_mg: ms.vitamin_b6_mg ?? null,
          vitamin_b12_ug: ms.vitamin_b12_ug ?? null,
          folic_acid_ug: ms.folic_acid_ug ?? null,
          vitamin_a_ug: ms.vitamin_a_ug ?? null,
          vitamin_d_ug: ms.vitamin_d_ug ?? null,
          vitamin_k_ug: ms.vitamin_k_ug ?? null,
          vitamin_e_mg: ms.vitamin_e_mg ?? null,
          saturated_fat_g: ms.saturated_fat_g ?? null,
          monounsaturated_fat_g: ms.monounsaturated_fat_g ?? null,
          polyunsaturated_fat_g: ms.polyunsaturated_fat_g ?? null,
        };

        if (existingMeal?.id) {
          const { error: updErr } = await supabase.from("planned_meals").update(mealData).eq("id", existingMeal.id);
          if (updErr) throw new Error(`Failed to update planned_meal: ${updErr.message}`);
        } else {
          // UI互換: display_order が無いと同日の並びが崩れるため、初回insert時のみデフォルトを入れる
          const insertData = {
            ...mealData,
            display_order: DISPLAY_ORDER_MAP[meal.mealType] ?? 0,
          };
          const { error: insErr } = await supabase.from("planned_meals").insert(insertData);
          if (insErr) throw new Error(`Failed to insert planned_meal: ${insErr.message}`);
        }
      }
    }

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

    return { selection, datasetVersion };
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

export async function handleGenerateWeeklyMenuV2(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // 認証: service role または user JWT を許可（verify_jwt=false を補完）
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
    const startDate = (body as any)?.startDate;
    // 互換: note / prompt どちらでも受け取る（single/regenerate-v2と揃える）
    const note = typeof (body as any)?.note === "string"
      ? (body as any).note
      : (typeof (body as any)?.prompt === "string" ? (body as any).prompt : null);
    const requestId = (body as any)?.requestId ?? null;
    const bodyUserId = (body as any)?.userId ?? null;

    let userId: string;
    if (serviceRoleKey && token === serviceRoleKey) {
      if (!bodyUserId) {
        return new Response(JSON.stringify({ error: "userId is required for service role calls" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }
      userId = bodyUserId;
    } else {
      const supabaseAuth = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 401,
        });
      }
      if (bodyUserId && bodyUserId !== user.id) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 403,
        });
      }
      userId = user.id;
    }

    if (typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return new Response(JSON.stringify({ error: "startDate must be YYYY-MM-DD" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const { selection, datasetVersion } = await generateMenuV2BackgroundTask({
      userId,
      startDate,
      note: typeof note === "string" ? note : null,
      requestId,
    });

    return new Response(
      JSON.stringify({
        message: "Menu generation v2 completed",
        success: true,
        datasetVersion,
        overall_advice: selection.overall_advice ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("❌ generate-weekly-menu-v2 failed:", error?.message ?? error);
    return new Response(JSON.stringify({ success: false, error: error?.message ?? String(error) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
}

if (import.meta.main) {
  Deno.serve(handleGenerateWeeklyMenuV2);
}


