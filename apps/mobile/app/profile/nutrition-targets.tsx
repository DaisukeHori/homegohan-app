import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";

import { Button, Card, LoadingState, PageHeader, SectionHeader } from "../../src/components/ui";
import { colors, spacing, radius } from "../../src/theme";
import { getApi } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";

interface NutritionTargets {
  daily_calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number;
  sodium_g: number;
  potassium_mg: number;
  calcium_mg: number;
  iron_mg: number;
  zinc_mg: number;
  vitamin_a_ug: number;
  vitamin_b1_mg: number;
  vitamin_b2_mg: number;
  vitamin_b6_mg: number;
  vitamin_b12_ug: number;
  vitamin_c_mg: number;
  vitamin_d_ug: number;
  vitamin_e_mg: number;
  vitamin_k_ug: number;
  folic_acid_ug: number;
  iodine_ug: number;
  phosphorus_mg: number;
  cholesterol_mg: number;
  last_calculated_at: string;
  auto_calculate: boolean;
}

const MACRO_ITEMS = [
  { key: "daily_calories", label: "目標カロリー", unit: "kcal", color: colors.accent, bg: colors.accentLight },
  { key: "protein_g", label: "タンパク質", unit: "g", color: colors.blue, bg: colors.blueLight },
  { key: "fat_g", label: "脂質", unit: "g", color: colors.warning, bg: colors.warningLight },
  { key: "carbs_g", label: "炭水化物", unit: "g", color: colors.success, bg: colors.successLight },
];

const VITAMIN_ITEMS = [
  { key: "vitamin_a_ug", label: "ビタミンA", unit: "µg" },
  { key: "vitamin_d_ug", label: "ビタミンD", unit: "µg" },
  { key: "vitamin_e_mg", label: "ビタミンE", unit: "mg" },
  { key: "vitamin_k_ug", label: "ビタミンK", unit: "µg" },
  { key: "vitamin_b1_mg", label: "ビタミンB1", unit: "mg" },
  { key: "vitamin_b2_mg", label: "ビタミンB2", unit: "mg" },
  { key: "vitamin_b6_mg", label: "ビタミンB6", unit: "mg" },
  { key: "vitamin_b12_ug", label: "ビタミンB12", unit: "µg" },
  { key: "vitamin_c_mg", label: "ビタミンC", unit: "mg" },
  { key: "folic_acid_ug", label: "葉酸", unit: "µg" },
];

const MINERAL_ITEMS = [
  { key: "potassium_mg", label: "カリウム", unit: "mg" },
  { key: "calcium_mg", label: "カルシウム", unit: "mg" },
  { key: "phosphorus_mg", label: "リン", unit: "mg" },
  { key: "iron_mg", label: "鉄", unit: "mg" },
  { key: "zinc_mg", label: "亜鉛", unit: "mg" },
  { key: "iodine_ug", label: "ヨウ素", unit: "µg" },
  { key: "sodium_g", label: "食塩相当量", unit: "g" },
  { key: "fiber_g", label: "食物繊維", unit: "g" },
  { key: "cholesterol_mg", label: "コレステロール", unit: "mg" },
];

export default function NutritionTargetsPage() {
  const [targets, setTargets] = useState<NutritionTargets | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRecalculating, setIsRecalculating] = useState(false);

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const { data } = await supabase
          .from("nutrition_targets")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        if (data) {
          setTargets(data as NutritionTargets);
        } else {
          // Auto-calculate if not exists
          await recalculate();
        }
      } catch (e) {
        console.error("Nutrition targets load error:", e);
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  async function recalculate() {
    setIsRecalculating(true);
    try {
      const api = getApi();
      await api.post("/api/nutrition-targets/calculate", {});

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data } = await supabase
          .from("nutrition_targets")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();
        if (data) setTargets(data as NutritionTargets);
      }
      Alert.alert("完了", "栄養目標を再計算しました。");
    } catch (e: any) {
      Alert.alert("エラー", e?.message ?? "再計算に失敗しました。");
    } finally {
      setIsRecalculating(false);
    }
  }

  if (isLoading) return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="栄養目標" />
      <LoadingState />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="栄養目標" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      {/* ヘッダー説明 */}
      <Card variant="accent">
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Ionicons name="nutrition" size={20} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>あなたの栄養目標</Text>
            <Text style={{ fontSize: 12, color: colors.textMuted }}>
              日本人の食事摂取基準（2020年版）に基づいて計算
            </Text>
          </View>
        </View>
      </Card>

      {!targets ? (
        <Card>
          <View style={{ alignItems: "center", gap: spacing.md, paddingVertical: spacing.xl }}>
            <Ionicons name="calculator-outline" size={48} color={colors.textMuted} />
            <Text style={{ color: colors.textMuted }}>栄養目標がまだ計算されていません</Text>
            <Button onPress={recalculate} loading={isRecalculating}>計算する</Button>
          </View>
        </Card>
      ) : (
        <>
          {/* マクロ栄養素 */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
            {MACRO_ITEMS.map((item) => (
              <View
                key={item.key}
                style={{
                  width: "47%",
                  flexGrow: 1,
                  backgroundColor: item.bg,
                  borderRadius: radius.lg,
                  padding: spacing.lg,
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <Text style={{ fontSize: 28, fontWeight: "800", color: item.color }}>
                  {(targets as any)[item.key] ?? "-"}
                </Text>
                <Text style={{ fontSize: 12, color: colors.textMuted }}>{item.label} ({item.unit})</Text>
              </View>
            ))}
          </View>

          {/* PFCバランス */}
          {(() => {
            const total = (targets.protein_g || 0) + (targets.fat_g || 0) + (targets.carbs_g || 0);
            if (total === 0) return null;
            const pPct = Math.round(((targets.protein_g || 0) / total) * 100);
            const fPct = Math.round(((targets.fat_g || 0) / total) * 100);
            const cPct = 100 - pPct - fPct;
            return (
              <Card>
                <View style={{ gap: spacing.sm }}>
                  <SectionHeader title="PFCバランス" />
                  <View style={{ flexDirection: "row", height: 12, borderRadius: 6, overflow: "hidden" }}>
                    <View style={{ flex: targets.protein_g || 0, backgroundColor: colors.blue }} />
                    <View style={{ flex: targets.fat_g || 0, backgroundColor: colors.warning }} />
                    <View style={{ flex: targets.carbs_g || 0, backgroundColor: colors.success }} />
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
                    <Text style={{ fontSize: 12, color: colors.blue, fontWeight: "700" }}>P {pPct}%</Text>
                    <Text style={{ fontSize: 12, color: colors.warning, fontWeight: "700" }}>F {fPct}%</Text>
                    <Text style={{ fontSize: 12, color: colors.success, fontWeight: "700" }}>C {cPct}%</Text>
                  </View>
                </View>
              </Card>
            );
          })()}

          {/* ビタミン */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <SectionHeader title="ビタミン" />
              {VITAMIN_ITEMS.map((item) => (
                <View
                  key={item.key}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    paddingVertical: 4,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  }}
                >
                  <Text style={{ fontSize: 13, color: colors.text }}>{item.label}</Text>
                  <Text style={{ fontSize: 13, fontWeight: "700", color: colors.textLight }}>
                    {(targets as any)[item.key] ?? "-"} {item.unit}
                  </Text>
                </View>
              ))}
            </View>
          </Card>

          {/* ミネラル・その他 */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <SectionHeader title="ミネラル・その他" />
              {MINERAL_ITEMS.map((item) => (
                <View
                  key={item.key}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    paddingVertical: 4,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  }}
                >
                  <Text style={{ fontSize: 13, color: colors.text }}>{item.label}</Text>
                  <Text style={{ fontSize: 13, fontWeight: "700", color: colors.textLight }}>
                    {(targets as any)[item.key] ?? "-"} {item.unit}
                  </Text>
                </View>
              ))}
            </View>
          </Card>

          {/* 計算日・再計算 */}
          <View style={{ gap: spacing.sm }}>
            {targets.last_calculated_at && (
              <Text style={{ fontSize: 12, color: colors.textMuted, textAlign: "center" }}>
                最終計算日: {new Date(targets.last_calculated_at).toLocaleDateString("ja-JP")}
              </Text>
            )}
            <Button variant="secondary" onPress={recalculate} loading={isRecalculating}>
              再計算する
            </Button>
          </View>
        </>
      )}
    </ScrollView>
    </View>
  );
}
