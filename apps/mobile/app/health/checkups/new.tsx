import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, radius, shadows, spacing } from "../../../src/theme";

// ─── Types ────────────────────────────────────────────
interface FormData {
  checkup_date: string;
  facility_name: string;
  checkup_type: string;
  // 血圧・代謝
  blood_pressure_systolic: string;
  blood_pressure_diastolic: string;
  hba1c: string;
  fasting_glucose: string;
  // 身体測定
  height: string;
  weight: string;
  bmi: string;
  waist_circumference: string;
  // 脂質
  total_cholesterol: string;
  ldl_cholesterol: string;
  hdl_cholesterol: string;
  triglycerides: string;
  // 肝機能
  ast: string;
  alt: string;
  gamma_gtp: string;
  // 腎機能
  creatinine: string;
  egfr: string;
  uric_acid: string;
}

type Step = "form" | "review";

const CHECKUP_TYPES = ["定期健診", "人間ドック", "特定健診", "その他"];

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toNum(v: string): number | undefined {
  const s = v.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

// ─── Component ────────────────────────────────────────
export default function NewCheckupPage() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [step, setStep] = useState<Step>("form");
  const [saving, setSaving] = useState(false);
  const [savedCheckup, setSavedCheckup] = useState<any>(null);

  const [form, setForm] = useState<FormData>({
    checkup_date: todayStr(),
    facility_name: "",
    checkup_type: "定期健診",
    blood_pressure_systolic: "",
    blood_pressure_diastolic: "",
    hba1c: "",
    fasting_glucose: "",
    height: "",
    weight: "",
    bmi: "",
    waist_circumference: "",
    total_cholesterol: "",
    ldl_cholesterol: "",
    hdl_cholesterol: "",
    triglycerides: "",
    ast: "",
    alt: "",
    gamma_gtp: "",
    creatinine: "",
    egfr: "",
    uric_acid: "",
  });

  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    basic: true,
    body: true,
    lipid: false,
    liver: false,
    kidney: false,
  });

  function update(field: keyof FormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function toggleSection(key: string) {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleSave() {
    if (!form.checkup_date) {
      Alert.alert("エラー", "検査日を入力してください。");
      return;
    }
    setSaving(true);
    try {
      const numericFields = [
        "blood_pressure_systolic", "blood_pressure_diastolic",
        "hba1c", "fasting_glucose",
        "height", "weight", "bmi", "waist_circumference",
        "total_cholesterol", "ldl_cholesterol", "hdl_cholesterol", "triglycerides",
        "ast", "alt", "gamma_gtp",
        "creatinine", "egfr", "uric_acid",
      ] as const;

      const payload: Record<string, unknown> = {
        checkup_date: form.checkup_date,
        facility_name: form.facility_name || null,
        checkup_type: form.checkup_type || null,
      };

      for (const field of numericFields) {
        const n = toNum(form[field]);
        if (n !== undefined) payload[field] = n;
      }

      const api = getApi();
      const data = await api.post<{ checkup: any }>("/api/health/checkups", payload);
      setSavedCheckup(data.checkup);
      setStep("review");
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "記録の保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  }

  // ─── Sub-renders ──────────────────────────────────
  function renderField(
    field: keyof FormData,
    label: string,
    unit?: string,
    placeholder?: string,
  ) {
    return (
      <View key={field} style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <View style={styles.fieldInputWrap}>
          <TextInput
            style={styles.fieldInput}
            value={form[field]}
            onChangeText={(v) => update(field, v)}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
          />
          {unit && <Text style={styles.fieldUnit}>{unit}</Text>}
        </View>
      </View>
    );
  }

  function renderSection(
    key: string,
    title: string,
    iconName: keyof typeof Ionicons.glyphMap,
    children: React.ReactNode,
  ) {
    return (
      <View style={styles.section}>
        <Pressable style={styles.sectionHeader} onPress={() => toggleSection(key)}>
          <View style={styles.sectionIconBox}>
            <Ionicons name={iconName} size={18} color={colors.accent} />
          </View>
          <Text style={styles.sectionTitle}>{title}</Text>
          <Ionicons
            name={expandedSections[key] ? "chevron-up" : "chevron-down"}
            size={18}
            color={colors.textMuted}
          />
        </Pressable>
        {expandedSections[key] && <View style={styles.sectionBody}>{children}</View>}
      </View>
    );
  }

  // ─── Review step ──────────────────────────────────
  if (step === "review" && savedCheckup) {
    const review = savedCheckup.individual_review;
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>AI分析結果</Text>
          <View style={{ width: 24 }} />
        </View>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {review ? (
            <>
              {/* 総評 */}
              <View style={styles.reviewCard}>
                <View style={styles.reviewCardHeader}>
                  <Ionicons name="sparkles-outline" size={20} color={colors.purple} />
                  <Text style={styles.reviewCardTitle}>AI分析結果</Text>
                </View>
                <Text style={styles.reviewCardBody}>{review.summary}</Text>
              </View>

              {/* 気になる点 */}
              {(review.concerns ?? []).length > 0 && (
                <View style={[styles.reviewCard, { backgroundColor: colors.warningLight }]}>
                  <View style={styles.reviewCardHeader}>
                    <Ionicons name="warning-outline" size={18} color={colors.warning} />
                    <Text style={[styles.reviewCardTitle, { color: colors.warning }]}>気になる点</Text>
                  </View>
                  {review.concerns.map((item: string, i: number) => (
                    <Text key={i} style={styles.reviewItem}>• {item}</Text>
                  ))}
                </View>
              )}

              {/* 良い点 */}
              {(review.positives ?? []).length > 0 && (
                <View style={[styles.reviewCard, { backgroundColor: colors.successLight }]}>
                  <View style={styles.reviewCardHeader}>
                    <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} />
                    <Text style={[styles.reviewCardTitle, { color: colors.success }]}>良い点</Text>
                  </View>
                  {review.positives.map((item: string, i: number) => (
                    <Text key={i} style={styles.reviewItem}>• {item}</Text>
                  ))}
                </View>
              )}

              {/* アドバイス */}
              {(review.recommendations ?? []).length > 0 && (
                <View style={[styles.reviewCard, { backgroundColor: colors.purpleLight }]}>
                  <View style={styles.reviewCardHeader}>
                    <Ionicons name="sparkles-outline" size={18} color={colors.purple} />
                    <Text style={[styles.reviewCardTitle, { color: colors.purple }]}>改善アドバイス</Text>
                  </View>
                  {review.recommendations.map((item: string, i: number) => (
                    <Text key={i} style={styles.reviewItem}>{i + 1}. {item}</Text>
                  ))}
                </View>
              )}
            </>
          ) : (
            <View style={styles.reviewCard}>
              <Text style={[styles.reviewCardBody, { color: colors.textMuted, textAlign: "center" }]}>
                AI分析を実行できませんでした
              </Text>
            </View>
          )}

          <Button onPress={() => router.push("/health/checkups" as any)}>完了</Button>
        </ScrollView>
      </View>
    );
  }

  // ─── Form step ────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={{ paddingTop: insets.top }}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>健康診断を記録</Text>
          <View style={{ width: 24 }} />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* 基本情報 */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIconBox}>
              <Ionicons name="calendar-outline" size={18} color={colors.accent} />
            </View>
            <Text style={styles.sectionTitle}>基本情報</Text>
          </View>
          <View style={styles.sectionBody}>
            {/* 検査日 */}
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>検査日</Text>
              <TextInput
                style={[styles.fieldInput, { flex: 1 }]}
                value={form.checkup_date}
                onChangeText={(v) => update("checkup_date", v)}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
              />
            </View>
            {/* 医療機関 */}
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>医療機関</Text>
              <TextInput
                style={[styles.fieldInput, { flex: 1 }]}
                value={form.facility_name}
                onChangeText={(v) => update("facility_name", v)}
                placeholder="〇〇クリニック"
                placeholderTextColor={colors.textMuted}
              />
            </View>
            {/* 種類 */}
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>種類</Text>
              <View style={styles.typeRow}>
                {CHECKUP_TYPES.map((t) => (
                  <Pressable
                    key={t}
                    style={[styles.typeBtn, form.checkup_type === t && styles.typeBtnActive]}
                    onPress={() => update("checkup_type", t)}
                  >
                    <Text
                      style={[styles.typeBtnText, form.checkup_type === t && styles.typeBtnTextActive]}
                    >
                      {t}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        </View>

        {/* 血圧・代謝 */}
        {renderSection("basic", "血圧・代謝", "pulse-outline", (
          <>
            {renderField("blood_pressure_systolic", "収縮期血圧", "mmHg", "120")}
            {renderField("blood_pressure_diastolic", "拡張期血圧", "mmHg", "80")}
            {renderField("hba1c", "HbA1c", "%", "5.6")}
            {renderField("fasting_glucose", "空腹時血糖", "mg/dL", "100")}
          </>
        ))}

        {/* 身体測定 */}
        {renderSection("body", "身体測定", "body-outline", (
          <>
            {renderField("height", "身長", "cm", "170")}
            {renderField("weight", "体重", "kg", "65")}
            {renderField("bmi", "BMI", "", "22.5")}
            {renderField("waist_circumference", "腹囲", "cm", "85")}
          </>
        ))}

        {/* 脂質 */}
        {renderSection("lipid", "脂質", "water-outline", (
          <>
            {renderField("total_cholesterol", "総コレステロール", "mg/dL", "200")}
            {renderField("ldl_cholesterol", "LDL", "mg/dL", "120")}
            {renderField("hdl_cholesterol", "HDL", "mg/dL", "60")}
            {renderField("triglycerides", "中性脂肪", "mg/dL", "150")}
          </>
        ))}

        {/* 肝機能 */}
        {renderSection("liver", "肝機能", "fitness-outline", (
          <>
            {renderField("ast", "AST(GOT)", "U/L", "25")}
            {renderField("alt", "ALT(GPT)", "U/L", "20")}
            {renderField("gamma_gtp", "γ-GTP", "U/L", "30")}
          </>
        ))}

        {/* 腎機能 */}
        {renderSection("kidney", "腎機能・尿酸", "leaf-outline", (
          <>
            {renderField("creatinine", "クレアチニン", "mg/dL", "0.8")}
            {renderField("egfr", "eGFR", "", "90")}
            {renderField("uric_acid", "尿酸", "mg/dL", "5.5")}
          </>
        ))}

        <Button onPress={handleSave} loading={saving} disabled={saving}>
          {saving ? "保存中..." : "保存してAI分析を実行"}
        </Button>

        <Text style={styles.ocrHint}>
          ※ OCR取込機能は別途対応予定です。手動で数値を入力してください。
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: "800",
    color: colors.text,
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: 120,
  },

  // ─── Section ───
  section: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    overflow: "hidden",
    ...shadows.sm,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  sectionIconBox: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    color: colors.text,
  },
  sectionBody: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },

  // ─── Fields ───
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  fieldLabel: {
    width: 90,
    fontSize: 13,
    color: colors.textLight,
    flexShrink: 0,
  },
  fieldInputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  fieldInput: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: colors.text,
  },
  fieldUnit: {
    width: 48,
    fontSize: 12,
    color: colors.textMuted,
  },

  // ─── Type selector ───
  typeRow: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  typeBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: colors.bg,
  },
  typeBtnActive: {
    backgroundColor: colors.accentLight,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  typeBtnText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  typeBtnTextActive: {
    color: colors.accent,
    fontWeight: "700",
  },

  // ─── OCR hint ───
  ocrHint: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },

  // ─── Review step ───
  reviewCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadows.sm,
  },
  reviewCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  reviewCardTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.text,
  },
  reviewCardBody: {
    fontSize: 13,
    color: colors.textLight,
    lineHeight: 20,
  },
  reviewItem: {
    fontSize: 13,
    color: colors.textLight,
    lineHeight: 20,
  },
});
