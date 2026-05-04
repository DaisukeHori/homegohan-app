import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Card, EmptyState, LoadingState } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, radius, shadows, spacing } from "../../../src/theme";

// ─── Types ────────────────────────────────────────────
interface IndividualReview {
  summary: string;
  concerns: string[];
  positives: string[];
  recommendations: string[];
  riskLevel: "low" | "medium" | "high";
}

interface HealthCheckup {
  id: string;
  checkup_date: string;
  facility_name?: string;
  checkup_type?: string;
  blood_pressure_systolic?: number;
  blood_pressure_diastolic?: number;
  hba1c?: number;
  ldl_cholesterol?: number;
  triglycerides?: number;
  individual_review?: IndividualReview;
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

// ─── Helpers ──────────────────────────────────────────
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

// ─── Component ────────────────────────────────────────
export default function CheckupsPage() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [checkups, setCheckups] = useState<HealthCheckup[]>([]);
  const [longitudinalReview, setLongitudinalReview] = useState<LongitudinalReview | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const api = getApi();
      const data = await api.get<{ checkups: HealthCheckup[]; longitudinalReview: LongitudinalReview | null }>(
        "/api/health/checkups",
      );
      setCheckups(data.checkups ?? []);
      setLongitudinalReview(data.longitudinalReview ?? null);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <LoadingState message="健康診断データを読み込み中..." />
      </View>
    );
  }

  return (
    <View testID="health-checkups-screen" style={[styles.screen, { paddingTop: insets.top }]}>
      {/* ─── Header ─── */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>健康診断記録</Text>
        <Pressable
          testID="health-checkups-add-button"
          onPress={() => router.push("/health/checkups/new")}
          style={styles.addBtn}
          hitSlop={12}
        >
          <Ionicons name="add" size={22} color="#fff" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ─── 経年分析カード ─── */}
        {longitudinalReview?.trend_analysis && (
          <View testID="health-checkups-trend-card" style={styles.longitudinalCard}>
            <View style={styles.longitudinalHeader}>
              <Ionicons name="analytics-outline" size={20} color="#fff" />
              <Text style={styles.longitudinalTitle}>経年分析</Text>
              <Text style={styles.longitudinalDate}>{formatDate(longitudinalReview.review_date)}</Text>
            </View>

            <Text style={styles.longitudinalAssessment}>
              {longitudinalReview.trend_analysis.overallAssessment}
            </Text>

            {/* 改善指標 */}
            {(longitudinalReview.trend_analysis.improvingMetrics ?? []).slice(0, 2).map((item, i) => (
              <View key={i} style={styles.trendRow}>
                <View style={styles.trendIconBox}>
                  <Ionicons name="trending-down" size={14} color="#86efac" />
                </View>
                <Text style={styles.trendMetric}>{item.metric}</Text>
                <Text style={styles.trendBadgeGood}>改善</Text>
              </View>
            ))}

            {/* 悪化指標 */}
            {(longitudinalReview.trend_analysis.worseningMetrics ?? []).slice(0, 2).map((item, i) => (
              <View key={i} style={styles.trendRow}>
                <View style={styles.trendIconBox}>
                  <Ionicons name="trending-up" size={14} color="#fca5a5" />
                </View>
                <Text style={styles.trendMetric}>{item.metric}</Text>
                <Text style={styles.trendBadgeBad}>要注意</Text>
              </View>
            ))}

            {/* 食事方針 */}
            {longitudinalReview.nutrition_guidance?.generalDirection && (
              <View style={styles.nutritionBox}>
                <Text style={styles.nutritionLabel}>食事方針</Text>
                <Text style={styles.nutritionText}>
                  {longitudinalReview.nutrition_guidance.generalDirection}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* ─── 健康診断一覧 ─── */}
        {checkups.length === 0 ? (
          <EmptyState
            testID="health-checkups-empty"
            icon={<Ionicons name="document-text-outline" size={48} color={colors.textMuted} />}
            message="健康診断の記録がありません。最初の記録を追加しましょう"
            actionLabel="記録を追加"
            onAction={() => router.push("/health/checkups/new")}
          />
        ) : (
          <View style={{ gap: spacing.sm }}>
            {checkups.map((checkup) => {
              const riskColor = getRiskColor(checkup.individual_review?.riskLevel);
              const riskIcon = getRiskIcon(checkup.individual_review?.riskLevel);
              const riskLabel = getRiskLabel(checkup.individual_review?.riskLevel);
              return (
                <Pressable
                  key={checkup.id}
                  testID={`health-checkups-item-${checkup.id}`}
                  style={styles.checkupCard}
                  onPress={() => router.push(`/health/checkups/${checkup.id}` as any)}
                >
                  {/* 上段: 日付・種別・リスクバッジ */}
                  <View style={styles.checkupTop}>
                    <View style={{ flex: 1 }}>
                      <View style={styles.checkupDateRow}>
                        <Text style={styles.checkupDate}>{formatDate(checkup.checkup_date)}</Text>
                        {checkup.checkup_type && (
                          <View style={styles.typeBadge}>
                            <Text style={styles.typeBadgeText}>{checkup.checkup_type}</Text>
                          </View>
                        )}
                      </View>
                      {checkup.facility_name && (
                        <Text style={styles.facilityName}>{checkup.facility_name}</Text>
                      )}
                    </View>

                    {checkup.individual_review?.riskLevel && (
                      <View style={[styles.riskBadge, { backgroundColor: riskColor.bg }]}>
                        <Ionicons name={riskIcon} size={14} color={riskColor.text} />
                        <Text style={[styles.riskBadgeText, { color: riskColor.text }]}>
                          {riskLabel}
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* 主要指標 */}
                  <View style={styles.metricsRow}>
                    {checkup.blood_pressure_systolic != null && (
                      <View style={styles.metric}>
                        <Ionicons name="heart-outline" size={12} color={colors.error} />
                        <Text style={styles.metricText}>
                          {checkup.blood_pressure_systolic}/{checkup.blood_pressure_diastolic}
                        </Text>
                      </View>
                    )}
                    {checkup.hba1c != null && (
                      <View style={styles.metric}>
                        <Ionicons name="water-outline" size={12} color={colors.purple} />
                        <Text style={styles.metricText}>HbA1c {checkup.hba1c}%</Text>
                      </View>
                    )}
                    {checkup.ldl_cholesterol != null && (
                      <View style={styles.metric}>
                        <Ionicons name="pulse-outline" size={12} color={colors.warning} />
                        <Text style={styles.metricText}>LDL {checkup.ldl_cholesterol}</Text>
                      </View>
                    )}
                  </View>

                  {/* AI サマリー */}
                  {checkup.individual_review?.summary && (
                    <Text style={styles.aiSummary} numberOfLines={2}>
                      {checkup.individual_review.summary}
                    </Text>
                  )}

                  {/* AI レビュー詳細 (concerns / positives / recommendations) */}
                  {checkup.individual_review && (
                    <View style={styles.reviewSection}>
                      {(checkup.individual_review.concerns ?? []).length > 0 && (
                        <View style={[styles.reviewBlock, { backgroundColor: colors.warningLight }]}>
                          <View style={styles.reviewBlockHeader}>
                            <Ionicons name="warning-outline" size={14} color={colors.warning} />
                            <Text style={[styles.reviewBlockTitle, { color: colors.warning }]}>気になる点</Text>
                          </View>
                          {checkup.individual_review.concerns.slice(0, 2).map((item, i) => (
                            <Text key={i} style={styles.reviewBlockItem}>• {item}</Text>
                          ))}
                        </View>
                      )}

                      {(checkup.individual_review.positives ?? []).length > 0 && (
                        <View style={[styles.reviewBlock, { backgroundColor: colors.successLight }]}>
                          <View style={styles.reviewBlockHeader}>
                            <Ionicons name="checkmark-circle-outline" size={14} color={colors.success} />
                            <Text style={[styles.reviewBlockTitle, { color: colors.success }]}>良い点</Text>
                          </View>
                          {checkup.individual_review.positives.slice(0, 2).map((item, i) => (
                            <Text key={i} style={styles.reviewBlockItem}>• {item}</Text>
                          ))}
                        </View>
                      )}

                      {(checkup.individual_review.recommendations ?? []).length > 0 && (
                        <View style={[styles.reviewBlock, { backgroundColor: colors.purpleLight }]}>
                          <View style={styles.reviewBlockHeader}>
                            <Ionicons name="sparkles-outline" size={14} color={colors.purple} />
                            <Text style={[styles.reviewBlockTitle, { color: colors.purple }]}>改善アドバイス</Text>
                          </View>
                          {checkup.individual_review.recommendations.slice(0, 2).map((item, i) => (
                            <Text key={i} style={styles.reviewBlockItem}>{i + 1}. {item}</Text>
                          ))}
                        </View>
                      )}
                    </View>
                  )}

                  <Ionicons
                    name="chevron-forward"
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

  // ─── 一覧カード ───
  checkupCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadows.sm,
  },
  checkupTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  checkupDateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: 2,
  },
  checkupDate: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
  },
  typeBadge: {
    backgroundColor: colors.blueLight,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  typeBadgeText: {
    fontSize: 11,
    color: colors.blue,
    fontWeight: "600",
  },
  facilityName: {
    fontSize: 12,
    color: colors.textMuted,
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

  // ─── 主要指標 ───
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

  // ─── AI サマリー ───
  aiSummary: {
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 18,
  },

  // ─── AI レビューブロック ───
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

  chevron: {
    alignSelf: "flex-end",
    marginTop: -spacing.xs,
  },
});
