import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { getApi } from "../lib/api";
import { formatLocalDate } from "@homegohan/core";

interface DailySummary {
  totalCalories: number;
  completedCount: number;
  totalCount: number;
  cookCount: number;
  buyCount: number;
  outCount: number;
}

interface WeeklyStats {
  days: { date: string; dayOfWeek: string; cookRate: number; totalCalories: number; mealCount: number }[];
  avgCookRate: number;
  totalCookCount: number;
  totalMealCount: number;
}

interface MonthlyStats {
  cookCount: number;
  totalMeals: number;
  cookRate: number;
}

interface HealthSummary {
  todayRecord: any | null;
  healthStreak: number;
  weightChange: number | null;
  latestWeight: number | null;
  targetWeight: number | null;
  hasAlert: boolean;
}

interface NutritionAnalysis {
  score: number;
  issues: string[];
  advice: string | null;
  suggestion: any | null;
  comparison: Record<string, { actual: number; target: number; percentage: number; status: string }>;
  loading: boolean;
}

interface TodayMeal {
  id: string;
  meal_type: string;
  mode: string | null;
  dish_name: string | null;
  calories_kcal: number | null;
  is_completed: boolean | null;
  image_url: string | null;
}

interface BestMeal {
  id: string;
  dish_name: string | null;
  image_url: string;
  veg_score: number | null;
}

const DOW = ["日", "月", "火", "水", "木", "金", "土"];
// todayStr is computed fresh on each fetchAll call, not cached at module level
function getTodayStr() { return formatLocalDate(new Date()); }

export const useHomeData = (userId: string | undefined) => {
  const [loading, setLoading] = useState(true);
  const [todayMeals, setTodayMeals] = useState<TodayMeal[]>([]);
  const [dailySummary, setDailySummary] = useState<DailySummary>({
    totalCalories: 0, completedCount: 0, totalCount: 0, cookCount: 0, buyCount: 0, outCount: 0,
  });
  const [cookingStreak, setCookingStreak] = useState(0);
  const [weeklyStats, setWeeklyStats] = useState<WeeklyStats>({
    days: [], avgCookRate: 0, totalCookCount: 0, totalMealCount: 0,
  });
  const [monthlyStats, setMonthlyStats] = useState<MonthlyStats>({
    cookCount: 0, totalMeals: 0, cookRate: 0,
  });
  const [healthSummary, setHealthSummary] = useState<HealthSummary>({
    todayRecord: null, healthStreak: 0, weightChange: null, latestWeight: null, targetWeight: null, hasAlert: false,
  });
  const [nutritionAnalysis, setNutritionAnalysis] = useState<NutritionAnalysis>({
    score: 0, issues: [], advice: null, suggestion: null, comparison: {}, loading: false,
  });
  const [expiringItems, setExpiringItems] = useState<any[]>([]);
  const [shoppingRemaining, setShoppingRemaining] = useState(0);
  const [badgeCount, setBadgeCount] = useState(0);
  const [latestBadge, setLatestBadge] = useState<{ name: string; code: string; obtainedAt: string } | null>(null);
  const [bestMealThisWeek, setBestMealThisWeek] = useState<BestMeal | null>(null);

  // ─── Announcements ───
  const [announcements, setAnnouncements] = useState<{ id: string; title: string; content: string }[]>([]);

  // #407: meal toggle debounce — pending mealId set + 250ms debounce timer
  const pendingToggleRef = useRef<Set<string>>(new Set());
  const toggleDebounceTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  async function fetchAll() {
    if (!userId) return;
    setLoading(true);

    try {
      await Promise.all([
        fetchTodayMeals(userId),
        fetchCookingStreak(userId),
        fetchWeeklyStats(userId),
        fetchMonthlyStats(userId),
        fetchHealthSummary(userId),
        fetchExpiringItems(userId),
        fetchShoppingRemaining(userId),
        fetchBadgeInfo(userId),
        fetchActivityLevel(userId),
        fetchAnnouncements(),
        fetchBestMealThisWeek(userId),
      ]);

      // Heavier fetches — async
      fetchNutritionAnalysis();
      if (userId) fetchPerformanceAnalysis(userId);
    } catch (e) {
      console.error("useHomeData fetchAll error:", e);
    } finally {
      setLoading(false);
    }
  }

  async function fetchTodayMeals(uid: string) {
    const { data: dayData } = await supabase
      .from("user_daily_meals")
      .select(`id, day_date, planned_meals(id, meal_type, mode, dish_name, calories_kcal, is_completed, image_url)`)
      .eq("day_date", getTodayStr())
      .eq("user_id", uid)
      .maybeSingle();

    if (dayData) {
      const meals = (dayData as any)?.planned_meals ?? [];
      setTodayMeals(meals);
      setDailySummary({
        totalCalories: meals.reduce((s: number, m: any) => s + (m.calories_kcal ?? 0), 0),
        completedCount: meals.filter((m: any) => m.is_completed).length,
        totalCount: meals.length,
        cookCount: meals.filter((m: any) => m.mode === "cook" || m.mode === "quick").length,
        buyCount: meals.filter((m: any) => m.mode === "buy").length,
        outCount: meals.filter((m: any) => m.mode === "out").length,
      });
    } else {
      setTodayMeals([]);
      setDailySummary({ totalCalories: 0, completedCount: 0, totalCount: 0, cookCount: 0, buyCount: 0, outCount: 0 });
    }
  }

  async function fetchCookingStreak(uid: string) {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const { data: daysData } = await supabase
        .from("user_daily_meals")
        .select(`day_date, planned_meals(mode, is_completed)`)
        .eq("user_id", uid)
        .gte("day_date", formatLocalDate(thirtyDaysAgo))
        .lte("day_date", getTodayStr())
        .order("day_date", { ascending: false });

      if (daysData && daysData.length > 0) {
        let streak = 0;
        for (const day of daysData) {
          const meals = (day as any).planned_meals || [];
          const hasCompletedCook = meals.some((m: any) =>
            (m.mode === "cook" || m.mode === "quick" || !m.mode) && m.is_completed
          );
          if (hasCompletedCook) {
            streak++;
          } else if (day.day_date < getTodayStr()) {
            break;
          }
        }
        setCookingStreak(streak);
      }
    } catch (e) {
      console.error("Streak fetch error:", e);
    }
  }

  async function fetchWeeklyStats(uid: string) {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

      const { data: daysData } = await supabase
        .from("user_daily_meals")
        .select(`day_date, planned_meals(mode, is_completed, calories_kcal)`)
        .eq("user_id", uid)
        .gte("day_date", formatLocalDate(sevenDaysAgo))
        .lte("day_date", getTodayStr())
        .order("day_date");

      if (daysData) {
        const days: WeeklyStats["days"] = [];
        let totalCook = 0;
        let totalMeals = 0;

        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dateStr = formatLocalDate(d);
          const dayData = daysData.find((dd: any) => dd.day_date === dateStr);
          const meals = (dayData as any)?.planned_meals || [];
          const completedMeals = meals.filter((m: any) => m.is_completed);
          const cookMeals = completedMeals.filter((m: any) => m.mode === "cook" || m.mode === "quick");
          const mealCount = completedMeals.length;
          const cookRate = mealCount > 0 ? Math.round((cookMeals.length / mealCount) * 100) : 0;
          const totalCalories = meals.reduce((s: number, m: any) => s + (m.calories_kcal || 0), 0);

          days.push({ date: dateStr, dayOfWeek: DOW[d.getDay()], cookRate, totalCalories, mealCount });
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
      console.error("Weekly stats fetch error:", e);
    }
  }

  async function fetchMonthlyStats(uid: string) {
    try {
      const firstOfMonth = new Date();
      firstOfMonth.setDate(1);

      const { data: daysData } = await supabase
        .from("user_daily_meals")
        .select(`day_date, planned_meals(mode, is_completed)`)
        .eq("user_id", uid)
        .gte("day_date", formatLocalDate(firstOfMonth))
        .lte("day_date", getTodayStr());

      if (daysData) {
        let cookCount = 0;
        let totalMeals = 0;
        daysData.forEach((day: any) => {
          const meals = day.planned_meals || [];
          const completed = meals.filter((m: any) => m.is_completed);
          totalMeals += completed.length;
          cookCount += completed.filter((m: any) => m.mode === "cook" || m.mode === "quick" || !m.mode).length;
        });
        setMonthlyStats({ cookCount, totalMeals, cookRate: totalMeals > 0 ? Math.round((cookCount / totalMeals) * 100) : 0 });
      }
    } catch (e) {
      console.error("Monthly stats fetch error:", e);
    }
  }

  async function fetchHealthSummary(uid: string) {
    try {
      const [todayRes, streakRes, weightsRes, goalRes, alertRes] = await Promise.all([
        supabase.from("health_records").select("*").eq("user_id", uid).eq("record_date", getTodayStr()).maybeSingle(),
        supabase.from("health_streaks").select("current_streak").eq("user_id", uid).eq("streak_type", "daily_record").maybeSingle(),
        supabase.from("health_records").select("weight, record_date").eq("user_id", uid).not("weight", "is", null).order("record_date", { ascending: false }).limit(2),
        supabase.from("health_goals").select("target_value").eq("user_id", uid).eq("goal_type", "weight").eq("status", "active").maybeSingle(),
        supabase.from("health_insights").select("*", { count: "exact", head: true }).eq("user_id", uid).eq("is_alert", true).eq("is_dismissed", false),
      ]);

      let weightChange = null;
      let latestWeight = null;
      if (weightsRes.data && weightsRes.data.length > 0) {
        latestWeight = weightsRes.data[0].weight;
        if (weightsRes.data.length > 1) {
          weightChange = parseFloat((weightsRes.data[0].weight - weightsRes.data[1].weight).toFixed(2));
        }
      }

      setHealthSummary({
        todayRecord: todayRes.data,
        healthStreak: streakRes.data?.current_streak || 0,
        weightChange,
        latestWeight,
        targetWeight: goalRes.data?.target_value || null,
        hasAlert: (alertRes.count || 0) > 0,
      });
    } catch (e) {
      console.error("Health summary fetch error:", e);
    }
  }

  async function fetchExpiringItems(uid: string) {
    try {
      const threeDaysLater = new Date();
      threeDaysLater.setDate(threeDaysLater.getDate() + 3);

      const { data } = await supabase
        .from("pantry_items")
        .select("*")
        .eq("user_id", uid)
        .lte("expiration_date", formatLocalDate(threeDaysLater))
        .gte("expiration_date", getTodayStr())
        .order("expiration_date");

      if (data) setExpiringItems(data);
    } catch (e) {
      console.error("Expiring items fetch error:", e);
    }
  }

  async function fetchShoppingRemaining(uid: string) {
    try {
      const { data: shoppingList } = await supabase
        .from("shopping_lists")
        .select("id")
        .eq("user_id", uid)
        .eq("status", "active")
        .maybeSingle();

      if (shoppingList) {
        const { count } = await supabase
          .from("shopping_list_items")
          .select("*", { count: "exact", head: true })
          .eq("shopping_list_id", shoppingList.id)
          .eq("is_checked", false);
        setShoppingRemaining(count || 0);
      }
    } catch (e) {
      console.error("Shopping remaining fetch error:", e);
    }
  }

  async function fetchBadgeInfo(uid: string) {
    try {
      const { count } = await supabase
        .from("user_badges")
        .select("*", { count: "exact", head: true })
        .eq("user_id", uid);
      setBadgeCount(count || 0);

      const { data: latestData } = await supabase
        .from("user_badges")
        .select(`obtained_at, badges(name, code)`)
        .eq("user_id", uid)
        .order("obtained_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestData && (latestData as any).badges) {
        const badge = (latestData as any).badges;
        setLatestBadge({ name: badge.name, code: badge.code, obtainedAt: latestData.obtained_at });
      }
    } catch (e) {
      console.error("Badge info fetch error:", e);
    }
  }

  async function fetchAnnouncements() {
    try {
      const api = getApi();
      const data = await api.get<any>("/api/announcements?mode=public");
      if (data?.announcements && Array.isArray(data.announcements)) {
        setAnnouncements(
          data.announcements.map((a: any) => ({
            id: String(a.id ?? a.announcement_id ?? Math.random()),
            title: a.title ?? "",
            content: a.content ?? "",
          }))
        );
      }
    } catch (e) {
      // E2E 環境でもネットワーク到達不可の場合があるため warn に変更 (LogBox 自動オープンを防ぐ)
      console.warn("Announcements fetch error:", e);
    }
  }

  async function fetchBestMealThisWeek(uid: string) {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

      const { data } = await supabase
        .from("planned_meals")
        .select(`
          id,
          dish_name,
          image_url,
          veg_score,
          user_daily_meals!inner(
            day_date,
            user_id
          )
        `)
        .eq("user_daily_meals.user_id", uid)
        .gte("user_daily_meals.day_date", formatLocalDate(sevenDaysAgo))
        .eq("is_completed", true)
        .not("image_url", "is", null)
        .order("veg_score", { ascending: false, nullsFirst: false })
        .limit(1);

      if (data && data.length > 0 && (data[0] as any).image_url) {
        const row = data[0] as any;
        setBestMealThisWeek({
          id: row.id,
          dish_name: row.dish_name,
          image_url: row.image_url,
          veg_score: row.veg_score,
        });
      } else {
        setBestMealThisWeek(null);
      }
    } catch (e) {
      console.error("Best meal fetch error:", e);
    }
  }

  async function fetchNutritionAnalysis() {
    try {
      setNutritionAnalysis((prev) => ({ ...prev, loading: true }));
      const api = getApi();
      const data = await api.get<any>("/api/ai/nutrition-analysis?period=today&includeAdvice=true&includeSuggestion=true");

      if (data?.success && data?.analysis) {
        setNutritionAnalysis({
          score: data.analysis.score || 0,
          issues: data.analysis.issues || [],
          advice: data.advice || null,
          suggestion: data.suggestion || null,
          comparison: data.analysis.comparison || {},
          loading: false,
        });
      } else {
        setNutritionAnalysis((prev) => ({ ...prev, loading: false }));
      }
    } catch (e) {
      // API server not running is expected in dev - silently skip
      setNutritionAnalysis((prev) => ({ ...prev, loading: false }));
    }
  }

  async function executeNutritionSuggestion() {
    const suggestionData = nutritionAnalysis.suggestion;
    const issues = nutritionAnalysis.issues || [];

    if (!suggestionData && issues.length === 0) {
      setSuggestion("現在提案できる献立変更はありません。");
      return;
    }

    try {
      const todayStr = getTodayStr();
      let targetDate = todayStr;
      let targetMealType = "dinner";
      let prompt = "";

      if (suggestionData) {
        targetDate = suggestionData.targetDate || todayStr;
        targetMealType = suggestionData.targetMeal || "dinner";
        const dishes = suggestionData.suggestedDishes || [];
        const dishNames = dishes.map((d: any) => d.name).join("、");
        prompt = suggestionData.currentIssue
          ? `${suggestionData.currentIssue}を解決するために${dishNames ? `、${dishNames}を含めた` : ""}バランスの良い献立に変更してください。`
          : "栄養バランスを改善する献立に変更してください。";
      } else {
        prompt = `${issues[0]}。この問題を解決するバランスの良い献立に変更してください。`;
      }

      setSuggestion("献立を変更中...");

      const api = getApi();
      const result = await api.post<any>("/api/ai/nutrition-analysis", {
        targetDate,
        targetMealType,
        prompt,
      });

      if (result) {
        await fetchAll();
        setSuggestion("献立を変更しました！");
      } else {
        setSuggestion("変更に失敗しました。もう一度お試しください。");
      }
    } catch (e) {
      console.error("Execute nutrition suggestion error:", e);
      setSuggestion("変更に失敗しました。もう一度お試しください。");
    }
  }

  // ─── Activity Level (今日のコンディション) ───
  const [activityLevel, setActivityLevel] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  // ─── Performance OS (30秒チェックイン) ───
  const [performanceAnalysis, setPerformanceAnalysis] = useState<{
    eligible: boolean;
    eligibilityReason: string | null;
    nextAction: { actionType: string; reason: string } | null;
    todayCheckin: any | null;
    loading: boolean;
  }>({
    eligible: false,
    eligibilityReason: null,
    nextAction: null,
    todayCheckin: null,
    loading: false,
  });

  async function fetchActivityLevel(uid: string) {
    try {
      const { data } = await supabase
        .from("daily_activity_logs")
        .select("*")
        .eq("user_id", uid)
        .eq("date", getTodayStr())
        .maybeSingle();
      if (data) setActivityLevel(data.feeling);
    } catch (e) {
      console.error("Activity level fetch error:", e);
    }
  }

  async function updateActivityLevel(level: string) {
    if (!userId) return;
    setActivityLevel(level);
    await supabase
      .from("daily_activity_logs")
      .upsert({ user_id: userId, date: getTodayStr(), feeling: level }, { onConflict: "user_id, date" });

    if (level === "rest") setSuggestion("今日は運動量が少なめです。夕食の炭水化物を半分にして調整しましょう。");
    else if (level === "active") setSuggestion("ナイスワークアウト！夕食でタンパク質を多めに摂り、筋肉の回復を促しましょう。");
    else if (level === "stressed") setSuggestion("ストレスを感じているときは、ビタミンB群を含む食材がおすすめです。");
    else setSuggestion(null);
  }

  async function fetchPerformanceAnalysis(uid: string) {
    try {
      setPerformanceAnalysis((prev) => ({ ...prev, loading: true }));
      const todayStr = getTodayStr();
      const api = getApi();
      const [data, checkinResult] = await Promise.all([
        api.get<any>(`/api/performance/analyze?date=${todayStr}`),
        supabase
          .from("user_performance_checkins")
          .select("*")
          .eq("user_id", uid)
          .eq("checkin_date", todayStr)
          .maybeSingle(),
      ]);
      if (data) {
        setPerformanceAnalysis({
          eligible: data.eligible ?? false,
          eligibilityReason: data.eligibilityReason ?? null,
          nextAction: data.analysis?.nextAction ?? null,
          todayCheckin: checkinResult.data ?? null,
          loading: false,
        });
      } else {
        setPerformanceAnalysis((prev) => ({ ...prev, todayCheckin: checkinResult.data ?? null, loading: false }));
      }
    } catch {
      setPerformanceAnalysis((prev) => ({ ...prev, loading: false }));
    }
  }

  async function submitPerformanceCheckin(checkinData: {
    sleepHours?: number;
    sleepQuality?: number;
    fatigue?: number;
    focus?: number;
    hunger?: number;
  }) {
    if (!userId) return { success: false, error: "Not authenticated" };
    try {
      const { data, error } = await supabase
        .from("user_performance_checkins")
        .upsert({
          user_id: userId,
          checkin_date: getTodayStr(),
          sleep_hours: checkinData.sleepHours,
          sleep_quality: checkinData.sleepQuality,
          fatigue: checkinData.fatigue,
          focus: checkinData.focus,
          hunger: checkinData.hunger,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id, checkin_date" })
        .select()
        .single();
      if (error) return { success: false, error: error.message };

      // sleepHours / sleepQuality が入力されている場合のみ health_records に同期する
      // fatigue / focus / hunger は health_records に書き込まない
      const hasSleepData =
        checkinData.sleepHours !== undefined ||
        checkinData.sleepQuality !== undefined;
      if (hasSleepData) {
        try {
          const api = getApi();
          await api.post("/api/health/records/quick", {
            record_date: getTodayStr(),
            ...(checkinData.sleepHours !== undefined && { sleep_hours: checkinData.sleepHours }),
            ...(checkinData.sleepQuality !== undefined && { sleep_quality: checkinData.sleepQuality }),
          });
        } catch (syncErr) {
          // 健康記録への同期失敗はチェックイン自体の成否には影響させない
          console.warn("Health record sync after checkin failed:", syncErr);
        }
      }

      await fetchPerformanceAnalysis(userId);
      return { success: true, data };
    } catch (e: any) {
      return { success: false, error: e?.message ?? "Unknown error" };
    }
  }

  async function toggleMealCompletion(mealId: string, currentStatus: boolean) {
    // #407: 250ms debounce — 既存タイマーをキャンセルして再スケジュール
    if (toggleDebounceTimerRef.current[mealId]) {
      clearTimeout(toggleDebounceTimerRef.current[mealId]);
      delete toggleDebounceTimerRef.current[mealId];
    }

    // 同一 mealId のリクエストが進行中の場合はスキップ
    if (pendingToggleRef.current.has(mealId)) return;

    // 250ms 後に実際の処理を実行
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        delete toggleDebounceTimerRef.current[mealId];
        resolve();
      }, 250);
      toggleDebounceTimerRef.current[mealId] = timer;
    });

    // debounce 待機後、再度 pending チェック
    if (pendingToggleRef.current.has(mealId)) return;
    pendingToggleRef.current.add(mealId);

    const newStatus = !currentStatus;

    // 楽観的 UI 更新
    setTodayMeals((prev) =>
      prev.map((m) => (m.id === mealId ? { ...m, is_completed: newStatus } : m))
    );
    setDailySummary((prev) => ({
      ...prev,
      completedCount: newStatus
        ? Math.min(prev.completedCount + 1, prev.totalCount)
        : Math.max(prev.completedCount - 1, 0),
    }));

    const { error } = await supabase
      .from("planned_meals")
      .update({ is_completed: newStatus, completed_at: newStatus ? new Date().toISOString() : null })
      .eq("id", mealId);

    if (error) {
      console.error("Toggle completion error:", error);
      // ロールバック: 楽観的更新を元に戻す
      setTodayMeals((prev) =>
        prev.map((m) => (m.id === mealId ? { ...m, is_completed: currentStatus } : m))
      );
      setDailySummary((prev) => ({
        ...prev,
        completedCount: newStatus
          ? Math.max(prev.completedCount - 1, 0)
          : Math.min(prev.completedCount + 1, prev.totalCount),
      }));
      // サーバー真値に再同期
      fetchAll();
    }

    // PATCH 完了後に pending を解除
    pendingToggleRef.current.delete(mealId);
  }

  function dismissAnnouncement(id: string) {
    setAnnouncements((prev) => prev.filter((a) => a.id !== id));
  }

  // #407: アンマウント時にデバウンスタイマーをクリア（メモリリーク防止）
  useEffect(() => {
    const timers = toggleDebounceTimerRef.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    fetchAll();
  }, [userId]);

  return {
    loading,
    todayMeals,
    dailySummary,
    cookingStreak,
    weeklyStats,
    monthlyStats,
    healthSummary,
    nutritionAnalysis,
    expiringItems,
    shoppingRemaining,
    badgeCount,
    latestBadge,
    bestMealThisWeek,
    activityLevel,
    suggestion,
    performanceAnalysis,
    announcements,
    dismissAnnouncement,
    toggleMealCompletion,
    updateActivityLevel,
    setSuggestion,
    executeNutritionSuggestion,
    submitPerformanceCheckin,
    refetch: fetchAll,
  };
};
