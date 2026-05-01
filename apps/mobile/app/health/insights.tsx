import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, ChipSelector, EmptyState, LoadingState, PageHeader, StatCard, StatusBadge } from "../../src/components/ui";
import { colors, spacing } from "../../src/theme";
import { getApi } from "../../src/lib/api";

type Insight = {
  id: string;
  title: string;
  content: string;
  is_read: boolean;
  is_alert: boolean;
  created_at: string;
  analysis_date?: string;
  priority?: string;
  recommendations?: string[];
  insight_type?: string;
};

const PRIORITY_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "緊急",
};

const PRIORITY_COLORS_MAP: Record<string, string> = {
  low: colors.accent,
  medium: colors.warning,
  high: colors.error,
  critical: colors.error,
};

export default function HealthInsightsPage() {
  const [items, setItems] = useState<Insight[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedInsight, setSelectedInsight] = useState<Insight | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ insights: Insight[]; unreadCount: number; alertCount: number }>(
        `/api/health/insights?limit=20${unreadOnly ? "&unread=true" : ""}`
      );
      setItems(res.insights ?? []);
      setUnreadCount(res.unreadCount ?? 0);
      setAlertCount(res.alertCount ?? 0);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [unreadOnly]);

  async function generateInsights() {
    setIsGenerating(true);
    try {
      const api = getApi();
      await api.post(`/api/health/insights`, {});
      await load();
    } catch (e: any) {
      Alert.alert("生成失敗", e?.message ?? "インサイト生成に失敗しました。");
    } finally {
      setIsGenerating(false);
    }
  }

  async function markRead(id: string) {
    try {
      const api = getApi();
      await api.post(`/api/health/insights/${id}/read`, {});
      setItems((prev) => prev.map((item) => item.id === id ? { ...item, is_read: true } : item));
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "失敗しました。");
    }
  }

  function handleSelectInsight(insight: Insight) {
    setSelectedInsight(insight);
    if (!insight.is_read) {
      markRead(insight.id);
    }
  }

  function formatDate(dateStr?: string) {
    if (!dateStr) return "";
    return new Date(dateStr).toLocaleDateString("ja-JP", { month: "long", day: "numeric" });
  }

  return (
    <View style={styles.screen}>
      <PageHeader
        title="インサイト"
        right={
          <Link href="/health">
            <Text style={styles.linkText}>健康トップへ</Text>
          </Link>
        }
      />
      <ScrollView contentContainerStyle={styles.container}>

        <View style={styles.statsRow}>
          <StatCard
            icon={<Ionicons name="mail-unread-outline" size={22} color={colors.accent} />}
            label="未読"
            value={unreadCount}
            accentColor={colors.accentLight}
          />
          <StatCard
            icon={<Ionicons name="warning-outline" size={22} color={colors.warning} />}
            label="アラート"
            value={alertCount}
            accentColor={colors.warningLight}
          />
        </View>

        <Button
          onPress={generateInsights}
          variant="primary"
          size="sm"
          disabled={isGenerating}
          style={styles.generateBtn}
        >
          <Ionicons name="sparkles-outline" size={16} color="#FFFFFF" />
          <Text style={styles.generateBtnText}>
            {isGenerating ? "AI分析中..." : "AIインサイトを生成"}
          </Text>
        </Button>

        <ChipSelector
          options={[
            { value: "all", label: "すべて" },
            { value: "unread", label: "未読のみ" },
          ]}
          selected={unreadOnly ? "unread" : "all"}
          onSelect={(v) => setUnreadOnly(v === "unread")}
        />

        {isLoading ? (
          <LoadingState message="インサイトを読み込み中..." />
        ) : error ? (
          <Card variant="error">
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          </Card>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Ionicons name="bulb-outline" size={40} color={colors.textMuted} />}
            message="インサイトがありません。AIインサイトを生成してみましょう。"
          />
        ) : (
          <View style={styles.list}>
            {items.map((i) => (
              <Pressable key={i.id} onPress={() => handleSelectInsight(i)}>
                <Card variant={i.is_alert ? "warning" : "default"}>
                  <View style={styles.insightHeader}>
                    <View style={styles.insightTitleRow}>
                      {i.is_alert && <Ionicons name="alert-circle" size={18} color={colors.warning} />}
                      <Text style={styles.insightTitle}>{i.title}</Text>
                    </View>
                    <View style={styles.insightBadges}>
                      {!i.is_read && <StatusBadge variant="alert" label="未読" />}
                      {i.priority && i.priority !== "low" && (
                        <View style={[styles.priorityBadge, { backgroundColor: PRIORITY_COLORS_MAP[i.priority] ?? colors.accent }]}>
                          <Text style={styles.priorityBadgeText}>{PRIORITY_LABELS[i.priority] ?? i.priority}</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <Text style={styles.insightContent} numberOfLines={3}>{i.content}</Text>
                  <View style={styles.insightFooter}>
                    {i.analysis_date ? (
                      <Text style={styles.insightDate}>{formatDate(i.analysis_date)}の分析</Text>
                    ) : (
                      <Text style={styles.insightDate}>{new Date(i.created_at).toLocaleString("ja-JP")}</Text>
                    )}
                    <Ionicons name="chevron-forward-outline" size={16} color={colors.textMuted} />
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        )}

        <Button onPress={load} variant="ghost" size="sm">
          <Ionicons name="refresh-outline" size={16} color={colors.textLight} />
          <Text style={{ color: colors.textLight, fontWeight: "700", fontSize: 13 }}>更新</Text>
        </Button>
      </ScrollView>

      {/* 詳細BottomSheet */}
      <Modal
        visible={selectedInsight !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedInsight(null)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setSelectedInsight(null)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            {selectedInsight && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.modalHeader}>
                  {selectedInsight.is_alert && (
                    <Ionicons name="alert-circle" size={24} color={colors.error} style={styles.modalAlertIcon} />
                  )}
                  <View style={styles.modalTitleBlock}>
                    <Text style={styles.modalTitle}>{selectedInsight.title}</Text>
                    {selectedInsight.analysis_date && (
                      <Text style={styles.modalSubtitle}>{formatDate(selectedInsight.analysis_date)}の分析</Text>
                    )}
                  </View>
                  {selectedInsight.priority && (
                    <View style={[styles.priorityBadge, { backgroundColor: PRIORITY_COLORS_MAP[selectedInsight.priority] ?? colors.accent }]}>
                      <Text style={styles.priorityBadgeText}>{PRIORITY_LABELS[selectedInsight.priority] ?? selectedInsight.priority}</Text>
                    </View>
                  )}
                </View>

                <Text style={styles.modalContent}>{selectedInsight.content}</Text>

                {selectedInsight.recommendations && selectedInsight.recommendations.length > 0 && (
                  <View style={styles.recommendationsBlock}>
                    <Text style={styles.recommendationsTitle}>おすすめアクション</Text>
                    {selectedInsight.recommendations.map((rec, idx) => (
                      <View key={idx} style={styles.recommendationItem}>
                        <Ionicons name="checkmark-circle-outline" size={18} color={colors.accent} style={styles.recommendationIcon} />
                        <Text style={styles.recommendationText}>{rec}</Text>
                      </View>
                    ))}
                  </View>
                )}

                <Button
                  onPress={() => setSelectedInsight(null)}
                  variant="ghost"
                  size="sm"
                  style={styles.modalCloseBtn}
                >
                  <Text style={styles.modalCloseBtnText}>閉じる</Text>
                </Button>
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing["4xl"],
  },
  linkText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.accent,
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  generateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  generateBtnText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 14,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  errorText: {
    fontSize: 14,
    color: colors.error,
    fontWeight: "600",
    flex: 1,
  },
  list: {
    gap: spacing.md,
  },
  insightHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing.sm,
  },
  insightTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    flex: 1,
  },
  insightTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
    flex: 1,
  },
  insightBadges: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginLeft: spacing.xs,
  },
  priorityBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  priorityBadgeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
  },
  insightContent: {
    fontSize: 14,
    color: colors.textLight,
    lineHeight: 20,
  },
  insightFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.xs,
  },
  insightDate: {
    fontSize: 12,
    color: colors.textMuted,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: spacing.lg,
    paddingBottom: spacing["4xl"],
    maxHeight: "80%",
  },
  modalHandle: {
    width: 48,
    height: 4,
    backgroundColor: "#E0E0E0",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: spacing.lg,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  modalAlertIcon: {
    marginTop: 2,
  },
  modalTitleBlock: {
    flex: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.text,
  },
  modalSubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },
  modalContent: {
    fontSize: 15,
    color: colors.textLight,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  recommendationsBlock: {
    marginBottom: spacing.lg,
  },
  recommendationsTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.sm,
  },
  recommendationItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
    marginBottom: spacing.sm,
    backgroundColor: colors.bg,
    borderRadius: 8,
    padding: spacing.sm,
  },
  recommendationIcon: {
    marginTop: 1,
  },
  recommendationText: {
    fontSize: 14,
    color: colors.textLight,
    flex: 1,
    lineHeight: 20,
  },
  modalCloseBtn: {
    width: "100%",
    marginTop: spacing.sm,
  },
  modalCloseBtnText: {
    color: colors.textLight,
    fontWeight: "600",
    fontSize: 15,
  },
});
