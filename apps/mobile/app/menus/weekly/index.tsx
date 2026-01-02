import { Link, router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../../src/lib/api";
import { supabase } from "../../../src/lib/supabase";

type PlannedMealRow = {
  id: string;
  meal_type: string;
  dish_name: string;
  mode: string | null;
  calories_kcal: number | null;
  is_completed: boolean | null;
  is_generating: boolean | null;
  display_order?: number | null;
};

type DayRow = {
  id: string;
  day_date: string;
  planned_meals: PlannedMealRow[];
};

type MealPlanRow = {
  id: string;
  start_date: string;
  end_date: string;
  title: string;
};

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function WeeklyMenuPage() {
  const [weekStart, setWeekStart] = useState<Date>(() => getWeekStart(new Date()));
  const weekStartStr = useMemo(() => formatLocalDate(weekStart), [weekStart]);
  const weekEndStr = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    return formatLocalDate(end);
  }, [weekStart]);

  const [plan, setPlan] = useState<MealPlanRow | null>(null);
  const [days, setDays] = useState<DayRow[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(() => formatLocalDate(new Date()));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regeneratingMealId, setRegeneratingMealId] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [pendingProgress, setPendingProgress] = useState<{ phase: string; message: string; percentage: number } | null>(null);

  async function loadData() {
    setIsLoading(true);
    setError(null);

    try {
      const api = getApi();
      const res = await api.get<{ mealPlan: any }>(`/api/meal-plans?date=${weekStartStr}`);
      const mealPlan = res.mealPlan;

      if (!mealPlan) {
        setPlan(null);
        setDays([]);
        return;
      }

      setPlan({
        id: mealPlan.id,
        start_date: mealPlan.startDate,
        end_date: mealPlan.endDate,
        title: mealPlan.title ?? "週間献立",
      });

      const mappedDays: DayRow[] =
        (mealPlan.days ?? []).map((d: any) => ({
          id: d.id,
          day_date: d.dayDate,
          planned_meals:
            (d.meals ?? []).map((m: any) => ({
              id: m.id,
              meal_type: m.mealType,
              dish_name: m.dishName,
              mode: m.mode,
              calories_kcal: m.caloriesKcal,
              is_completed: m.isCompleted,
              is_generating: m.isGenerating,
              display_order: m.displayOrder,
            })) ?? [],
        })) ?? [];

      setDays(mappedDays);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
      setPlan(null);
      setDays([]);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [weekStartStr, weekEndStr]);

  const selectedDay = useMemo(() => days.find((d) => d.day_date === selectedDate) ?? null, [days, selectedDate]);

  function shiftWeek(delta: number) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + delta * 7);
    setWeekStart(getWeekStart(d));
    setSelectedDate(formatLocalDate(d));
  }

  const mealTypeLabel = useMemo(() => {
    const map: Record<string, string> = {
      breakfast: "朝食",
      lunch: "昼食",
      dinner: "夕食",
      snack: "おやつ",
      midnight_snack: "夜食",
    };
    return map;
  }, []);

  async function checkPending() {
    try {
      const api = getApi();
      const res = await api.get<{ hasPending: boolean; requestId?: string; status?: string; startDate?: string }>(
        `/api/ai/menu/weekly/pending?date=${weekStartStr}`
      );
      if (res.hasPending && res.requestId && res.startDate === weekStartStr) {
        setPendingRequestId(res.requestId);
        setPendingStatus(res.status ?? "processing");
        return;
      }
      setPendingRequestId(null);
      setPendingStatus(null);
    } catch {
      setPendingRequestId(null);
      setPendingStatus(null);
    }
  }

  useEffect(() => {
    checkPending();
  }, [weekStartStr]);

  // Supabase Realtime で進捗をリアルタイム監視
  useEffect(() => {
    if (!pendingRequestId) return;
    
    console.log("📡 Subscribing to Realtime for request:", pendingRequestId);
    
    const channel = supabase
      .channel(`weekly-menu-progress-${pendingRequestId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "weekly_menu_requests",
          filter: `id=eq.${pendingRequestId}`,
        },
        async (payload) => {
          const newRecord = payload.new as {
            status: string;
            error_message?: string | null;
            progress?: { phase: string; message: string; percentage: number } | null;
          };
          
          console.log("📡 Realtime update:", newRecord.status, newRecord.progress?.message);
          
          setPendingStatus(newRecord.status);
          if (newRecord.progress) {
            setPendingProgress(newRecord.progress);
          }
          
          if (newRecord.status === "completed") {
            await loadData();
            setPendingRequestId(null);
            setPendingStatus(null);
            setPendingProgress(null);
            Alert.alert("完了", "週間献立の生成が完了しました。");
          }
          if (newRecord.status === "failed") {
            setPendingRequestId(null);
            setPendingStatus(null);
            setPendingProgress(null);
            setError(newRecord.error_message ?? "週間献立の生成に失敗しました。");
          }
        }
      )
      .subscribe((status) => {
        console.log("📡 Realtime subscription status:", status);
      });
    
    return () => {
      console.log("📡 Unsubscribing from Realtime");
      supabase.removeChannel(channel);
    };
  }, [pendingRequestId]);

  useEffect(() => {
    if (pendingRequestId) return;
    const hasGenerating = days.some((d) => d.planned_meals?.some((m) => m.is_generating));
    if (!hasGenerating) return;
    const t = setInterval(() => {
      loadData();
    }, 5000);
    return () => clearInterval(t);
  }, [days, pendingRequestId, weekStartStr, weekEndStr]);

  async function reorderMeal(mealId: string, direction: "up" | "down") {
    if (!selectedDay) return;
    try {
      const api = getApi();
      await api.post("/api/meal-plans/meals/reorder", { mealId, direction, dayId: selectedDay.id });
      await loadData();
    } catch (e: any) {
      setError(e?.message ?? "順序変更に失敗しました。");
    }
  }

  async function regenerateMeal(mealId: string, mealType: string) {
    if (regeneratingMealId) return;
    setRegeneratingMealId(mealId);
    try {
      const api = getApi();
      await api.post("/api/ai/menu/meal/regenerate", {
        mealId,
        dayDate: selectedDate,
        mealType,
      });
    } catch (e: any) {
      setError(e?.message ?? "再生成に失敗しました。");
    } finally {
      setRegeneratingMealId(null);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>週間献立</Text>
        <Link href="/menus/weekly/request">AIで生成</Link>
      </View>

      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Pressable onPress={() => shiftWeek(-1)} style={{ padding: 10, borderRadius: 10, backgroundColor: "#eee" }}>
          <Text style={{ fontWeight: "900" }}>←</Text>
        </Pressable>
        <Text style={{ color: "#666" }}>
          {weekStartStr} 〜 {weekEndStr}
        </Text>
        <Pressable onPress={() => shiftWeek(1)} style={{ padding: 10, borderRadius: 10, backgroundColor: "#eee" }}>
          <Text style={{ fontWeight: "900" }}>→</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !plan ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: "#666" }}>今週の献立がありません。</Text>
          <Link href="/menus/weekly/request">AIで週間献立を作成</Link>
        </View>
      ) : (
        <>
          <Text style={{ color: "#999" }}>{plan.title}</Text>
          {pendingRequestId ? (
            <View style={{ padding: 12, borderRadius: 12, backgroundColor: "#fff7ed", borderWidth: 1, borderColor: "#fed7aa", gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <ActivityIndicator size="small" color="#E07A5F" />
                <Text style={{ fontWeight: "700", color: "#333", flex: 1 }}>
                  {pendingProgress?.message ?? "AIが献立を生成中..."}
                </Text>
                {pendingProgress?.percentage ? (
                  <Text style={{ color: "#E07A5F", fontWeight: "600" }}>
                    {pendingProgress.percentage}%
                  </Text>
                ) : null}
              </View>
              {pendingProgress?.percentage ? (
                <View style={{ height: 6, backgroundColor: "#fed7aa", borderRadius: 3, overflow: "hidden" }}>
                  <View 
                    style={{ 
                      height: "100%", 
                      width: `${pendingProgress.percentage}%`, 
                      backgroundColor: "#E07A5F", 
                      borderRadius: 3 
                    }} 
                  />
                </View>
              ) : null}
            </View>
          ) : null}

          {/* 日付セレクタ */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {days.map((d) => {
              const selected = d.day_date === selectedDate;
              return (
                <Pressable
                  key={d.id}
                  onPress={() => setSelectedDate(d.day_date)}
                  style={{
                    paddingVertical: 8,
                    paddingHorizontal: 10,
                    borderRadius: 999,
                    backgroundColor: selected ? "#E07A5F" : "#eee",
                  }}
                >
                  <Text style={{ color: selected ? "white" : "#333", fontWeight: "900" }}>{d.day_date.slice(5)}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={{ gap: 10, marginTop: 6 }}>
            <Text style={{ fontWeight: "900" }}>{selectedDate} の献立</Text>

            {selectedDay?.planned_meals?.length ? (
              <View style={{ gap: 10 }}>
                {selectedDay.planned_meals
                  .slice()
                  .sort((a, b) => {
                    const ao = a.display_order ?? 0;
                    const bo = b.display_order ?? 0;
                    if (ao !== bo) return ao - bo;
                    return a.meal_type.localeCompare(b.meal_type);
                  })
                  .map((m) => (
                    <Pressable
                      key={m.id}
                      onPress={() => router.push(`/meals/${m.id}`)}
                      style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}
                    >
                      <Text style={{ fontWeight: "900" }}>
                        {mealTypeLabel[m.meal_type] ?? m.meal_type} · {m.dish_name}
                        {m.is_generating ? "（生成中）" : ""}
                      </Text>
                      <Text style={{ color: "#666" }}>{m.calories_kcal ? `${m.calories_kcal}kcal` : "kcal未設定"} / {m.mode || "cook"}</Text>
                      <Text style={{ color: "#999" }}>{m.is_completed ? "完了" : "未完了"}</Text>
                      <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
                        <Pressable
                          onPress={() => router.push(`/meals/${m.id}/edit`)}
                          style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#eee" }}
                        >
                          <Text style={{ fontWeight: "900" }}>編集</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => reorderMeal(m.id, "up")}
                          style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#eee" }}
                        >
                          <Text style={{ fontWeight: "900" }}>↑</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => reorderMeal(m.id, "down")}
                          style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#eee" }}
                        >
                          <Text style={{ fontWeight: "900" }}>↓</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => regenerateMeal(m.id, m.meal_type)}
                          style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}
                        >
                          <Text style={{ color: "white", fontWeight: "900" }}>
                            {regeneratingMealId === m.id ? "再生成中..." : "再生成"}
                          </Text>
                        </Pressable>
                      </View>
                    </Pressable>
                  ))}
              </View>
            ) : (
              <Text style={{ color: "#666" }}>この日の食事がありません。</Text>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}


