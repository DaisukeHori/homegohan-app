import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toAnnouncement } from "@/lib/converter";
import type { Announcement, PlannedMeal, MealPlanDay } from "@/types/domain";

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

// Helper: ローカル日付文字列
const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
      // まず今日を含むmeal_plan_dayを探す
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
        // その日のplanned_mealsを取得
        const { data: mealsData } = await supabase
          .from('planned_meals')
          .select('*')
          .eq('meal_plan_day_id', dayData.id)
          .order('meal_type');

        if (mealsData) {
          // snake_case -> camelCase 変換
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
    } else {
      setUser(null);
    }

    // 4. Announcements
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
      // エラー時はロールバック
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
    toggleMealCompletion,
    updateActivityLevel,
    setAnnouncement,
    setSuggestion,
    refetch: fetchHomeData,
  };
};
