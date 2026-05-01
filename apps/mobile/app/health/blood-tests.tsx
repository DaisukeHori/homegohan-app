import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
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

import { Button, EmptyState, LoadingState } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { colors, radius, shadows, spacing } from "../../src/theme";

// ─── Types ────────────────────────────────────────────

interface AiReview {
  summary: string;
  concerns: string[];
  positives: string[];
  recommendations: string[];
  riskLevel: "low" | "medium" | "high";
}

interface BloodTest {
  id: string;
  test_date: string;
  test_facility: string | null;
  total_cholesterol: number | null;
  ldl_cholesterol: number | null;
  hdl_cholesterol: number | null;
  triglycerides: number | null;
  fasting_glucose: number | null;
  hba1c: number | null;
  ast: number | null;
  alt: number | null;
  gamma_gtp: number | null;
  creatinine: number | null;
  egfr: number | null;
  uric_acid: number | null;
  bun: number | null;
  hemoglobin: number | null;
  note: string | null;
  ai_review?: AiReview | null;
  created_at: string;
}

interface TrendMetric {
  metric: string;
  detail: string;
}

interface TrendAnalysis {
  overallAssessment: string;
  improvingMetrics?: TrendMetric[];
  worseningMetrics?: (TrendMetric & { severity: string })[];
  stableMetrics?: string[];
  priorityActions?: string[];
}

interface NutritionGuidance {
  generalDirection: string;
  avoidanceHints?: string[];
  emphasisHints?: string[];
  specialNotes?: string;
}

interface LongitudinalReview {
  id: string;
  review_date: string;
  trend_analysis?: TrendAnalysis;
  nutrition_guidance?: NutritionGuidance;
}

interface FormData {
  test_date: string;
  test_facility: string;
  total_cholesterol: string;
  ldl_cholesterol: string;
  hdl_cholesterol: string;
  triglycerides: string;
  fasting_glucose: string;
  hba1c: string;
  ast: string;
  alt: string;
  gamma_gtp: string;
  creatinine: string;
  egfr: string;
  uric_acid: string;
  bun: string;
  hemoglobin: string;
  note: string;
}

type Screen = "list" | "form" | "review";

// ─── Helpers ──────────────────────────────────────────

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

function toInt(v: string): number | undefined {
  const s = v.trim();
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function getRiskColor(level?: string): { bg: string; text: string } {
  switch (level) {
    case "high":
      return { bg: colors.errorLight, text: colors.error };
    case "medium":
      return { bg: colors.warningLight, text: colors.warning };
    default:
      return { bg: colors.successLight, text: colors.success };
  }
}

function getRiskIcon(level?: string): keyof typeof Ionicons.glyphMap {
  switch (level) {
    case "high":
      return "warning-outline";
    case "medium":
      return "time-outline";
    default:
      return "checkmark-circle-outline";
  }
}

function getRiskLabel(level?: string): string {
  switch (level) {
    case "high":
      return "要注意";
    case "medium":
      return "注意";
    default:
      return "良好";
  }
}

function emptyForm(): FormData {
  return {
    test_date: todayStr(),
    test_facility: "",
    total_cholesterol: "",
    ldl_cholesterol: "",
    hdl_cholesterol: "",
    triglycerides: "",
    fasting_glucose: "",
    hba1c: "",
    ast: "",
    alt: "",
    gamma_gtp: "",
    creatinine: "",
    egfr: "",
    uric_acid: "",
    bun: "",
    hemoglobin: "",
    note: "",
  };
}

// ─── Component ────────────────────────────────────────

export default function BloodTestsPage() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [screen, setScreen] = useState<Screen>("list");
  const [isLoading, setIsLoading] = useState(true);
  const [items, setItems] = useState<BloodTest[]>([]);
  const [longitudinalReview, setLongitudinalReview] = useState<LongitudinalReview | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Form / OCR state
  const [form, setForm] = useState<FormData>(emptyForm());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [savedResult, setSavedResult] = useState<any>(null);

  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    lipid: true,
    glucose: true,
    liver: false,
    kidney: false,
    other: false,
  });

  // ─── Data loading ────────────────────────────────────
  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const api = getApi();
      const res = await api.get<{ results: BloodTest[]; longitudinalReview: LongitudinalReview | null }>(
        "/api/health/blood-tests?limit=20",
      );
      setItems(res.results ?? []);
      setLongitudinalReview(res.longitudinalReview ?? null);
    } catch (e: any) {
      Alert.alert("エラー", e?.message ?? "データの取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ─── OCR ─────────────────────────────────────────────
  async function handleOcr(mode: "camera" | "library") {
    try {
      let picked: ImagePicker.ImagePickerResult;

      if (mode === "camera") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          Alert.alert("権限が必要です", "カメラへのアクセスを許可してください。");
          return;
        }
        picked = await ImagePicker.launchCameraAsync({
          base64: true,
          quality: 0.85,
          mediaTypes: ["images"] as any,
        });
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert("権限が必要です", "写真へのアクセスを許可してください。");
          return;
        }
        picked = await ImagePicker.launchImageLibraryAsync({
          base64: true,
          quality: 0.85,
          mediaTypes: ["images"] as any,
        });
      }

      if (picked.canceled || !picked.assets?.[0]?.base64) return;

      const asset = picked.assets[0];
      setIsOcrProcessing(true);

      const api = getApi();
      const ocrRes = await api.post<{ extractedData?: any }>("/api/ai/analyze-health-checkup", {
        imageBase64: asset.base64,
        mimeType: asset.mimeType ?? "image/jpeg",
      });

      const ext = ocrRes.extractedData ?? {};

      // camelCase → FormData mapping（血液検査に関連する項目のみ反映）
      setForm((prev) => ({
        ...prev,
        ...(ext.checkupDate ? { test_date: ext.checkupDate } : {}),
        ...(ext.facilityName ? { test_facility: ext.facilityName } : {}),
        ...(ext.hba1c != null ? { hba1c: String(ext.hba1c) } : {}),
        ...(ext.fastingGlucose != null ? { fasting_glucose: String(ext.fastingGlucose) } : {}),
        ...(ext.totalCholesterol != null ? { total_cholesterol: String(ext.totalCholesterol) } : {}),
        ...(ext.ldlCholesterol != null ? { ldl_cholesterol: String(ext.ldlCholesterol) } : {}),
        ...(ext.hdlCholesterol != null ? { hdl_cholesterol: String(ext.hdlCholesterol) } : {}),
        ...(ext.triglycerides != null ? { triglycerides: String(ext.triglycerides) } : {}),
        ...(ext.ast != null ? { ast: String(ext.ast) } : {}),
        ...(ext.alt != null ? { alt: String(ext.alt) } : {}),
        ...(ext.gammaGtp != null ? { gamma_gtp: String(ext.gammaGtp) } : {}),
        ...(ext.creatinine != null ? { creatinine: String(ext.creatinine) } : {}),
        ...(ext.egfr != null ? { egfr: String(ext.egfr) } : {}),
        ...(ext.uricAcid != null ? { uric_acid: String(ext.uricAcid) } : {}),
        ...(ext.hemoglobin != null ? { hemoglobin: String(ext.hemoglobin) } : {}),
      }));

      Alert.alert("OCR完了", "検査値を自動入力しました。内容を確認して登録してください。");
    } catch (e: any) {
      Alert.alert("OCRエラー", e?.message ?? "画像の読み取りに失敗しました。手動で入力してください。");
    } finally {
      setIsOcrProcessing(false);
    }
  }

  function showOcrOptions() {
    Alert.alert(
      "画像から取込",
      "検査結果票の画像を選択してください",
      [
        { text: "カメラで撮影", onPress: () => handleOcr("camera") },
        { text: "写真を選択", onPress: () => handleOcr("library") },
        { text: "キャンセル", style: "cancel" },
      ],
    );
  }

  // ─── Form save ────────────────────────────────────────
  async function handleSave() {
    if (!form.test_date.trim()) {
      Alert.alert("入力不足", "検査日を入力してください。");
      return;
    }
    if (isSubmitting) return;

    setIsSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        test_date: form.test_date.trim(),
      };
      if (form.test_facility.trim()) body.test_facility = form.test_facility.trim();
      const n = (v: string) => toNum(v);
      const i = (v: string) => toInt(v);
      const set = (k: string, v: number | undefined) => { if (v !== undefined) body[k] = v; };

      set("total_cholesterol", i(form.total_cholesterol));
      set("ldl_cholesterol", i(form.ldl_cholesterol));
      set("hdl_cholesterol", i(form.hdl_cholesterol));
      set("triglycerides", i(form.triglycerides));
      set("fasting_glucose", i(form.fasting_glucose));
      set("hba1c", n(form.hba1c));
      set("ast", i(form.ast));
      set("alt", i(form.alt));
      set("gamma_gtp", i(form.gamma_gtp));
      set("creatinine", n(form.creatinine));
      set("egfr", n(form.egfr));
      set("uric_acid", n(form.uric_acid));
      set("bun", n(form.bun));
      set("hemoglobin", n(form.hemoglobin));
      if (form.note.trim()) body.note = form.note.trim();

      const api = getApi();
      const data = await api.post<{ result: any; longitudinalReview: LongitudinalReview | null }>(
        "/api/health/blood-tests",
        body,
      );

      setSavedResult(data.result);
      if (data.longitudinalReview) {
        setLongitudinalReview(data.longitudinalReview);
      }
      setScreen("review");
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "登録に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  function update(field: keyof FormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function toggleSection(key: string) {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // ─── Field renderer ───────────────────────────────────
  function renderField(
    field: keyof FormData,
    label: string,
    unit?: string,
    placeholder?: string,
    isDecimal = false,
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
            keyboardType={isDecimal ? "decimal-pad" : "number-pad"}
          />
          {unit ? <Text style={styles.fieldUnit}>{unit}</Text> : null}
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
        {expandedSections[key] ? <View style={styles.sectionBody}>{children}</View> : null}
      </View>
    );
  }

  // ─── Screen: Review (AI分析結果) ─────────────────────
  if (screen === "review" && savedResult) {
    const review: AiReview | null | undefined = savedResult.ai_review;
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => { setScreen("list"); void load(); }} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>AI分析結果</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent}>
          {review ? (
            <>
              <View style={styles.reviewCard}>
                <View style={styles.reviewCardHeader}>
                  <Ionicons name="sparkles-outline" size={20} color={colors.purple} />
                  <Text style={styles.reviewCardTitle}>AI分析結果</Text>
                </View>
                <Text style={styles.reviewCardBody}>{review.summary}</Text>
              </View>

              {(review.concerns ?? []).length > 0 ? (
                <View style={[styles.reviewCard, { backgroundColor: colors.warningLight }]}>
                  <View style={styles.reviewCardHeader}>
                    <Ionicons name="warning-outline" size={18} color={colors.warning} />
                    <Text style={[styles.reviewCardTitle, { color: colors.warning }]}>気になる点</Text>
                  </View>
                  {review.concerns.map((item, i) => (
                    <Text key={i} style={styles.reviewItem}>• {item}</Text>
                  ))}
                </View>
              ) : null}

              {(review.positives ?? []).length > 0 ? (
                <View style={[styles.reviewCard, { backgroundColor: colors.successLight }]}>
                  <View style={styles.reviewCardHeader}>
                    <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} />
                    <Text style={[styles.reviewCardTitle, { color: colors.success }]}>良い点</Text>
                  </View>
                  {review.positives.map((item, i) => (
                    <Text key={i} style={styles.reviewItem}>• {item}</Text>
                  ))}
                </View>
              ) : null}

              {(review.recommendations ?? []).length > 0 ? (
                <View style={[styles.reviewCard, { backgroundColor: colors.purpleLight }]}>
                  <View style={styles.reviewCardHeader}>
                    <Ionicons name="sparkles-outline" size={18} color={colors.purple} />
                    <Text style={[styles.reviewCardTitle, { color: colors.purple }]}>改善アドバイス</Text>
                  </View>
                  {review.recommendations.map((item, i) => (
                    <Text key={i} style={styles.reviewItem}>{i + 1}. {item}</Text>
                  ))}
                </View>
              ) : null}
            </>
          ) : (
            <View style={styles.reviewCard}>
              <Text style={[styles.reviewCardBody, { color: colors.textMuted, textAlign: "center" }]}>
                AI分析を実行できませんでした
              </Text>
            </View>
          )}

          <Button onPress={() => { setScreen("list"); void load(); }}>完了</Button>
        </ScrollView>
      </View>
    );
  }

  // ─── Screen: Form ─────────────────────────────────────
  if (screen === "form") {
    return (
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={{ paddingTop: insets.top }}>
          <View style={styles.header}>
            <Pressable onPress={() => setScreen("list")} hitSlop={12}>
              <Ionicons name="arrow-back" size={24} color={colors.text} />
            </Pressable>
            <Text style={styles.headerTitle}>血液検査を記録</Text>
            <View style={{ width: 24 }} />
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

          {/* OCR ボタン */}
          <Pressable
            style={styles.ocrButton}
            onPress={showOcrOptions}
            disabled={isOcrProcessing}
          >
            <Ionicons
              name={isOcrProcessing ? "hourglass-outline" : "camera-outline"}
              size={20}
              color={colors.accent}
            />
            <Text style={styles.ocrButtonText}>
              {isOcrProcessing ? "読み取り中..." : "検査結果票を撮影して自動入力"}
            </Text>
          </Pressable>

          {/* 基本情報 */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIconBox}>
                <Ionicons name="calendar-outline" size={18} color={colors.accent} />
              </View>
              <Text style={styles.sectionTitle}>基本情報</Text>
            </View>
            <View style={styles.sectionBody}>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>検査日</Text>
                <TextInput
                  style={[styles.fieldInput, { flex: 1 }]}
                  value={form.test_date}
                  onChangeText={(v) => update("test_date", v)}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.textMuted}
                />
              </View>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>施設名</Text>
                <TextInput
                  style={[styles.fieldInput, { flex: 1 }]}
                  value={form.test_facility}
                  onChangeText={(v) => update("test_facility", v)}
                  placeholder="〇〇クリニック（任意）"
                  placeholderTextColor={colors.textMuted}
                />
              </View>
            </View>
          </View>

          {/* 脂質 */}
          {renderSection("lipid", "脂質", "water-outline", (
            <>
              {renderField("total_cholesterol", "総コレステロール", "mg/dL", "200")}
              {renderField("ldl_cholesterol", "LDL", "mg/dL", "120")}
              {renderField("hdl_cholesterol", "HDL", "mg/dL", "60")}
              {renderField("triglycerides", "中性脂肪", "mg/dL", "150")}
            </>
          ))}

          {/* 糖代謝 */}
          {renderSection("glucose", "糖代謝", "pulse-outline", (
            <>
              {renderField("fasting_glucose", "空腹時血糖", "mg/dL", "100")}
              {renderField("hba1c", "HbA1c", "%", "5.6", true)}
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
          {renderSection("kidney", "腎機能", "leaf-outline", (
            <>
              {renderField("creatinine", "クレアチニン", "mg/dL", "0.8", true)}
              {renderField("egfr", "eGFR", "", "90", true)}
              {renderField("uric_acid", "尿酸", "mg/dL", "5.5", true)}
              {renderField("bun", "BUN", "mg/dL", "15", true)}
            </>
          ))}

          {/* その他 */}
          {renderSection("other", "その他", "flask-outline", (
            <>
              {renderField("hemoglobin", "ヘモグロビン", "g/dL", "13.5", true)}
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>メモ</Text>
                <TextInput
                  style={[styles.fieldInput, { flex: 1 }]}
                  value={form.note}
                  onChangeText={(v) => update("note", v)}
                  placeholder="メモ（任意）"
                  placeholderTextColor={colors.textMuted}
                />
              </View>
            </>
          ))}

          <Button onPress={handleSave} loading={isSubmitting} disabled={isSubmitting}>
            {isSubmitting ? "登録中（AI分析実行中）..." : "保存してAI分析を実行"}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ─── Screen: List ─────────────────────────────────────
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>血液検査</Text>
        <Pressable
          onPress={() => { setForm(emptyForm()); setScreen("form"); }}
          style={styles.addBtn}
          hitSlop={12}
        >
          <Ionicons name="add" size={22} color="#fff" />
        </Pressable>
      </View>

      {isLoading ? (
        <LoadingState message="検査結果を読み込み中..." />
      ) : (
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

          {/* ─── 経年分析カード ─── */}
          {longitudinalReview?.trend_analysis ? (
            <View style={styles.longitudinalCard}>
              <View style={styles.longitudinalHeader}>
                <Ionicons name="analytics-outline" size={20} color="#fff" />
                <Text style={styles.longitudinalTitle}>経年分析</Text>
                <Text style={styles.longitudinalDate}>{formatDate(longitudinalReview.review_date)}</Text>
              </View>

              <Text style={styles.longitudinalAssessment}>
                {longitudinalReview.trend_analysis.overallAssessment}
              </Text>

              {(longitudinalReview.trend_analysis.improvingMetrics ?? []).slice(0, 2).map((item, i) => (
                <View key={i} style={styles.trendRow}>
                  <View style={styles.trendIconBox}>
                    <Ionicons name="trending-down" size={14} color="#86efac" />
                  </View>
                  <Text style={styles.trendMetric}>{item.metric}</Text>
                  <Text style={styles.trendBadgeGood}>改善</Text>
                </View>
              ))}

              {(longitudinalReview.trend_analysis.worseningMetrics ?? []).slice(0, 2).map((item, i) => (
                <View key={i} style={styles.trendRow}>
                  <View style={styles.trendIconBox}>
                    <Ionicons name="trending-up" size={14} color="#fca5a5" />
                  </View>
                  <Text style={styles.trendMetric}>{item.metric}</Text>
                  <Text style={styles.trendBadgeBad}>要注意</Text>
                </View>
              ))}

              {longitudinalReview.nutrition_guidance?.generalDirection ? (
                <View style={styles.nutritionBox}>
                  <Text style={styles.nutritionLabel}>食事方針</Text>
                  <Text style={styles.nutritionText}>
                    {longitudinalReview.nutrition_guidance.generalDirection}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* ─── 検査結果一覧 ─── */}
          {items.length === 0 ? (
            <EmptyState
              icon={<Ionicons name="flask-outline" size={48} color={colors.textMuted} />}
              message="血液検査の記録がありません。最初の記録を追加しましょう"
              actionLabel="記録を追加"
              onAction={() => { setForm(emptyForm()); setScreen("form"); }}
            />
          ) : (
            <View style={{ gap: spacing.sm }}>
              {items.map((r) => {
                const isOpen = expandedId === r.id;
                const riskColor = getRiskColor(r.ai_review?.riskLevel);
                const riskIcon = getRiskIcon(r.ai_review?.riskLevel);
                const riskLabel = getRiskLabel(r.ai_review?.riskLevel);

                return (
                  <Pressable
                    key={r.id}
                    style={styles.testCard}
                    onPress={() => setExpandedId(isOpen ? null : r.id)}
                  >
                    {/* 上段 */}
                    <View style={styles.testCardTop}>
                      <View style={{ flex: 1 }}>
                        <View style={styles.testDateRow}>
                          <Ionicons name="flask-outline" size={14} color={colors.accent} />
                          <Text style={styles.testDate}>{formatDate(r.test_date)}</Text>
                        </View>
                        {r.test_facility ? (
                          <Text style={styles.facilityText}>{r.test_facility}</Text>
                        ) : null}
                      </View>

                      {r.ai_review?.riskLevel ? (
                        <View style={[styles.riskBadge, { backgroundColor: riskColor.bg }]}>
                          <Ionicons name={riskIcon} size={14} color={riskColor.text} />
                          <Text style={[styles.riskBadgeText, { color: riskColor.text }]}>
                            {riskLabel}
                          </Text>
                        </View>
                      ) : null}
                    </View>

                    {/* 主要指標 */}
                    <View style={styles.metricsRow}>
                      {r.hba1c != null ? (
                        <View style={styles.metric}>
                          <Text style={styles.metricText}>HbA1c {r.hba1c}%</Text>
                        </View>
                      ) : null}
                      {r.ldl_cholesterol != null ? (
                        <View style={styles.metric}>
                          <Text style={styles.metricText}>LDL {r.ldl_cholesterol}</Text>
                        </View>
                      ) : null}
                      {r.fasting_glucose != null ? (
                        <View style={styles.metric}>
                          <Text style={styles.metricText}>血糖 {r.fasting_glucose}</Text>
                        </View>
                      ) : null}
                    </View>

                    {/* AI サマリー */}
                    {r.ai_review?.summary ? (
                      <Text style={styles.aiSummary} numberOfLines={isOpen ? undefined : 2}>
                        {r.ai_review.summary}
                      </Text>
                    ) : null}

                    {/* 展開時: 全データ + AI詳細 */}
                    {isOpen ? (
                      <View style={styles.expandedArea}>
                        {/* 数値グリッド */}
                        <View style={styles.resultGrid}>
                          {r.total_cholesterol != null ? <MetricCell label="TC" value={r.total_cholesterol} /> : null}
                          {r.ldl_cholesterol != null ? <MetricCell label="LDL" value={r.ldl_cholesterol} /> : null}
                          {r.hdl_cholesterol != null ? <MetricCell label="HDL" value={r.hdl_cholesterol} /> : null}
                          {r.triglycerides != null ? <MetricCell label="TG" value={r.triglycerides} /> : null}
                          {r.fasting_glucose != null ? <MetricCell label="Glu" value={r.fasting_glucose} /> : null}
                          {r.hba1c != null ? <MetricCell label="HbA1c" value={r.hba1c} /> : null}
                          {r.ast != null ? <MetricCell label="AST" value={r.ast} /> : null}
                          {r.alt != null ? <MetricCell label="ALT" value={r.alt} /> : null}
                          {r.gamma_gtp != null ? <MetricCell label="γ-GTP" value={r.gamma_gtp} /> : null}
                          {r.creatinine != null ? <MetricCell label="Cr" value={r.creatinine} /> : null}
                          {r.egfr != null ? <MetricCell label="eGFR" value={r.egfr} /> : null}
                          {r.uric_acid != null ? <MetricCell label="UA" value={r.uric_acid} /> : null}
                          {r.bun != null ? <MetricCell label="BUN" value={r.bun} /> : null}
                          {r.hemoglobin != null ? <MetricCell label="Hb" value={r.hemoglobin} /> : null}
                        </View>

                        {/* AI レビュー詳細 */}
                        {r.ai_review ? (
                          <View style={styles.reviewSection}>
                            {(r.ai_review.concerns ?? []).length > 0 ? (
                              <View style={[styles.reviewBlock, { backgroundColor: colors.warningLight }]}>
                                <View style={styles.reviewBlockHeader}>
                                  <Ionicons name="warning-outline" size={14} color={colors.warning} />
                                  <Text style={[styles.reviewBlockTitle, { color: colors.warning }]}>気になる点</Text>
                                </View>
                                {r.ai_review.concerns.slice(0, 3).map((item, i) => (
                                  <Text key={i} style={styles.reviewBlockItem}>• {item}</Text>
                                ))}
                              </View>
                            ) : null}

                            {(r.ai_review.positives ?? []).length > 0 ? (
                              <View style={[styles.reviewBlock, { backgroundColor: colors.successLight }]}>
                                <View style={styles.reviewBlockHeader}>
                                  <Ionicons name="checkmark-circle-outline" size={14} color={colors.success} />
                                  <Text style={[styles.reviewBlockTitle, { color: colors.success }]}>良い点</Text>
                                </View>
                                {r.ai_review.positives.slice(0, 3).map((item, i) => (
                                  <Text key={i} style={styles.reviewBlockItem}>• {item}</Text>
                                ))}
                              </View>
                            ) : null}

                            {(r.ai_review.recommendations ?? []).length > 0 ? (
                              <View style={[styles.reviewBlock, { backgroundColor: colors.purpleLight }]}>
                                <View style={styles.reviewBlockHeader}>
                                  <Ionicons name="sparkles-outline" size={14} color={colors.purple} />
                                  <Text style={[styles.reviewBlockTitle, { color: colors.purple }]}>改善アドバイス</Text>
                                </View>
                                {r.ai_review.recommendations.slice(0, 3).map((item, i) => (
                                  <Text key={i} style={styles.reviewBlockItem}>{i + 1}. {item}</Text>
                                ))}
                              </View>
                            ) : null}
                          </View>
                        ) : null}

                        {r.note ? (
                          <View style={styles.noteRow}>
                            <Ionicons name="document-text-outline" size={14} color={colors.textMuted} />
                            <Text style={styles.noteText}>{r.note}</Text>
                          </View>
                        ) : null}
                      </View>
                    ) : null}

                    <Ionicons
                      name={isOpen ? "chevron-up" : "chevron-down"}
                      size={16}
                      color={colors.textMuted}
                      style={styles.chevron}
                    />
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────

function MetricCell({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.metricCell}>
      <Text style={styles.metricCellLabel}>{label}</Text>
      <Text style={styles.metricCellValue}>{value}</Text>
    </View>
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
  addBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: 100,
  },

  // ─── OCR ───
  ocrButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.accent,
    backgroundColor: colors.accentLight,
  },
  ocrButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.accent,
  },

  // ─── 経年分析 ───
  longitudinalCard: {
    borderRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.sm,
    backgroundColor: colors.purple,
  },
  longitudinalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  longitudinalTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: "800",
    color: "#fff",
  },
  longitudinalDate: {
    fontSize: 11,
    color: "rgba(255,255,255,0.6)",
  },
  longitudinalAssessment: {
    fontSize: 13,
    color: "rgba(255,255,255,0.9)",
    lineHeight: 20,
  },
  trendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  trendIconBox: {
    width: 24,
    height: 24,
    borderRadius: radius.full,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  trendMetric: {
    flex: 1,
    fontSize: 13,
    color: "rgba(255,255,255,0.9)",
  },
  trendBadgeGood: {
    fontSize: 11,
    color: "#86efac",
    fontWeight: "700",
  },
  trendBadgeBad: {
    fontSize: 11,
    color: "#fca5a5",
    fontWeight: "700",
  },
  nutritionBox: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.2)",
  },
  nutritionLabel: {
    fontSize: 11,
    color: "rgba(255,255,255,0.6)",
    marginBottom: 4,
  },
  nutritionText: {
    fontSize: 13,
    color: "#fff",
    lineHeight: 18,
  },

  // ─── 検査結果カード ───
  testCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadows.sm,
  },
  testCardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  testDateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: 2,
  },
  testDate: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
  },
  facilityText: {
    fontSize: 12,
    color: colors.textMuted,
    marginLeft: 20,
  },
  riskBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  riskBadgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  metricsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  metric: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  metricText: {
    fontSize: 12,
    color: colors.textLight,
  },
  aiSummary: {
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 18,
  },
  expandedArea: {
    gap: spacing.sm,
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  resultGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  metricCell: {
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    minWidth: 70,
    alignItems: "center",
  },
  metricCellLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textMuted,
  },
  metricCellValue: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
    marginTop: 2,
  },
  reviewSection: {
    gap: spacing.xs,
  },
  reviewBlock: {
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: 4,
  },
  reviewBlockHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 2,
  },
  reviewBlockTitle: {
    fontSize: 12,
    fontWeight: "700",
  },
  reviewBlockItem: {
    fontSize: 12,
    color: colors.textLight,
    lineHeight: 18,
  },
  noteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.bg,
    padding: spacing.sm,
    borderRadius: radius.sm,
  },
  noteText: {
    fontSize: 13,
    color: colors.textLight,
    flex: 1,
  },
  chevron: {
    alignSelf: "flex-end",
    marginTop: -spacing.xs,
  },

  // ─── Form ───
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
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  fieldLabel: {
    width: 110,
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
    width: 52,
    fontSize: 12,
    color: colors.textMuted,
  },

  // ─── Review screen ───
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
