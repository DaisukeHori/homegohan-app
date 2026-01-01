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

// 旧: ID選択用（後方互換用に残す）
const RegenerateV2SelectionSchema = z.object({
  mealType: z.enum(ALLOWED_MEAL_TYPES),
  source_menu_set_external_id: z.string().min(1),
  advice: z.string().optional(),
});
type RegenerateV2Selection = z.infer<typeof RegenerateV2SelectionSchema>;

// 新: LLMが料理を「創造」するためのスキーマ
const GeneratedDishSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["main", "side", "soup", "rice", "other"]),
  ingredients: z.array(z.object({
    name: z.string().min(1),
    amount_g: z.number(),
    note: z.string().optional(),
  })),
  instructions: z.array(z.string()),
});

const GeneratedMealSchema = z.object({
  mealType: z.enum(ALLOWED_MEAL_TYPES),
  dishes: z.array(GeneratedDishSchema),
  advice: z.string().optional(),
});
type GeneratedMeal = z.infer<typeof GeneratedMealSchema>;
type GeneratedDish = z.infer<typeof GeneratedDishSchema>;

// 栄養計算用の型
type NutritionTotals = {
  calories_kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number;
  sodium_g: number;
  potassium_mg: number;
  calcium_mg: number;
  phosphorus_mg: number;
  iron_mg: number;
  zinc_mg: number;
  iodine_ug: number;
  cholesterol_mg: number;
  vitamin_b1_mg: number;
  vitamin_b2_mg: number;
  vitamin_b6_mg: number;
  vitamin_b12_ug: number;
  folic_acid_ug: number;
  vitamin_c_mg: number;
  vitamin_a_ug: number;
  vitamin_d_ug: number;
  vitamin_k_ug: number;
  vitamin_e_mg: number;
};

function emptyNutrition(): NutritionTotals {
  return {
    calories_kcal: 0,
    protein_g: 0,
    fat_g: 0,
    carbs_g: 0,
    fiber_g: 0,
    sodium_g: 0,
    potassium_mg: 0,
    calcium_mg: 0,
    phosphorus_mg: 0,
    iron_mg: 0,
    zinc_mg: 0,
    iodine_ug: 0,
    cholesterol_mg: 0,
    vitamin_b1_mg: 0,
    vitamin_b2_mg: 0,
    vitamin_b6_mg: 0,
    vitamin_b12_ug: 0,
    folic_acid_ug: 0,
    vitamin_c_mg: 0,
    vitamin_a_ug: 0,
    vitamin_d_ug: 0,
    vitamin_k_ug: 0,
    vitamin_e_mg: 0,
  };
}

// =========================================================
// Helpers
// =========================================================

// 食材名の正規化（dataset_ingredients 側の正規化に合わせる）
function normalizeIngredientNameJs(name: string): string {
  return String(name ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[（）()]/g, "")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

// よく使う調味料・食材のエイリアス（LLMが生成する名前 → DB上の名前）
const INGREDIENT_ALIASES: Record<string, string[]> = {
  // 調味料
  "醤油": ["しょうゆ", "こいくちしょうゆ", "濃口醤油"],
  "しょうゆ": ["醤油", "こいくちしょうゆ"],
  "酢": ["穀物酢", "米酢", "食酢"],
  "みりん": ["本みりん", "みりん風調味料"],
  "料理酒": ["清酒", "日本酒"],
  "塩": ["食塩", "精製塩"],
  "砂糖": ["上白糖", "グラニュー糖"],
  "味噌": ["みそ", "米みそ", "合わせみそ"],
  // 油
  "ごま油": ["ごま油", "香味ごま油"],
  "サラダ油": ["調合油", "植物油"],
  "オリーブ油": ["オリーブオイル"],
  // 野菜
  "もやし": ["りょくとうもやし", "緑豆もやし", "大豆もやし"],
  "ねぎ": ["長ねぎ", "白ねぎ", "青ねぎ"],
  "にんにく": ["ガーリック"],
  "しょうが": ["生姜", "おろししょうが"],
  "生姜": ["しょうが", "おろししょうが"],
  // ごま
  "すりごま": ["ごま", "いりごま", "白ごま"],
  "いりごま": ["ごま", "すりごま", "白ごま"],
  "白ごま": ["ごま", "いりごま"],
  // だし
  "鶏がらスープの素": ["チキンブイヨン", "鶏がらだし"],
  "和風だし": ["かつおだし", "だしの素"],
  "中華だし": ["鶏がらスープ", "ウェイパー"],
  // 肉
  "鶏むね肉": ["若どり むね 皮なし", "鶏肉 むね"],
  "鶏もも肉": ["若どり もも", "鶏肉 もも"],
  "豚ひき肉": ["ぶた ひき肉"],
  "牛ひき肉": ["うし ひき肉"],
};

// 水系食材は栄養計算をスキップ
function isWaterishIngredient(raw: string): boolean {
  const n = normalizeIngredientNameJs(raw);
  if (!n) return false;
  if (n === "水" || n === "お湯" || n === "湯" || n === "熱湯") return true;
  if (n.startsWith("水")) return true;
  return false;
}

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
// 材料・作り方をマークダウンに整形するLLM関数
// =========================================================

async function formatRecipeToMarkdown(ingredientsText: string | null, instructionsText: string | null): Promise<{ ingredientsMd: string; recipeStepsMd: string }> {
  if (!ingredientsText && !instructionsText) {
    return { ingredientsMd: '', recipeStepsMd: '' };
  }

  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) {
    console.warn("Missing OPENAI_API_KEY for markdown formatting");
    return { ingredientsMd: ingredientsText ?? '', recipeStepsMd: instructionsText ?? '' };
  }

  const prompt = `以下のレシピデータをマークダウン形式に整形してください。

【材料テキスト】
${ingredientsText ?? '(なし)'}

【作り方テキスト】
${instructionsText ?? '(なし)'}

【出力形式】JSONで出力してください：
{
  "ingredientsMd": "マークダウンテーブル形式の材料リスト",
  "recipeStepsMd": "マークダウン番号リスト形式の作り方"
}

【ルール】
- 材料は「| 材料 | 分量 |」の2列テーブルにする
- 同じ材料が複数回出てくる場合は1回だけ記載（使用量を優先）
- 「材料1人分使用量買い物量」などのヘッダーや「※」の注釈は除外
- 作り方は番号付きリスト（1. 2. 3. ...）にする
- 各ステップは改行で区切る
- JSONのみを出力し、説明は不要`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!res.ok) {
      console.error("Markdown formatting API error:", await res.text());
      return { ingredientsMd: ingredientsText ?? '', recipeStepsMd: instructionsText ?? '' };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    const cleaned = stripMarkdownCodeBlock(content);
    const parsed = JSON.parse(cleaned);
    
    return {
      ingredientsMd: parsed.ingredientsMd ?? '',
      recipeStepsMd: parsed.recipeStepsMd ?? '',
    };
  } catch (error) {
    console.error("Markdown formatting error:", error);
    return { ingredientsMd: ingredientsText ?? '', recipeStepsMd: instructionsText ?? '' };
  }
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

function pickCandidatesForMealType(mealType: MealType, all: MenuSetCandidate[], opts: { min?: number; max?: number; preferMultipleDishes?: boolean; minDishCount?: number } = {}): MenuSetCandidate[] {
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
// 栄養計算: dataset_ingredients からマッチング
// =========================================================

// 栄養値を加算するヘルパー関数
function addNutritionFromMatch(totals: NutritionTotals, matched: any, amount_g: number) {
  const factor = amount_g / 100.0;
  const add = (key: keyof NutritionTotals, v: number | null | undefined) => {
    if (v != null && Number.isFinite(v)) {
      totals[key] += v * factor;
    }
  };

  add("calories_kcal", matched.calories_kcal);
  add("protein_g", matched.protein_g);
  add("fat_g", matched.fat_g);
  add("carbs_g", matched.carbs_g);
  add("fiber_g", matched.fiber_g);
  add("sodium_g", matched.salt_eq_g);
  add("potassium_mg", matched.potassium_mg);
  add("calcium_mg", matched.calcium_mg);
  add("phosphorus_mg", matched.phosphorus_mg);
  add("iron_mg", matched.iron_mg);
  add("zinc_mg", matched.zinc_mg);
  add("iodine_ug", matched.iodine_ug);
  add("cholesterol_mg", matched.cholesterol_mg);
  add("vitamin_b1_mg", matched.vitamin_b1_mg);
  add("vitamin_b2_mg", matched.vitamin_b2_mg);
  add("vitamin_b6_mg", matched.vitamin_b6_mg);
  add("vitamin_b12_ug", matched.vitamin_b12_ug);
  add("folic_acid_ug", matched.folic_acid_ug);
  add("vitamin_c_mg", matched.vitamin_c_mg);
  add("vitamin_a_ug", matched.vitamin_a_ug);
  add("vitamin_d_ug", matched.vitamin_d_ug);
  add("vitamin_k_ug", matched.vitamin_k_ug);
  add("vitamin_e_mg", matched.vitamin_e_alpha_mg);
}

// Embedding API を呼び出す
async function embedTexts(texts: string[], dimensions = 384): Promise<number[][]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OpenAI API Key is missing");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
      dimensions,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Embeddings API error: ${t}`);
  }
  const json = await res.json();
  const data = json?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error("Embeddings API returned invalid data");
  }
  return data.map((d: any) => d?.embedding) as number[][];
}

async function calculateNutritionFromIngredients(
  supabase: any,
  ingredients: Array<{ name: string; amount_g: number; note?: string }>
): Promise<NutritionTotals> {
  const totals = emptyNutrition();
  
  if (!ingredients || ingredients.length === 0) {
    console.log("[nutrition] No ingredients provided");
    return totals;
  }

  // 水系食材を除外した材料リスト
  const validIngredients = ingredients.filter(i => !isWaterishIngredient(i.name) && i.amount_g > 0);
  console.log(`[nutrition] Valid ingredients: ${validIngredients.length}/${ingredients.length}`, validIngredients.map(i => `${i.name}(${i.amount_g}g)`).join(", "));
  
  if (validIngredients.length === 0) return totals;

  // エイリアスを含めた検索候補を生成
  const searchCandidates: string[] = [];
  for (const ing of validIngredients) {
    const name = ing.name;
    searchCandidates.push(normalizeIngredientNameJs(name));
    // エイリアスも追加
    const aliases = INGREDIENT_ALIASES[name] ?? [];
    for (const alias of aliases) {
      searchCandidates.push(normalizeIngredientNameJs(alias));
    }
  }
  const uniqueNorms = Array.from(new Set(searchCandidates)).filter(Boolean);
  console.log(`[nutrition] Search candidates: ${uniqueNorms.join(", ")}`);

  // 完全一致検索（エイリアスを含む）
  const { data: exactRows, error: exactErr } = await supabase
    .from("dataset_ingredients")
    .select("id, name, name_norm, calories_kcal, protein_g, fat_g, carbs_g, fiber_g, salt_eq_g, potassium_mg, calcium_mg, phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg, vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug, vitamin_k_ug, vitamin_e_alpha_mg")
    .in("name_norm", uniqueNorms);

  if (exactErr) {
    console.error("[nutrition] Failed to fetch ingredients:", exactErr.message);
    return totals;
  }
  
  console.log(`[nutrition] Exact match count: ${exactRows?.length ?? 0}`);
  if (exactRows && exactRows.length > 0) {
    console.log(`[nutrition] Exact matches: ${exactRows.map((r: any) => `${r.name}(${r.calories_kcal}kcal/100g)`).join(", ")}`);
  }

  // name_norm をキーにしたマップを作成
  const ingredientMap = new Map<string, any>();
  for (const row of exactRows ?? []) {
    if (row?.name_norm) ingredientMap.set(String(row.name_norm), row);
  }

  // マッチ結果を格納
  const matchResults: string[] = [];
  const unmatchedIngredients: { ing: typeof validIngredients[0]; idx: number }[] = [];

  // 各食材についてマッチングを試みる
  for (let idx = 0; idx < validIngredients.length; idx++) {
    const ing = validIngredients[idx];
    const norm = normalizeIngredientNameJs(ing.name);
    let matched = ingredientMap.get(norm);
    let matchMethod = matched ? "exact" : "none";

    // エイリアスで完全一致を試みる
    if (!matched) {
      const aliases = INGREDIENT_ALIASES[ing.name] ?? [];
      for (const alias of aliases) {
        const aliasNorm = normalizeIngredientNameJs(alias);
        matched = ingredientMap.get(aliasNorm);
        if (matched) {
          matchMethod = `alias(${alias})`;
          break;
        }
      }
    }

    // 完全一致がない場合、trigram 類似検索
    if (!matched) {
      const { data: sims, error: simErr } = await supabase.rpc("search_similar_dataset_ingredients", {
        query_name: ing.name,
        similarity_threshold: 0.15, // 閾値を下げる
        result_limit: 5,
      });
      if (!simErr && Array.isArray(sims) && sims.length > 0) {
        // 油系の食材は油系のみにマッチさせる
        const isOil = /油|オイル/.test(ing.name);
        const candidates = sims.filter((s: any) => {
          if (isOil) return /油|オイル/.test(s.name ?? "");
          return true;
        });
        const best = candidates[0] ?? sims[0];
        if (best?.id && best.similarity >= 0.15) {
          const { data: row } = await supabase
            .from("dataset_ingredients")
            .select("id, name, name_norm, calories_kcal, protein_g, fat_g, carbs_g, fiber_g, salt_eq_g, potassium_mg, calcium_mg, phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg, vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug, vitamin_k_ug, vitamin_e_alpha_mg")
            .eq("id", best.id)
            .maybeSingle();
          if (row) {
            matched = row;
            matchMethod = `trgm(${best.similarity?.toFixed(2) ?? "?"})`;
          }
        }
      }
    }

    // まだマッチしない場合、後でベクトル検索
    if (!matched) {
      unmatchedIngredients.push({ ing, idx });
      continue;
    }
    
    matchResults[idx] = `${ing.name}(${ing.amount_g}g) → ${matched.name}[${matchMethod}](${matched.calories_kcal}kcal/100g)`;
    
    // 栄養値を加算
    addNutritionFromMatch(totals, matched, ing.amount_g);
  }

  // ベクトル検索（未マッチの食材）
  if (unmatchedIngredients.length > 0) {
    console.log(`[nutrition] Vector search for ${unmatchedIngredients.length} unmatched ingredients`);
    try {
      const texts = unmatchedIngredients.map(u => u.ing.name);
      const embeddings = await embedTexts(texts, 384);
      
      for (let i = 0; i < unmatchedIngredients.length; i++) {
        const { ing, idx } = unmatchedIngredients[i];
        const emb = embeddings[i];
        
        const { data: rows, error: embErr } = await supabase.rpc("search_dataset_ingredients_by_embedding", {
          query_embedding: emb,
          match_count: 5,
        });
        
        if (!embErr && Array.isArray(rows) && rows.length > 0) {
          // 油系の食材は油系のみにマッチさせる
          const isOil = /油|オイル/.test(ing.name);
          const candidates = rows.filter((r: any) => {
            if (isOil) return /油|オイル/.test(r.name ?? "");
            return true;
          });
          const best = candidates[0] ?? rows[0];
          
          if (best?.id) {
            const { data: row } = await supabase
              .from("dataset_ingredients")
              .select("id, name, name_norm, calories_kcal, protein_g, fat_g, carbs_g, fiber_g, salt_eq_g, potassium_mg, calcium_mg, phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg, vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug, vitamin_k_ug, vitamin_e_alpha_mg")
              .eq("id", best.id)
              .maybeSingle();
            
            if (row) {
              matchResults[idx] = `${ing.name}(${ing.amount_g}g) → ${row.name}[vector(${best.similarity?.toFixed(2) ?? "?"})](${row.calories_kcal}kcal/100g)`;
              addNutritionFromMatch(totals, row, ing.amount_g);
              continue;
            }
          }
        }
        
        matchResults[idx] = `${ing.name}(${ing.amount_g}g) → UNMATCHED`;
      }
    } catch (e: any) {
      console.error("[nutrition] Vector search failed:", e?.message ?? e);
      // ベクトル検索失敗時は UNMATCHED のまま
      for (const { ing, idx } of unmatchedIngredients) {
        matchResults[idx] = `${ing.name}(${ing.amount_g}g) → UNMATCHED`;
      }
    }
  }

  // ログ出力
  const validResults = matchResults.filter(Boolean);
  console.log(`[nutrition] Match results:\n  ${validResults.join("\n  ")}`);
  console.log(`[nutrition] Total: ${Math.round(totals.calories_kcal)}kcal, P:${totals.protein_g.toFixed(1)}g, F:${totals.fat_g.toFixed(1)}g, C:${totals.carbs_g.toFixed(1)}g`);

  return totals;
}

// =========================================================
// LLM: 料理を「創造」する（derived方式）
// =========================================================

async function runAgentToGenerateMeal(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  mealType: MealType;
  currentDishName: string | null;
  referenceMenus: MenuSetCandidate[]; // 参考例として
}): Promise<GeneratedMeal> {
  const mealTypeJa = input.mealType === "breakfast" ? "朝食" : input.mealType === "lunch" ? "昼食" : input.mealType === "dinner" ? "夕食" : input.mealType === "snack" ? "間食" : "夜食";
  
  const systemPrompt =
    `あなたは日本の国家資格「管理栄養士」兼 料理研究家です。\n` +
    `このタスクは「${mealTypeJa}の献立を創造する」ことです。\n` +
    `\n` +
    `【絶対ルール】\n` +
    `- 出力は **厳密なJSONのみ**（Markdown/説明文/コードブロック禁止）\n` +
    `- ingredients[].amount_g は必ず g 単位（大さじ/小さじ/個/本などは料理として自然なgに換算）\n` +
    `- ingredients[].name は **食材名のみ**（括弧・分量・用途・状態は入れない）\n` +
    `  - 例: 「キャベツ」「卵」「豚ひき肉」「ごま油」「醤油」\n` +
    `- instructions は手順ごとに分割し、番号なしで配列に入れる\n` +
    `- アレルギー/禁忌食材は絶対に使わない\n` +
    `\n` +
    `【献立の構成】\n` +
    `- 昼食・夕食は「1汁3菜」を基本（主菜 + 副菜 + 汁物 + ご飯など、3〜4品）\n` +
    `- 朝食は2品以上（主食 + 汁物 or おかず）\n` +
    `- 間食/夜食は1〜2品\n` +
    `\n` +
    `【品質（管理栄養士としての配慮）】\n` +
    `- ユーザーの料理経験/調理時間を考慮し、現実的に作れる献立を\n` +
    `- 減塩指示がある場合は、塩・醤油・味噌を控えめに、香味野菜/酢/だしで補う\n` +
    `- 野菜・たんぱく質のバランスを意識\n` +
    `- 日本の家庭料理として自然な組み合わせ\n` +
    `\n` +
    `出力JSONスキーマ:\n` +
    `{\n` +
    `  "mealType": "${input.mealType}",\n` +
    `  "dishes": [\n` +
    `    {\n` +
    `      "name": "料理名",\n` +
    `      "role": "main" | "side" | "soup" | "rice" | "other",\n` +
    `      "ingredients": [{ "name": "食材名", "amount_g": 数値, "note": "任意" }],\n` +
    `      "instructions": ["手順1", "手順2", ...]\n` +
    `    }\n` +
    `  ],\n` +
    `  "advice": "栄養士としてのワンポイントアドバイス（任意）"\n` +
    `}\n`;

  // 参考例を3つまで抜粋
  const referenceText = input.referenceMenus.slice(0, 3).map((m, i) => {
    const dishes = Array.isArray(m.dishes) ? m.dishes : [];
    const dishNames = dishes.map((d: any) => `${d.name}(${d.role || d.class_raw})`).join(", ");
    return `例${i + 1}: ${m.title} → ${dishNames}`;
  }).join("\n");

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【ユーザーコンテキスト(JSON)】\n${JSON.stringify(input.userContext)}\n\n` +
    `${input.note ? `【要望】\n${input.note}\n\n` : ""}` +
    `【食事タイプ】\n${mealTypeJa}\n\n` +
    `${input.currentDishName ? `【現在の献立（これとは異なるものを）】\n${input.currentDishName}\n\n` : ""}` +
    `【参考にできる献立例（あくまで参考）】\n${referenceText}\n\n` +
    `上記を参考に、${mealTypeJa}の献立を創造してください。参考例をそのままコピーせず、ユーザーに合わせてアレンジしてください。`;

  const agent = new Agent({
    name: "meal-creator-v2",
    instructions: systemPrompt,
    model: "gpt-5-mini",
    tools: [],
  });

  const conversationHistory: AgentInputItem[] = [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }];
  const runner = new Runner({
    traceMetadata: {
      __trace_source__: "regenerate-meal-direct-v2",
      workflow_id: "wf_regenerate_meal_create_v2",
    },
  });

  const result = await runner.run(agent, conversationHistory);
  const out = result.finalOutput ? String(result.finalOutput) : "";
  if (!out) throw new Error("LLM output is empty");
  const parsed = safeJsonParse(out);
  return GeneratedMealSchema.parse(parsed);
}

// =========================================================
// LLM selection (旧: 後方互換用)
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
    `- **昼食・夕食は「1汁3菜」（主菜+副菜+汁物+ご飯/主食）を基本とし、3品以上含む献立セットを優先して選ぶ**\n` +
    `- 候補の dishes 配列の品数（length）を確認し、昼食・夕食は3品以上の候補を優先的に選択する\n` +
    `- 朝食は2品以上（主食+汁物orおかず）を基本とする\n` +
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

// ログ用ヘルパー: フェーズ時間計測
function logPhase(phase: string, startTime: number, extra?: Record<string, unknown>) {
  const elapsed = Date.now() - startTime;
  console.log(`[PHASE] ${phase}: ${elapsed}ms`, extra ? JSON.stringify(extra) : "");
  return Date.now();
}

async function regenerateMealV2BackgroundTask(args: {
  userId: string;
  mealId: string;
  note?: string | null;
  requestId?: string | null;
  constraints?: unknown;
}): Promise<{ selection: RegenerateV2Selection; datasetVersion: string; plannedMealId: string }> {
  const totalStart = Date.now();
  let phaseStart = Date.now();
  console.log(`[START] regenerate-meal-direct-v2 requestId=${args.requestId} mealId=${args.mealId}`);

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
  phaseStart = logPhase("1_init", phaseStart);

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
    phaseStart = logPhase("2_user_info", phaseStart);
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
    // パフォーマンス改善: 候補数を削減（regenerateは1食分なので少なくてOK）
    const raw = await searchMenuCandidates(supabase, `${ja}\n${baseQuery}`, mealType === "dinner" ? 300 : mealType === "lunch" ? 200 : 150);
    phaseStart = logPhase("3_vector_search", phaseStart, { rawCount: raw.length });

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
    phaseStart = logPhase("4_filtering", phaseStart, { candidateCount: candidates.length });

    // 新方式: LLMが料理を「創造」する
    const currentDishName = (existingMeal as any).dish_name ?? null;
    const generatedMeal = await runAgentToGenerateMeal({
      userSummary,
      userContext,
      note: note ?? null,
      mealType,
      currentDishName,
      referenceMenus: candidates, // 参考例として渡す
    });
    phaseStart = logPhase("5_llm_generation", phaseStart, { dishCount: generatedMeal.dishes.length });

    // 生成された料理からdishDetailsを構築
    const dishDetails: any[] = [];
    const aggregatedIngredients: string[] = [];
    
    // 全体の栄養を合算するための変数
    const mealNutrition = emptyNutrition();
    
    for (const dish of generatedMeal.dishes) {
      // 材料をマークダウンテーブル形式に
      let ingredientsMd = "| 材料 | 分量 |\n|------|------|\n";
      for (const ing of dish.ingredients) {
        ingredientsMd += `| ${ing.name} | ${ing.amount_g}g${ing.note ? ` (${ing.note})` : ""} |\n`;
        aggregatedIngredients.push(`${ing.name} ${ing.amount_g}g`);
      }
      
      // 作り方をマークダウン番号リスト形式に
      const recipeStepsMd = dish.instructions.map((step, i) => `${i + 1}. ${step}`).join("\n\n");
      
      // dataset_ingredients から栄養計算
      const nutrition = await calculateNutritionFromIngredients(supabase, dish.ingredients);
      
      // 全体の栄養に加算
      for (const key of Object.keys(mealNutrition) as (keyof NutritionTotals)[]) {
        mealNutrition[key] += nutrition[key];
      }
      
      dishDetails.push({
        name: dish.name,
        role: dish.role,
        cal: Math.round(nutrition.calories_kcal),
        protein: Math.round(nutrition.protein_g * 10) / 10,
        fat: Math.round(nutrition.fat_g * 10) / 10,
        carbs: Math.round(nutrition.carbs_g * 10) / 10,
        sodium: Math.round(nutrition.sodium_g * 10) / 10,
        sugar: 0, // dataset_ingredients に糖質がないため
        fiber: Math.round(nutrition.fiber_g * 10) / 10,
        fiberSoluble: 0,
        fiberInsoluble: 0,
        potassium: Math.round(nutrition.potassium_mg),
        calcium: Math.round(nutrition.calcium_mg),
        phosphorus: Math.round(nutrition.phosphorus_mg),
        iron: Math.round(nutrition.iron_mg * 10) / 10,
        zinc: Math.round(nutrition.zinc_mg * 10) / 10,
        iodine: Math.round(nutrition.iodine_ug),
        cholesterol: Math.round(nutrition.cholesterol_mg),
        vitaminB1: Math.round(nutrition.vitamin_b1_mg * 100) / 100,
        vitaminB2: Math.round(nutrition.vitamin_b2_mg * 100) / 100,
        vitaminC: Math.round(nutrition.vitamin_c_mg),
        vitaminB6: Math.round(nutrition.vitamin_b6_mg * 100) / 100,
        vitaminB12: Math.round(nutrition.vitamin_b12_ug * 10) / 10,
        folicAcid: Math.round(nutrition.folic_acid_ug),
        vitaminA: Math.round(nutrition.vitamin_a_ug),
        vitaminD: Math.round(nutrition.vitamin_d_ug * 10) / 10,
        vitaminK: Math.round(nutrition.vitamin_k_ug),
        vitaminE: Math.round(nutrition.vitamin_e_mg * 10) / 10,
        saturatedFat: 0,
        monounsaturatedFat: 0,
        polyunsaturatedFat: 0,
        ingredient: dish.ingredients.slice(0, 3).map(i => i.name).join("、"),
        ingredients: dish.ingredients.map(i => `${i.name} ${i.amount_g}g`),
        recipeSteps: dish.instructions,
        // マークダウン整形済み
        ingredientsMd,
        recipeStepsMd,
        base_recipe_id: null,
        is_generated_name: true,
      });
    }
    
    phaseStart = logPhase("5.5_nutrition_calc", phaseStart, { totalKcal: Math.round(mealNutrition.calories_kcal) });
    
    const mainDish = dishDetails.find((d) => d.role === "main") ?? dishDetails[0];
    const allDishNames = dishDetails.map((d) => d.name).join("、");
    const dishName = allDishNames || mainDish?.name || "献立";
    
    phaseStart = logPhase("6_build_details", phaseStart, { dishCount: dishDetails.length });

    // DB保存用データを構築
    const mealData: Record<string, any> = {
      dish_name: dishName,
      description: generatedMeal.advice ?? null,
      dishes: dishDetails,
      ingredients: aggregatedIngredients.length > 0 ? aggregatedIngredients : null,
      recipe_steps: null,
      is_simple: dishDetails.length <= 1,
      updated_at: new Date().toISOString(),

      // v2 traceability - 新方式では source_type を "generated" に
      source_type: "generated",
      source_dataset_version: datasetVersion,
      source_menu_set_external_id: null, // LLMが創造したのでデータセットIDなし
      generation_metadata: {
        ...(typeof (existingMeal as any).generation_metadata === "object" ? (existingMeal as any).generation_metadata : {}),
        generator: "regenerate-meal-direct-v2",
        generation_mode: "derived", // 新方式
        llm_model: "gpt-5-mini",
        embeddings_model: "text-embedding-3-small",
        search_query_base: String(baseQuery).slice(0, 1200),
        user_context: userContextForLog,
        constraints: (userContextForLog as any)?.weekly?.constraints ?? null,
        previous_dish_name: currentDishName,
        advice: generatedMeal.advice ?? null,
        note: note ?? null,
        reference_menu_count: candidates.length,
      },

      // 栄養（dataset_ingredients から計算）
      calories_kcal: Math.round(mealNutrition.calories_kcal),
      protein_g: Math.round(mealNutrition.protein_g * 10) / 10,
      fat_g: Math.round(mealNutrition.fat_g * 10) / 10,
      carbs_g: Math.round(mealNutrition.carbs_g * 10) / 10,
      sodium_g: Math.round(mealNutrition.sodium_g * 10) / 10,
      sugar_g: null, // dataset_ingredients に糖質がないため
      fiber_g: Math.round(mealNutrition.fiber_g * 10) / 10,
      fiber_soluble_g: null,
      fiber_insoluble_g: null,
      potassium_mg: Math.round(mealNutrition.potassium_mg),
      calcium_mg: Math.round(mealNutrition.calcium_mg),
      magnesium_mg: null,
      phosphorus_mg: Math.round(mealNutrition.phosphorus_mg),
      iron_mg: Math.round(mealNutrition.iron_mg * 10) / 10,
      zinc_mg: Math.round(mealNutrition.zinc_mg * 10) / 10,
      iodine_ug: Math.round(mealNutrition.iodine_ug),
      cholesterol_mg: Math.round(mealNutrition.cholesterol_mg),
      vitamin_b1_mg: Math.round(mealNutrition.vitamin_b1_mg * 100) / 100,
      vitamin_b2_mg: Math.round(mealNutrition.vitamin_b2_mg * 100) / 100,
      vitamin_c_mg: Math.round(mealNutrition.vitamin_c_mg),
      vitamin_b6_mg: Math.round(mealNutrition.vitamin_b6_mg * 100) / 100,
      vitamin_b12_ug: Math.round(mealNutrition.vitamin_b12_ug * 10) / 10,
      folic_acid_ug: Math.round(mealNutrition.folic_acid_ug),
      vitamin_a_ug: Math.round(mealNutrition.vitamin_a_ug),
      vitamin_d_ug: Math.round(mealNutrition.vitamin_d_ug * 10) / 10,
      vitamin_k_ug: Math.round(mealNutrition.vitamin_k_ug),
      vitamin_e_mg: Math.round(mealNutrition.vitamin_e_mg * 10) / 10,
      saturated_fat_g: null,
      monounsaturated_fat_g: null,
      polyunsaturated_fat_g: null,
    };

    const { error: updErr } = await supabase.from("planned_meals").update(mealData).eq("id", mealId);
    if (updErr) throw new Error(`Failed to update planned_meal: ${updErr.message}`);
    phaseStart = logPhase("7_db_save", phaseStart);

    if (requestId) {
      const resultJson = {
        mealType,
        generated_dishes: generatedMeal.dishes.map(d => d.name),
        advice: generatedMeal.advice,
        _meta: {
          generator: "regenerate-meal-direct-v2",
          generation_mode: "derived",
          dataset_version: datasetVersion,
          search_query_base: String(baseQuery).slice(0, 1200),
          user_context: userContextForLog,
          constraints: (userContextForLog as any)?.weekly?.constraints ?? null,
          allergy_tokens: allergyTokens.slice(0, 30),
          previous_dish_name: currentDishName,
          reference_menu_count: candidates.length,
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
    logPhase("8_complete_update", phaseStart);
    console.log(`[END] regenerate-meal-direct-v2 total=${Date.now() - totalStart}ms`);

    // 新方式の戻り値
    const dummySelection: RegenerateV2Selection = {
      mealType,
      source_menu_set_external_id: "generated",
      advice: generatedMeal.advice,
    };
    return { selection: dummySelection, datasetVersion, plannedMealId: mealId };
  } catch (error: any) {
    console.error("❌ regenerateMealV2BackgroundTask failed:", error?.message ?? error);

    // 失敗時: weekly_menu_requests を failed に更新
    // is_generating フラグは使用しないので、クリアは不要
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
