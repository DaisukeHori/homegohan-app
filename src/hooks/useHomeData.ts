import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toAnnouncement } from "@/lib/converter";
import type { Announcement, PlannedMeal, PantryItem, Badge } from "@/types/domain";

// 今日の献立データ
interface TodayMealPlan {
  dayId: string;
  dayDate: string;
  meals: PlannedMeal[];
}

// 日次サマリー
interface DailySummary {
  totalCalories: number;
  completedCount: number;
  totalCount: number;
  cookCount: number;
  buyCount: number;
  outCount: number;
}

// 週間統計
interface WeeklyStats {
  days: { date: string; dayOfWeek: string; cookRate: number; totalCalories: number; mealCount: number }[];
  avgCookRate: number;
  totalCookCount: number;
  totalMealCount: number;
}

// 月間統計
interface MonthlyStats {
  cookCount: number;
  totalMeals: number;
  cookRate: number;
}

// Helper: ローカル日付文字列
const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Helper: 曜日を取得
const getDayOfWeek = (dateStr: string): string => {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  return days[new Date(dateStr).getDay()];
};

export const useHomeData = () => {
  const [user, setUser] = useState<any>(null);
  const [todayPlan, setTodayPlan] = useState<TodayMealPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [dailySummary, setDailySummary] = useState<DailySummary>({
    totalCalories: 0,
    completedCount: 0,
    totalCount: 0,
    cookCount: 0,
    buyCount: 0,
    outCount: 0,
  });
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [activityLevel, setActivityLevel] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  
  // 新規追加
  const [cookingStreak, setCookingStreak] = useState(0);
  const [weeklyStats, setWeeklyStats] = useState<WeeklyStats>({
    days: [],
    avgCookRate: 0,
    totalCookCount: 0,
    totalMealCount: 0,
  });
  const [monthlyStats, setMonthlyStats] = useState<MonthlyStats>({
    cookCount: 0,
    totalMeals: 0,
    cookRate: 0,
  });
  const [expiringItems, setExpiringItems] = useState<PantryItem[]>([]);
  const [shoppingRemaining, setShoppingRemaining] = useState(0);
  const [badgeCount, setBadgeCount] = useState(0);
  const [latestBadge, setLatestBadge] = useState<{ name: string; code: string; obtainedAt: string } | null>(null);
  const [bestMealThisWeek, setBestMealThisWeek] = useState<PlannedMeal | null>(null);

  // 健康記録データ
  const [healthSummary, setHealthSummary] = useState<{
    todayRecord: any | null;
    healthStreak: number;
    weightChange: number | null;
    latestWeight: number | null;
    targetWeight: number | null;
    hasAlert: boolean;
  }>({
    todayRecord: null,
    healthStreak: 0,
    weightChange: null,
    latestWeight: null,
    targetWeight: null,
    hasAlert: false,
  });

  // 栄養分析データ
  const [nutritionAnalysis, setNutritionAnalysis] = useState<{
    score: number;
    issues: string[];
    advice: string | null;
    suggestion: any | null;
    comparison: Record<string, { actual: number; target: number; percentage: number; status: string }>;
    loading: boolean;
  }>({
    score: 0,
    issues: [],
    advice: null,
    suggestion: null,
    comparison: {},
    loading: false,
  });

  // Performance OS v3: パフォーマンス分析データ
  const [performanceAnalysis, setPerformanceAnalysis] = useState<{
    eligible: boolean;
    eligibilityReason: string | null;
    nextAction: { actionType: string; reason: string } | null;
    recommendations: any[];
    todayCheckin: any | null;
    loading: boolean;
  }>({
    eligible: false,
    eligibilityReason: null,
    nextAction: null,
    recommendations: [],
    todayCheckin: null,
    loading: false,
  });

  const supabase = createClient();
  const todayStr = formatLocalDate(new Date());

  const fetchHomeData = async () => {
    setLoading(true);
    
    // 1. ユーザー情報取得
    const { data: { user: authUser } } = await supabase.auth.getUser();
    
    if (authUser) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('nickname')
        .eq('id', authUser.id)
        .single();
      
      setUser({
        ...authUser,
        nickname: profile?.nickname || null,
      });

      // 2. Activity Log
      const { data: activity } = await supabase
        .from('daily_activity_logs')
        .select('*')
        .eq('user_id', authUser.id)
        .eq('date', todayStr)
        .single();
      
      if (activity) {
        setActivityLevel(activity.feeling);
      }

      // 3. 今日の献立を取得（日付ベースモデル: user_daily_meals → planned_meals）
      const { data: dailyMealData } = await supabase
        .from('user_daily_meals')
        .select(`
          id,
          day_date,
          planned_meals(*)
        `)
        .eq('day_date', todayStr)
        .eq('user_id', authUser.id)
        .maybeSingle();

      if (dailyMealData && dailyMealData.planned_meals) {
        const mealsData = dailyMealData.planned_meals;
        const meals: PlannedMeal[] = mealsData.map((m: any) => ({
            id: m.id,
            dailyMealId: m.daily_meal_id,
            mealType: m.meal_type,
            mode: m.mode || 'cook',
            dishName: m.dish_name,
            description: m.description,
            recipeUrl: m.recipe_url,
            imageUrl: m.image_url,
            ingredients: m.ingredients,
            recipeSteps: m.recipe_steps,
            // 基本栄養素
            caloriesKcal: m.calories_kcal,
            proteinG: m.protein_g,
            fatG: m.fat_g,
            carbsG: m.carbs_g,
            // 拡張栄養素
            sodiumG: m.sodium_g ?? null,
            aminoAcidG: m.amino_acid_g ?? null,
            sugarG: m.sugar_g ?? null,
            fiberG: m.fiber_g ?? null,
            fiberSolubleG: m.fiber_soluble_g ?? null,
            fiberInsolubleG: m.fiber_insoluble_g ?? null,
            potassiumMg: m.potassium_mg ?? null,
            calciumMg: m.calcium_mg ?? null,
            magnesiumMg: m.magnesium_mg ?? null,
            phosphorusMg: m.phosphorus_mg ?? null,
            ironMg: m.iron_mg ?? null,
            zincMg: m.zinc_mg ?? null,
            iodineUg: m.iodine_ug ?? null,
            cholesterolMg: m.cholesterol_mg ?? null,
            vitaminB1Mg: m.vitamin_b1_mg ?? null,
            vitaminB2Mg: m.vitamin_b2_mg ?? null,
            vitaminCMg: m.vitamin_c_mg ?? null,
            vitaminB6Mg: m.vitamin_b6_mg ?? null,
            vitaminB12Ug: m.vitamin_b12_ug ?? null,
            folicAcidUg: m.folic_acid_ug ?? null,
            vitaminAUg: m.vitamin_a_ug ?? null,
            vitaminDUg: m.vitamin_d_ug ?? null,
            vitaminKUg: m.vitamin_k_ug ?? null,
            vitaminEMg: m.vitamin_e_mg ?? null,
            saturatedFatG: m.saturated_fat_g ?? null,
            monounsaturatedFatG: m.monounsaturated_fat_g ?? null,
            polyunsaturatedFatG: m.polyunsaturated_fat_g ?? null,
            // その他
            isCompleted: m.is_completed || false,
            completedAt: m.completed_at,
            actualMealId: m.actual_meal_id,
            dishes: m.dishes,
            isSimple: m.is_simple,
            cookingTimeMinutes: m.cooking_time_minutes,
            memo: m.memo || null,
            vegScore: m.veg_score || null,
            qualityTags: m.quality_tags || null,
            displayOrder: m.display_order ?? 0,
            isGenerating: m.is_generating ?? false,
            createdAt: m.created_at,
            updatedAt: m.updated_at,
          }));

          setTodayPlan({
            dayId: dailyMealData.id,
            dayDate: dailyMealData.day_date,
            meals,
          });

          // サマリー計算
          const summary: DailySummary = {
            totalCalories: meals.reduce((sum, m) => sum + (m.caloriesKcal || 0), 0),
            completedCount: meals.filter(m => m.isCompleted).length,
            totalCount: meals.length,
            cookCount: meals.filter(m => m.mode === 'cook' || m.mode === 'quick').length,
            buyCount: meals.filter(m => m.mode === 'buy').length,
            outCount: meals.filter(m => m.mode === 'out').length,
          };
          setDailySummary(summary);
        }

      // ========== 拡張データを並列取得（高速化） ==========
      await Promise.all([
        fetchCookingStreak(authUser.id),
        fetchWeeklyStats(authUser.id),
        fetchMonthlyStats(authUser.id),
        fetchExpiringItems(authUser.id),
        fetchShoppingRemaining(authUser.id),
        fetchBadgeInfo(authUser.id),
        fetchBestMealThisWeek(authUser.id),
        fetchHealthSummary(authUser.id),
      ]);

      // 栄養分析は重いので非同期で後から取得（UIはloadingなしで先に表示）
      fetchNutritionAnalysis();

      // Performance OS v3: パフォーマンス分析も非同期で取得
      fetchPerformanceAnalysis(authUser.id);

    } else {
      setUser(null);
    }

    // 11. Announcements
    try {
      const annRes = await fetch('/api/announcements?mode=public');
      if (annRes.ok) {
        const annData = await annRes.json();
        if (annData.announcements && annData.announcements.length > 0) {
          setAnnouncement(toAnnouncement(annData.announcements[0]));
        }
      }
    } catch (e) {
      console.error("Announcement fetch error", e);
    }

    setLoading(false);
  };

  // 連続自炊ストリーク（完了した自炊のみカウント）
  const fetchCookingStreak = async (userId: string) => {
    try {
      // 過去30日分のデータを取得（日付ベースモデル）
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const { data: daysData } = await supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals(mode, is_completed)
        `)
        .eq('user_id', userId)
        .gte('day_date', formatLocalDate(thirtyDaysAgo))
        .lte('day_date', todayStr)
        .order('day_date', { ascending: false });

      if (daysData && daysData.length > 0) {
        let streak = 0;
        const sortedDays = daysData.sort((a, b) => 
          new Date(b.day_date).getTime() - new Date(a.day_date).getTime()
        );

        for (const day of sortedDays) {
          const meals = (day as any).planned_meals || [];
          // 完了した自炊のみカウント
          const hasCompletedCookMeal = meals.some((m: any) => 
            (m.mode === 'cook' || m.mode === 'quick' || !m.mode) && m.is_completed
          );
          
          if (hasCompletedCookMeal) {
            streak++;
          } else if (day.day_date < todayStr) {
            // 今日以前で完了した自炊がない日があったらストリーク終了
            break;
          }
        }
        setCookingStreak(streak);
      }
    } catch (e) {
      console.error('Streak fetch error:', e);
    }
  };

  // 週間統計（日付ベースモデル）
  const fetchWeeklyStats = async (userId: string) => {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      
      const { data: daysData } = await supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals(mode, is_completed, calories_kcal)
        `)
        .eq('user_id', userId)
        .gte('day_date', formatLocalDate(sevenDaysAgo))
        .lte('day_date', todayStr)
        .order('day_date');

      if (daysData) {
        const days: WeeklyStats['days'] = [];
        let totalCook = 0;
        let totalMeals = 0;

        // 7日分のデータを作成（データがない日も含む）
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dateStr = formatLocalDate(d);
          
          const dayData = daysData.find((dd: any) => dd.day_date === dateStr);
          const meals = (dayData as any)?.planned_meals || [];
          const completedMeals = meals.filter((m: any) => m.is_completed);
          const cookMeals = completedMeals.filter((m: any) => m.mode === 'cook' || m.mode === 'quick');
          
          const mealCount = completedMeals.length;
          const cookRate = mealCount > 0 ? Math.round((cookMeals.length / mealCount) * 100) : 0;
          const totalCalories = meals.reduce((sum: number, m: any) => sum + (m.calories_kcal || 0), 0);
          
          days.push({
            date: dateStr,
            dayOfWeek: getDayOfWeek(dateStr),
            cookRate,
            totalCalories,
            mealCount,
          });
          
          totalCook += cookMeals.length;
          totalMeals += mealCount;
        }

        setWeeklyStats({
          days,
          avgCookRate: totalMeals > 0 ? Math.round((totalCook / totalMeals) * 100) : 0,
          totalCookCount: totalCook,
          totalMealCount: totalMeals,
        });
      }
    } catch (e) {
      console.error('Weekly stats fetch error:', e);
    }
  };

  // 月間統計（日付ベースモデル、完了した自炊のみカウント）
  const fetchMonthlyStats = async (userId: string) => {
    try {
      const firstOfMonth = new Date();
      firstOfMonth.setDate(1);
      
      const { data: daysData } = await supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals(mode, is_completed)
        `)
        .eq('user_id', userId)
        .gte('day_date', formatLocalDate(firstOfMonth))
        .lte('day_date', todayStr);

      if (daysData) {
        let cookCount = 0;
        let totalMeals = 0;

        daysData.forEach((day: any) => {
          const meals = day.planned_meals || [];
          // 完了した食事のみカウント
          const completedMeals = meals.filter((m: any) => m.is_completed);
          totalMeals += completedMeals.length;
          // 完了した自炊（mode='cook', 'quick', またはnull）をカウント
          const completedCookMeals = completedMeals.filter((m: any) => 
            m.mode === 'cook' || m.mode === 'quick' || !m.mode
          );
          cookCount += completedCookMeals.length;
        });

        setMonthlyStats({
          cookCount,
          totalMeals,
          cookRate: totalMeals > 0 ? Math.round((cookCount / totalMeals) * 100) : 0,
        });
      }
    } catch (e) {
      console.error('Monthly stats fetch error:', e);
    }
  };

  // 冷蔵庫の期限切れ間近
  const fetchExpiringItems = async (userId: string) => {
    try {
      const threeDaysLater = new Date();
      threeDaysLater.setDate(threeDaysLater.getDate() + 3);
      
      const { data } = await supabase
        .from('pantry_items')
        .select('*')
        .eq('user_id', userId)
        .lte('expiration_date', formatLocalDate(threeDaysLater))
        .gte('expiration_date', todayStr)
        .order('expiration_date');

      if (data) {
        setExpiringItems(data.map((item: any) => ({
          id: item.id,
          userId: item.user_id,
          name: item.name,
          amount: item.amount,
          category: item.category,
          expirationDate: item.expiration_date,
          addedAt: item.added_at,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        })));
      }
    } catch (e) {
      console.error('Expiring items fetch error:', e);
    }
  };

  // 買い物リスト残数（日付ベースモデル）
  const fetchShoppingRemaining = async (userId: string) => {
    try {
      // アクティブな買い物リストを取得
      const { data: shoppingList } = await supabase
        .from('shopping_lists')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle();

      if (shoppingList) {
        const { count } = await supabase
          .from('shopping_list_items')
          .select('*', { count: 'exact', head: true })
          .eq('shopping_list_id', shoppingList.id)
          .eq('is_checked', false);

        setShoppingRemaining(count || 0);
      }
    } catch (e) {
      console.error('Shopping remaining fetch error:', e);
    }
  };

  // バッジ情報
  const fetchBadgeInfo = async (userId: string) => {
    try {
      // バッジ総数
      const { count } = await supabase
        .from('user_badges')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      setBadgeCount(count || 0);

      // 最新バッジ
      const { data: latestData } = await supabase
        .from('user_badges')
        .select(`
          obtained_at,
          badges(name, code)
        `)
        .eq('user_id', userId)
        .order('obtained_at', { ascending: false })
        .limit(1)
        .single();

      if (latestData && (latestData as any).badges) {
        const badge = (latestData as any).badges;
        setLatestBadge({
          name: badge.name,
          code: badge.code,
          obtainedAt: latestData.obtained_at,
        });
      }
    } catch (e) {
      console.error('Badge info fetch error:', e);
    }
  };

  // 今週のベスト料理（日付ベースモデル）
  const fetchBestMealThisWeek = async (userId: string) => {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      
      const { data } = await supabase
        .from('planned_meals')
        .select(`
          *,
          user_daily_meals!inner(
            day_date,
            user_id
          )
        `)
        .eq('user_daily_meals.user_id', userId)
        .gte('user_daily_meals.day_date', formatLocalDate(sevenDaysAgo))
        .eq('is_completed', true)
        .not('image_url', 'is', null)
        .order('veg_score', { ascending: false, nullsFirst: false })
        .limit(1);

      if (data && data.length > 0) {
        const m = data[0];
        setBestMealThisWeek({
          id: m.id,
          dailyMealId: m.daily_meal_id,
          mealType: m.meal_type,
          mode: m.mode || 'cook',
          dishName: m.dish_name,
          description: m.description,
          recipeUrl: m.recipe_url,
          imageUrl: m.image_url,
          ingredients: m.ingredients,
          recipeSteps: m.recipe_steps || null,
          // 基本栄養素
          caloriesKcal: m.calories_kcal,
          proteinG: m.protein_g,
          fatG: m.fat_g,
          carbsG: m.carbs_g,
          // 拡張栄養素
          sodiumG: m.sodium_g ?? null,
          aminoAcidG: m.amino_acid_g ?? null,
          sugarG: m.sugar_g ?? null,
          fiberG: m.fiber_g ?? null,
          fiberSolubleG: m.fiber_soluble_g ?? null,
          fiberInsolubleG: m.fiber_insoluble_g ?? null,
          potassiumMg: m.potassium_mg ?? null,
          calciumMg: m.calcium_mg ?? null,
          magnesiumMg: m.magnesium_mg ?? null,
          phosphorusMg: m.phosphorus_mg ?? null,
          ironMg: m.iron_mg ?? null,
          zincMg: m.zinc_mg ?? null,
          iodineUg: m.iodine_ug ?? null,
          cholesterolMg: m.cholesterol_mg ?? null,
          vitaminB1Mg: m.vitamin_b1_mg ?? null,
          vitaminB2Mg: m.vitamin_b2_mg ?? null,
          vitaminCMg: m.vitamin_c_mg ?? null,
          vitaminB6Mg: m.vitamin_b6_mg ?? null,
          vitaminB12Ug: m.vitamin_b12_ug ?? null,
          folicAcidUg: m.folic_acid_ug ?? null,
          vitaminAUg: m.vitamin_a_ug ?? null,
          vitaminDUg: m.vitamin_d_ug ?? null,
          vitaminKUg: m.vitamin_k_ug ?? null,
          vitaminEMg: m.vitamin_e_mg ?? null,
          saturatedFatG: m.saturated_fat_g ?? null,
          monounsaturatedFatG: m.monounsaturated_fat_g ?? null,
          polyunsaturatedFatG: m.polyunsaturated_fat_g ?? null,
          // その他
          isCompleted: m.is_completed || false,
          completedAt: m.completed_at,
          actualMealId: m.actual_meal_id,
          dishes: m.dishes,
          isSimple: m.is_simple,
          cookingTimeMinutes: m.cooking_time_minutes,
          memo: m.memo,
          vegScore: m.veg_score,
          qualityTags: m.quality_tags,
          displayOrder: m.display_order ?? 0,
          isGenerating: m.is_generating ?? false,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
        });
      }
    } catch (e) {
      console.error('Best meal fetch error:', e);
    }
  };

  // 健康記録サマリー
  const fetchHealthSummary = async (userId: string) => {
    try {
      // 今日の記録
      const { data: todayRecord } = await supabase
        .from('health_records')
        .select('*')
        .eq('user_id', userId)
        .eq('record_date', todayStr)
        .single();

      // 連続記録
      const { data: streak } = await supabase
        .from('health_streaks')
        .select('current_streak')
        .eq('user_id', userId)
        .eq('streak_type', 'daily_record')
        .single();

      // 最新の体重と昨日の体重
      const { data: recentWeights } = await supabase
        .from('health_records')
        .select('weight, record_date')
        .eq('user_id', userId)
        .not('weight', 'is', null)
        .order('record_date', { ascending: false })
        .limit(2);

      let weightChange = null;
      let latestWeight = null;
      if (recentWeights && recentWeights.length > 0) {
        latestWeight = recentWeights[0].weight;
        if (recentWeights.length > 1) {
          weightChange = parseFloat((recentWeights[0].weight - recentWeights[1].weight).toFixed(2));
        }
      }

      // 目標体重
      const { data: weightGoal } = await supabase
        .from('health_goals')
        .select('target_value')
        .eq('user_id', userId)
        .eq('goal_type', 'weight')
        .eq('status', 'active')
        .single();

      // アラートがあるか確認
      const { count: alertCount } = await supabase
        .from('health_insights')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_alert', true)
        .eq('is_dismissed', false);

      setHealthSummary({
        todayRecord,
        healthStreak: streak?.current_streak || 0,
        weightChange,
        latestWeight,
        targetWeight: weightGoal?.target_value || null,
        hasAlert: (alertCount || 0) > 0,
      });
    } catch (e) {
      console.error('Health summary fetch error:', e);
    }
  };

  // 栄養分析（AIアドバイス付き）
  const fetchNutritionAnalysis = async () => {
    try {
      setNutritionAnalysis(prev => ({ ...prev, loading: true }));
      
      const response = await fetch('/api/ai/nutrition-analysis?period=today&includeAdvice=true&includeSuggestion=true');
      
      if (response.ok) {
        const data = await response.json();
        
        if (data.success && data.analysis) {
          setNutritionAnalysis({
            score: data.analysis.score || 0,
            issues: data.analysis.issues || [],
            advice: data.advice || null,
            suggestion: data.suggestion || null,
            comparison: data.analysis.comparison || {},
            loading: false,
          });
          
          // AIアドバイスをsuggestに設定
          if (data.advice && !suggestion) {
            setSuggestion(data.advice);
          }
        } else {
          setNutritionAnalysis(prev => ({ ...prev, loading: false }));
        }
      } else {
        setNutritionAnalysis(prev => ({ ...prev, loading: false }));
      }
    } catch (e) {
      console.error('Nutrition analysis fetch error:', e);
      setNutritionAnalysis(prev => ({ ...prev, loading: false }));
    }
  };

  // Performance OS v3: パフォーマンス分析を取得
  const fetchPerformanceAnalysis = async (userId: string) => {
    try {
      setPerformanceAnalysis(prev => ({ ...prev, loading: true }));

      // 今日のチェックインを取得
      const { data: todayCheckin } = await supabase
        .from('user_performance_checkins')
        .select('*')
        .eq('user_id', userId)
        .eq('checkin_date', todayStr)
        .maybeSingle();

      // 7日分析を取得
      const response = await fetch(`/api/performance/analyze?date=${todayStr}`);

      if (response.ok) {
        const data = await response.json();

        setPerformanceAnalysis({
          eligible: data.eligible || false,
          eligibilityReason: data.eligibilityReason || null,
          nextAction: data.analysis?.nextAction || null,
          recommendations: data.analysis?.recommendations || [],
          todayCheckin,
          loading: false,
        });
      } else {
        setPerformanceAnalysis(prev => ({
          ...prev,
          todayCheckin,
          loading: false
        }));
      }
    } catch (e) {
      console.error('Performance analysis fetch error:', e);
      setPerformanceAnalysis(prev => ({ ...prev, loading: false }));
    }
  };

  // Performance OS v3: 30秒チェックインを保存
  const submitPerformanceCheckin = async (checkinData: {
    sleepHours?: number;
    sleepQuality?: number;
    fatigue?: number;
    focus?: number;
    hunger?: number;
    trainingLoadRpe?: number;
    trainingMinutes?: number;
    weight?: number;
    note?: string;
  }) => {
    try {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) return { success: false, error: 'Not authenticated' };

      const { data, error } = await supabase
        .from('user_performance_checkins')
        .upsert({
          user_id: authUser.id,
          checkin_date: todayStr,
          sleep_hours: checkinData.sleepHours,
          sleep_quality: checkinData.sleepQuality,
          fatigue: checkinData.fatigue,
          focus: checkinData.focus,
          hunger: checkinData.hunger,
          training_load_rpe: checkinData.trainingLoadRpe,
          training_minutes: checkinData.trainingMinutes,
          weight: checkinData.weight,
          note: checkinData.note,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id, checkin_date' })
        .select()
        .single();

      if (error) {
        console.error('Checkin save error:', error);
        return { success: false, error: error.message };
      }

      // チェックイン後に分析を再取得
      await fetchPerformanceAnalysis(authUser.id);

      return { success: true, data };
    } catch (e) {
      console.error('Checkin submit error:', e);
      return { success: false, error: 'Unknown error' };
    }
  };

  // AIが提案した献立変更を実行
  const executeNutritionSuggestion = async () => {
    // suggestionがなくても、issuesがあれば献立変更を提案
    const suggestion = nutritionAnalysis.suggestion;
    const issues = nutritionAnalysis.issues || [];
    
    if (!suggestion && issues.length === 0) {
      setSuggestion('現在提案できる献立変更はありません。');
      return;
    }
    
    try {
      // suggestionがある場合はそれを使用、なければissuesから生成
      let targetDate = todayStr;
      let targetMealType = 'dinner';
      let prompt = '';
      
      if (suggestion) {
        targetDate = suggestion.targetDate || todayStr;
        targetMealType = suggestion.targetMeal || 'dinner';
        const dishes = suggestion.suggestedDishes || [];
        const dishNames = dishes.map((d: any) => d.name).join('、');
        prompt = suggestion.currentIssue 
          ? `${suggestion.currentIssue}を解決するために${dishNames ? `、${dishNames}を含めた` : ''}バランスの良い献立に変更してください。`
          : `栄養バランスを改善する献立に変更してください。`;
      } else {
        // issuesから自動生成
        prompt = `${issues[0]}。この問題を解決するバランスの良い献立に変更してください。`;
      }
      
      setSuggestion('献立を変更中...');
      
      const response = await fetch('/api/ai/nutrition-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDate,
          targetMealType,
          prompt,
        }),
      });
      
      if (response.ok) {
        // 成功したらデータを再取得
        await fetchHomeData();
        setSuggestion('🎉 献立を変更しました！');
      } else {
        const errorData = await response.json().catch(() => ({}));
        setSuggestion(`変更に失敗しました: ${errorData.error || 'エラーが発生しました'}`);
      }
    } catch (e) {
      console.error('Execute nutrition suggestion error:', e);
      setSuggestion('変更に失敗しました。もう一度お試しください。');
    }
  };

  // 食事完了をトグル
  const toggleMealCompletion = async (mealId: string, currentStatus: boolean) => {
    const newStatus = !currentStatus;
    
    // 楽観的UI更新
    setTodayPlan(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        meals: prev.meals.map(m => 
          m.id === mealId 
            ? { ...m, isCompleted: newStatus, completedAt: newStatus ? new Date().toISOString() : null }
            : m
        ),
      };
    });

    // サマリー更新
    setDailySummary(prev => ({
      ...prev,
      completedCount: newStatus ? prev.completedCount + 1 : prev.completedCount - 1,
    }));

    // DB更新
    const { error } = await supabase
      .from('planned_meals')
      .update({
        is_completed: newStatus,
        completed_at: newStatus ? new Date().toISOString() : null,
      })
      .eq('id', mealId);

    if (error) {
      console.error('Toggle completion error:', error);
      fetchHomeData();
    }
  };

  useEffect(() => {
    fetchHomeData();
  }, []);

  const updateActivityLevel = async (level: string) => {
    if (!user) return;
    setActivityLevel(level);

    await supabase
      .from('daily_activity_logs')
      .upsert({
        user_id: user.id,
        date: todayStr,
        feeling: level,
      }, { onConflict: 'user_id, date' });

    // AIサジェスト生成
    if (level === 'rest') {
      setSuggestion("今日は運動量が少なめです。夕食の炭水化物を半分にして調整しましょう。");
    } else if (level === 'active') {
      setSuggestion("ナイスワークアウト！夕食でタンパク質を多めに摂り、筋肉の回復を促しましょう。");
    } else if (level === 'stressed') {
      setSuggestion("ストレスを感じているときは、ビタミンB群を含む食材がおすすめです。");
    } else {
      setSuggestion(null);
    }
  };

  return {
    user,
    todayPlan,
    loading,
    dailySummary,
    announcement,
    activityLevel,
    suggestion,
    // 新規追加
    cookingStreak,
    weeklyStats,
    monthlyStats,
    expiringItems,
    shoppingRemaining,
    badgeCount,
    latestBadge,
    bestMealThisWeek,
    healthSummary,
    nutritionAnalysis,
    // Performance OS v3
    performanceAnalysis,
    // 関数
    toggleMealCompletion,
    updateActivityLevel,
    setAnnouncement,
    setSuggestion,
    executeNutritionSuggestion,
    submitPerformanceCheckin,
    refetch: fetchHomeData,
  };
};
