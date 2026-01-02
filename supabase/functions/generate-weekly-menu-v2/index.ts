import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildSearchQueryBase, buildUserContextForPrompt, buildUserSummary } from "../_shared/user-context.ts";
import { detectAllergenHits, summarizeAllergenHits } from "../_shared/allergy.ts";
import { calculateNutritionFromIngredients, emptyNutrition, type NutritionTotals } from "../_shared/nutrition-calculator.ts";
import { createLogger, generateRequestId } from "../_shared/db-logger.ts";
import {
  generateDayMealsWithLLM,
  reviewWeeklyMenus,
  regenerateMealForIssue,
  type GeneratedMeal,
  type GeneratedDish,
  type MealType,
  type MenuReference,
  type WeeklyMealsSummary,
} from "../_shared/meal-generator.ts";

console.log("Generate Weekly Menu v2 Function loaded (Creative Mode + Parallel)");

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

function toNullableNumber(value: unknown): number | null {
  const n = Number(value);
  return isNaN(n) || n === 0 ? null : n;
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

// =========================================================
// Embeddings / Search (参考候補取得用)
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
// タイミング計測
// =========================================================

const timings: Record<string, number> = {};
let phaseStartTime = Date.now();

function phaseStart(name: string) {
  phaseStartTime = Date.now();
  console.log(`[PHASE] ${name} started`);
}

function phaseEnd(name: string, extra?: Record<string, unknown>) {
  const elapsed = Date.now() - phaseStartTime;
  timings[name] = elapsed;
  console.log(`[PHASE] ${name} completed in ${elapsed}ms`, extra ? JSON.stringify(extra) : "");
}

// =========================================================
// 進捗更新（Realtime配信用）
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
) {
  if (!requestId) return;
  try {
    await supabase
      .from("weekly_menu_requests")
      .update({
        progress,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);
  } catch (e) {
    console.error("Failed to update progress:", e);
  }
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

    if (!accessToken) throw new Error("Missing access token");

    // フロントエンドからuserIdが渡される場合はそれを使用（サービスロールキーでの呼び出し時）
    // そうでない場合はトークンからユーザーを取得
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

    // バックグラウンドタスクをラップしてエラーをキャッチ
    const wrappedBackgroundTask = async () => {
      console.log("🚀 Background task starting...");
      try {
        await generateWeeklyMenuBackground(supabase, userId, requestId, startDate, dates, body.note ?? null);
        console.log("✅ Background task completed successfully");
      } catch (bgErr: any) {
        console.error("❌ Background task error:", bgErr?.message ?? String(bgErr), bgErr);
        // DBにエラーを保存
        if (requestId) {
          await supabase
            .from("weekly_menu_requests")
            .update({
              status: "failed",
              error_message: bgErr?.message ?? String(bgErr) ?? "Background task error",
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
        JSON.stringify({ status: "processing", request_id: requestId, message: "週間献立を生成中..." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      // EdgeRuntime.waitUntilがない場合は同期的に実行
      console.log("⚠️ EdgeRuntime.waitUntil not available, running synchronously");
      await wrappedBackgroundTask();
      return new Response(
        JSON.stringify({ status: "completed", request_id: requestId, message: "週間献立を生成しました" }),
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
// Background Task
// =========================================================

async function generateWeeklyMenuBackground(
  supabase: any,
  userId: string,
  requestId: string | null,
  startDate: string,
  dates: string[],
  note: string | null,
) {
  console.log("🔵 generateWeeklyMenuBackground called", { userId, requestId, startDate, datesCount: dates.length });
  
  const logRequestId = generateRequestId();
  console.log("🔵 Logger created", { logRequestId });
  
  const logger = createLogger(supabase, "generate-weekly-menu-v2", userId, logRequestId);

  try {
    console.log("🔵 About to log background_task_start to DB...");
    await logger.info("background_task_start", { requestId, startDate });
    console.log("🔵 Logged background_task_start successfully");

    // ========== Phase 1: ユーザー情報取得 ==========
    phaseStart("1_user_context");
    await updateProgress(supabase, requestId, {
      phase: "user_context",
      message: "ユーザー情報を取得中...",
      percentage: 5,
    });
    
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
    
    phaseEnd("1_user_context");
    console.log("🔵 Phase 1 complete - user context loaded");

    // ========== Phase 2: 参考候補検索 ==========
    phaseStart("2_search_references");
    await updateProgress(supabase, requestId, {
      phase: "search_references",
      message: "参考レシピを検索中...",
      percentage: 10,
    });
    
    const searchQuery = buildSearchQueryBase(userContext);
    const candidates = await searchMenuCandidates(supabase, searchQuery, 30);
    const references = candidatesToReferences(candidates);
    
    phaseEnd("2_search_references", { candidateCount: candidates.length });
    console.log("🔵 Phase 2 complete - found", candidates.length, "reference candidates");

    // ========== Phase 3: 7日分を並列生成 ==========
    phaseStart("3_parallel_generation");
    await updateProgress(supabase, requestId, {
      phase: "generating",
      message: "AIが7日分の献立を作成中... (約2分)",
      percentage: 15,
    });
    
    const generationPromises = dates.map((date) =>
      generateDayMealsWithLLM({
        userSummary,
        userContext,
        note,
        date,
        mealTypes: REQUIRED_MEAL_TYPES,
        referenceMenus: references,
      }).catch(err => {
        console.error(`Failed to generate meals for ${date}:`, err);
        return null;
      })
    );
    
    const dailyResults = await Promise.all(generationPromises);
    
    // 失敗した日がないか確認
    const failedDays = dates.filter((_, i) => !dailyResults[i]);
    if (failedDays.length > 0) {
      throw new Error(`Failed to generate meals for: ${failedDays.join(", ")}`);
    }
    
    phaseEnd("3_parallel_generation", { successDays: 7 - failedDays.length });
    console.log("🔵 Phase 3 complete - generated meals for", 7 - failedDays.length, "days");

    // ========== Phase 4: 全体俯瞰レビュー ==========
    phaseStart("4_review");
    await updateProgress(supabase, requestId, {
      phase: "reviewing",
      message: "献立のバランスをチェック中... (約1分)",
      percentage: 50,
    });
    
    const weeklyMealsSummary: WeeklyMealsSummary[] = dailyResults.map((day, i) => ({
      date: dates[i],
      meals: day!.meals.map(m => ({
        mealType: m.mealType as MealType,
        dishNames: m.dishes.map(d => d.name),
      })),
    }));
    
    const reviewResult = await reviewWeeklyMenus({
      weeklyMeals: weeklyMealsSummary,
      userSummary,
    });
    
    phaseEnd("4_review", { hasIssues: reviewResult.hasIssues, issueCount: reviewResult.issues.length, swapCount: reviewResult.swaps.length });

    // ========== Phase 5: 問題があれば修正 ==========
    let finalDailyResults = dailyResults.map(d => d!);
    
    if (reviewResult.hasIssues && reviewResult.issues.length > 0) {
      phaseStart("5_fix_issues");
      const fixCount = Math.min(reviewResult.issues.length, 2);
      await updateProgress(supabase, requestId, {
        phase: "fixing",
        message: `${fixCount}件の改善点を修正中...`,
        percentage: 65,
      });
      
      // 時間制約のため、修正は最大2件まで
      const maxFixes = 2;
      const issuesToFix = reviewResult.issues.slice(0, maxFixes);
      console.log(`Fixing ${issuesToFix.length} of ${reviewResult.issues.length} issues (limited to ${maxFixes})`);
      
      for (const issue of issuesToFix) {
        const dayIndex = dates.indexOf(issue.date);
        if (dayIndex === -1) continue;
        
        const dayMeals = finalDailyResults[dayIndex];
        const mealIndex = dayMeals.meals.findIndex(m => m.mealType === issue.mealType);
        if (mealIndex === -1) continue;
        
        const currentDishes = dayMeals.meals[mealIndex].dishes.map(d => d.name);
        
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
          
          // 修正した食事で置き換え
          dayMeals.meals[mealIndex] = fixedMeal;
          console.log(`Fixed ${issue.date} ${issue.mealType}: ${issue.issue}`);
        } catch (e) {
          console.error(`Failed to fix ${issue.date} ${issue.mealType}:`, e);
        }
      }
      
      phaseEnd("5_fix_issues", { fixedCount: reviewResult.issues.length });
    }

    // ========== Phase 5.5: 昼夜入れ替え ==========
    if (reviewResult.swaps.length > 0) {
      phaseStart("5.5_apply_swaps");
      
      for (const swap of reviewResult.swaps) {
        // 同じ日の昼夜入れ替えのみサポート
        if (swap.date1 !== swap.date2) continue;
        
        const dayIndex = dates.indexOf(swap.date1);
        if (dayIndex === -1) continue;
        
        const dayMeals = finalDailyResults[dayIndex];
        const meal1Index = dayMeals.meals.findIndex(m => m.mealType === swap.mealType1);
        const meal2Index = dayMeals.meals.findIndex(m => m.mealType === swap.mealType2);
        
        if (meal1Index !== -1 && meal2Index !== -1) {
          const temp = dayMeals.meals[meal1Index];
          dayMeals.meals[meal1Index] = { ...dayMeals.meals[meal2Index], mealType: swap.mealType1 as any };
          dayMeals.meals[meal2Index] = { ...temp, mealType: swap.mealType2 as any };
          console.log(`Swapped ${swap.date1} ${swap.mealType1} <-> ${swap.mealType2}: ${swap.reason}`);
        }
      }
      
      phaseEnd("5.5_apply_swaps", { swapCount: reviewResult.swaps.length });
    }

    // ========== Phase 6: 栄養計算 ==========
    phaseStart("6_nutrition_calc");
    await updateProgress(supabase, requestId, {
      phase: "calculating",
      message: "栄養価を計算中...",
      percentage: 80,
    });
    
    // 全食事の栄養を計算
    for (const day of finalDailyResults) {
      for (const meal of day.meals) {
        for (const dish of meal.dishes) {
          try {
            const nutrition = await calculateNutritionFromIngredients(supabase, dish.ingredients);
            (dish as any).nutrition = nutrition;
          } catch (e) {
            console.warn(`Nutrition calc failed for ${dish.name}:`, e);
            (dish as any).nutrition = emptyNutrition();
          }
        }
      }
    }
    
    phaseEnd("6_nutrition_calc");

    // ========== Phase 7: DB保存 ==========
    phaseStart("7_save_to_db");
    await updateProgress(supabase, requestId, {
      phase: "saving",
      message: "献立を保存中...",
      percentage: 90,
    });
    
    const endDate = dates[6];
    
    // meal_plan: 既存があれば再利用（無ければ作成）
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
        .eq("id", mealPlanId)
        .eq("user_id", userId);
    } else {
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

    // 他のプランを非アクティブ化
    await supabase.from("meal_plans").update({ is_active: false }).eq("user_id", userId).neq("id", mealPlanId);

    // 各日・各食事を保存
    for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
      const dayDate = dates[dayIndex];
      const dayMeals = finalDailyResults[dayIndex];

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
          .insert({ meal_plan_id: mealPlanId, day_date: dayDate, nutritional_focus: null })
          .select("id")
          .single();
        if (dayErr) throw new Error(`Failed to create meal_plan_day: ${dayErr.message}`);
        mealPlanDayId = newDay.id;
      }

      for (const meal of dayMeals.meals) {
        const mealType = meal.mealType;
        const dishDetails = buildDishDetails(meal);
        const aggregatedIngredients = meal.dishes.flatMap(d => d.ingredients.map(i => `${i.name} ${i.amount_g}g`));
        const dishName = meal.dishes.map(d => d.name).join("、");
        
        // 栄養値を合算
        const totalNutrition = meal.dishes.reduce((acc, dish) => {
          const n = (dish as any).nutrition as NutritionTotals | undefined;
          if (n) {
            for (const key of Object.keys(acc) as (keyof NutritionTotals)[]) {
              acc[key] += n[key] ?? 0;
            }
          }
          return acc;
        }, emptyNutrition());

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
            generator: "generate-weekly-menu-v2",
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
    
    phaseEnd("7_save_to_db");

    // ========== Phase 8: 完了ステータス更新 ==========
    phaseStart("8_complete");
    
    if (requestId) {
      await supabase
        .from("weekly_menu_requests")
        .update({
          status: "completed",
          progress: {
            phase: "completed",
            message: "献立が完成しました！",
            percentage: 100,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);
    }
    
    phaseEnd("8_complete");

    // ========== 完了サマリー ==========
    console.log("[PHASE] ========== 完了サマリー ==========");
    console.log("[PHASE] timings:", JSON.stringify(timings));
    const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);
    console.log(`[PHASE] 総処理時間: ${totalTime}ms`);
    
    await logger.info("background_task_complete", { timings, totalTime });
    
  } catch (err: any) {
    console.error("Background task error:", err);
    await logger.error("background_task_failed", { error: err.message, stack: err.stack });
    
    if (requestId) {
      await supabase
        .from("weekly_menu_requests")
        .update({ status: "failed", error_message: err.message, updated_at: new Date().toISOString() })
        .eq("id", requestId);
    }
  }
}

// =========================================================
// dishDetails 構築ヘルパー
// =========================================================

function buildDishDetails(meal: GeneratedMeal): any[] {
  return meal.dishes.map((dish) => {
    const nutrition = (dish as any).nutrition as NutritionTotals | undefined;
    
    // マークダウン形式で材料を整形
    let ingredientsMd = "| 材料 | 分量 |\n|------|------|\n";
    for (const ing of dish.ingredients) {
      ingredientsMd += `| ${ing.name} | ${ing.amount_g}g${ing.note ? ` (${ing.note})` : ""} |\n`;
    }
    
    // 作り方をマークダウン番号リスト形式に
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
