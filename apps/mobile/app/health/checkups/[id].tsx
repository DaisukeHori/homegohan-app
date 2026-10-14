/**
 * 健康診断の詳細 (#1049)。一覧 (app/health/checkups/index.tsx) の各行のタップで開く。
 *
 * 以前はこの画面が無く、一覧の行をタップすると「Unmatched Route」の画面が出ていた。
 * 中身は Web の詳細 (src/app/(main)/health/checkups/[id]/CheckupDetailClient.tsx) と同じ情報を出す:
 * 日付・種別・施設、AI の分析 (総評・気になる点・良い点・改善アドバイス)、検査値 (基準値と判定。性別で変わる)、画像。
 * 基準値と判定は Web と同じ @homegohan/shared の health-blood-test-reference を使う (写さない)。
 * 記録の削除は Web の詳細にだけある (この画面は見るだけ)。
 */

import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ALL_METRIC_DEFS,
  evaluateStatus,
  formatLocalDate,
  formatRangeText,
  getRangeForSex,
  getStatusLabel,
  type BiologicalSex,
  type MetricStatus,
} from "@homegohan/shared";

import { Card, LoadingState, PageHeader } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, radius, spacing } from "../../../src/theme";

// ─── Types ────────────────────────────────────────────
interface IndividualReview {
  summary: string;
  concerns?: string[];
  positives?: string[];
  recommendations?: string[];
  riskLevel?: "low" | "medium" | "high";
}

/** 検査値の列 (Web の詳細と同じ並び)。キーは ALL_METRIC_DEFS のキーと同じ列名 */
type MetricColumn =
  | "height"
  | "weight"
  | "bmi"
  | "waist_circumference"
  | "blood_pressure_systolic"
  | "blood_pressure_diastolic"
  | "hba1c"
  | "fasting_glucose"
  | "hemoglobin"
  | "total_cholesterol"
  | "ldl_cholesterol"
  | "hdl_cholesterol"
  | "triglycerides"
  | "ast"
  | "alt"
  | "gamma_gtp"
  | "creatinine"
  | "egfr"
  | "uric_acid";

type HealthCheckup = {
  id: string;
  checkup_date: string;
  facility_name?: string | null;
  checkup_type?: string | null;
  image_url?: string | null;
  individual_review?: IndividualReview | null;
} & Partial<Record<MetricColumn, number | null>>;

/** 検査値の段 (Web の詳細の「身体測定」「血圧・代謝」「脂質」「肝機能」「腎機能・尿酸」と同じ) */
const METRIC_GROUPS: readonly { key: string; title: string; icon: keyof typeof Ionicons.glyphMap; columns: readonly MetricColumn[] }[] = [
  { key: "body", title: "身体測定", icon: "body-outline", columns: ["height", "weight", "bmi", "waist_circumference"] },
  {
    key: "metabolic",
    title: "血圧・代謝",
    icon: "heart-outline",
    columns: ["blood_pressure_systolic", "blood_pressure_diastolic", "hba1c", "fasting_glucose", "hemoglobin"],
  },
  { key: "lipid", title: "脂質", icon: "water-outline", columns: ["total_cholesterol", "ldl_cholesterol", "hdl_cholesterol", "triglycerides"] },
  { key: "liver", title: "肝機能", icon: "pulse-outline", columns: ["ast", "alt", "gamma_gtp"] },
  { key: "kidney", title: "腎機能・尿酸", icon: "pulse-outline", columns: ["creatinine", "egfr", "uric_acid"] },
];

// ─── Helpers ──────────────────────────────────────────
/** 日付 (YYYY-MM-DD) を日本の日付 (YYYY/MM/DD) にする。一覧 (index.tsx の formatDate) と同じ (#1049 F7-21) */
function formatDate(dateStr: string): string {
  return formatLocalDate(new Date(dateStr)).replace(/-/g, "/");
}

/** 判定の色。文字は *Text、点は塗りの色 (Web の詳細の getStatusStyle と同じ割り当て) */
function statusStyleOf(status: MetricStatus): { text: string; dot: string } {
  switch (status) {
    case "high":
    case "low":
      return { text: colors.dangerText, dot: colors.error };
    case "warning_high":
    case "warning_low":
      return { text: colors.warningText, dot: colors.warning };
    default:
      return { text: colors.successText, dot: colors.success };
  }
}

// ─── Component ────────────────────────────────────────
export default function CheckupDetailPage() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [loading, setLoading] = useState(true);
  const [checkup, setCheckup] = useState<HealthCheckup | null>(null);
  const [sex, setSex] = useState<BiologicalSex>(null);

  const fetchCheckup = useCallback(async () => {
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await getApi().get<{ checkup: HealthCheckup }>(`/api/health/checkups/${encodeURIComponent(id)}`);
      setCheckup(data.checkup ?? null);
    } catch {
      // 見つからない・読めない: 「記録が見つかりません」を出す (Web の詳細と同じ)
      setCheckup(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchCheckup();
  }, [fetchCheckup]);

  // 基準値をプロフィールの性別で分ける (Web の詳細と同じ。読めなければ男女どちらでも異常と言える値だけを示す一般基準)
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await getApi().get<{ gender?: string | null }>("/api/profile");
        if (active) setSex(data?.gender ?? null);
      } catch {
        // 一般基準のまま
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <PageHeader title="健康診断詳細" />
        <LoadingState message="健康診断の記録を読み込み中..." />
      </View>
    );
  }

  if (!checkup) {
    return (
      <View testID="health-checkup-detail-not-found" style={[styles.screen, { paddingTop: insets.top }]}>
        <PageHeader title="健康診断詳細" />
        <View style={styles.centered}>
          <Text style={styles.mutedText}>記録が見つかりません</Text>
        </View>
      </View>
    );
  }

  const review = checkup.individual_review;
  const sexIsKnown = sex === "male" || sex === "female";

  function renderMetricRow(column: MetricColumn) {
    const value = checkup?.[column];
    if (value === undefined || value === null) return null;
    const def = ALL_METRIC_DEFS[column];
    if (!def) return null;
    const status = evaluateStatus(column, value, sex);
    const statusStyle = statusStyleOf(status);
    const statusLabel = getStatusLabel(status);
    return (
      <View key={column} testID={`health-checkup-metric-${column}`} style={styles.metricRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.metricLabel}>{def.label}</Text>
          <Text style={styles.metricRange}>基準: {formatRangeText(getRangeForSex(column, sex))}</Text>
        </View>
        <View style={styles.metricValueRow}>
          <Text
            style={[styles.metricValue, status !== "normal" && status !== "unknown" && { color: statusStyle.text }]}
          >
            {value}
          </Text>
          {def.unit ? <Text style={styles.metricUnit}>{def.unit}</Text> : null}
          {statusLabel && (
            <View style={styles.statusLabelRow}>
              <View style={[styles.statusDot, { backgroundColor: statusStyle.dot }]} />
              <Text style={[styles.statusLabel, { color: statusStyle.text }]}>{statusLabel}</Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  function renderList(items: string[] | undefined, numbered: boolean) {
    return (items ?? []).map((item, i) => (
      <View key={i} style={styles.listRow}>
        <Text style={numbered ? styles.listNumber : styles.listBullet}>{numbered ? `${i + 1}.` : "•"}</Text>
        <Text style={styles.listText}>{item}</Text>
      </View>
    ));
  }

  return (
    <View testID="health-checkup-detail-screen" style={[styles.screen, { paddingTop: insets.top }]}>
      <PageHeader title="健康診断詳細" />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* 基本情報 */}
        <Card>
          <View style={{ gap: spacing.xs }}>
            <Text style={styles.date}>{formatDate(checkup.checkup_date)}</Text>
            {checkup.checkup_type ? <Text style={styles.typeBadge}>{checkup.checkup_type}</Text> : null}
            {checkup.facility_name ? (
              <View style={styles.facilityRow}>
                <Ionicons name="location-outline" size={14} color={colors.textMuted} />
                <Text style={styles.mutedText}>{checkup.facility_name}</Text>
              </View>
            ) : null}
          </View>
        </Card>

        {/* AI の分析 */}
        {review && (
          <>
            <View testID="health-checkup-review-summary" style={[styles.section, { backgroundColor: colors.purpleLight }]}>
              <Text style={[styles.sectionTitle, { color: colors.purple }]}>AI分析</Text>
              <Text style={styles.listText}>{review.summary}</Text>
            </View>
            {(review.concerns?.length ?? 0) > 0 && (
              <View style={[styles.section, { backgroundColor: colors.warningLight }]}>
                <Text style={[styles.sectionTitle, { color: colors.warningText }]}>気になる点</Text>
                {renderList(review.concerns, false)}
              </View>
            )}
            {(review.positives?.length ?? 0) > 0 && (
              <View style={[styles.section, { backgroundColor: colors.successLight }]}>
                <Text style={[styles.sectionTitle, { color: colors.successText }]}>良い点</Text>
                {renderList(review.positives, false)}
              </View>
            )}
            {(review.recommendations?.length ?? 0) > 0 && (
              <View style={[styles.section, { backgroundColor: colors.card }]}>
                <Text style={[styles.sectionTitle, { color: colors.accent }]}>改善アドバイス</Text>
                {renderList(review.recommendations, true)}
              </View>
            )}
          </>
        )}

        {/* 検査値 */}
        <Card>
          <View style={{ gap: spacing.md }}>
            <Text style={styles.cardTitle}>検査値</Text>
            {!sexIsKnown && <Text style={styles.metricRange}>※ 性別未設定のため一般基準で判定しています</Text>}
            {METRIC_GROUPS.map((group) => (
              <View key={group.key}>
                <View style={styles.groupHeader}>
                  <Ionicons name={group.icon} size={16} color={colors.accent} />
                  <Text style={styles.groupTitle}>{group.title}</Text>
                </View>
                {group.columns.map(renderMetricRow)}
              </View>
            ))}
          </View>
        </Card>

        {/* 画像 */}
        {checkup.image_url ? (
          <Image
            testID="health-checkup-image"
            source={{ uri: checkup.image_url }}
            accessibilityLabel="健康診断結果"
            style={styles.image}
            resizeMode="contain"
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  scrollContent: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl },
  mutedText: { fontSize: 13, color: colors.textMuted },
  date: { fontSize: 18, fontWeight: "800", color: colors.text },
  typeBadge: {
    alignSelf: "flex-start",
    fontSize: 11,
    color: colors.blue,
    backgroundColor: colors.blueLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    overflow: "hidden",
  },
  facilityRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  section: { borderRadius: radius.xl, padding: spacing.lg, gap: spacing.sm },
  sectionTitle: { fontSize: 15, fontWeight: "800" },
  listRow: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  listBullet: { fontSize: 13, color: colors.textLight },
  listNumber: { fontSize: 13, fontWeight: "800", color: colors.accent },
  listText: { flex: 1, fontSize: 13, lineHeight: 20, color: colors.textLight },
  cardTitle: { fontSize: 15, fontWeight: "800", color: colors.text },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginBottom: spacing.xs },
  groupTitle: { fontSize: 13, fontWeight: "700", color: colors.textLight },
  metricRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  metricLabel: { fontSize: 13, color: colors.textLight },
  metricRange: { fontSize: 11, color: colors.textMuted },
  metricValueRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  metricValue: { fontSize: 15, fontWeight: "800", color: colors.text },
  metricUnit: { fontSize: 11, color: colors.textMuted },
  statusLabelRow: { flexDirection: "row", alignItems: "center", gap: 2 },
  statusDot: { width: 8, height: 8, borderRadius: radius.full },
  statusLabel: { fontSize: 11, fontWeight: "700" },
  image: { width: "100%", aspectRatio: 3 / 4, borderRadius: radius.xl, backgroundColor: colors.card },
});
