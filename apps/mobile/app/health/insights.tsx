import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, ChipSelector, EmptyState, LoadingState, PageHeader, StatCard, StatusBadge } from "../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../src/theme";
import { getApi } from "../../src/lib/api";

type Insight = {
  id: string;
  title: string;
  summary: string;
  is_read: boolean;
  is_alert: boolean;
  created_at: string;
};

export default function HealthInsightsPage() {
  const [items, setItems] = useState<Insight[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
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

  async function markRead(id: string) {
    try {
      const api = getApi();
      await api.post(`/api/health/insights/${id}/read`, {});
      await load();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "失敗しました。");
    }
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
          message="インサイトがありません。"
        />
      ) : (
        <View style={styles.list}>
          {items.map((i) => (
            <Card key={i.id} variant={i.is_alert ? "warning" : "default"}>
              <View style={styles.insightHeader}>
                <View style={styles.insightTitleRow}>
                  {i.is_alert && <Ionicons name="alert-circle" size={18} color={colors.warning} />}
                  <Text style={styles.insightTitle}>{i.title}</Text>
                </View>
                {!i.is_read && <StatusBadge variant="alert" label="未読" />}
              </View>
              <Text style={styles.insightSummary}>{i.summary}</Text>
              <Text style={styles.insightDate}>{new Date(i.created_at).toLocaleString("ja-JP")}</Text>
              {!i.is_read && (
                <Button onPress={() => markRead(i.id)} variant="primary" size="sm" style={styles.markReadBtn}>
                  <Ionicons name="checkmark-outline" size={14} color="#FFFFFF" />
                  <Text style={styles.markReadText}>既読にする</Text>
                </Button>
              )}
            </Card>
          ))}
        </View>
      )}

      <Button onPress={load} variant="ghost" size="sm">
        <Ionicons name="refresh-outline" size={16} color={colors.textLight} />
        <Text style={{ color: colors.textLight, fontWeight: "700", fontSize: 13 }}>更新</Text>
      </Button>
    </ScrollView>
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
  insightSummary: {
    fontSize: 14,
    color: colors.textLight,
    lineHeight: 20,
  },
  insightDate: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  markReadBtn: {
    alignSelf: "flex-start",
    marginTop: spacing.sm,
  },
  markReadText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 13,
  },
});
