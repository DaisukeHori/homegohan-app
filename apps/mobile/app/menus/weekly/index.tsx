import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader, ProgressBar, StatusBadge } from "../../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../../src/theme";
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

type PendingProgress = {
  phase?: string;
  message: string;
  percentage?: number;
  currentStep?: number;
  totalSteps?: number;
  completedSlots?: number;
  totalSlots?: number;
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

const DOW = ["月", "火", "水", "木", "金", "土", "日"];

const MEAL_ORDER = ["breakfast", "lunch", "snack", "dinner", "midnight_snack"] as const;

const MEAL_CONFIG: Record<string, { icon: keyof typeof Ionicons.glyphMap; label: string; color: string }> = {
  breakfast: { icon: "sunny", label: "朝食", color: "#FF9800" },
  lunch: { icon: "partly-sunny", label: "昼食", color: "#4CAF50" },
  snack: { icon: "cafe", label: "おやつ", color: "#E91E63" },
  dinner: { icon: "moon", label: "夕食", color: "#7C4DFF" },
  midnight_snack: { icon: "cloudy-night", label: "夜食", color: "#3F51B5" },
};

const MODE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  cook: { label: "自炊", color: colors.success, bg: colors.successLight },
  quick: { label: "時短", color: colors.blue, bg: colors.blueLight },
  buy: { label: "買う", color: colors.purple, bg: colors.purpleLight },
  out: { label: "外食", color: colors.warning, bg: colors.warningLight },
  skip: { label: "なし", color: colors.textMuted, bg: colors.bg },
};

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
  const [pendingProgress, setPendingProgress] = useState<PendingProgress | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const api = getApi();
      const res = await api.get<{ dailyMeals: any[]; startDate: string; endDate: string }>(`/api/meal-plans?startDate=${weekStartStr}&endDate=${weekEndStr}`);
      const dailyMeals = res.dailyMeals ?? [];

      if (dailyMeals.length === 0) {
        setPlan(null);
        setDays([]);
        return;
      }

      setPlan({
        id: dailyMeals[0].id,
        start_date: res.startDate ?? weekStartStr,
        end_date: res.endDate ?? weekEndStr,
        title: "週間献立",
      });

      const mappedDays: DayRow[] = dailyMeals.map((d: any) => ({
        id: d.id,
        day_date: d.dayDate,
        planned_meals: (d.meals ?? []).map((m: any) => ({
          id: m.id,
          meal_type: m.mealType,
          dish_name: m.dishName,
          mode: m.mode,
          calories_kcal: m.caloriesKcal,
          is_completed: m.isCompleted,
          is_generating: m.isGenerating,
          display_order: m.displayOrder,
        })),
      }));

      setDays(mappedDays);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
      setPlan(null);
      setDays([]);
    } finally {
      setIsLoading(false);
    }
  }, [weekStartStr, weekEndStr]);

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
            progress?: PendingProgress | null;
          };

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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [pendingRequestId]);

  useEffect(() => {
    if (!pendingRequestId) return;

    const poll = async () => {
      try {
        const api = getApi();
        const res = await api.get<{
          status: string;
          errorMessage?: string | null;
          progress?: PendingProgress | null;
        }>(`/api/ai/menu/weekly/status?requestId=${pendingRequestId}`);

        setPendingStatus(res.status);
        if (res.progress) {
          setPendingProgress(res.progress);
        }

        if (res.status === "completed") {
          await loadData();
          setPendingRequestId(null);
          setPendingStatus(null);
          setPendingProgress(null);
        } else if (res.status === "failed") {
          setPendingRequestId(null);
          setPendingStatus(null);
          setPendingProgress(null);
          setError(res.errorMessage ?? "週間献立の生成に失敗しました。");
        }
      } catch {
        // Ignore transient polling errors
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [loadData, pendingRequestId]);

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
      await loadData();
    } catch (e: any) {
      setError(e?.message ?? "再生成に失敗しました。");
    } finally {
      setRegeneratingMealId(null);
    }
  }

  // Day selector helpers
  const getDayOfWeek = (dateStr: string): string => {
    const d = new Date(dateStr + "T00:00:00");
    const dayIdx = (d.getDay() + 6) % 7; // Mon=0
    return DOW[dayIdx] ?? "";
  };

  const sortedMeals = useMemo(() => {
    if (!selectedDay?.planned_meals) return [];
    return [...selectedDay.planned_meals].sort((a, b) => {
      const ao = a.display_order ?? 0;
      const bo = b.display_order ?? 0;
      if (ao !== bo) return ao - bo;
      const ai = MEAL_ORDER.indexOf(a.meal_type as any);
      const bi = MEAL_ORDER.indexOf(b.meal_type as any);
      return ai - bi;
    });
  }, [selectedDay]);

  const daySummary = useMemo(() => {
    if (!selectedDay?.planned_meals) return { totalCalories: 0, completed: 0, total: 0 };
    const meals = selectedDay.planned_meals;
    return {
      totalCalories: meals.reduce((s, m) => s + (m.calories_kcal ?? 0), 0),
      completed: meals.filter((m) => m.is_completed).length,
      total: meals.length,
    };
  }, [selectedDay]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="週間献立" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      {/* ヘッダー: 週ナビゲーション */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Pressable
          onPress={() => shiftWeek(-1)}
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.md,
            backgroundColor: colors.card,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: colors.border,
            ...shadows.sm,
          }}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </Pressable>
        <View style={{ alignItems: "center" }}>
          <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>
            {weekStartStr.slice(5)} 〜 {weekEndStr.slice(5)}
          </Text>
          {plan && <Text style={{ fontSize: 12, color: colors.textMuted }}>{plan.title}</Text>}
        </View>
        <Pressable
          onPress={() => shiftWeek(1)}
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.md,
            backgroundColor: colors.card,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: colors.border,
            ...shadows.sm,
          }}
        >
          <Ionicons name="chevron-forward" size={20} color={colors.text} />
        </Pressable>
      </View>

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ flex: 1, color: colors.error, fontSize: 13 }}>{error}</Text>
          </View>
          <Button size="sm" variant="ghost" onPress={() => { setError(null); loadData(); }}>再読み込み</Button>
        </Card>
      ) : !plan ? (
        <View style={{ gap: spacing.lg, paddingTop: spacing["3xl"] }}>
          <EmptyState
            icon={<Ionicons name="restaurant-outline" size={48} color={colors.textMuted} />}
            message="この週の献立がまだありません"
          />
          <Button onPress={() => router.push("/menus/weekly/request")}>
            AIで週間献立を作成
          </Button>
        </View>
      ) : (
        <>
          {/* AI生成中プログレス */}
          {pendingRequestId && (
            <Card variant="accent">
              <View style={{ gap: spacing.md }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <ActivityIndicator size="small" color={colors.accent} />
                  <Text style={{ flex: 1, fontWeight: "700", color: colors.text, fontSize: 14 }}>
                    {pendingProgress?.message ?? "AIが献立を生成中..."}
                  </Text>
                  <StatusBadge variant="generating" label="生成中" />
                </View>
                {pendingProgress?.percentage != null && (
                  <ProgressBar
                    value={pendingProgress.percentage}
                    max={100}
                    color={colors.accent}
                    showPercentage
                  />
                )}
              </View>
            </Card>
          )}

          {/* 日付セレクタ — 横並び丸型ピル */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
            {days.map((d) => {
              const selected = d.day_date === selectedDate;
              const dow = getDayOfWeek(d.day_date);
              const dayNum = d.day_date.slice(8);
              const completedAll = d.planned_meals.length > 0 && d.planned_meals.every((m) => m.is_completed);
              const hasGenerating = d.planned_meals.some((m) => m.is_generating);

              return (
                <Pressable
                  key={d.id}
                  onPress={() => setSelectedDate(d.day_date)}
                  style={({ pressed }) => ({
                    alignItems: "center",
                    gap: 4,
                    paddingVertical: spacing.sm,
                    paddingHorizontal: spacing.md,
                    borderRadius: radius.lg,
                    backgroundColor: selected ? colors.accent : colors.card,
                    borderWidth: 1,
                    borderColor: selected ? colors.accent : colors.border,
                    minWidth: 48,
                    ...shadows.sm,
                    ...(pressed ? { opacity: 0.9 } : {}),
                  })}
                >
                  <Text style={{ fontSize: 11, fontWeight: "600", color: selected ? "#fff" : colors.textMuted }}>{dow}</Text>
                  <Text style={{ fontSize: 16, fontWeight: "800", color: selected ? "#fff" : colors.text }}>{dayNum}</Text>
                  {completedAll ? (
                    <Ionicons name="checkmark-circle" size={14} color={selected ? "#fff" : colors.success} />
                  ) : hasGenerating ? (
                    <ActivityIndicator size={12} color={selected ? "#fff" : colors.accent} />
                  ) : (
                    <Text style={{ fontSize: 10, color: selected ? "rgba(255,255,255,0.7)" : colors.textMuted }}>
                      {d.planned_meals.length}食
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>

          {/* 選択日のサマリ */}
          {selectedDay && daySummary.total > 0 && (
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 13, color: colors.textMuted }}>
                {daySummary.totalCalories.toLocaleString()} kcal・{daySummary.completed}/{daySummary.total} 完了
              </Text>
              <Button
                size="sm"
                variant="ghost"
                onPress={() => router.push("/menus/weekly/request")}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Ionicons name="sparkles" size={14} color={colors.accent} />
                  <Text style={{ fontSize: 12, fontWeight: "600", color: colors.accent }}>AIで再生成</Text>
                </View>
              </Button>
            </View>
          )}

          {/* 食事一覧 */}
          {sortedMeals.length > 0 ? (
            <View style={{ gap: spacing.md }}>
              {sortedMeals.map((m) => {
                const mealCfg = MEAL_CONFIG[m.meal_type] ?? { icon: "ellipse", label: m.meal_type, color: colors.textMuted };
                const modeCfg = MODE_CONFIG[m.mode ?? "cook"] ?? MODE_CONFIG.cook;
                const isGenerating = m.is_generating;
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => router.push(`/meals/${m.id}`)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: spacing.md,
                      padding: spacing.lg,
                      backgroundColor: m.is_completed ? colors.successLight : isGenerating ? colors.accentLight : colors.card,
                      borderRadius: radius.lg,
                      borderWidth: 1,
                      borderColor: m.is_completed ? "#C8E6C9" : isGenerating ? "#FED7AA" : colors.border,
                      ...shadows.sm,
                      ...(pressed ? { opacity: 0.9 } : {}),
                    })}
                  >
                    {/* 食事タイプアイコン */}
                    <View
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: radius.md,
                        backgroundColor: m.is_completed ? colors.success : mealCfg.color,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {m.is_completed ? (
                        <Ionicons name="checkmark" size={24} color="#fff" />
                      ) : isGenerating ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Ionicons name={mealCfg.icon} size={22} color="#fff" />
                      )}
                    </View>

                    {/* 情報 */}
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }} numberOfLines={1}>
                        {isGenerating ? "生成中..." : m.dish_name || "（未設定）"}
                      </Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Text style={{ fontSize: 12, color: colors.textMuted }}>{mealCfg.label}</Text>
                        <View
                          style={{
                            backgroundColor: modeCfg.bg,
                            paddingHorizontal: 6,
                            paddingVertical: 2,
                            borderRadius: 4,
                          }}
                        >
                          <Text style={{ fontSize: 10, fontWeight: "700", color: modeCfg.color }}>{modeCfg.label}</Text>
                        </View>
                        {m.calories_kcal ? (
                          <Text style={{ fontSize: 12, color: colors.textMuted }}>{m.calories_kcal} kcal</Text>
                        ) : null}
                      </View>
                    </View>

                    {/* ステータス & アクション */}
                    <View style={{ alignItems: "center", gap: 4 }}>
                      {m.is_completed ? (
                        <StatusBadge variant="completed" label="完了" />
                      ) : isGenerating ? (
                        <StatusBadge variant="generating" label="生成中" />
                      ) : (
                        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                      )}
                    </View>
                  </Pressable>
                );
              })}

              {/* アクションボタン行 */}
              {selectedDay && (
                <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
                  {sortedMeals.map((m) => {
                    const mealCfg = MEAL_CONFIG[m.meal_type] ?? { label: m.meal_type };
                    return (
                      <View key={m.id} style={{ flexDirection: "row", gap: 4 }}>
                        <Pressable
                          onPress={() => router.push(`/meals/${m.id}/edit`)}
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 4,
                            paddingVertical: 6,
                            paddingHorizontal: 10,
                            borderRadius: radius.sm,
                            backgroundColor: colors.card,
                            borderWidth: 1,
                            borderColor: colors.border,
                          }}
                        >
                          <Ionicons name="create-outline" size={14} color={colors.textLight} />
                          <Text style={{ fontSize: 11, color: colors.textLight }}>{mealCfg.label}</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => regenerateMeal(m.id, m.meal_type)}
                          disabled={!!regeneratingMealId}
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 4,
                            paddingVertical: 6,
                            paddingHorizontal: 10,
                            borderRadius: radius.sm,
                            backgroundColor: regeneratingMealId === m.id ? colors.accentLight : colors.card,
                            borderWidth: 1,
                            borderColor: regeneratingMealId === m.id ? colors.accent : colors.border,
                          }}
                        >
                          <Ionicons name="refresh" size={14} color={regeneratingMealId === m.id ? colors.accent : colors.textLight} />
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          ) : (
            <EmptyState
              icon={<Ionicons name="restaurant-outline" size={40} color={colors.textMuted} />}
              message="この日の食事がありません"
            />
          )}
        </>
      )}
    </ScrollView>
    </View>
  );
}
