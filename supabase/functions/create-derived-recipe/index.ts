import { createClient } from "jsr:@supabase/supabase-js@2";
import { Agent, type AgentInputItem, Runner } from "npm:@openai/agents";
import { withOpenAIUsageContext, generateExecutionId } from "../_shared/llm-usage.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type CreateDerivedRecipeRequest = {
  // 派生料理名（例: 麻婆茄子）
  name: string;
  // ベースとなる dataset_recipes.external_id（例: web-scraper-order）
  base_recipe_external_id: string;
  // 追加指示（例: 茄子で、辛さ控えめ、減塩）
  note?: string | null;
  // 生成者（ユーザーID）。未指定可（バッチや内部生成）
  user_id?: string | null;
  // どの献立から派生したか（任意）
  derived_from_menu_set_external_id?: string | null;
  // 生成時のdataset_version（planned_meals.source_dataset_version と合わせる用）
  source_dataset_version?: string | null;
  // 1食分の想定（基本は1）
  servings?: number;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth) return null;
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return auth.trim();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeDishNameJs(name: string): string {
  // 既存の normalize_dish_name と同等（括弧内は落とす）
  return String(name ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

function normalizeIngredientNameJs(name: string): string {
  // dataset_ingredients 側の正規化に合わせる（括弧の中身は残し、括弧文字だけ落とす）
  return String(name ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[（）()]/g, "")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

function simplifyIngredientQuery(raw: string): string {
  // 料理指示や括弧注釈を落として「食材名」だけに近づける
  let s = String(raw ?? "").trim();
  // 括弧は中身ごと削除（検索の主軸は括弧外）
  s = s.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "");
  // よくある調理表現を削除
  s = s
    .replace(/みじん切り|小口切り|輪切り|薄切り|角切り|乱切り|千切り|短冊切り|さいの目切り/g, "")
    .replace(/すりおろし|おろし|刻み|みじん|仕上げ|炒め用|煮汁|溶き用|とろみ用/g, "")
    .replace(/減塩推奨|減塩|推奨/g, "")
    .replace(/植物油/g, "")
    .trim();

  // 記号など
  s = s.replace(/[・･、,]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

function extractParenContents(raw: string): string[] {
  const s = String(raw ?? "");
  const out: string[] = [];
  for (const m of s.matchAll(/（([^）]+)）/g)) out.push(String(m[1] ?? "").trim());
  for (const m of s.matchAll(/\(([^)]+)\)/g)) out.push(String(m[1] ?? "").trim());
  return out.filter(Boolean);
}

function buildIngredientSearchVariants(raw: string): string[] {
  const variants = new Set<string>();
  const original = String(raw ?? "").trim();
  if (original) variants.add(original);

  const simplified = simplifyIngredientQuery(original);
  if (simplified) variants.add(simplified);

  const noParens = String(original)
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
  if (noParens) variants.add(noParens);

  // 括弧内が「別名（なす）」のような短い同義語っぽい場合のみ採用
  for (const inside of extractParenContents(original)) {
    const t = inside.trim();
    if (!t) continue;
    if (t.length > 10) continue;
    // 調理表現は除外
    if (/(切り|すり|おろし|用|仕上げ|炒め|煮汁|溶き)/.test(t)) continue;
    variants.add(t);
  }

  // 表記ゆれ（漢字→かな等）の簡易辞書
  const aliasRules: Array<[RegExp, string]> = [
    [/茄子/g, "なす"],
    [/葱/g, "ねぎ"],
    [/長ねぎ/g, "ねぎ"],
    [/長ネギ/g, "ねぎ"],
    [/豚/g, "ぶた"],
    [/鶏/g, "とり"],
    [/牛/g, "うし"],
    [/醤油/g, "しょうゆ"],
    [/胡麻油/g, "ごま油"],
  ];
  for (const v of Array.from(variants)) {
    let a = v;
    for (const [re, rep] of aliasRules) a = a.replace(re, rep);
    if (a && a !== v) variants.add(a);
  }

  // 最後にもう一段だけ正規化して重複除去
  const cleaned = Array.from(variants)
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.replace(/[　]+/g, " "))
    .filter(Boolean);
  return Array.from(new Set(cleaned));
}

function pickBestQueryVariant(variants: string[]): string {
  // できれば「ひらがな/カタカナだけ」の短い同義語（例: なす, ねぎ）を優先
  const kana = variants.find((v) => /^[ぁ-んー]+$/.test(v) || /^[ァ-ヶー]+$/.test(v));
  if (kana) return kana;

  // 肉/魚などはDB側が「ぶた/うし/とり」表記のことが多いので、それを含む候補を優先
  for (const term of ["ぶた", "うし", "とり"]) {
    const hit = variants
      .filter((v) => v.includes(term))
      .sort((a, b) => a.length - b.length)[0];
    if (hit) return hit;
  }

  // 次にノイズが少ない短いもの
  const sorted = [...variants].sort((a, b) => a.length - b.length);
  return sorted[0] ?? "";
}

function isWaterishIngredient(raw: string): boolean {
  const n = normalizeIngredientNameJs(raw);
  if (!n) return false;
  if (n === "水" || n === "お湯" || n === "湯" || n === "熱湯") return true;
  // 「水（煮汁）」「水（片栗粉溶き用）」など
  if (n.startsWith("水")) return true;
  return false;
}

function passesKeywordConstraints(query: string, candidateNameNorm: string): boolean {
  const q = normalizeIngredientNameJs(query);
  const c = String(candidateNameNorm ?? "").toLowerCase();

  const requireAny = (alts: string[]) => alts.some((a) => c.includes(a));

  if (q.includes("豚") || q.includes("ぶた")) {
    if (!requireAny(["豚", "ぶた"])) return false;
  }
  if (q.includes("牛") || q.includes("うし")) {
    if (!requireAny(["牛", "うし"])) return false;
  }
  if (q.includes("鶏") || q.includes("とり")) {
    if (!requireAny(["鶏", "とり"])) return false;
  }
  if (q.includes("油")) {
    if (!c.includes("油")) return false;
  }
  if (q.includes("なす") || q.includes("茄子")) {
    if (!requireAny(["なす", "茄子"])) return false;
  }
  if (q.includes("ねぎ") || q.includes("葱") || q.includes("ネギ")) {
    if (!requireAny(["ねぎ", "葱", "ネギ"])) return false;
  }
  if (q.includes("しょうゆ") || q.includes("醤油")) {
    if (!requireAny(["しょうゆ", "醤油"])) return false;
  }
  if (q.includes("ごま油") || q.includes("胡麻油")) {
    if (!requireAny(["ごま油", "胡麻油", "ゴマ油"])) return false;
  }
  return true;
}

function stripMarkdownCodeBlock(text: string): string {
  let cleaned = String(text ?? "").trim();
  const m = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m?.[1]) cleaned = m[1].trim();
  return cleaned;
}

function safeJsonParse(text: string): any {
  const cleaned = stripMarkdownCodeBlock(String(text ?? ""));
  try {
    return JSON.parse(cleaned);
  } catch {
    // JSONっぽい部分だけ抜く
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m?.[0]) return JSON.parse(m[0]);
    throw new Error("JSON parse failed");
  }
}

function truncateForPrompt(text: string | null | undefined, maxChars: number): string {
  const s = String(text ?? "").trim();
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "\n...(truncated)...";
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { label?: string; retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const label = opts.label ?? "op";
  const retries = opts.retries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 800;

  let lastErr: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const status = e?.status ?? e?.response?.status ?? e?.cause?.status;
      const retryable = status === 429 || (typeof status === "number" && status >= 500 && status <= 599);
      if (!retryable || attempt === retries) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.log(`⏳ ${label} retry in ${delay}ms (attempt ${attempt + 1}/${retries}) status=${status}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function embedTexts(texts: string[], dimensions = 384): Promise<number[][]> {
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
          input: texts,
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

  const data = res?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(`Embeddings API returned invalid data length: ${Array.isArray(data) ? data.length : "null"}`);
  }
  const embeddings = data.map((d: any) => d?.embedding);
  if (!embeddings.every((e: any) => Array.isArray(e) && e.length === dimensions)) {
    throw new Error("Embeddings API returned invalid embedding vectors");
  }
  return embeddings as number[][];
}

async function agentJson(userPrompt: string): Promise<any> {
  const systemPrompt =
    `あなたは日本の国家資格「管理栄養士」兼 レシピ開発者です。\n` +
    `目的: ベースレシピを参考に、指示（減塩/油控えめ/辛さ等）を満たしつつ、家庭で再現できる「派生料理」を作ります。\n` +
    `\n` +
    `【絶対ルール】\n` +
    `- 出力は **厳密なJSONのみ**（Markdown/説明文/コードブロック禁止）\n` +
    `- JSONはスキーマ通り。余計なキーを追加しない\n` +
    `- ingredients[].amount_g は必ず g 単位。大さじ/小さじ/個/本などは料理として自然なgに換算\n` +
    `- ingredients[].name は **食材名のみ**（括弧・分量・用途・状態・ブランド名を入れない）\n` +
    `  - 例: 「なす」「豚ひき肉」「長ねぎ」「ごま油」\n` +
    `  - 切り方/用途/補足は ingredients[].note に書く\n` +
    `- 現実的な家庭料理として破綻しない分量・手順にする（極端な量、特殊機材前提は避ける）\n` +
    `\n` +
    `【管理栄養士としての配慮】\n` +
    `- 減塩指示がある場合は、塩・醤油・味噌・中華だし・オイスターソース等を控えめにし、香味野菜/酢/柑橘/香辛料/だしで満足感を補う\n` +
    `- 油控えめ指示がある場合は、油の量を抑え、焼き/蒸し/茹で/レンジ等で調理する\n` +
    `- たんぱく源（肉/魚/卵/大豆）と野菜のバランスを意識し、野菜が少なければ増やす提案を入れる\n` +
    `\n` +
    `【安全】\n` +
    `- 火入れ/衛生の注意（中心温度、加熱不足回避）を踏まえた手順にする\n`;

  const agent = new Agent({
    name: "derived-recipe-generator",
    instructions: systemPrompt,
    model: "gpt-5-mini",
    modelSettings: { reasoningEffort: "minimal" },
    tools: [],
  });

  const conversationHistory: AgentInputItem[] = [
    { role: "user", content: [{ type: "input_text", text: userPrompt }] },
  ];

  const runner = new Runner({
    traceMetadata: {
      __trace_source__: "create-derived-recipe",
      workflow_id: "wf_create_derived_recipe",
    },
  });

  const result = await runner.run(agent, conversationHistory);

  let outputText = "";
  if (!result.finalOutput) {
    const lastAssistantItem = result.newItems.find((item) =>
      item.rawItem.role === "assistant" && item.rawItem.content
    );
    if (lastAssistantItem && Array.isArray(lastAssistantItem.rawItem.content)) {
      const textContent = lastAssistantItem.rawItem.content.find((c: any) => c.type === "output_text" || c.type === "text");
      if (textContent && (textContent as any).text) outputText = String((textContent as any).text);
    }
  } else if (typeof result.finalOutput === "object") {
    outputText = JSON.stringify(result.finalOutput);
  } else {
    outputText = String(result.finalOutput);
  }

  if (!outputText.trim()) throw new Error("LLM output is empty");
  return safeJsonParse(outputText);
}

type LlmDerivedRecipe = {
  name: string;
  servings?: number;
  ingredients: Array<{
    name: string;
    amount_g: number;
    note?: string | null;
  }>;
  instructions?: string[];
};

type IngredientMatch = {
  input_name: string;
  input_name_norm: string;
  search_variants: string[];
  search_query: string;
  amount_g: number;
  skip: boolean;
  matched: null | {
    id: string;
    name: string;
    name_norm: string;
    similarity: number | null;
    method: "exact" | "trgm" | "embedding";
    calories_kcal: number | null;
    protein_g: number | null;
    fat_g: number | null;
    carbs_g: number | null;
    fiber_g: number | null;
    salt_eq_g: number | null;
    potassium_mg: number | null;
    calcium_mg: number | null;
    phosphorus_mg: number | null;
    iron_mg: number | null;
    zinc_mg: number | null;
    iodine_ug: number | null;
    cholesterol_mg: number | null;
    vitamin_b1_mg: number | null;
    vitamin_b2_mg: number | null;
    vitamin_b6_mg: number | null;
    vitamin_b12_ug: number | null;
    folic_acid_ug: number | null;
    vitamin_c_mg: number | null;
    vitamin_a_ug: number | null;
    vitamin_d_ug: number | null;
    vitamin_k_ug: number | null;
    vitamin_e_alpha_mg: number | null;
  };
  note?: string | null;
};

type NutritionTotals = {
  calories_kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number;
  sugar_g: number; // 今回は0（食材DBに糖質が無い/定義が複雑なので後回し）
  sodium_g: number; // 食塩相当量(g)
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

function addScaled(totals: NutritionTotals, m: IngredientMatch["matched"], amount_g: number) {
  if (!m) return;
  const f = amount_g / 100.0;
  const add = (key: keyof NutritionTotals, v: number | null | undefined) => {
    if (v == null) return;
    // @ts-ignore
    totals[key] += v * f;
  };

  add("calories_kcal", m.calories_kcal);
  add("protein_g", m.protein_g);
  add("fat_g", m.fat_g);
  add("carbs_g", m.carbs_g);
  add("fiber_g", m.fiber_g);
  add("sodium_g", m.salt_eq_g);

  add("potassium_mg", m.potassium_mg);
  add("calcium_mg", m.calcium_mg);
  add("phosphorus_mg", m.phosphorus_mg);
  add("iron_mg", m.iron_mg);
  add("zinc_mg", m.zinc_mg);
  add("iodine_ug", m.iodine_ug);
  add("cholesterol_mg", m.cholesterol_mg);

  add("vitamin_b1_mg", m.vitamin_b1_mg);
  add("vitamin_b2_mg", m.vitamin_b2_mg);
  add("vitamin_b6_mg", m.vitamin_b6_mg);
  add("vitamin_b12_ug", m.vitamin_b12_ug);
  add("folic_acid_ug", m.folic_acid_ug);
  add("vitamin_c_mg", m.vitamin_c_mg);
  add("vitamin_a_ug", m.vitamin_a_ug);
  add("vitamin_d_ug", m.vitamin_d_ug);
  add("vitamin_k_ug", m.vitamin_k_ug);

  // vitamin_e: dataset_ingredients は alpha/beta/gamma/delta を持つが、derived_recipes は合算を入れる
  if (m.vitamin_e_alpha_mg != null) totals.vitamin_e_mg += m.vitamin_e_alpha_mg * f;
}

function emptyTotals(): NutritionTotals {
  return {
    calories_kcal: 0,
    protein_g: 0,
    fat_g: 0,
    carbs_g: 0,
    fiber_g: 0,
    sugar_g: 0,
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // service_role JWT only
  const token = getBearerToken(req);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const payload = decodeJwtPayload(token);
  const role = String(payload?.role ?? "");
  if (role !== "service_role") return jsonResponse({ error: "unauthorized" }, 401);

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const startedAt = Date.now();

  const body: CreateDerivedRecipeRequest = await req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  const baseRecipeExternalId = String(body?.base_recipe_external_id ?? "").trim();
  const note = body?.note ?? null;
  const userId = body?.user_id ?? null;
  const derivedFromMenuSetExternalId = body?.derived_from_menu_set_external_id ?? null;
  const sourceDatasetVersion = body?.source_dataset_version ?? null;
  const servings = clampInt(Number(body?.servings ?? 1), 1, 12);

  if (!name || !baseRecipeExternalId) {
    return jsonResponse({ error: "name and base_recipe_external_id are required" }, 400);
  }

  // LLMトークン使用量計測
  const executionId = generateExecutionId();

  try {
    // withOpenAIUsageContextで全体をラップ（agentJson, embedTexts呼び出しを計測）
    return await withOpenAIUsageContext({
      functionName: "create-derived-recipe",
      executionId,
      userId: userId ?? undefined,
      supabaseClient: supabaseAdmin,
    }, async () => {
      // 1) base recipe
      const { data: baseRecipe, error: baseErr } = await supabaseAdmin
      .from("dataset_recipes")
      .select("id, external_id, name, ingredients_text, instructions_text")
      .eq("external_id", baseRecipeExternalId)
      .maybeSingle();
    if (baseErr) throw new Error(`Failed to fetch base recipe: ${baseErr.message}`);
    if (!baseRecipe?.id) throw new Error(`Base recipe not found: ${baseRecipeExternalId}`);

    // 2) LLM -> structured ingredients (g) + instructions
    const prompt =
      `以下の「ベースレシピ」を参考に、派生料理を作ってください。\n` +
      `必ず材料は「g単位」に換算してください（大さじ/小さじ/本/個/枚 などは料理として自然なgに換算）。\n` +
      `ingredients[].name は「食材名のみ」にしてください（例: なす / 長ねぎ / 豚ひき肉 / ごま油）。切り方・用途・補足は ingredients[].note に書き、括弧で別名/説明を足さないでください。\n` +
      `出力はJSONのみ。\n\n` +
      `【派生料理名】\n${name}\n\n` +
      `${note ? `【追加指示】\n${note}\n\n` : ""}` +
      `【ベースレシピ名】\n${baseRecipe.name}\n\n` +
      `【ベース材料（1人分・抜粋）】\n${truncateForPrompt(baseRecipe.ingredients_text, 1200)}\n\n` +
      `【ベース作り方（抜粋）】\n${truncateForPrompt(baseRecipe.instructions_text, 1200)}\n\n` +
      `出力JSONスキーマ:\n` +
      `{\n` +
      `  "name": "料理名（${name}）",\n` +
      `  "servings": ${servings},\n` +
      `  "ingredients": [\n` +
      `    { "name": "食材名", "amount_g": 0, "note": "任意" }\n` +
      `  ],\n` +
      `  "instructions": ["手順1", "手順2", "..."]\n` +
      `}\n`;

    const llmOut = (await agentJson(prompt)) as LlmDerivedRecipe;
    const llmName = String(llmOut?.name ?? "").trim() || name;
    const llmIngredients = Array.isArray(llmOut?.ingredients) ? llmOut.ingredients : [];
    const llmInstructions = Array.isArray(llmOut?.instructions) ? llmOut.instructions.map((s) => String(s).trim()).filter(Boolean) : [];

    if (llmIngredients.length === 0) {
      throw new Error("LLM returned no ingredients");
    }

    const normalizedIngredients = llmIngredients
      .map((i) => ({
        name: String(i?.name ?? "").trim(),
        amount_g: Number(i?.amount_g ?? 0),
        note: i?.note == null ? null : String(i.note).trim(),
      }))
      .filter((i) => i.name && Number.isFinite(i.amount_g) && i.amount_g > 0);

    if (normalizedIngredients.length === 0) {
      throw new Error("No valid ingredients after normalization (name + amount_g required)");
    }

    // 3) ingredient matching (exact -> trgm -> embedding)
    const matches: IngredientMatch[] = normalizedIngredients.map((i) => {
      const variants = buildIngredientSearchVariants(i.name);
      const query = pickBestQueryVariant(variants);
      return {
        input_name: i.name,
        input_name_norm: normalizeIngredientNameJs(i.name),
        search_variants: variants,
        search_query: query || i.name,
        amount_g: i.amount_g,
        skip: isWaterishIngredient(i.name),
        matched: null,
        note: i.note ?? null,
      };
    });

    // 3-1 exact by name_norm (batch)
    const norms = Array.from(
      new Set(
        matches
          .filter((m) => !m.skip)
          .flatMap((m) => m.search_variants.map((v) => normalizeIngredientNameJs(v))),
      ),
    ).filter(Boolean);
    const { data: exactRows, error: exactErr } = await supabaseAdmin
      .from("dataset_ingredients")
      .select(
        "id,name,name_norm,calories_kcal,protein_g,fat_g,carbs_g,fiber_g,salt_eq_g,potassium_mg,calcium_mg,phosphorus_mg,iron_mg,zinc_mg,iodine_ug,cholesterol_mg,vitamin_b1_mg,vitamin_b2_mg,vitamin_b6_mg,vitamin_b12_ug,folic_acid_ug,vitamin_c_mg,vitamin_a_ug,vitamin_d_ug,vitamin_k_ug,vitamin_e_alpha_mg",
      )
      .in("name_norm", norms);
    if (exactErr) throw new Error(`Failed to fetch exact ingredients: ${exactErr.message}`);

    const exactByNorm = new Map<string, any>((exactRows ?? []).map((r: any) => [String(r.name_norm), r]));
    for (const m of matches) {
      if (m.skip) continue;
      for (const v of m.search_variants) {
        const norm = normalizeIngredientNameJs(v);
        const row = exactByNorm.get(norm);
        if (!row) continue;
        m.matched = {
          id: row.id,
          name: row.name,
          name_norm: row.name_norm,
          similarity: 1,
          method: "exact",
          calories_kcal: row.calories_kcal ?? null,
          protein_g: row.protein_g ?? null,
          fat_g: row.fat_g ?? null,
          carbs_g: row.carbs_g ?? null,
          fiber_g: row.fiber_g ?? null,
          salt_eq_g: row.salt_eq_g ?? null,
          potassium_mg: row.potassium_mg ?? null,
          calcium_mg: row.calcium_mg ?? null,
          phosphorus_mg: row.phosphorus_mg ?? null,
          iron_mg: row.iron_mg ?? null,
          zinc_mg: row.zinc_mg ?? null,
          iodine_ug: row.iodine_ug ?? null,
          cholesterol_mg: row.cholesterol_mg ?? null,
          vitamin_b1_mg: row.vitamin_b1_mg ?? null,
          vitamin_b2_mg: row.vitamin_b2_mg ?? null,
          vitamin_b6_mg: row.vitamin_b6_mg ?? null,
          vitamin_b12_ug: row.vitamin_b12_ug ?? null,
          folic_acid_ug: row.folic_acid_ug ?? null,
          vitamin_c_mg: row.vitamin_c_mg ?? null,
          vitamin_a_ug: row.vitamin_a_ug ?? null,
          vitamin_d_ug: row.vitamin_d_ug ?? null,
          vitamin_k_ug: row.vitamin_k_ug ?? null,
          vitamin_e_alpha_mg: row.vitamin_e_alpha_mg ?? null,
        };
        break;
      }
    }

    // 3-2 trgm for unresolved
    for (const m of matches.filter((x) => !x.matched && !x.skip)) {
      const { data: sims, error: simErr } = await supabaseAdmin.rpc("search_similar_dataset_ingredients", {
        query_name: m.search_query,
        similarity_threshold: 0.15,
        result_limit: 12,
      });
      if (simErr) continue;
      const candidates = Array.isArray(sims) ? sims : [];
      const best = candidates
        .filter((c: any) =>
          c?.id && passesKeywordConstraints(m.search_query, normalizeIngredientNameJs(String(c?.name ?? "")))
        )
        .sort((a: any, b: any) => Number(b?.similarity ?? 0) - Number(a?.similarity ?? 0))[0] ?? null;
      if (!best?.id) continue;

      const { data: row, error: rowErr } = await supabaseAdmin
        .from("dataset_ingredients")
        .select(
          "id,name,name_norm,calories_kcal,protein_g,fat_g,carbs_g,fiber_g,salt_eq_g,potassium_mg,calcium_mg,phosphorus_mg,iron_mg,zinc_mg,iodine_ug,cholesterol_mg,vitamin_b1_mg,vitamin_b2_mg,vitamin_b6_mg,vitamin_b12_ug,folic_acid_ug,vitamin_c_mg,vitamin_a_ug,vitamin_d_ug,vitamin_k_ug,vitamin_e_alpha_mg",
        )
        .eq("id", best.id)
        .maybeSingle();
      if (rowErr || !row?.id) continue;

      m.matched = {
        id: row.id,
        name: row.name,
        name_norm: row.name_norm,
        similarity: Number(best.similarity ?? null),
        method: "trgm",
        calories_kcal: row.calories_kcal ?? null,
        protein_g: row.protein_g ?? null,
        fat_g: row.fat_g ?? null,
        carbs_g: row.carbs_g ?? null,
        fiber_g: row.fiber_g ?? null,
        salt_eq_g: row.salt_eq_g ?? null,
        potassium_mg: row.potassium_mg ?? null,
        calcium_mg: row.calcium_mg ?? null,
        phosphorus_mg: row.phosphorus_mg ?? null,
        iron_mg: row.iron_mg ?? null,
        zinc_mg: row.zinc_mg ?? null,
        iodine_ug: row.iodine_ug ?? null,
        cholesterol_mg: row.cholesterol_mg ?? null,
        vitamin_b1_mg: row.vitamin_b1_mg ?? null,
        vitamin_b2_mg: row.vitamin_b2_mg ?? null,
        vitamin_b6_mg: row.vitamin_b6_mg ?? null,
        vitamin_b12_ug: row.vitamin_b12_ug ?? null,
        folic_acid_ug: row.folic_acid_ug ?? null,
        vitamin_c_mg: row.vitamin_c_mg ?? null,
        vitamin_a_ug: row.vitamin_a_ug ?? null,
        vitamin_d_ug: row.vitamin_d_ug ?? null,
        vitamin_k_ug: row.vitamin_k_ug ?? null,
        vitamin_e_alpha_mg: row.vitamin_e_alpha_mg ?? null,
      };
    }

    // 3-3 embedding for unresolved (batch embed)
    const unresolved = matches.filter((x) => !x.matched && !x.skip);
    if (unresolved.length > 0) {
      const qTexts = unresolved.map((u) => u.search_query);
      const qEmbeddings = await embedTexts(qTexts, 384);
      for (let i = 0; i < unresolved.length; i++) {
        const u = unresolved[i];
        const emb = qEmbeddings[i];
        const { data: rows, error: embErr } = await supabaseAdmin.rpc("search_dataset_ingredients_by_embedding", {
          query_embedding: emb,
          match_count: 15,
        });
        if (embErr) continue;
        const candidates = Array.isArray(rows) ? rows : [];
        const best = candidates
          .filter((c: any) =>
            c?.id && passesKeywordConstraints(u.search_query, normalizeIngredientNameJs(String(c?.name ?? "")))
          )
          .sort((a: any, b: any) => Number(b?.similarity ?? 0) - Number(a?.similarity ?? 0))[0] ?? null;
        if (!best?.id) continue;

        // similarityはRPCが返すのでそれを使う（0..1）
        // 低すぎる場合は採用しない（安全策）
        const sim = Number(best.similarity ?? 0);
        if (!Number.isFinite(sim) || sim < 0.72) continue;

        const { data: row, error: rowErr } = await supabaseAdmin
          .from("dataset_ingredients")
          .select(
            "id,name,name_norm,calories_kcal,protein_g,fat_g,carbs_g,fiber_g,salt_eq_g,potassium_mg,calcium_mg,phosphorus_mg,iron_mg,zinc_mg,iodine_ug,cholesterol_mg,vitamin_b1_mg,vitamin_b2_mg,vitamin_b6_mg,vitamin_b12_ug,folic_acid_ug,vitamin_c_mg,vitamin_a_ug,vitamin_d_ug,vitamin_k_ug,vitamin_e_alpha_mg",
          )
          .eq("id", best.id)
          .maybeSingle();
        if (rowErr || !row?.id) continue;

        u.matched = {
          id: row.id,
          name: row.name,
          name_norm: row.name_norm,
          similarity: sim,
          method: "embedding",
          calories_kcal: row.calories_kcal ?? null,
          protein_g: row.protein_g ?? null,
          fat_g: row.fat_g ?? null,
          carbs_g: row.carbs_g ?? null,
          fiber_g: row.fiber_g ?? null,
          salt_eq_g: row.salt_eq_g ?? null,
          potassium_mg: row.potassium_mg ?? null,
          calcium_mg: row.calcium_mg ?? null,
          phosphorus_mg: row.phosphorus_mg ?? null,
          iron_mg: row.iron_mg ?? null,
          zinc_mg: row.zinc_mg ?? null,
          iodine_ug: row.iodine_ug ?? null,
          cholesterol_mg: row.cholesterol_mg ?? null,
          vitamin_b1_mg: row.vitamin_b1_mg ?? null,
          vitamin_b2_mg: row.vitamin_b2_mg ?? null,
          vitamin_b6_mg: row.vitamin_b6_mg ?? null,
          vitamin_b12_ug: row.vitamin_b12_ug ?? null,
          folic_acid_ug: row.folic_acid_ug ?? null,
          vitamin_c_mg: row.vitamin_c_mg ?? null,
          vitamin_a_ug: row.vitamin_a_ug ?? null,
          vitamin_d_ug: row.vitamin_d_ug ?? null,
          vitamin_k_ug: row.vitamin_k_ug ?? null,
          vitamin_e_alpha_mg: row.vitamin_e_alpha_mg ?? null,
        };
      }
    }

    const totals = emptyTotals();
    for (const m of matches) {
      if (m.skip) continue;
      addScaled(totals, m.matched, m.amount_g);
    }

    const effective = matches.filter((m) => !m.skip);
    const matchedCount = effective.filter((m) => m.matched).length;
    const mappingRate = effective.length > 0 ? matchedCount / effective.length : 1;

    // 4) derived recipe save
    const nameEmbedding = (await embedTexts([llmName], 384))[0];

    const { data: saved, error: saveErr } = await supabaseAdmin
      .from("derived_recipes")
      .insert({
        name: llmName,
        name_norm: normalizeDishNameJs(llmName),
        base_dataset_recipe_id: baseRecipe.id,
        base_dataset_recipe_external_id: baseRecipe.external_id,
        created_by_user_id: userId,
        source_dataset_version: sourceDatasetVersion,
        derived_from_menu_set_external_id: derivedFromMenuSetExternalId,
        generator: "ai",
        generation_metadata: {
          note,
          mapping_rate: mappingRate,
          matched_count: matchedCount,
          total_ingredients: effective.length,
          total_ingredients_including_skipped: matches.length,
          elapsed_ms: Date.now() - startedAt,
          warnings: mappingRate < 0.85 ? ["ingredient_mapping_rate_low"] : [],
        },
        servings,
        ingredients: matches.map((m) => ({
          name: m.input_name,
          name_norm: m.input_name_norm,
          amount_g: m.amount_g,
          note: m.note,
          skip: m.skip,
          matched_ingredient_id: m.matched?.id ?? null,
          matched_name: m.matched?.name ?? null,
          similarity: m.matched?.similarity ?? null,
          method: m.matched?.method ?? null,
        })),
        instructions: llmInstructions.length > 0 ? llmInstructions : null,

        // 栄養（計算値）
        calories_kcal: Math.round(totals.calories_kcal),
        protein_g: totals.protein_g,
        fat_g: totals.fat_g,
        carbs_g: totals.carbs_g,
        sodium_g: totals.sodium_g,
        fiber_g: totals.fiber_g,
        sugar_g: totals.sugar_g,
        potassium_mg: totals.potassium_mg,
        calcium_mg: totals.calcium_mg,
        phosphorus_mg: totals.phosphorus_mg,
        iron_mg: totals.iron_mg,
        zinc_mg: totals.zinc_mg,
        iodine_ug: totals.iodine_ug,
        cholesterol_mg: totals.cholesterol_mg,
        vitamin_b1_mg: totals.vitamin_b1_mg,
        vitamin_b2_mg: totals.vitamin_b2_mg,
        vitamin_c_mg: totals.vitamin_c_mg,
        vitamin_b6_mg: totals.vitamin_b6_mg,
        vitamin_b12_ug: totals.vitamin_b12_ug,
        folic_acid_ug: totals.folic_acid_ug,
        vitamin_a_ug: totals.vitamin_a_ug,
        vitamin_d_ug: totals.vitamin_d_ug,
        vitamin_k_ug: totals.vitamin_k_ug,
        vitamin_e_mg: totals.vitamin_e_mg,

        name_embedding: nameEmbedding,
      })
      .select("id,name,base_dataset_recipe_external_id,calories_kcal,protein_g,fat_g,carbs_g,sodium_g,fiber_g,generation_metadata,created_at")
      .single();
    if (saveErr) throw new Error(`Failed to insert derived_recipes: ${saveErr.message}`);

      return jsonResponse({
        ok: true,
        derived_recipe: saved,
        mapping_rate: mappingRate,
        ingredient_matches: matches,
        nutrition_totals: totals,
        elapsed_ms: Date.now() - startedAt,
      });
    }); // withOpenAIUsageContext end
  } catch (e: any) {
    console.error("❌ create-derived-recipe failed:", e?.message ?? e);
    return jsonResponse({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});


