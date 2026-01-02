import { createClient } from "jsr:@supabase/supabase-js@2";
import { Agent, type AgentInputItem, Runner } from "@openai/agents";
import { z } from "zod";
import { buildSearchQueryBase, buildUserContextForPrompt, buildUserSummary } from "../_shared/user-context.ts";
import { 
  calculateNutritionFromIngredients, 
  emptyNutrition, 
  type NutritionTotals 
} from "../_shared/nutrition-calculator.ts";
import { createLogger, generateRequestId } from "../_shared/db-logger.ts";

console.log("Regenerate Meal Direct v3 Function loaded (3-Step Mode)");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// =========================================================
// Types / Schemas
// =========================================================

const ALLOWED_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "midnight_snack"] as const;
type MealType = (typeof ALLOWED_MEAL_TYPES)[number];

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

function pickCandidatesForMealType(mealType: MealType, all: MenuSetCandidate[]): MenuSetCandidate[] {
  const mapped = mapMealTypeForDataset(mealType);
  const minDishCount = (mealType === "lunch" || mealType === "dinner") ? 3 : 2;
  let typed = all.filter((c) => c.meal_type_hint === mapped);
  
  const richDish = typed.filter((c) => getDishCount(c) >= minDishCount);
  const mediumDish = typed.filter((c) => getDishCount(c) >= 2 && getDishCount(c) < minDishCount);
  const singleDish = typed.filter((c) => getDishCount(c) < 2);
  typed = [...richDish, ...mediumDish, ...singleDish];
  
  if (typed.length >= 10) return typed.slice(0, 80);
  const seen = new Set(typed.map((c) => c.external_id));
  const fallback = all.filter((c) => !seen.has(c.external_id));
  return typed.concat(fallback).slice(0, 80);
}

// =========================================================
// 進捗更新
// =========================================================

interface ProgressInfo {
  phase: string;
  message: string;
  percentage: number;
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
    await supabase
      .from("weekly_menu_requests")
      .update(updateData)
      .eq("id", requestId);
  } catch (e) {
    console.error("Failed to update progress:", e);
  }
}

// =========================================================
// 次のステップをトリガー
// =========================================================

async function triggerNextStep(
  supabaseUrl: string,
  supabaseServiceKey: string,
  requestId: string,
  userId: string,
  mealId: string,
  note: string | null,
) {
  console.log("🔄 Triggering next step...");
  
  const url = `${supabaseUrl}/functions/v1/regenerate-meal-direct-v3`;
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        requestId: requestId,
        mealId: mealId,
        userId: userId,
        note: note,
        _continue: true,
      }),
    });
    console.log(`✅ Next step triggered: ${res.status}`);
  } catch (e) {
    console.error("❌ Failed to trigger next step:", e);
  }
}

// =========================================================
// LLM: 料理を「創造」する
// =========================================================

async function runAgentToGenerateMeal(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  mealType: MealType;
  currentDishName: string | null;
  referenceMenus: MenuSetCandidate[];
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
    `- instructions は手順ごとに分割し、番号なしで配列に入れる\n` +
    `- アレルギー/禁忌食材は絶対に使わない\n` +
    `\n` +
    `【献立の構成】\n` +
    `- 昼食・夕食は「1汁3菜」を基本（主菜 + 副菜 + 汁物 + ご飯など、3〜4品）\n` +
    `- 朝食は2品以上（主食 + 汁物 or おかず）\n` +
    `- 間食/夜食は1〜2品\n` +
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
    `上記を参考に、${mealTypeJa}の献立を創造してください。`;

  const agent = new Agent({
    name: "meal-creator-v3",
    instructions: systemPrompt,
    model: "gpt-5-mini",
    tools: [],
  });

  const conversationHistory: AgentInputItem[] = [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }];
  const runner = new Runner({});

  const result = await runner.run(agent, conversationHistory);
  const out = result.finalOutput ? String(result.finalOutput) : "";
  if (!out) throw new Error("LLM output is empty");
  const parsed = safeJsonParse(out);
  return GeneratedMealSchema.parse(parsed);
}

// =========================================================
// Main Handler
// =========================================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("DATASET_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let requestId: string | null = null;
  let userId: string | null = null;

  try {
    const body = await req.json();
    requestId = body.requestId ?? null;
    const mealId = String(body.mealId ?? "").trim();
    const note = body.note ?? body.prompt ?? null;
    const authHeader = req.headers.get("Authorization") ?? "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    const isContinue = body._continue === true;

    if (!accessToken) throw new Error("Missing access token");

    if (body.userId) {
      userId = body.userId;
    } else {
      const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
      if (userErr || !userData?.user) throw new Error(`Auth failed: ${userErr?.message ?? "no user"}`);
      userId = userData.user.id;
    }

    if (!mealId) throw new Error("mealId is required");

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

    // バックグラウンドタスク
    const wrappedBackgroundTask = async () => {
      console.log(`🚀 Step ${currentStep} starting...`);
      try {
        await executeStep(supabase, supabaseUrl, supabaseServiceKey, userId!, requestId, mealId, note, currentStep);
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
        JSON.stringify({ status: "processing", request_id: requestId, step: currentStep }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      await wrappedBackgroundTask();
      return new Response(
        JSON.stringify({ status: "completed", request_id: requestId }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (err: any) {
    console.error("Request error:", err);
    if (requestId) {
      await supabase
        .from("weekly_menu_requests")
        .update({ status: "failed", error_message: err.message, updated_at: new Date().toISOString() })
        .eq("id", requestId);
    }
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// =========================================================
// ステップ実行
// =========================================================

async function executeStep(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string | null,
  mealId: string,
  note: string | null,
  currentStep: number,
) {
  switch (currentStep) {
    case 1:
      await executeStep1_Generate(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, mealId, note);
      break;
    case 2:
      await executeStep2_Nutrition(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, mealId, note);
      break;
    case 3:
      await executeStep3_Save(supabase, userId, requestId, mealId);
      break;
    default:
      throw new Error(`Unknown step: ${currentStep}`);
  }
}

// =========================================================
// Step 1: 生成
// =========================================================

async function executeStep1_Generate(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string | null,
  mealId: string,
  note: string | null,
) {
  console.log("📝 Step 1: Generating replacement meal...");
  
  await updateProgress(supabase, requestId, {
    phase: "user_context",
    message: "ユーザー情報を取得中...",
    percentage: 10,
  }, 1);

  // 既存の献立を取得
  const { data: existingMeal, error: mealErr } = await supabase
    .from("planned_meals")
    .select("id, meal_type, dish_name, meal_plan_day_id, meal_plan_days!inner(day_date, meal_plans!inner(user_id))")
    .eq("id", mealId)
    .eq("meal_plan_days.meal_plans.user_id", userId)
    .single();
  if (mealErr) throw new Error(`Meal not found or unauthorized: ${mealErr.message}`);

  const mealType = String((existingMeal as any).meal_type ?? "").trim() as MealType;
  const currentDishName = (existingMeal as any).dish_name ?? null;

  // ユーザー情報取得
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  
  const { data: allergies } = await supabase
    .from("user_allergies")
    .select("*")
    .eq("user_id", userId);
  
  const { data: nutritionGoals } = await supabase
    .from("nutrition_goals")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  const userContext = buildUserContextForPrompt({
    profile: profile ?? null,
    allergies: allergies ?? [],
    nutritionGoals: nutritionGoals ?? null,
    healthRecords: [],
    medications: [],
    pregnancyInfo: null,
  });
  const userSummary = buildUserSummary(userContext);

  await updateProgress(supabase, requestId, {
    phase: "search_references",
    message: "参考レシピを検索中...",
    percentage: 20,
  });

  // 参考候補検索
  const ja = mealType === "breakfast" ? "朝食" : mealType === "lunch" ? "昼食" : mealType === "dinner" ? "夕食" : "間食";
  const baseQuery = buildSearchQueryBase(userContext);
  const raw = await searchMenuCandidates(supabase, `${ja}\n${baseQuery}`, 150);
  const candidates = pickCandidatesForMealType(mealType, raw);

  await updateProgress(supabase, requestId, {
    phase: "generating",
    message: "AIが新しい献立を作成中...",
    percentage: 30,
  });

  // LLMで生成
  const generatedMeal = await runAgentToGenerateMeal({
    userSummary,
    userContext,
    note,
    mealType,
    currentDishName,
    referenceMenus: candidates,
  });

  console.log("✅ Step 1: Meal generated");

  // 生成データを保存
  const generatedData = {
    generatedMeal: generatedMeal,
    mealId: mealId,
    mealType: mealType,
    mealPlanDayId: (existingMeal as any).meal_plan_day_id,
    currentDishName: currentDishName,
  };

  await supabase
    .from("weekly_menu_requests")
    .update({
      generated_data: generatedData,
      current_step: 2,
      progress: {
        phase: "step1_complete",
        message: "献立生成完了。栄養計算開始...",
        percentage: 50,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  // 次のステップをトリガー
  await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId!, userId, mealId, note);
}

// =========================================================
// Step 2: 栄養計算
// =========================================================

async function executeStep2_Nutrition(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string | null,
  mealId: string,
  note: string | null,
) {
  console.log("🔢 Step 2: Calculating nutrition...");
  
  // 生成データを取得
  const { data: reqData } = await supabase
    .from("weekly_menu_requests")
    .select("generated_data")
    .eq("id", requestId)
    .single();
  
  if (!reqData?.generated_data) {
    throw new Error("No generated data found for nutrition calculation");
  }
  
  const { generatedMeal } = reqData.generated_data;

  await updateProgress(supabase, requestId, {
    phase: "calculating",
    message: "栄養価を計算中...",
    percentage: 60,
  }, 2);

  // 栄養計算
  const mealNutrition = emptyNutrition();
  for (const dish of generatedMeal.dishes) {
    try {
      const nutrition = await calculateNutritionFromIngredients(supabase, dish.ingredients);
      dish.nutrition = nutrition;
      for (const key of Object.keys(mealNutrition) as (keyof NutritionTotals)[]) {
        mealNutrition[key] += nutrition[key] ?? 0;
      }
    } catch (e) {
      console.warn(`Nutrition calc failed for ${dish.name}:`, e);
      dish.nutrition = emptyNutrition();
    }
  }

  console.log("✅ Step 2: Nutrition calculated");

  // 更新されたデータを保存
  const updatedData = {
    ...reqData.generated_data,
    generatedMeal: generatedMeal,
    mealNutrition: mealNutrition,
  };

  await supabase
    .from("weekly_menu_requests")
    .update({
      generated_data: updatedData,
      current_step: 3,
      progress: {
        phase: "step2_complete",
        message: "栄養計算完了。保存中...",
        percentage: 75,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  // 次のステップをトリガー
  await triggerNextStep(supabaseUrl, supabaseServiceKey, requestId!, userId, mealId, note);
}

// =========================================================
// Step 3: 保存
// =========================================================

async function executeStep3_Save(
  supabase: any,
  userId: string,
  requestId: string | null,
  mealId: string,
) {
  console.log("💾 Step 3: Saving to database...");
  
  // 生成データを取得
  const { data: reqData } = await supabase
    .from("weekly_menu_requests")
    .select("generated_data")
    .eq("id", requestId)
    .single();
  
  if (!reqData?.generated_data) {
    throw new Error("No generated data found for saving");
  }
  
  const { generatedMeal, mealNutrition, mealType } = reqData.generated_data;

  await updateProgress(supabase, requestId, {
    phase: "saving",
    message: "献立を保存中...",
    percentage: 85,
  }, 3);

  // dishDetails を構築
  const dishDetails: any[] = [];
  const aggregatedIngredients: string[] = [];
  
  for (const dish of generatedMeal.dishes) {
    const nutrition = dish.nutrition as NutritionTotals | undefined;
    
    let ingredientsMd = "| 材料 | 分量 |\n|------|------|\n";
    for (const ing of dish.ingredients) {
      ingredientsMd += `| ${ing.name} | ${ing.amount_g}g${ing.note ? ` (${ing.note})` : ""} |\n`;
      aggregatedIngredients.push(`${ing.name} ${ing.amount_g}g`);
    }
    
    const recipeStepsMd = dish.instructions.map((step: string, i: number) => `${i + 1}. ${step}`).join("\n\n");
    
    dishDetails.push({
      name: dish.name,
      role: dish.role,
      cal: Math.round(nutrition?.calories_kcal ?? 0),
      protein: Math.round((nutrition?.protein_g ?? 0) * 10) / 10,
      fat: Math.round((nutrition?.fat_g ?? 0) * 10) / 10,
      carbs: Math.round((nutrition?.carbs_g ?? 0) * 10) / 10,
      fiber: Math.round((nutrition?.fiber_g ?? 0) * 10) / 10,
      sodium: Math.round((nutrition?.sodium_mg ?? 0) / 1000 * 10) / 10,
      ingredient: dish.ingredients.slice(0, 3).map((i: any) => i.name).join("、"),
      ingredients: dish.ingredients.map((i: any) => `${i.name} ${i.amount_g}g`),
      recipeSteps: dish.instructions,
      ingredientsMd,
      recipeStepsMd,
      base_recipe_id: null,
      is_generated_name: true,
    });
  }

  const dishName = dishDetails.map((d) => d.name).join("、");

  // DB更新
  const mealData = {
    dish_name: dishName,
    description: generatedMeal.advice ?? null,
    dishes: dishDetails,
    ingredients: aggregatedIngredients.length > 0 ? aggregatedIngredients : null,
    source_type: "generated",
    generation_metadata: {
      generator: "regenerate-meal-direct-v3",
      mode: "creative",
      generated_at: new Date().toISOString(),
      advice: generatedMeal.advice ?? null,
    },
    calories_kcal: Math.round(mealNutrition.calories_kcal),
    protein_g: Math.round(mealNutrition.protein_g * 10) / 10,
    fat_g: Math.round(mealNutrition.fat_g * 10) / 10,
    carbs_g: Math.round(mealNutrition.carbs_g * 10) / 10,
    fiber_g: Math.round(mealNutrition.fiber_g * 10) / 10,
    sodium_mg: Math.round(mealNutrition.sodium_mg),
    updated_at: new Date().toISOString(),
  };

  const { error: updErr } = await supabase.from("planned_meals").update(mealData).eq("id", mealId);
  if (updErr) throw new Error(`Failed to update planned_meal: ${updErr.message}`);

  console.log("✅ Step 3: Meal saved to database");

  // 完了ステータス更新
  await supabase
    .from("weekly_menu_requests")
    .update({
      status: "completed",
      current_step: 3,
      progress: {
        phase: "completed",
        message: "献立が完成しました！",
        percentage: 100,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  console.log("🎉 Meal regeneration completed!");
}
