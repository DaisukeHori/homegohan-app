import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, Input, LoadingState, PageHeader, SectionHeader } from "../../../src/components/ui";
import { colors, spacing, radius } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

type Mode = "cook" | "out" | "buy" | "skip" | "quick";

const MODE_OPTIONS: { value: Mode; label: string; icon: keyof typeof Ionicons.glyphMap; color: string }[] = [
  { value: "cook", label: "自炊", icon: "flame", color: colors.success },
  { value: "quick", label: "時短", icon: "flash", color: colors.blue },
  { value: "buy", label: "中食", icon: "bag", color: colors.purple },
  { value: "out", label: "外食", icon: "restaurant", color: colors.warning },
  { value: "skip", label: "スキップ", icon: "close-circle", color: colors.textMuted },
];

export default function MealEditPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [dishName, setDishName] = useState("");
  const [mode, setMode] = useState<Mode>("cook");
  const [description, setDescription] = useState("");
  const [caloriesKcal, setCaloriesKcal] = useState("");
  const [proteinG, setProteinG] = useState("");
  const [fatG, setFatG] = useState("");
  const [carbsG, setCarbsG] = useState("");
  const [cookingTimeMinutes, setCookingTimeMinutes] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!id) return;
      setIsLoading(true);
      setError(null);
      try {
        const api = getApi();
        const data: any = await api.get(`/api/meals/${id}`);
        if (cancelled) return;
        setDishName(data?.dish_name ?? "");
        setMode((data?.mode ?? "cook") as Mode);
        setDescription(data?.description ?? "");
        setCaloriesKcal(data?.calories_kcal != null ? String(data.calories_kcal) : "");
        setProteinG(data?.protein_g != null ? String(data.protein_g) : "");
        setFatG(data?.fat_g != null ? String(data.fat_g) : "");
        setCarbsG(data?.carbs_g != null ? String(data.carbs_g) : "");
        setCookingTimeMinutes(data?.cooking_time_minutes != null ? String(data.cooking_time_minutes) : "");
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "取得に失敗しました。");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id]);

  function toNumberOrNull(s: string): number | null {
    const v = s.trim();
    if (!v) return null;
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return n;
  }

  async function save() {
    if (!id || isSaving) return;
    const name = dishName.trim();
    if (!name) {
      Alert.alert("入力エラー", "料理名を入力してください。");
      return;
    }
    setIsSaving(true);
    try {
      const api = getApi();
      await api.patch(`/api/meals/${id}`, {
        dish_name: name,
        mode,
        description: description.trim() || null,
        calories_kcal: toNumberOrNull(caloriesKcal),
        protein_g: toNumberOrNull(proteinG),
        fat_g: toNumberOrNull(fatG),
        carbs_g: toNumberOrNull(carbsG),
        cooking_time_minutes: toNumberOrNull(cookingTimeMinutes),
      });
      router.replace(`/meals/${id}`);
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="食事を編集" />
      <LoadingState />
    </View>
  );

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <PageHeader title="食事を編集" />
        <View style={{ flex: 1, padding: spacing.lg, justifyContent: "center", gap: spacing.md }}>
          <Card variant="error">
            <Text style={{ color: colors.error }}>{error}</Text>
          </Card>
          <Button variant="ghost" onPress={() => router.back()}>戻る</Button>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="食事を編集" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      {/* 料理名 */}
      <Input label="料理名" value={dishName} onChangeText={setDishName} placeholder="例: 鮭の塩焼き定食" />

      {/* モード */}
      <Card>
        <View style={{ gap: spacing.md }}>
          <SectionHeader title="モード" />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {MODE_OPTIONS.map((opt) => {
              const selected = mode === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => setMode(opt.value)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingVertical: spacing.sm,
                    paddingHorizontal: spacing.md,
                    borderRadius: radius.full,
                    backgroundColor: selected ? opt.color : colors.bg,
                    borderWidth: 1,
                    borderColor: selected ? opt.color : colors.border,
                  }}
                >
                  <Ionicons name={opt.icon} size={14} color={selected ? "#fff" : opt.color} />
                  <Text style={{ fontSize: 13, fontWeight: "700", color: selected ? "#fff" : colors.text }}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </Card>

      {/* メモ */}
      <Input
        label="メモ（任意）"
        value={description}
        onChangeText={setDescription}
        placeholder="例: 野菜を増やしたい"
        multiline
      />

      {/* 栄養 */}
      <Card>
        <View style={{ gap: spacing.md }}>
          <SectionHeader title="栄養（任意）" />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Input label="kcal" value={caloriesKcal} onChangeText={setCaloriesKcal} keyboardType="numeric" placeholder="500" />
            </View>
            <View style={{ flex: 1 }}>
              <Input label="P (g)" value={proteinG} onChangeText={setProteinG} keyboardType="numeric" placeholder="20" />
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Input label="F (g)" value={fatG} onChangeText={setFatG} keyboardType="numeric" placeholder="15" />
            </View>
            <View style={{ flex: 1 }}>
              <Input label="C (g)" value={carbsG} onChangeText={setCarbsG} keyboardType="numeric" placeholder="60" />
            </View>
          </View>
          <Input label="調理時間 (分)" value={cookingTimeMinutes} onChangeText={setCookingTimeMinutes} keyboardType="numeric" placeholder="30" />
        </View>
      </Card>

      <Button onPress={save} loading={isSaving}>
        {isSaving ? "保存中..." : "保存"}
      </Button>
    </ScrollView>
    </View>
  );
}
