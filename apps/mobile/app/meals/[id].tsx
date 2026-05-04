import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, LoadingState, PageHeader, SectionHeader, StatusBadge } from "../../src/components/ui";
import { colors, spacing, radius } from "../../src/theme";
import { getApi } from "../../src/lib/api";

type Dish = {
  name?: string | null;
  role?: string | null;
  calories_kcal?: number | null;
  ingredientsMd?: string | null;
  recipeStepsMd?: string | null;
  ingredients?: string[] | null;
};

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
  // 拡張栄養素 (27項目対応)
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_g: number | null;
  potassium_mg: number | null;
  calcium_mg: number | null;
  phosphorus_mg: number | null;
  iron_mg: number | null;
  zinc_mg: number | null;
  iodine_ug: number | null;
  cholesterol_mg: number | null;
  vitamin_a_ug: number | null;
  vitamin_b1_mg: number | null;
  vitamin_b2_mg: number | null;
  vitamin_b6_mg: number | null;
  vitamin_b12_ug: number | null;
  vitamin_c_mg: number | null;
  vitamin_d_ug: number | null;
  vitamin_e_mg: number | null;
  vitamin_k_ug: number | null;
  folic_acid_ug: number | null;
  saturated_fat_g: number | null;
  monounsaturated_fat_g: number | null;
  polyunsaturated_fat_g: number | null;
  is_completed: boolean | null;
  completed_at: string | null;
  dishes: Dish[] | null;
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

const ROLE_LABEL: Record<string, string> = {
  main: "主菜",
  side: "副菜",
  soup: "汁物",
  rice: "主食",
};

const ROLE_COLOR: Record<string, string> = {
  main: colors.accent,
  side: colors.success,
  soup: colors.blue,
  rice: "#8B4513",
};

/** Markdownテキストを行単位で簡易レンダリング */
function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <View style={{ gap: 2 }}>
      {lines.map((line, i) => {
        // テーブル行
        if (line.startsWith("|")) {
          const cells = line.split("|").filter((c) => c.trim() !== "");
          // 区切り行は非表示
          if (cells.every((c) => /^[-: ]+$/.test(c))) return null;
          return (
            <View key={i} style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border }}>
              {cells.map((cell, j) => (
                <Text key={j} style={{ flex: 1, fontSize: 13, color: colors.text, paddingVertical: 4, paddingHorizontal: 4 }}>
                  {cell.trim()}
                </Text>
              ))}
            </View>
          );
        }
        // 番号付きリスト
        const orderedMatch = line.match(/^(\d+)\.\s+(.*)/);
        if (orderedMatch) {
          return (
            <View key={i} style={{ flexDirection: "row", gap: 4, marginBottom: 2 }}>
              <Text style={{ fontSize: 13, color: colors.textMuted, minWidth: 20 }}>{orderedMatch[1]}.</Text>
              <Text style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 20 }}>{orderedMatch[2]}</Text>
            </View>
          );
        }
        // 箇条書き
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <View key={i} style={{ flexDirection: "row", gap: 6, marginBottom: 2 }}>
              <Text style={{ fontSize: 13, color: colors.textMuted }}>•</Text>
              <Text style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 20 }}>{line.slice(2)}</Text>
            </View>
          );
        }
        // 見出し
        if (line.startsWith("## ")) {
          return <Text key={i} style={{ fontSize: 14, fontWeight: "700", color: colors.text, marginTop: 6, marginBottom: 2 }}>{line.slice(3)}</Text>;
        }
        if (line.startsWith("# ")) {
          return <Text key={i} style={{ fontSize: 15, fontWeight: "800", color: colors.text, marginTop: 6, marginBottom: 2 }}>{line.slice(2)}</Text>;
        }
        // 空行
        if (line.trim() === "") return <View key={i} style={{ height: 4 }} />;
        // 通常テキスト
        return <Text key={i} style={{ fontSize: 13, color: colors.text, lineHeight: 20 }}>{line}</Text>;
      })}
    </View>
  );
}

/** 栄養素の値を1行表示するコンポーネント */
function NutritionRow({
  label,
  value,
  unit,
  decimals = 1,
}: {
  label: string;
  value: number | null | undefined;
  unit: string;
  decimals?: number;
}) {
  if (value == null) return null;
  const formatted =
    decimals === 0
      ? Math.round(value).toString()
      : value.toFixed(decimals);
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingVertical: 5,
        borderBottomWidth: 1,
        borderBottomColor: "#F0EDE8",
      }}
    >
      <Text style={{ fontSize: 13, color: colors.textMuted }}>{label}</Text>
      <Text style={{ fontSize: 13, color: colors.text, fontWeight: "600" }}>
        {formatted} {unit}
      </Text>
    </View>
  );
}

/** 栄養素カテゴリラベル */
function NutritionSectionLabel({ label }: { label: string }) {
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: "700",
        color: colors.textMuted,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginTop: 10,
        marginBottom: 2,
      }}
    >
      {label}
    </Text>
  );
}

export default function MealDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [meal, setMeal] = useState<PlannedMealDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllNutrition, setShowAllNutrition] = useState(false);

  // お気に入り状態
  const [isFavorite, setIsFavorite] = useState(false);
  const [isFavoriteLoading, setIsFavoriteLoading] = useState(false);

  // 買い物リスト追加中フラグ
  const [isAddingToCart, setIsAddingToCart] = useState(false);

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

  // お気に入り状態の取得
  useEffect(() => {
    if (!meal?.dish_name) return;
    const encodedId = encodeURIComponent(meal.dish_name);
    const api = getApi();
    api.get<{ liked: boolean }>(`/api/recipes/${encodedId}/like`)
      .then((data) => { if (data) setIsFavorite(data.liked); })
      .catch(() => {/* 取得失敗は無視 */});
  }, [meal?.dish_name]);

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

  const handleToggleFavorite = useCallback(async () => {
    if (!meal?.dish_name || isFavoriteLoading) return;
    const prev = isFavorite;
    setIsFavorite(!prev);
    setIsFavoriteLoading(true);
    try {
      const encodedId = encodeURIComponent(meal.dish_name);
      const api = getApi();
      if (prev) {
        await api.del(`/api/recipes/${encodedId}/like`);
      } else {
        await api.post(`/api/recipes/${encodedId}/like`, {});
      }
    } catch {
      setIsFavorite(prev);
    } finally {
      setIsFavoriteLoading(false);
    }
  }, [meal?.dish_name, isFavorite, isFavoriteLoading]);

  const handleAddToShoppingList = useCallback(async () => {
    if (!meal || isAddingToCart) return;
    setIsAddingToCart(true);
    try {
      let allIngredients: string[] = [];
      if (Array.isArray(meal.dishes)) {
        for (const dish of meal.dishes) {
          if (Array.isArray(dish.ingredients)) {
            allIngredients = [...allIngredients, ...dish.ingredients];
          }
        }
      }

      if (allIngredients.length === 0) {
        Alert.alert("材料なし", "材料情報がありません。AIで再生成してください。");
        return;
      }

      const parsedIngredients = allIngredients.map((ing) => {
        const match = ing.match(/^(.+?)\s+(\d+.*|少々|適量|適宜)$/);
        if (match) return { name: match[1], amount: match[2] };
        return { name: ing, amount: null };
      });

      const api = getApi();
      await api.post("/api/shopping-list/add-recipe", { ingredients: parsedIngredients });

      Alert.alert("追加完了", `${parsedIngredients.length}件の材料を買い物リストに追加しました。`);
    } catch (e: any) {
      Alert.alert("エラー", e?.message ?? "追加に失敗しました。");
    } finally {
      setIsAddingToCart(false);
    }
  }, [meal, isAddingToCart]);

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

  const mealCfg = MEAL_CONFIG[meal.meal_type] ?? { icon: "ellipse" as keyof typeof Ionicons.glyphMap, label: meal.meal_type, color: colors.textMuted };
  const modeCfg = MODE_CONFIG[meal.mode ?? "cook"] ?? MODE_CONFIG.cook;
  const totalPFC = (meal.protein_g ?? 0) + (meal.fat_g ?? 0) + (meal.carbs_g ?? 0);

  const primaryDish: Dish | null = Array.isArray(meal.dishes) && meal.dishes.length > 0 ? meal.dishes[0] : null;
  const ingredientsMd = primaryDish?.ingredientsMd ?? null;
  const recipeStepsMd = primaryDish?.recipeStepsMd ?? null;

  return (
    <View testID="meal-detail-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
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
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
            {/* 役割バッジ */}
            {primaryDish?.role && (
              <View style={{
                backgroundColor: ROLE_COLOR[primaryDish.role] ?? colors.accent,
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 4,
              }}>
                <Text style={{ fontSize: 11, fontWeight: "700", color: "#fff" }}>
                  {ROLE_LABEL[primaryDish.role] ?? primaryDish.role}
                </Text>
              </View>
            )}
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

            {/* 4大栄養素サマリ */}
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

            {/* 詳細栄養素トグル */}
            <Pressable
              testID="meal-detail-nutrition-toggle"
              onPress={() => setShowAllNutrition((v) => !v)}
              style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: spacing.xs }}
            >
              <Text style={{ fontSize: 13, fontWeight: "700", color: colors.accent }}>
                {showAllNutrition ? "詳細栄養素を閉じる" : "詳細栄養素を見る（27項目）"}
              </Text>
              <Ionicons
                name={showAllNutrition ? "chevron-up" : "chevron-down"}
                size={16}
                color={colors.accent}
              />
            </Pressable>

            {/* 詳細栄養素一覧（折りたたみ） */}
            {showAllNutrition && (
              <View style={{ gap: 0 }}>
                {/* 基本 */}
                <NutritionRow label="エネルギー" value={meal.calories_kcal} unit="kcal" decimals={0} />
                <NutritionRow label="タンパク質" value={meal.protein_g} unit="g" />
                <NutritionRow label="脂質" value={meal.fat_g} unit="g" />
                <NutritionRow label="炭水化物" value={meal.carbs_g} unit="g" />
                <NutritionRow label="食物繊維" value={meal.fiber_g} unit="g" />
                <NutritionRow label="糖質" value={meal.sugar_g} unit="g" />
                {/* ミネラル */}
                <NutritionSectionLabel label="ミネラル" />
                <NutritionRow label="塩分" value={meal.sodium_g} unit="g" />
                <NutritionRow label="カリウム" value={meal.potassium_mg} unit="mg" decimals={0} />
                <NutritionRow label="カルシウム" value={meal.calcium_mg} unit="mg" decimals={0} />
                <NutritionRow label="リン" value={meal.phosphorus_mg} unit="mg" decimals={0} />
                <NutritionRow label="鉄分" value={meal.iron_mg} unit="mg" />
                <NutritionRow label="亜鉛" value={meal.zinc_mg} unit="mg" />
                <NutritionRow label="ヨウ素" value={meal.iodine_ug} unit="µg" decimals={0} />
                <NutritionRow label="コレステロール" value={meal.cholesterol_mg} unit="mg" decimals={0} />
                {/* ビタミン */}
                <NutritionSectionLabel label="ビタミン" />
                <NutritionRow label="ビタミンA" value={meal.vitamin_a_ug} unit="µg" decimals={0} />
                <NutritionRow label="ビタミンB1" value={meal.vitamin_b1_mg} unit="mg" decimals={2} />
                <NutritionRow label="ビタミンB2" value={meal.vitamin_b2_mg} unit="mg" decimals={2} />
                <NutritionRow label="ビタミンB6" value={meal.vitamin_b6_mg} unit="mg" decimals={2} />
                <NutritionRow label="ビタミンB12" value={meal.vitamin_b12_ug} unit="µg" />
                <NutritionRow label="ビタミンC" value={meal.vitamin_c_mg} unit="mg" decimals={0} />
                <NutritionRow label="ビタミンD" value={meal.vitamin_d_ug} unit="µg" />
                <NutritionRow label="ビタミンE" value={meal.vitamin_e_mg} unit="mg" />
                <NutritionRow label="ビタミンK" value={meal.vitamin_k_ug} unit="µg" decimals={0} />
                <NutritionRow label="葉酸" value={meal.folic_acid_ug} unit="µg" decimals={0} />
                {/* 脂肪酸 */}
                <NutritionSectionLabel label="脂肪酸" />
                <NutritionRow label="飽和脂肪酸" value={meal.saturated_fat_g} unit="g" />
                <NutritionRow label="一価不飽和脂肪酸" value={meal.monounsaturated_fat_g} unit="g" />
                <NutritionRow label="多価不飽和脂肪酸" value={meal.polyunsaturated_fat_g} unit="g" />
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

        {/* 材料 */}
        <Card>
          <View style={{ gap: spacing.sm }}>
            <SectionHeader title="材料" />
            {ingredientsMd ? (
              <SimpleMarkdown text={ingredientsMd} />
            ) : (
              <Text style={{ fontSize: 13, color: colors.textMuted }}>
                材料情報なし。AIで再生成すると表示されます。
              </Text>
            )}
          </View>
        </Card>

        {/* 作り方 */}
        <Card>
          <View style={{ gap: spacing.sm }}>
            <SectionHeader title="作り方" />
            {recipeStepsMd ? (
              <SimpleMarkdown text={recipeStepsMd} />
            ) : (
              <Text style={{ fontSize: 13, color: colors.textMuted }}>
                レシピはAI献立を生成すると自動で作成されます。
              </Text>
            )}
          </View>
        </Card>

        {/* 料理内訳 */}
        {Array.isArray(meal.dishes) && meal.dishes.length > 0 && (
          <Card>
            <View style={{ gap: spacing.sm }}>
              <SectionHeader title="料理内訳" />
              {meal.dishes.map((d, idx) => (
                <View
                  key={`${d?.name ?? idx}-${idx}`}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    paddingVertical: 4,
                    borderBottomWidth: idx < meal.dishes!.length - 1 ? 1 : 0,
                    borderBottomColor: colors.border,
                  }}
                >
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

        {/* ハートボタン + 買い物リスト追加 */}
        <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}>
          <Pressable
            testID="meal-detail-favorite-button"
            onPress={handleToggleFavorite}
            disabled={isFavoriteLoading}
            accessibilityLabel={isFavorite ? "お気に入りから削除" : "お気に入りに追加"}
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: isFavorite ? "#FFF0F0" : colors.card,
              borderWidth: 1,
              borderColor: isFavorite ? "#FF6B6B" : colors.border,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed || isFavoriteLoading ? 0.7 : 1,
            })}
          >
            <Ionicons
              name={isFavorite ? "heart" : "heart-outline"}
              size={22}
              color={isFavorite ? "#FF6B6B" : colors.textMuted}
            />
          </Pressable>

          <Button
            style={{ flex: 1 }}
            variant="secondary"
            onPress={handleAddToShoppingList}
            disabled={isAddingToCart}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="cart-outline" size={18} color={colors.accent} />
              <Text style={{ fontWeight: "700", color: colors.accent }}>
                {isAddingToCart ? "追加中..." : "材料を買い物リストに追加"}
              </Text>
            </View>
          </Button>
        </View>

        {/* アクション */}
        <Button testID="meal-detail-edit-button" variant="secondary" onPress={() => router.push(`/meals/${meal.id}/edit`)}>
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
          <Button testID="meal-detail-delete-button" variant="destructive" onPress={deleteMeal}>
            <Ionicons name="trash-outline" size={18} color="#fff" />
          </Button>
        </View>
      </View>
    </ScrollView>
    </View>
  );
}
