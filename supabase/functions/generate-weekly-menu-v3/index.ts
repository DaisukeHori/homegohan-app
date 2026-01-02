import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildSearchQueryBase, buildUserContextForPrompt, buildUserSummary } from "../_shared/user-context.ts";
import { calculateNutritionFromIngredients, emptyNutrition } from "../_shared/nutrition-calculator.ts";
import { createLogger, generateRequestId } from "../_shared/db-logger.ts";
import {
  generateDayMealsWithLLM,
  reviewWeeklyMenus,
  regenerateMealForIssue,
  type GeneratedMeal,
  type MealType,
  type MenuReference,
  type WeeklyMealsSummary,
} from "../_shared/meal-generator.ts";

console.log("Generate Weekly Menu v3 Function loaded (LLM Creative + 3-Step Mode)");

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

const REQUIRED_MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner"];

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

async function triggerNextStep(
  supabaseUrl: string,
  supabaseServiceKey: string,
  requestId: string,
  userId: string,
  startDate: string,
  note: string | null,
) {
  console.log("🔄 Triggering next step...");
  
  // 自分自身を非同期で呼び出す
  const url = `${supabaseUrl}/functions/v1/generate-weekly-menu-v3`;
  
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseServiceKey}`,
    },
    body: JSON.stringify({
      request_id: requestId,
      start_date: startDate,
      userId: userId,
      note: note,
      _continue: true, // 継続フラグ
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
    requestId = body.request_id ?? body.requestId ?? null;
    const startDateRaw = body.start_date ?? body.startDate;
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

    const startDate = String(startDateRaw).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error("Invalid start_date format");

    // 7日分の日付を生成
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(`${startDate}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() + i);
      dates.push(d.toISOString().slice(0, 10));
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

    // バックグラウンドタスクをラップ
    const wrappedBackgroundTask = async () => {
      console.log(`🚀 Step ${currentStep} starting...`);
      try {
        await executeStep(supabase, supabaseUrl, supabaseServiceKey, userId!, requestId, startDate, dates, body.note ?? null, currentStep);
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
        JSON.stringify({ status: "processing", request_id: requestId, step: currentStep, message: `Step ${currentStep} を実行中...` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      console.log("⚠️ EdgeRuntime.waitUntil not available, running synchronously");
      await wrappedBackgroundTask();
      return new Response(
        JSON.stringify({ status: "completed", request_id: requestId, message: "完了" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (err: any) {
    const errorMessage = err?.message ?? String(err) ?? "Unknown error";
    console.error("Request error:", errorMessage, err);
    if (requestId) {
      await supabase
        .from("weekly_menu_requests")
        .update({ status: "failed", error_message: errorMessage, updated_at: new Date().toISOString() })
        .eq("id", requestId);
    }
    return new Response(JSON.stringify({ error: errorMessage }), {
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
  startDate: string,
  dates: string[],
  note: string | null,
  currentStep: number,
) {
  switch (currentStep) {
    case 1:
      await executeStep1_Generate(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, startDate, dates, note);
      break;
    case 2:
      await executeStep2_Review(supabase, supabaseUrl, supabaseServiceKey, userId, requestId, startDate, dates, note);
      break;
    case 3:
      await executeStep3_Complete(supabase, userId, requestId, startDate, dates);
      break;
    default:
      throw new Error(`Unknown step: ${currentStep}`);
  }
}

// =========================================================
// Step 1: 生成 (Phase 1-3)
// =========================================================

async function executeStep1_Generate(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string | null,
  startDate: string,
  dates: string[],
  note: string | null,
) {
  console.log("📝 Step 1: Generating meals...");
  
  await updateProgress(supabase, requestId, {
    phase: "user_context",
    message: "ユーザー情報を取得中...",
    percentage: 5,
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
    percentage: 10,
  });

  // 参考候補検索
  const searchQuery = buildSearchQueryBase(userContext);
  const candidates = await searchMenuCandidates(supabase, searchQuery, 30);
  const references = candidatesToReferences(candidates);
  
  console.log(`Found ${candidates.length} reference candidates`);

  await updateProgress(supabase, requestId, {
    phase: "generating",
    message: "1日目の献立を作成中...",
    percentage: 15,
  });

  // 7日分を順次生成（進捗を細かく更新するため）
  const dailyResults: any[] = [];
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const dayNum = i + 1;
    const percentage = 15 + Math.round((i / 7) * 20); // 15% → 35%
    
    await updateProgress(supabase, requestId, {
      phase: "generating",
      message: `${dayNum}日目の献立を作成中...`,
      percentage,
    });
    
    try {
      const result = await generateDayMealsWithLLM({
        userSummary,
        userContext,
        note,
        date,
        mealTypes: REQUIRED_MEAL_TYPES,
        referenceMenus: references,
      });
      dailyResults.push(result);
      console.log(`✅ Day ${dayNum} (${date}) generated`);
    } catch (err) {
      console.error(`Failed to generate meals for ${date}:`, err);
      dailyResults.push(null);
    }
  }
  
  // 失敗した日がないか確認
  const failedDays = dates.filter((_, i) => !dailyResults[i]);
  if (failedDays.length > 0) {
    throw new Error(`Failed to generate meals for: ${failedDays.join(", ")}`);
  }
  
  console.log("✅ Step 1: All 7 days generated");

  await updateProgress(supabase, requestId, {
    phase: "step1_complete",
    message: "7日分の献立が完成！レビュー準備中...",
    percentage: 40,
  });

  // 生成データを保存
  const generatedData = {
    dailyResults: dailyResults,
    userContext: userContext,
    userSummary: userSummary,
    references: references,
    dates: dates,
  };

  await supabase
    .from("weekly_menu_requests")
    .update({
      generated_data: generatedData,
      current_step: 2,
      progress: {
        phase: "step1_complete",
        message: "レビュー開始...",
        percentage: 42,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  // 次のステップをトリガー
  triggerNextStep(supabaseUrl, supabaseServiceKey, requestId!, userId, startDate, note);
}

// =========================================================
// Step 2: レビュー・修正 (Phase 4-5)
// =========================================================

async function executeStep2_Review(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  requestId: string | null,
  startDate: string,
  dates: string[],
  note: string | null,
) {
  console.log("🔍 Step 2: Reviewing meals...");
  
  // 生成データを取得
  const { data: reqData } = await supabase
    .from("weekly_menu_requests")
    .select("generated_data")
    .eq("id", requestId)
    .single();
  
  if (!reqData?.generated_data) {
    throw new Error("No generated data found for review");
  }
  
  const { dailyResults, userContext, userSummary, references } = reqData.generated_data;

  await updateProgress(supabase, requestId, {
    phase: "reviewing",
    message: "献立のバランスをチェック中...",
    percentage: 45,
  }, 2);

  // 全体俯瞰レビュー
  const weeklyMealsSummary: WeeklyMealsSummary[] = dailyResults.map((day: any, i: number) => ({
    date: dates[i],
    meals: day.meals.map((m: any) => ({
      mealType: m.mealType as MealType,
      dishNames: m.dishes.map((d: any) => d.name),
    })),
  }));

  await updateProgress(supabase, requestId, {
    phase: "reviewing",
    message: "重複・バランスをAIがチェック中...",
    percentage: 50,
  });
  
  const reviewResult = await reviewWeeklyMenus({
    weeklyMeals: weeklyMealsSummary,
    userSummary,
  });
  
  console.log(`Review result: ${reviewResult.issues.length} issues, ${reviewResult.swaps.length} swaps`);

  await updateProgress(supabase, requestId, {
    phase: "review_done",
    message: `${reviewResult.issues.length}件の改善点を発見`,
    percentage: 55,
  });

  // 修正フェーズ
  let finalDailyResults = dailyResults.map((d: any) => d);
  
  if (reviewResult.hasIssues && reviewResult.issues.length > 0) {
    const maxFixes = 3;
    const issuesToFix = reviewResult.issues.slice(0, maxFixes);
    
    console.log(`Fixing ${issuesToFix.length} of ${reviewResult.issues.length} issues (limited to ${maxFixes})`);
    
    for (let fixIdx = 0; fixIdx < issuesToFix.length; fixIdx++) {
      const issue = issuesToFix[fixIdx];
      const percentage = 55 + Math.round(((fixIdx + 1) / issuesToFix.length) * 15); // 55% → 70%
      
      await updateProgress(supabase, requestId, {
        phase: "fixing",
        message: `改善点${fixIdx + 1}/${issuesToFix.length}を修正中...`,
        percentage,
      });
      
      const dayIndex = dates.indexOf(issue.date);
      if (dayIndex === -1) continue;
      
      const dayMeals = finalDailyResults[dayIndex];
      const mealIndex = dayMeals.meals.findIndex((m: any) => m.mealType === issue.mealType);
      if (mealIndex === -1) continue;
      
      const currentDishes = dayMeals.meals[mealIndex].dishes.map((d: any) => d.name);
      
      try {
        const fixedMeal = await regenerateMealForIssue({
          userSummary,
          userContext,
          note,
          date: issue.date,
          mealType: issue.mealType as MealType,
          currentDishes,
          issue: issue.issue,
          suggestion: issue.suggestion,
          referenceMenus: references,
        });
        
        dayMeals.meals[mealIndex] = fixedMeal;
        console.log(`Fixed ${issue.date} ${issue.mealType}: ${issue.issue}`);
      } catch (e) {
        console.error(`Failed to fix ${issue.date} ${issue.mealType}:`, e);
      }
    }
  } else {
    await updateProgress(supabase, requestId, {
      phase: "no_issues",
      message: "問題なし！次のステップへ...",
      percentage: 70,
    });
  }

  // スワップ適用
  if (reviewResult.swaps && reviewResult.swaps.length > 0) {
    for (const swap of reviewResult.swaps) {
      if (swap.date1 !== swap.date2) continue;
      
      const dayIndex = dates.indexOf(swap.date1);
      if (dayIndex === -1) continue;
      
      const dayMeals = finalDailyResults[dayIndex];
      const meal1Index = dayMeals.meals.findIndex((m: any) => m.mealType === swap.mealType1);
      const meal2Index = dayMeals.meals.findIndex((m: any) => m.mealType === swap.mealType2);
      
      if (meal1Index !== -1 && meal2Index !== -1) {
        const temp = dayMeals.meals[meal1Index];
        dayMeals.meals[meal1Index] = { ...dayMeals.meals[meal2Index], mealType: swap.mealType1 };
        dayMeals.meals[meal2Index] = { ...temp, mealType: swap.mealType2 };
        console.log(`Swapped ${swap.date1} ${swap.mealType1} <-> ${swap.mealType2}`);
      }
    }
  }

  console.log("✅ Step 2: Review and fixes complete");

  // 更新されたデータを保存
  const updatedData = {
    ...reqData.generated_data,
    dailyResults: finalDailyResults,
    reviewResult: reviewResult,
  };

  await supabase
    .from("weekly_menu_requests")
    .update({
      generated_data: updatedData,
      current_step: 3,
      progress: {
        phase: "step2_complete",
        message: "レビュー完了。栄養計算開始...",
        percentage: 75,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  // 次のステップをトリガー
  triggerNextStep(supabaseUrl, supabaseServiceKey, requestId!, userId, startDate, note);
}

// =========================================================
// Step 3: 栄養計算・保存 (Phase 6-8)
// =========================================================

async function executeStep3_Complete(
  supabase: any,
  userId: string,
  requestId: string | null,
  startDate: string,
  dates: string[],
) {
  console.log("💾 Step 3: Calculating nutrition and saving...");
  
  // 生成データを取得
  const { data: reqData } = await supabase
    .from("weekly_menu_requests")
    .select("generated_data")
    .eq("id", requestId)
    .single();
  
  if (!reqData?.generated_data) {
    throw new Error("No generated data found for completion");
  }
  
  const { dailyResults } = reqData.generated_data;

  await updateProgress(supabase, requestId, {
    phase: "calculating",
    message: "1日目の栄養を計算中...",
    percentage: 75,
  }, 3);

  // 栄養計算（日ごとに進捗更新）
  for (let dayIdx = 0; dayIdx < dailyResults.length; dayIdx++) {
    const day = dailyResults[dayIdx];
    const dayNum = dayIdx + 1;
    const percentage = 75 + Math.round((dayIdx / 7) * 10); // 75% → 85%
    
    await updateProgress(supabase, requestId, {
      phase: "calculating",
      message: `${dayNum}日目の栄養を計算中...`,
      percentage,
    });
    
    for (const meal of day.meals) {
      for (const dish of meal.dishes) {
        try {
          const nutrition = await calculateNutritionFromIngredients(supabase, dish.ingredients);
          dish.nutrition = nutrition;
        } catch (e) {
          console.warn(`Nutrition calc failed for ${dish.name}:`, e);
          dish.nutrition = emptyNutrition();
        }
      }
    }
  }

  await updateProgress(supabase, requestId, {
    phase: "saving",
    message: "献立をデータベースに保存中...",
    percentage: 88,
  });

  // DB保存
  const endDate = dates[6];
  
  // meal_plan: 既存があれば再利用
  const { data: existingPlan } = await supabase
    .from("meal_plans")
    .select("id")
    .eq("user_id", userId)
    .eq("start_date", startDate)
    .maybeSingle();

  let mealPlanId: string;
  if (existingPlan?.id) {
    mealPlanId = existingPlan.id;
    await supabase
      .from("meal_plans")
      .update({ end_date: endDate, status: "active", is_active: true, updated_at: new Date().toISOString() })
      .eq("id", mealPlanId);
  } else {
    const { data: newPlan, error: planErr } = await supabase
      .from("meal_plans")
      .insert({ user_id: userId, start_date: startDate, end_date: endDate, status: "active", is_active: true })
      .select("id")
      .single();
    if (planErr || !newPlan?.id) throw new Error(`Failed to create meal_plan: ${planErr?.message}`);
    mealPlanId = newPlan.id;
  }

  // 各日のデータを保存
  for (let dayIdx = 0; dayIdx < dates.length; dayIdx++) {
    const dateStr = dates[dayIdx];
    const dayData = dailyResults[dayIdx];
    if (!dayData) continue;
    
    const dayNum = dayIdx + 1;
    const percentage = 88 + Math.round((dayIdx / 7) * 10); // 88% → 98%
    
    await updateProgress(supabase, requestId, {
      phase: "saving",
      message: `${dayNum}日目を保存中...`,
      percentage,
    });

    // meal_plan_days
    const { data: existingDay } = await supabase
      .from("meal_plan_days")
      .select("id")
      .eq("meal_plan_id", mealPlanId)
      .eq("day_date", dateStr)
      .maybeSingle();

    let mealPlanDayId: string;
    if (existingDay?.id) {
      mealPlanDayId = existingDay.id;
    } else {
      const { data: newDay, error: dayErr } = await supabase
        .from("meal_plan_days")
        .insert({ meal_plan_id: mealPlanId, day_date: dateStr })
        .select("id")
        .single();
      if (dayErr || !newDay?.id) throw new Error(`Failed to create meal_plan_days: ${dayErr?.message}`);
      mealPlanDayId = newDay.id;
    }

    // 各食事を保存
    for (const meal of dayData.meals) {
      const mealType = meal.mealType;
      const displayOrder = DISPLAY_ORDER_MAP[mealType] ?? 99;
      
      const dishDetails = buildDishDetails(meal);
      const totalNutrition = sumNutrition(meal.dishes);

      const mealData = {
        meal_plan_day_id: mealPlanDayId,
        meal_type: mealType,
        dish_name: dishDetails.dishName,
        mode: "ai_creative",
        display_order: displayOrder,
        is_completed: false,
        calories_kcal: totalNutrition.calories,
        protein_g: totalNutrition.protein,
        fat_g: totalNutrition.fat,
        carbs_g: totalNutrition.carbs,
        fiber_g: totalNutrition.fiber,
        sodium_mg: totalNutrition.sodium,
        nutrition_source: "calculated",
        dishes: dishDetails.dishes,
      };

      const { data: existingMeal } = await supabase
        .from("planned_meals")
        .select("id")
        .eq("meal_plan_day_id", mealPlanDayId)
        .eq("meal_type", mealType)
        .maybeSingle();

      if (existingMeal?.id) {
        await supabase
          .from("planned_meals")
          .update({ ...mealData, updated_at: new Date().toISOString() })
          .eq("id", existingMeal.id);
      } else {
        await supabase.from("planned_meals").insert(mealData);
      }
    }
  }

  console.log("✅ Step 3: All meals saved to database");

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

  console.log("🎉 Weekly menu generation completed!");
}

// =========================================================
// ヘルパー関数
// =========================================================

function buildDishDetails(meal: GeneratedMeal) {
  const dishes = meal.dishes.map((d, idx) => ({
    name: d.name,
    role: d.role ?? "other",
    ingredients: d.ingredients,
    ingredientsMd: d.ingredients.map(ing => `- ${ing.name}: ${ing.amount}`).join("\n"),
    recipeStepsMd: d.instructions?.map((step, i) => `${i + 1}. ${step}`).join("\n") ?? "",
    displayOrder: idx,
    calories_kcal: (d as any).nutrition?.calories ?? null,
    protein_g: (d as any).nutrition?.protein ?? null,
    fat_g: (d as any).nutrition?.fat ?? null,
    carbs_g: (d as any).nutrition?.carbs ?? null,
    fiber_g: (d as any).nutrition?.fiber ?? null,
    sodium_mg: (d as any).nutrition?.sodium ?? null,
  }));

  const dishName = dishes.length === 1 
    ? dishes[0].name 
    : dishes.slice(0, 3).map(d => d.name).join("、") + (dishes.length > 3 ? " など" : "");

  return { dishName, dishes };
}

function sumNutrition(dishes: any[]) {
  let calories = 0, protein = 0, fat = 0, carbs = 0, fiber = 0, sodium = 0;
  for (const d of dishes) {
    const n = d.nutrition;
    if (!n) continue;
    calories += n.calories ?? 0;
    protein += n.protein ?? 0;
    fat += n.fat ?? 0;
    carbs += n.carbs ?? 0;
    fiber += n.fiber ?? 0;
    sodium += n.sodium ?? 0;
  }
  return { calories, protein, fat, carbs, fiber, sodium };
}
