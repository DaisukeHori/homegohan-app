import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Card, EmptyState, LoadingState, StatusBadge } from "../../src/components/ui";
import { colors, spacing } from "../../src/theme";
import { getApi } from "../../src/lib/api";

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

type DaySummary = {
  dayDate: string;
  mealCount: number;
  completedCount: number;
  totalCalories: number;
};

export default function MenusScreen() {
  const insets = useSafeAreaInsets();
  const [days, setDays] = useState<DaySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasPlan, setHasPlan] = useState(false);

  const weekStart = useMemo(() => getWeekStart(new Date()), []);
  const weekStartStr = useMemo(() => formatLocalDate(weekStart), [weekStart]);
  const weekEndStr = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    return formatLocalDate(end);
  }, [weekStart]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const api = getApi();
      const res = await api.get<{ dailyMeals: any[] }>(`/api/meal-plans?startDate=${weekStartStr}&endDate=${weekEndStr}`);
      const dailyMeals = res.dailyMeals ?? [];
      if (dailyMeals.length === 0) {
        setHasPlan(false);
        setDays([]);
        return;
      }
      setHasPlan(true);
      const mapped: DaySummary[] = dailyMeals.map((d: any) => {
        const meals = d.meals ?? [];
        return {
          dayDate: d.dayDate,
          mealCount: meals.length,
          completedCount: meals.filter((m: any) => m.isCompleted).length,
          totalCalories: meals.reduce((sum: number, m: any) => sum + (m.caloriesKcal ?? 0), 0),
        };
      });
      setDays(mapped);
    } catch {
      setHasPlan(false);
      setDays([]);
    } finally {
      setIsLoading(false);
    }
  }, [weekStartStr, weekEndStr]);

  useEffect(() => { loadData(); }, [loadData]);

  const weekSummary = useMemo(() => {
    const totalMeals = days.reduce((s, d) => s + d.mealCount, 0);
    const completedMeals = days.reduce((s, d) => s + d.completedCount, 0);
    const totalCalories = days.reduce((s, d) => s + d.totalCalories, 0);
    return { totalMeals, completedMeals, totalCalories };
  }, [days]);

  const DOW = ["月", "火", "水", "木", "金", "土", "日"];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: insets.top + spacing.md, padding: spacing.lg, gap: spacing.lg }}>
      <Text style={{ fontSize: 24, fontWeight: "800", color: colors.text, marginBottom: spacing.xs }}>献立</Text>
      {isLoading ? (
        <LoadingState />
      ) : !hasPlan ? (
        <View style={{ gap: spacing.lg, paddingTop: spacing['3xl'] }}>
          <EmptyState
            icon={<Ionicons name="restaurant-outline" size={48} color={colors.textMuted} />}
            message="今週の献立がまだありません"
          />
          <Button onPress={() => router.push("/menus/weekly/request")}>
            AIで週間献立を作成
          </Button>
          <Button variant="secondary" onPress={() => router.push("/menus/weekly")}>
            週間献立を見る
          </Button>
        </View>
      ) : (
        <>
          {/* 週間サマリ */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ fontSize: 16, fontWeight: "800", color: colors.text }}>今週の献立</Text>
                <StatusBadge variant="completed" label={`${weekSummary.completedMeals}/${weekSummary.totalMeals} 完了`} />
              </View>
              <Text style={{ fontSize: 13, color: colors.textMuted }}>
                合計 {weekSummary.totalCalories.toLocaleString()} kcal（{weekSummary.totalMeals}食）
              </Text>

              {/* 日別ドット */}
              <View style={{ flexDirection: "row", justifyContent: "space-around", paddingTop: spacing.sm }}>
                {days.map((d, i) => {
                  const rate = d.mealCount > 0 ? d.completedCount / d.mealCount : 0;
                  return (
                    <View key={d.dayDate} style={{ alignItems: "center", gap: 4 }}>
                      <Text style={{ fontSize: 11, fontWeight: "600", color: colors.textMuted }}>{DOW[i] ?? ""}</Text>
                      <View
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 14,
                          backgroundColor: rate >= 1 ? colors.success : rate > 0 ? colors.warningLight : colors.bg,
                          alignItems: "center",
                          justifyContent: "center",
                          borderWidth: 1,
                          borderColor: rate >= 1 ? colors.success : colors.border,
                        }}
                      >
                        {rate >= 1 ? (
                          <Ionicons name="checkmark" size={16} color="#fff" />
                        ) : (
                          <Text style={{ fontSize: 10, fontWeight: "700", color: colors.textMuted }}>{d.mealCount}</Text>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          </Card>

          <View style={{ flexDirection: "row", gap: spacing.md }}>
            <Button onPress={() => router.push("/menus/weekly")} style={{ flex: 1 }}>
              詳細を見る
            </Button>
            <Button variant="secondary" onPress={() => router.push("/menus/weekly/request")} style={{ flex: 1 }}>
              AIで再生成
            </Button>
          </View>
        </>
      )}
    </ScrollView>
  );
}
