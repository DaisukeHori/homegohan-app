import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Image, ScrollView, Text, View } from "react-native";

import { Button, Card, LoadingState, PageHeader, SectionHeader, StatusBadge } from "../../src/components/ui";
import { colors, spacing, radius } from "../../src/theme";
import { getApi } from "../../src/lib/api";

type PlannedMealDetail = {
  id: string;
  meal_type: string;
  mode: string | null;
  dish_name: string | null;
  description: string | null;
  image_url: string | null;
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  is_completed: boolean | null;
  completed_at: string | null;
  dishes: any[] | null;
  is_simple: boolean | null;
  cooking_time_minutes: number | null;
  daily_meal_id: string;
  day_date: string | null;
};

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

export default function MealDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [meal, setMeal] = useState<PlannedMealDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!id) return;
      setIsLoading(true);
      setError(null);
      try {
        const api = getApi();
        const data = await api.get<any>(`/api/meals/${id}`);
        if (cancelled) return;
        if (!data) {
          setError("食事データが見つかりませんでした。");
          setMeal(null);
        } else {
          setMeal({
            ...(data as any),
            day_date: (data as any).user_daily_meals?.day_date ?? null,
          });
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? "取得に失敗しました。");
          setMeal(null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [id]);

  async function toggleCompletion() {
    if (!meal) return;
    const next = !meal.is_completed;
    setMeal((prev) => (prev ? { ...prev, is_completed: next, completed_at: next ? new Date().toISOString() : null } : prev));
    try {
      const api = getApi();
      await api.patch(`/api/meals/${meal.id}`, {
        is_completed: next,
        completed_at: next ? new Date().toISOString() : null,
      });
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
      setMeal((prev) => (prev ? { ...prev, is_completed: !next, completed_at: !next ? null : prev.completed_at } : prev));
    }
  }

  async function deleteMeal() {
    if (!meal) return;
    Alert.alert("削除", "この食事を削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/meals/${meal.id}`);
            router.replace("/menus");
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  if (isLoading) return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="食事詳細" />
      <LoadingState />
    </View>
  );

  if (error || !meal) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <PageHeader title="食事詳細" />
        <View style={{ flex: 1, padding: spacing.lg, justifyContent: "center", gap: spacing.md }}>
          <Card variant="error">
            <Text style={{ color: colors.error }}>{error ?? "データが見つかりません"}</Text>
          </Card>
          <Button variant="ghost" onPress={() => router.back()}>戻る</Button>
        </View>
      </View>
    );
  }

  const mealCfg = MEAL_CONFIG[meal.meal_type] ?? { icon: "ellipse", label: meal.meal_type, color: colors.textMuted };
  const modeCfg = MODE_CONFIG[meal.mode ?? "cook"] ?? MODE_CONFIG.cook;
  const totalPFC = (meal.protein_g ?? 0) + (meal.fat_g ?? 0) + (meal.carbs_g ?? 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="食事詳細" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 32 }}>
      {/* 画像ヒーロー */}
      {meal.image_url ? (
        <Image source={{ uri: meal.image_url }} style={{ width: "100%", height: 240 }} resizeMode="cover" />
      ) : (
        <View style={{ width: "100%", height: 120, backgroundColor: mealCfg.color, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name={mealCfg.icon} size={48} color="rgba(255,255,255,0.5)" />
        </View>
      )}

      <View style={{ padding: spacing.lg, gap: spacing.lg, marginTop: -spacing.lg, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, backgroundColor: colors.bg }}>
        {/* タイトル & メタ */}
        <View style={{ gap: spacing.sm }}>
          <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>{meal.dish_name || "食事"}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Ionicons name={mealCfg.icon} size={14} color={mealCfg.color} />
              <Text style={{ fontSize: 13, color: colors.textMuted }}>{mealCfg.label}</Text>
            </View>
            <View style={{ backgroundColor: modeCfg.bg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: modeCfg.color }}>{modeCfg.label}</Text>
            </View>
            {meal.day_date && <Text style={{ fontSize: 13, color: colors.textMuted }}>{meal.day_date}</Text>}
            <StatusBadge variant={meal.is_completed ? "completed" : "pending"} label={meal.is_completed ? "完了" : "未完了"} />
          </View>
        </View>

        {/* 栄養カード */}
        <Card>
          <View style={{ gap: spacing.md }}>
            <SectionHeader title="栄養（推定）" />
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <View style={{ flex: 1, alignItems: "center", padding: spacing.sm, backgroundColor: colors.accentLight, borderRadius: radius.md }}>
                <Text style={{ fontSize: 20, fontWeight: "800", color: colors.accent }}>{meal.calories_kcal ?? "-"}</Text>
                <Text style={{ fontSize: 11, color: colors.textMuted }}>kcal</Text>
              </View>
              <View style={{ flex: 1, alignItems: "center", padding: spacing.sm, backgroundColor: colors.blueLight, borderRadius: radius.md }}>
                <Text style={{ fontSize: 20, fontWeight: "800", color: colors.blue }}>{meal.protein_g ?? "-"}</Text>
                <Text style={{ fontSize: 11, color: colors.textMuted }}>P (g)</Text>
              </View>
              <View style={{ flex: 1, alignItems: "center", padding: spacing.sm, backgroundColor: colors.warningLight, borderRadius: radius.md }}>
                <Text style={{ fontSize: 20, fontWeight: "800", color: colors.warning }}>{meal.fat_g ?? "-"}</Text>
                <Text style={{ fontSize: 11, color: colors.textMuted }}>F (g)</Text>
              </View>
              <View style={{ flex: 1, alignItems: "center", padding: spacing.sm, backgroundColor: colors.successLight, borderRadius: radius.md }}>
                <Text style={{ fontSize: 20, fontWeight: "800", color: colors.success }}>{meal.carbs_g ?? "-"}</Text>
                <Text style={{ fontSize: 11, color: colors.textMuted }}>C (g)</Text>
              </View>
            </View>

            {/* PFCバー */}
            {totalPFC > 0 && (
              <View style={{ flexDirection: "row", height: 8, borderRadius: 4, overflow: "hidden" }}>
                <View style={{ flex: (meal.protein_g ?? 0) / totalPFC, backgroundColor: colors.blue }} />
                <View style={{ flex: (meal.fat_g ?? 0) / totalPFC, backgroundColor: colors.warning }} />
                <View style={{ flex: (meal.carbs_g ?? 0) / totalPFC, backgroundColor: colors.success }} />
              </View>
            )}
          </View>
        </Card>

        {/* コメント */}
        {meal.description && (
          <Card>
            <View style={{ gap: spacing.sm }}>
              <SectionHeader title="コメント" />
              <Text style={{ fontSize: 14, color: colors.text, lineHeight: 22 }}>{meal.description}</Text>
            </View>
          </Card>
        )}

        {/* 料理内訳 */}
        {Array.isArray(meal.dishes) && meal.dishes.length > 0 && (
          <Card>
            <View style={{ gap: spacing.sm }}>
              <SectionHeader title="料理内訳" />
              {meal.dishes.map((d: any, idx: number) => (
                <View key={`${d?.name ?? idx}-${idx}`} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: idx < meal.dishes!.length - 1 ? 1 : 0, borderBottomColor: colors.border }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Text style={{ fontSize: 13, color: colors.text }}>{d?.name ?? "?"}</Text>
                    <Text style={{ fontSize: 11, color: colors.textMuted }}>({d?.role ?? "?"})</Text>
                  </View>
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>{d?.calories_kcal ?? 0} kcal</Text>
                </View>
              ))}
            </View>
          </Card>
        )}

        {/* アクション */}
        <Button variant="secondary" onPress={() => router.push(`/meals/${meal.id}/edit`)}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="create-outline" size={18} color={colors.accent} />
            <Text style={{ fontWeight: "700", color: colors.accent }}>編集</Text>
          </View>
        </Button>

        <View style={{ flexDirection: "row", gap: spacing.md }}>
          <Button
            style={{ flex: 1 }}
            variant={meal.is_completed ? "ghost" : "primary"}
            onPress={toggleCompletion}
          >
            {meal.is_completed ? "未完了に戻す" : "完了にする"}
          </Button>
          <Button variant="destructive" onPress={deleteMeal}>
            <Ionicons name="trash-outline" size={18} color="#fff" />
          </Button>
        </View>
      </View>
    </ScrollView>
    </View>
  );
}
