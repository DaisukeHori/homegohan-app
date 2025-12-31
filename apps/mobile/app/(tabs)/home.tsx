import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { getApi } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";
import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";

type PlannedMealLite = {
  id: string;
  meal_type: string;
  mode: string | null;
  dish_name: string | null;
  calories_kcal: number | null;
  is_completed: boolean | null;
};

const MEAL_ORDER = ["breakfast", "lunch", "snack", "dinner", "midnight_snack"] as const;
const MEAL_LABEL: Record<string, string> = {
  breakfast: "朝食",
  lunch: "昼食",
  snack: "おやつ",
  dinner: "夕食",
  midnight_snack: "夜食",
};

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

export default function HomeScreen() {
  const { user } = useAuth();
  const { profile } = useProfile();

  const todayStr = useMemo(() => formatLocalDate(new Date()), []);
  const [todayMeals, setTodayMeals] = useState<PlannedMealLite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!user) return;
      setIsLoading(true);
      setError(null);

      // 今日の献立（meal_plan_days -> planned_meals）
      const { data: dayData, error: dayError } = await supabase
        .from("meal_plan_days")
        .select(
          `
          id,
          day_date,
          meal_plan_id,
          meal_plans!inner(user_id)
        `
        )
        .eq("day_date", todayStr)
        .eq("meal_plans.user_id", user.id)
        .maybeSingle();

      if (cancelled) return;

      if (dayError) {
        setError(dayError.message);
        setTodayMeals([]);
      } else if (!dayData) {
        setTodayMeals([]);
      } else {
        const { data: mealsData, error: mealsError } = await supabase
          .from("planned_meals")
          .select("id,meal_type,mode,dish_name,calories_kcal,is_completed")
          .eq("meal_plan_day_id", (dayData as any).id)
          .order("meal_type");

        if (cancelled) return;
        if (mealsError) {
          setError(mealsError.message);
          setTodayMeals([]);
        } else {
          setTodayMeals((mealsData as any) ?? []);
        }
      }

      setIsLoading(false);
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const summary = useMemo(() => {
    const totalCalories = todayMeals.reduce((sum, m) => sum + (m.calories_kcal ?? 0), 0);
    const completedCount = todayMeals.filter((m) => !!m.is_completed).length;
    return { totalCalories, completedCount, totalCount: todayMeals.length };
  }, [todayMeals]);

  const nextMeal = useMemo(() => {
    const sorted = [...todayMeals].sort((a, b) => {
      const ai = MEAL_ORDER.indexOf(a.meal_type as any);
      const bi = MEAL_ORDER.indexOf(b.meal_type as any);
      return ai - bi;
    });
    return sorted.find((m) => !m.is_completed) ?? null;
  }, [todayMeals]);

  async function toggleCompletion(meal: PlannedMealLite) {
    const next = !meal.is_completed;
    try {
      const api = getApi();
      await api.patch(`/api/meals/${meal.id}`, {
        is_completed: next,
        completed_at: next ? new Date().toISOString() : null,
      });
      setTodayMeals((prev) => prev.map((m) => (m.id === meal.id ? { ...m, is_completed: next } : m)));
    } catch (e: any) {
      setError(e?.message ?? "更新に失敗しました。");
    }
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 12, color: "#666" }}>
          {new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}
        </Text>
        <Text style={{ fontSize: 22, fontWeight: "800" }}>
          こんにちは、{profile?.nickname ?? "ゲスト"}さん
        </Text>
        <Text style={{ color: "#999" }}>ログイン: {user?.email ?? "unknown"}</Text>
      </View>

      <View style={{ flexDirection: "row", gap: 10 }}>
        <Link href="/menus">献立</Link>
        <Link href="/meals">食事</Link>
        <Link href="/ai">AI相談</Link>
        <Link href="/health">健康</Link>
        <Link href="/settings">設定</Link>
      </View>

      <View style={{ marginTop: 8, padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}>
        <Text style={{ fontWeight: "800" }}>今日のサマリ</Text>
        <Text style={{ color: "#666" }}>
          {summary.totalCount ? `完了 ${summary.completedCount}/${summary.totalCount}` : "献立がまだありません"}
        </Text>
        <Text style={{ color: "#666" }}>推定 {summary.totalCalories} kcal</Text>
        {nextMeal ? (
          <Text style={{ color: "#333", marginTop: 4 }}>
            次の食事: {MEAL_LABEL[nextMeal.meal_type] ?? nextMeal.meal_type}（{nextMeal.dish_name || "未設定"}）
          </Text>
        ) : null}
      </View>

      <Text style={{ marginTop: 6, fontSize: 16, fontWeight: "800" }}>今日の献立</Text>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : todayMeals.length === 0 ? (
        <Text style={{ color: "#666" }}>今日の献立がまだ作成されていません（献立タブから生成できます）。</Text>
      ) : (
        <View style={{ gap: 8 }}>
          {todayMeals.map((m) => (
            <Pressable
              key={m.id}
              onPress={() => toggleCompletion(m)}
              style={{
                padding: 12,
                borderWidth: 1,
                borderColor: "#eee",
                borderRadius: 12,
                backgroundColor: m.is_completed ? "#E8F5E9" : "white",
              }}
            >
              <Text style={{ fontWeight: "800" }}>
                {m.meal_type} · {m.dish_name || "（未設定）"}
              </Text>
              <Text style={{ color: "#666" }}>
                {m.calories_kcal ? `${m.calories_kcal} kcal` : "kcal未設定"} / {m.mode || "cook"}
              </Text>
              <Text style={{ color: "#999", marginTop: 4 }}>
                タップで{m.is_completed ? "未完了" : "完了"}にする
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}


