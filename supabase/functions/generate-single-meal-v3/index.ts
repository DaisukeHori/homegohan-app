import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildSearchQueryBase, buildUserContextForPrompt, buildUserSummary } from "../_shared/user-context.ts";
import { calculateNutritionFromIngredients, emptyNutrition, type NutritionTotals } from "../_shared/nutrition-calculator.ts";
import { createLogger, generateRequestId } from "../_shared/db-logger.ts";
import {
  generateMealWithLLM,
  type GeneratedMeal,
  type MealType,
  type MenuReference,
} from "../_shared/meal-generator.ts";

console.log("Generate Single Meal v3 Function loaded (3-Step Mode)");

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

const ALLOWED_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "midnight_snack"] as const;

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
          input: text,
          model: "text-embedding-3-small",
          dimensions,
        }),
      });
      if (!r.ok) {
        const err = new Error(`Embedding failed: ${r.statusText}`) as any;
        err.status = r.status;
        throw err;
      }
      return r;
    },
    { retries: 3, label: "embedText" },
  );

  const json = await res.json();
  return json.data?.[0]?.embedding ?? [];
}

type MenuSetCandidate = {
  external_id: string;
  title: string;
  meal_type_hint: string | null;
  theme_tags: string[] | null;
  dishes: unknown[];
  calories_kcal: number | null;
  sodium_g: number | null;
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
    filter_meal_type_hint: null,
    filter_max_sodium: null,
    filter_theme_tags: null,
  });
  if (error) throw new Error(`search_menu_examples failed: ${error.message}`);
  return (data ?? []) as MenuSetCandidate[];
}

function candidatesToReferences(candidates: MenuSetCandidate[]): MenuReference[] {
  return candidates.map(c => ({
    title: c.title,
    dishes: Array.isArray(c.dishes) 
      ? c.dishes.map((d: any) => ({ 
          name: String(d?.name ?? ""), 
          role: String(d?.role ?? d?.class_raw ?? "other") 
        }))
      : [],
  }));
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

function triggerNextStep(
  supabaseUrl: string,
  supabaseServiceKey: string,
  requestId: string,
  userId: string,
  targetDate: string,
  mealType: string,
  note: string | null,
) {
  console.log("🔄 Triggering next step...");
  
  const url = `${supabaseUrl}/functions/v1/generate-single-meal-v3`;
  
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseServiceKey}`,
    },
    body: JSON.stringify({
      request_id: requestId,
      target_date: targetDate,
      meal_type: mealType,
      userId: userId,
      note: note,
      _continue: true,
    }),
  }).catch(e => {
    console.error("Failed to trigger next step:", e);
  });
}

// =========================================================
// Main Handler
// =========================================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let requestId: string | null = null;
  let userId: string | null = null;

  try {
    const body = await req.json();
    requestId = body.request_id ?? null;
    const targetDate = body.target_date ?? body.date;
    const mealType = body.meal_type ?? body.mealType;
    const note = body.note ?? null;
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

    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      throw new Error("Invalid target_date format");
    }
    if (!mealType || !ALLOWED_MEAL_TYPES.includes(mealType)) {
      throw new Error(`Invalid meal_type: ${mealType}`);
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

    // バックグラウンドタスク
    const wrappedBackgroundTask = async () => {
      console.log(`🚀 Step ${currentStep} starting...`);
      try {
        await executeStep(supabase, supabaseUrl, supabaseServiceKey, userId!, requestId, targetDate, mealType, note, currentStep);
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
  targetDate: string,
  mealType: string,
  note: string | null,
  currentStep: number,
) {
  switch (currentStep) {
    case 1:
      await executeStep1_Generate(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, targetDate, mealType, note);
      break;
    case 2:
      await executeStep2_Nutrition(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, targetDate, mealType, note);
      break;
    case 3:
      await executeStep3_Save(supabase, userId, requestId, targetDate, mealType);
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
  targetDate: string,
  mealType: string,
  note: string | null,
) {
  console.log("📝 Step 1: Generating meal...");
  
  await updateProgress(supabase, requestId, {
    phase: "user_context",
    message: "ユーザー情報を取得中...",
    percentage: 10,
  }, 1);

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
  const searchQuery = buildSearchQueryBase(userContext);
  const candidates = await searchMenuCandidates(supabase, searchQuery, 20);
  const references = candidatesToReferences(candidates);

  await updateProgress(supabase, requestId, {
    phase: "generating",
    message: "AIが献立を作成中...",
    percentage: 30,
  });

  // LLMで生成
  const generatedMeal = await generateMealWithLLM({
    userSummary,
    userContext,
    note,
    mealType: mealType as MealType,
    currentDishName: null,
    referenceMenus: references,
  });

  console.log("✅ Step 1: Meal generated");

  // 生成データを保存
  const generatedData = {
    generatedMeal: generatedMeal,
    userContext: userContext,
    targetDate: targetDate,
    mealType: mealType,
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
  triggerNextStep(supabaseUrl, supabaseServiceKey, requestId!, userId, targetDate, mealType, note);
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
  targetDate: string,
  mealType: string,
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
  const totalNutrition = emptyNutrition();
  for (const dish of generatedMeal.dishes) {
    try {
      const nutrition = await calculateNutritionFromIngredients(supabase, dish.ingredients);
      dish.nutrition = nutrition;
      for (const key of Object.keys(totalNutrition) as (keyof NutritionTotals)[]) {
        totalNutrition[key] += nutrition[key] ?? 0;
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
    totalNutrition: totalNutrition,
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
  triggerNextStep(supabaseUrl, supabaseServiceKey, requestId!, userId, targetDate, mealType, note);
}

// =========================================================
// Step 3: 保存
// =========================================================

async function executeStep3_Save(
  supabase: any,
  userId: string,
  requestId: string | null,
  targetDate: string,
  mealType: string,
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
  
  const { generatedMeal, totalNutrition } = reqData.generated_data;

  await updateProgress(supabase, requestId, {
    phase: "saving",
    message: "献立を保存中...",
    percentage: 85,
  }, 3);

  // meal_plan を取得または作成
  const startOfWeek = getStartOfWeek(targetDate);
  const endOfWeek = getEndOfWeek(targetDate);

  const { data: existingPlan } = await supabase
    .from("meal_plans")
    .select("id")
    .eq("user_id", userId)
    .eq("start_date", startOfWeek)
    .maybeSingle();

  let mealPlanId: string;
  if (existingPlan?.id) {
    mealPlanId = existingPlan.id;
  } else {
    await supabase.from("meal_plans").update({ is_active: false }).eq("user_id", userId);
    
    const { data: newPlan, error: planErr } = await supabase
      .from("meal_plans")
      .insert({
        user_id: userId,
        title: `${new Date(`${startOfWeek}T00:00:00.000Z`).getUTCMonth() + 1}月${new Date(`${startOfWeek}T00:00:00.000Z`).getUTCDate()}日〜の献立`,
        start_date: startOfWeek,
        end_date: endOfWeek,
        status: "active",
        is_active: true,
      })
      .select("id")
      .single();
    if (planErr) throw new Error(`Failed to create meal_plan: ${planErr.message}`);
    mealPlanId = newPlan.id;
  }

  // meal_plan_day を取得または作成
  const { data: existingDay } = await supabase
    .from("meal_plan_days")
    .select("id")
    .eq("meal_plan_id", mealPlanId)
    .eq("day_date", targetDate)
    .maybeSingle();

  let mealPlanDayId: string;
  if (existingDay?.id) {
    mealPlanDayId = existingDay.id;
  } else {
    const { data: newDay, error: dayErr } = await supabase
      .from("meal_plan_days")
      .insert({ meal_plan_id: mealPlanId, day_date: targetDate, nutritional_focus: null })
      .select("id")
      .single();
    if (dayErr) throw new Error(`Failed to create meal_plan_day: ${dayErr.message}`);
    mealPlanDayId = newDay.id;
  }

  // dishDetails 構築
  const dishDetails = buildDishDetails(generatedMeal);
  const aggregatedIngredients = generatedMeal.dishes.flatMap((d: any) => d.ingredients.map((i: any) => `${i.name} ${i.amount_g}g`));
  const dishName = generatedMeal.dishes.map((d: any) => d.name).join("、");

  const mealData = {
    user_id: userId,
    meal_plan_day_id: mealPlanDayId,
    meal_plan_id: mealPlanId,
    meal_type: mealType,
    display_order: DISPLAY_ORDER_MAP[mealType] ?? 99,
    source_type: "generated" as const,
    dish_name: dishName,
    dishes: dishDetails,
    ingredients: aggregatedIngredients,
    calories_kcal: Math.round(totalNutrition.calories_kcal) || null,
    protein_g: Math.round(totalNutrition.protein_g * 10) / 10 || null,
    fat_g: Math.round(totalNutrition.fat_g * 10) / 10 || null,
    carbs_g: Math.round(totalNutrition.carbs_g * 10) / 10 || null,
    fiber_g: Math.round(totalNutrition.fiber_g * 10) / 10 || null,
    sodium_mg: Math.round(totalNutrition.sodium_mg) || null,
    salt_equivalent_g: Math.round((totalNutrition.sodium_mg / 400) * 10) / 10 || null,
    iron_mg: Math.round(totalNutrition.iron_mg * 10) / 10 || null,
    calcium_mg: Math.round(totalNutrition.calcium_mg) || null,
    zinc_mg: Math.round(totalNutrition.zinc_mg * 10) / 10 || null,
    vitamin_a_ug: Math.round(totalNutrition.vitamin_a_ug) || null,
    vitamin_c_mg: Math.round(totalNutrition.vitamin_c_mg) || null,
    vitamin_d_ug: Math.round(totalNutrition.vitamin_d_ug * 10) / 10 || null,
    magnesium_mg: Math.round(totalNutrition.magnesium_mg) || null,
    folic_acid_ug: Math.round(totalNutrition.folic_acid_ug) || null,
    is_eaten: false,
    is_skipped: false,
    generation_metadata: {
      generator: "generate-single-meal-v3",
      mode: "creative",
      generated_at: new Date().toISOString(),
      nutrition_source: "calculated",
    },
  };

  // 既存レコードがあれば更新、なければ挿入
  const { data: existingMeal } = await supabase
    .from("planned_meals")
    .select("id")
    .eq("meal_plan_day_id", mealPlanDayId)
    .eq("meal_type", mealType)
    .maybeSingle();

  let savedMealId: string;
  if (existingMeal?.id) {
    await supabase
      .from("planned_meals")
      .update({ ...mealData, updated_at: new Date().toISOString() })
      .eq("id", existingMeal.id);
    savedMealId = existingMeal.id;
  } else {
    const { data: newMeal, error: mealErr } = await supabase
      .from("planned_meals")
      .insert(mealData)
      .select("id")
      .single();
    if (mealErr) throw new Error(`Failed to create planned_meal: ${mealErr.message}`);
    savedMealId = newMeal.id;
  }

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

  console.log("🎉 Single meal generation completed!");
}

// =========================================================
// Helpers
// =========================================================

function getStartOfWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function getEndOfWeek(dateStr: string): string {
  const start = getStartOfWeek(dateStr);
  const d = new Date(`${start}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function buildDishDetails(meal: GeneratedMeal): any[] {
  return meal.dishes.map((dish) => {
    const nutrition = (dish as any).nutrition as NutritionTotals | undefined;
    
    let ingredientsMd = "| 材料 | 分量 |\n|------|------|\n";
    for (const ing of dish.ingredients) {
      ingredientsMd += `| ${ing.name} | ${ing.amount_g}g${ing.note ? ` (${ing.note})` : ""} |\n`;
    }
    
    const recipeStepsMd = dish.instructions.map((step, i) => `${i + 1}. ${step}`).join("\n\n");

    return {
      name: dish.name,
      role: dish.role,
      cal: Math.round(nutrition?.calories_kcal ?? 0),
      protein: Math.round((nutrition?.protein_g ?? 0) * 10) / 10,
      fat: Math.round((nutrition?.fat_g ?? 0) * 10) / 10,
      carbs: Math.round((nutrition?.carbs_g ?? 0) * 10) / 10,
      fiber: Math.round((nutrition?.fiber_g ?? 0) * 10) / 10,
      sugar: 0,
      sodium: Math.round((nutrition?.sodium_mg ?? 0) / 1000 * 10) / 10,
      iron: Math.round((nutrition?.iron_mg ?? 0) * 10) / 10,
      calcium: Math.round(nutrition?.calcium_mg ?? 0),
      zinc: Math.round((nutrition?.zinc_mg ?? 0) * 10) / 10,
      vitaminA: Math.round(nutrition?.vitamin_a_ug ?? 0),
      vitaminC: Math.round(nutrition?.vitamin_c_mg ?? 0),
      vitaminD: Math.round((nutrition?.vitamin_d_ug ?? 0) * 10) / 10,
      vitaminE: 0,
      vitaminK: 0,
      vitaminB1: 0,
      vitaminB2: 0,
      vitaminB6: 0,
      vitaminB12: 0,
      folicAcid: Math.round(nutrition?.folic_acid_ug ?? 0),
      potassium: 0,
      phosphorus: 0,
      iodine: 0,
      cholesterol: 0,
      fiberSoluble: 0,
      fiberInsoluble: 0,
      saturatedFat: 0,
      monounsaturatedFat: 0,
      polyunsaturatedFat: 0,
      ingredient: dish.ingredients.slice(0, 3).map(i => i.name).join("、"),
      ingredients: dish.ingredients.map(i => `${i.name} ${i.amount_g}g`),
      recipeSteps: dish.instructions,
      ingredientsMd,
      recipeStepsMd,
      base_recipe_id: null,
      is_generated_name: true,
    };
  });
}
