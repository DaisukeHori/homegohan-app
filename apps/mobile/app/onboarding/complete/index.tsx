import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { Card, SectionHeader } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { supabase } from "../../../src/lib/supabase";
import { colors, radius, shadows, spacing } from "../../../src/theme";

// ------------------------------------------------------------
// 型定義
// ------------------------------------------------------------

interface NutritionTargets {
  daily_calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g?: number | null;
  sodium_g?: number | null;
  sugar_g?: number | null;
  auto_calculate: boolean;
  calculation_basis?: CalculationBasis | null;
  last_calculated_at?: string | null;
}

interface CalculationBasis {
  energy?: {
    bmr: { result_kcal: number };
    pal: { result: number };
    tdee_kcal: number;
    goal_adjustment: { delta_kcal: number; reason: string };
  };
  macros?: {
    ratios?: { protein: number; fat: number; carbs: number };
  };
}

// PFC 比率から g を再計算するミニ関数（web 版 deriveMacroTargets と同等）
function deriveMacros(
  dailyCalories: number,
  ratios: { protein: number; fat: number; carbs: number },
): { proteinG: number; fatG: number; carbsG: number } {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const total = Math.max(0, dailyCalories);
  const proteinG = r1((total * ratios.protein) / 4);
  const fatG = r1((total * ratios.fat) / 9);
  const carbsG = r1(Math.max(0, total - proteinG * 4 - fatG * 9) / 4);
  return { proteinG, fatG, carbsG };
}

function getRatios(targets: NutritionTargets): { protein: number; fat: number; carbs: number } {
  const basisRatios = targets.calculation_basis?.macros?.ratios;
  if (basisRatios) return basisRatios;

  const total = targets.daily_calories || 1;
  const protein = ((targets.protein_g || 0) * 4) / total;
  const fat = ((targets.fat_g || 0) * 9) / total;
  const carbs = ((targets.carbs_g || 0) * 4) / total;
  const sum = protein + fat + carbs;
  if (sum <= 0) return { protein: 0.3, fat: 0.25, carbs: 0.45 };
  return { protein: protein / sum, fat: fat / sum, carbs: carbs / sum };
}

// ------------------------------------------------------------
// メインコンポーネント
// ------------------------------------------------------------

export default function OnboardingComplete() {
  const [loadingTargets, setLoadingTargets] = useState(true);
  const [saving, setSaving] = useState(false);
  const [targets, setTargets] = useState<NutritionTargets | null>(null);
  const [autoCalculate, setAutoCalculate] = useState(true);
  const [manualCalories, setManualCalories] = useState("");

  // 栄養目標を読み込む
  useEffect(() => {
    async function load() {
      setLoadingTargets(true);
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        const { data } = await supabase
          .from("nutrition_targets")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        if (data) {
          const t = data as NutritionTargets;
          setTargets(t);
          setAutoCalculate(t.auto_calculate ?? true);
          setManualCalories(String(t.daily_calories ?? ""));
        }
      } catch (e) {
        console.error("nutrition_targets load error:", e);
      } finally {
        setLoadingTargets(false);
      }
    }
    void load();
  }, []);

  // プレビューカロリー
  const previewCalories = useMemo(() => {
    if (autoCalculate) return targets?.daily_calories ?? 0;
    const parsed = Number(manualCalories);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : targets?.daily_calories ?? 0;
  }, [autoCalculate, manualCalories, targets?.daily_calories]);

  // PFC プレビュー
  const previewMacros = useMemo(() => {
    if (!targets) return null;
    return deriveMacros(previewCalories, getRatios(targets));
  }, [previewCalories, targets]);

  // BMR / TDEE 情報
  const energy = targets?.calculation_basis?.energy;

  // 保存処理
  async function handleSave() {
    if (!targets || !previewMacros) return;
    setSaving(true);
    try {
      const api = getApi();
      if (autoCalculate) {
        await api.post("/api/nutrition-targets/calculate", {});
      } else {
        const basisWithOverride = {
          ...(targets.calculation_basis ?? {}),
          manual_override: {
            enabled: true,
            original_daily_calories: targets.daily_calories,
            overridden_daily_calories: previewCalories,
            saved_at: new Date().toISOString(),
          },
        };
        await api.put("/api/nutrition/targets", {
          autoCalculate: false,
          dailyCalories: previewCalories,
          proteinG: previewMacros.proteinG,
          fatG: previewMacros.fatG,
          carbsG: previewMacros.carbsG,
          fiberG: targets.fiber_g,
          sodiumG: targets.sodium_g,
          sugarG: targets.sugar_g,
          calculationBasis: basisWithOverride,
          lastCalculatedAt: new Date().toISOString(),
        });
      }

      // 保存後にデータを再読み込み
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data } = await supabase
          .from("nutrition_targets")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();
        if (data) {
          setTargets(data as NutritionTargets);
          setManualCalories(String((data as NutritionTargets).daily_calories ?? ""));
        }
      }

      Alert.alert(
        "保存しました",
        autoCalculate ? "自動計算の目標に設定しました。" : "手動調整した栄養目標を保存しました。",
        [{ text: "OK" }],
      );
    } catch (e: any) {
      Alert.alert("エラー", e?.message ?? "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  }

  // PFC バランスバー用パーセント
  const pfcPct = useMemo(() => {
    if (!targets) return null;
    const p = (targets.protein_g || 0) * 4;
    const f = (targets.fat_g || 0) * 9;
    const c = (targets.carbs_g || 0) * 4;
    const total = p + f + c;
    if (total === 0) return null;
    const pPct = Math.round((p / total) * 100);
    const fPct = Math.round((f / total) * 100);
    return { pPct, fPct, cPct: 100 - pPct - fPct };
  }, [targets]);

  return (
    <ScrollView
      style={styles.scrollView}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
    >
      {/* ヒーローヘッダー */}
      <View style={styles.heroSection}>
        <View style={styles.heroIcon}>
          <Ionicons name="checkmark-done" size={52} color="#FFFFFF" />
        </View>
        <Text style={styles.title}>栄養設計まで完了！</Text>
        <Text style={styles.subtitle}>
          算出された BMR / TDEE / PFC を確認して、{"\n"}
          そのまま始めるか自分好みに微調整できます。
        </Text>
      </View>

      {/* 栄養目標セクション */}
      {loadingTargets ? (
        <Card style={styles.loadingCard}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>栄養目標を読み込み中...</Text>
        </Card>
      ) : targets ? (
        <>
          {/* BMR / TDEE ステップカード */}
          {energy && (
            <Card style={styles.energyCard}>
              <SectionHeader title="計算の根拠" />
              <View style={styles.energySteps}>
                {[
                  { label: "BMR", value: `${energy.bmr.result_kcal} kcal`, note: "基礎代謝" },
                  { label: "PAL", value: `${energy.pal.result}`, note: "活動係数" },
                  { label: "TDEE", value: `${energy.tdee_kcal} kcal`, note: "1日の消費量" },
                  {
                    label: "調整",
                    value: `${energy.goal_adjustment.delta_kcal >= 0 ? "+" : ""}${energy.goal_adjustment.delta_kcal} kcal`,
                    note: energy.goal_adjustment.reason,
                  },
                ].map((step) => (
                  <View key={step.label} style={styles.energyStep}>
                    <Text style={styles.energyStepLabel}>{step.label}</Text>
                    <Text style={styles.energyStepValue}>{step.value}</Text>
                    <Text style={styles.energyStepNote}>{step.note}</Text>
                  </View>
                ))}
              </View>
            </Card>
          )}

          {/* 目標カロリー・PFC マクロ */}
          <Card style={styles.macroCard}>
            <View style={styles.calorieHeader}>
              <View>
                <Text style={styles.sectionTitle}>目標カロリー</Text>
                <Text style={styles.calorieValue}>{previewCalories}</Text>
                <Text style={styles.calorieUnit}>kcal / day</Text>
              </View>
              <View style={styles.macroGrid}>
                <View style={[styles.macroItem, { backgroundColor: colors.blueLight }]}>
                  <Text style={[styles.macroValue, { color: colors.blue }]}>
                    {previewMacros?.proteinG ?? "-"}
                  </Text>
                  <Text style={styles.macroLabel}>タンパク質 g</Text>
                </View>
                <View style={[styles.macroItem, { backgroundColor: colors.warningLight }]}>
                  <Text style={[styles.macroValue, { color: colors.warning }]}>
                    {previewMacros?.fatG ?? "-"}
                  </Text>
                  <Text style={styles.macroLabel}>脂質 g</Text>
                </View>
                <View style={[styles.macroItem, { backgroundColor: colors.successLight }]}>
                  <Text style={[styles.macroValue, { color: colors.success }]}>
                    {previewMacros?.carbsG ?? "-"}
                  </Text>
                  <Text style={styles.macroLabel}>炭水化物 g</Text>
                </View>
              </View>
            </View>

            {/* PFC バランスバー */}
            {pfcPct && (
              <View style={styles.pfcSection}>
                <View style={styles.pfcBar}>
                  <View style={[styles.pfcSegment, { flex: pfcPct.pPct, backgroundColor: colors.blue }]} />
                  <View style={[styles.pfcSegment, { flex: pfcPct.fPct, backgroundColor: colors.warning }]} />
                  <View style={[styles.pfcSegment, { flex: pfcPct.cPct, backgroundColor: colors.success }]} />
                </View>
                <View style={styles.pfcLegend}>
                  <Text style={[styles.pfcLegendText, { color: colors.blue }]}>P {pfcPct.pPct}%</Text>
                  <Text style={[styles.pfcLegendText, { color: colors.warning }]}>F {pfcPct.fPct}%</Text>
                  <Text style={[styles.pfcLegendText, { color: colors.success }]}>C {pfcPct.cPct}%</Text>
                </View>
              </View>
            )}
          </Card>

          {/* 微調整パネル */}
          <Card style={styles.adjustCard}>
            <SectionHeader title="目標の微調整" />
            <Text style={styles.adjustSubtitle}>
              自動計算のまま使うか、カロリーだけ手動で指定するか選べます。
            </Text>

            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>自動計算を使う</Text>
              <Switch
                value={autoCalculate}
                onValueChange={(v) => {
                  setAutoCalculate(v);
                  if (v) setManualCalories(String(targets.daily_calories));
                }}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor="#FFFFFF"
              />
            </View>

            {!autoCalculate && (
              <View style={styles.manualInput}>
                <Text style={styles.inputLabel}>目標カロリー (kcal)</Text>
                <TextInput
                  style={styles.textInput}
                  value={manualCalories}
                  onChangeText={setManualCalories}
                  keyboardType="numeric"
                  placeholder="例: 1800"
                  placeholderTextColor={colors.textMuted}
                />
                <Text style={styles.inputHint}>推奨範囲: 1,000〜5,000 kcal</Text>
              </View>
            )}

            <Pressable
              onPress={() => void handleSave()}
              disabled={saving}
              style={({ pressed }) => [
                styles.saveButton,
                (pressed || saving) && { opacity: 0.75 },
              ]}
            >
              {saving ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.saveButtonText}>
                  {autoCalculate ? "自動計算で保存" : "この設定で保存"}
                </Text>
              )}
            </Pressable>
          </Card>
        </>
      ) : (
        /* 栄養目標未算出の場合のフォールバック */
        <Card style={styles.hintCard}>
          <View style={styles.hintRow}>
            <View style={styles.hintIconWrap}>
              <Ionicons name="home" size={20} color={colors.accent} />
            </View>
            <Text style={styles.hintText}>ホーム画面から食事を記録</Text>
          </View>
          <View style={styles.hintRow}>
            <View style={styles.hintIconWrap}>
              <Ionicons name="calendar" size={20} color={colors.accent} />
            </View>
            <Text style={styles.hintText}>週間献立を自動で提案</Text>
          </View>
          <View style={styles.hintRow}>
            <View style={styles.hintIconWrap}>
              <Ionicons name="trophy" size={20} color={colors.accent} />
            </View>
            <Text style={styles.hintText}>目標達成で褒めてもらえる</Text>
          </View>
        </Card>
      )}

      {/* ホームへ CTA */}
      <Pressable
        onPress={() => router.replace("/(tabs)/home")}
        style={({ pressed }) => [
          styles.ctaButton,
          pressed && { opacity: 0.9, transform: [{ scale: 0.98 }] },
        ]}
      >
        <Text style={styles.ctaText}>この設定で始める</Text>
        <Ionicons name="arrow-forward" size={20} color="#FFFFFF" />
      </Pressable>

      <Text style={styles.laterNote}>後から設定画面でいつでも見直せます。</Text>
    </ScrollView>
  );
}

// ------------------------------------------------------------
// スタイル
// ------------------------------------------------------------

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
    backgroundColor: "#FFF7ED",
  },
  container: {
    padding: spacing["2xl"],
    gap: spacing.lg,
    paddingBottom: spacing["4xl"],
  },
  heroSection: {
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  heroIcon: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: colors.success,
    justifyContent: "center",
    alignItems: "center",
    ...shadows.lg,
  },
  title: {
    fontSize: 26,
    fontWeight: "900",
    color: colors.text,
    textAlign: "center",
  },
  subtitle: {
    color: colors.textLight,
    textAlign: "center",
    fontSize: 14,
    lineHeight: 22,
  },
  loadingCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    justifyContent: "center",
    paddingVertical: spacing.xl,
  },
  loadingText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  // エネルギー計算カード
  energyCard: {
    gap: spacing.md,
  },
  energySteps: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  energyStep: {
    flex: 1,
    minWidth: "22%",
    backgroundColor: colors.accentLight,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: 2,
    alignItems: "center",
  },
  energyStepLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.accent,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  energyStepValue: {
    fontSize: 13,
    fontWeight: "800",
    color: colors.text,
    textAlign: "center",
  },
  energyStepNote: {
    fontSize: 10,
    color: colors.textMuted,
    textAlign: "center",
  },
  // マクロカード
  macroCard: {
    gap: spacing.md,
  },
  calorieHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  sectionTitle: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: "600",
  },
  calorieValue: {
    fontSize: 36,
    fontWeight: "900",
    color: colors.accent,
  },
  calorieUnit: {
    fontSize: 12,
    color: colors.textMuted,
  },
  macroGrid: {
    flex: 1,
    gap: spacing.sm,
  },
  macroItem: {
    borderRadius: radius.md,
    padding: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  macroValue: {
    fontSize: 18,
    fontWeight: "800",
  },
  macroLabel: {
    fontSize: 11,
    color: colors.textMuted,
  },
  pfcSection: {
    gap: spacing.sm,
  },
  pfcBar: {
    flexDirection: "row",
    height: 10,
    borderRadius: radius.full,
    overflow: "hidden",
  },
  pfcSegment: {
    height: "100%",
  },
  pfcLegend: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  pfcLegendText: {
    fontSize: 12,
    fontWeight: "700",
  },
  // 微調整カード
  adjustCard: {
    gap: spacing.md,
  },
  adjustSubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 20,
  },
  toggleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  manualInput: {
    gap: spacing.sm,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  textInput: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 16,
    color: colors.text,
  },
  inputHint: {
    fontSize: 11,
    color: colors.textMuted,
  },
  saveButton: {
    backgroundColor: colors.textLight,
    paddingVertical: 14,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  saveButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 15,
  },
  // フォールバックヒントカード
  hintCard: {
    gap: spacing.md,
  },
  hintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  hintIconWrap: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    justifyContent: "center",
    alignItems: "center",
  },
  hintText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textLight,
  },
  // CTA
  ctaButton: {
    backgroundColor: colors.accent,
    paddingVertical: 18,
    paddingHorizontal: spacing["3xl"],
    borderRadius: radius.full,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
    ...shadows.lg,
  },
  ctaText: {
    color: "#FFFFFF",
    fontWeight: "800",
    fontSize: 17,
  },
  laterNote: {
    textAlign: "center",
    fontSize: 12,
    color: colors.textMuted,
  },
});
