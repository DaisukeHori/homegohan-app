import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toMeal, toMealNutritionEstimate, toAnnouncement, toDailyActivityLog } from "@/lib/converter";
import type { Meal, MealNutritionEstimate, Announcement } from "@/types/domain";

interface MealWithNutrition extends Meal {
  nutrition?: MealNutritionEstimate;
}

export const useHomeData = () => {
  const [user, setUser] = useState<any>(null);
  const [meals, setMeals] = useState<MealWithNutrition[]>([]);
  const [loading, setLoading] = useState(true);
  const [dailySummary, setDailySummary] = useState({
    energyKcal: 0,
    proteinG: 0,
    fatG: 0,
    carbsG: 0,
    targetEnergy: 2200,
    targetProtein: 80,
    targetFat: 60,
    targetCarbs: 280,
  });
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [activityLevel, setActivityLevel] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const supabase = createClient();

  const fetchHomeData = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    setUser(user);

    if (user) {
      // 1. Activity Log
      const today = new Date().toISOString().split('T')[0];
      const { data: activity } = await supabase
        .from('daily_activity_logs')
        .select('*')
        .eq('user_id', user.id)
        .eq('date', today)
        .single();
      
      if (activity) {
        setActivityLevel(activity.feeling);
      }

      // 2. Meals
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

      const { data: mealsData, error: mealsError } = await supabase
        .from('meals')
        .select('*')
        .eq('user_id', user.id)
        .gte('eaten_at', startOfDay)
        .lt('eaten_at', endOfDay)
        .order('eaten_at', { ascending: true });

      if (mealsData && !mealsError) {
        const mealIds = mealsData.map((m: any) => m.id);
        let nutritionMap: Record<string, MealNutritionEstimate> = {};
        
        if (mealIds.length > 0) {
          const { data: nutritionData } = await supabase
            .from('meal_nutrition_estimates')
            .select('*')
            .in('meal_id', mealIds);
          
          if (nutritionData) {
            nutritionData.forEach((n: any) => {
              nutritionMap[n.meal_id] = toMealNutritionEstimate(n);
            });
          }
        }

        const mergedMeals = mealsData.map((m: any) => {
          const meal = toMeal(m);
          return { ...meal, nutrition: nutritionMap[meal.id] };
        });

        setMeals(mergedMeals);

        const summary = mergedMeals.reduce((acc, curr) => {
          const n = curr.nutrition;
          if (!n) return acc;
          return {
            energyKcal: acc.energyKcal + (n.energyKcal || 0),
            proteinG: acc.proteinG + (n.proteinG || 0),
            fatG: acc.fatG + (n.fatG || 0),
            carbsG: acc.carbsG + (n.carbsG || 0),
          };
        }, { energyKcal: 0, proteinG: 0, fatG: 0, carbsG: 0 });

        setDailySummary(prev => ({ ...prev, ...summary }));
      }
    }

    // 3. Announcements
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

  useEffect(() => {
    fetchHomeData();
  }, []);

  const updateActivityLevel = async (level: string) => {
    if (!user) return;
    setActivityLevel(level);
    const today = new Date().toISOString().split('T')[0];

    await supabase
      .from('daily_activity_logs')
      .upsert({
        user_id: user.id,
        date: today,
        feeling: level,
      }, { onConflict: 'user_id, date' });

    if (level === 'rest') setSuggestion("今日は運動量が少なめです。夕食の炭水化物を半分にして調整しましょう。");
    else if (level === 'active') setSuggestion("ナイスワークアウト！夕食でタンパク質を多めに摂り、筋肉の回復を促しましょう。");
    else setSuggestion(null);
  };

  return {
    user,
    meals,
    loading,
    dailySummary,
    announcement,
    activityLevel,
    suggestion,
    updateActivityLevel,
    setAnnouncement,
    setSuggestion
  };
};

