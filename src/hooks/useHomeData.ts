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

      // 3. 今日の献立を取得（planned_mealsベース）
      const { data: dayData } = await supabase
        .from('meal_plan_days')
        .select(`
          id,
          day_date,
          meal_plan_id,
          meal_plans!inner(user_id)
        `)
        .eq('day_date', todayStr)
        .eq('meal_plans.user_id', authUser.id)
        .single();

      if (dayData) {
        const { data: mealsData } = await supabase
          .from('planned_meals')
          .select('*')
          .eq('meal_plan_day_id', dayData.id)
          .order('meal_type');

        if (mealsData) {
          const meals: PlannedMeal[] = mealsData.map((m: any) => ({
            id: m.id,
            mealPlanDayId: m.meal_plan_day_id,
            mealType: m.meal_type,
            mode: m.mode || 'cook',
            dishName: m.dish_name,
            description: m.description,
            recipeUrl: m.recipe_url,
            imageUrl: m.image_url,
            ingredients: m.ingredients,
            caloriesKcal: m.calories_kcal,
            proteinG: m.protein_g,
            fatG: m.fat_g,
            carbsG: m.carbs_g,
            isCompleted: m.is_completed || false,
            completedAt: m.completed_at,
            actualMealId: m.actual_meal_id,
            dishes: m.dishes,
            isSimple: m.is_simple,
            cookingTimeMinutes: m.cooking_time_minutes,
            memo: m.memo || null,
            vegScore: m.veg_score || null,
            qualityTags: m.quality_tags || null,
            createdAt: m.created_at,
            updatedAt: m.updated_at,
          }));

          setTodayPlan({
            dayId: dayData.id,
            dayDate: dayData.day_date,
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
      }

      // ========== 新規: 拡張データ取得 ==========

      // 4. 連続自炊ストリーク計算
      await fetchCookingStreak(authUser.id);

      // 5. 週間統計
      await fetchWeeklyStats(authUser.id);

      // 6. 月間統計
      await fetchMonthlyStats(authUser.id);

      // 7. 冷蔵庫の期限切れ間近アイテム
      await fetchExpiringItems(authUser.id);

      // 8. 買い物リスト残数
      await fetchShoppingRemaining(authUser.id);

      // 9. バッジ情報
      await fetchBadgeInfo(authUser.id);

      // 10. 今週のベスト料理
      await fetchBestMealThisWeek(authUser.id);

      // 11. 健康記録サマリー
      await fetchHealthSummary(authUser.id);

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
      // 過去30日分のデータを取得
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const { data: daysData } = await supabase
        .from('meal_plan_days')
        .select(`
          day_date,
          meal_plan_id,
          meal_plans!inner(user_id),
          planned_meals(mode, is_completed)
        `)
        .eq('meal_plans.user_id', userId)
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

  // 週間統計
  const fetchWeeklyStats = async (userId: string) => {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      
      const { data: daysData } = await supabase
        .from('meal_plan_days')
        .select(`
          day_date,
          meal_plans!inner(user_id),
          planned_meals(mode, is_completed, calories_kcal)
        `)
        .eq('meal_plans.user_id', userId)
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

  // 月間統計
  // 月間統計（完了した自炊のみカウント）
  const fetchMonthlyStats = async (userId: string) => {
    try {
      const firstOfMonth = new Date();
      firstOfMonth.setDate(1);
      
      const { data: daysData } = await supabase
        .from('meal_plan_days')
        .select(`
          day_date,
          meal_plans!inner(user_id),
          planned_meals(mode, is_completed)
        `)
        .eq('meal_plans.user_id', userId)
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

  // 買い物リスト残数
  const fetchShoppingRemaining = async (userId: string) => {
    try {
      // 現在アクティブなmeal_planの買い物リストを取得
      const { data: planData } = await supabase
        .from('meal_plans')
        .select('id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();

      if (planData) {
        const { count } = await supabase
          .from('shopping_list_items')
          .select('*', { count: 'exact', head: true })
          .eq('meal_plan_id', planData.id)
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

  // 今週のベスト料理
  const fetchBestMealThisWeek = async (userId: string) => {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      
      const { data } = await supabase
        .from('planned_meals')
        .select(`
          *,
          meal_plan_days!inner(
            day_date,
            meal_plans!inner(user_id)
          )
        `)
        .eq('meal_plan_days.meal_plans.user_id', userId)
        .gte('meal_plan_days.day_date', formatLocalDate(sevenDaysAgo))
        .eq('is_completed', true)
        .not('image_url', 'is', null)
        .order('veg_score', { ascending: false, nullsFirst: false })
        .limit(1);

      if (data && data.length > 0) {
        const m = data[0];
        setBestMealThisWeek({
          id: m.id,
          mealPlanDayId: m.meal_plan_day_id,
          mealType: m.meal_type,
          mode: m.mode || 'cook',
          dishName: m.dish_name,
          description: m.description,
          recipeUrl: m.recipe_url,
          imageUrl: m.image_url,
          ingredients: m.ingredients,
          caloriesKcal: m.calories_kcal,
          proteinG: m.protein_g,
          fatG: m.fat_g,
          carbsG: m.carbs_g,
          isCompleted: m.is_completed || false,
          completedAt: m.completed_at,
          actualMealId: m.actual_meal_id,
          dishes: m.dishes,
          isSimple: m.is_simple,
          cookingTimeMinutes: m.cooking_time_minutes,
          memo: m.memo,
          vegScore: m.veg_score,
          qualityTags: m.quality_tags,
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
    // 関数
    toggleMealCompletion,
    updateActivityLevel,
    setAnnouncement,
    setSuggestion,
    refetch: fetchHomeData,
  };
};
