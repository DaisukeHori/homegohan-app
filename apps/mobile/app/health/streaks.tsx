import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader, ProgressBar, SectionHeader, StatCard } from "../../src/components/ui";
import { colors, spacing } from "../../src/theme";
import { getApi } from "../../src/lib/api";

type Streak = {
  id?: string;
  streak_type: string;
  current_streak: number;
  longest_streak: number;
  last_activity_date: string | null;
  streak_start_date: string | null;
  achieved_badges: string[] | null;
  total_records: number;
};

type StreakResponse = {
  streak: Streak;
  nextBadge: number | null;
  daysToNextBadge: number | null;
  weeklyRecords: string[];
  weeklyRecordCount: number;
};

function toYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function HealthStreaksPage() {
  const [data, setData] = useState<StreakResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<StreakResponse>("/api/health/streaks?type=daily_record");
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const weekly = useMemo(() => {
    const recorded = new Set(data?.weeklyRecords ?? []);
    const days: { date: string; recorded: boolean }[] = [];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const ymd = toYmd(d);
      days.push({ date: ymd, recorded: recorded.has(ymd) });
    }
    return days;
  }, [data]);

  async function reset() {
    Alert.alert("リセット", "連続記録をリセットしますか？（テスト用）", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "リセット",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del("/api/health/streaks?type=daily_record");
            await load();
          } catch (e: any) {
            Alert.alert("失敗", e?.message ?? "失敗しました。");
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.screen}>
      <PageHeader
        title="連続記録"
        right={
          <Link href="/health">
            <Text style={styles.linkText}>健康トップへ</Text>
          </Link>
        }
      />
      <ScrollView contentContainerStyle={styles.container}>

      {isLoading ? (
        <LoadingState message="ストリークを読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={styles.errorRow}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        </Card>
      ) : !data ? (
        <EmptyState
          icon={<Ionicons name="flame-outline" size={40} color={colors.textMuted} />}
          message="データがありません。"
        />
      ) : (
        <>
          <View style={styles.statsRow}>
            <StatCard
              icon={<Ionicons name="flame" size={22} color={colors.streak} />}
              label="現在の連続"
              value={data.streak.current_streak}
              unit="日"
              accentColor={colors.warningLight}
            />
            <StatCard
              icon={<Ionicons name="trophy" size={22} color={colors.warning} />}
              label="最長記録"
              value={data.streak.longest_streak}
              unit="日"
              accentColor={colors.warningLight}
            />
          </View>

          <Card>
            <SectionHeader
              title="daily_record"
              right={<Ionicons name="stats-chart-outline" size={18} color={colors.accent} />}
            />
            <View style={styles.detailGrid}>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>最終記録</Text>
                <Text style={styles.detailValue}>{data.streak.last_activity_date ?? "-"}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>開始日</Text>
                <Text style={styles.detailValue}>{data.streak.streak_start_date ?? "-"}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>合計記録数</Text>
                <Text style={styles.detailValue}>{data.streak.total_records}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>次のバッジ</Text>
                <Text style={styles.detailValue}>
                  {data.nextBadge ? `${data.nextBadge}日（あと${data.daysToNextBadge ?? "-"}日）` : "なし"}
                </Text>
              </View>
            </View>
          </Card>

          <Card>
            <SectionHeader
              title="直近7日"
              right={
                <Text style={styles.weeklyCount}>
                  {data.weeklyRecordCount}/7
                </Text>
              }
            />
            <ProgressBar
              value={data.weeklyRecordCount}
              max={7}
              color={colors.streak}
              style={styles.weeklyProgress}
            />
            <View style={styles.weekGrid}>
              {weekly.map((d) => (
                <View key={d.date} style={styles.dayItem}>
                  <View
                    style={[
                      styles.dayDot,
                      { backgroundColor: d.recorded ? colors.success : colors.border },
                    ]}
                  >
                    {d.recorded && (
                      <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                    )}
                  </View>
                  <Text style={[styles.dayText, d.recorded && styles.dayTextRecorded]}>
                    {d.date.slice(5)}
                  </Text>
                </View>
              ))}
            </View>
          </Card>

          <Button onPress={reset} variant="destructive" size="sm">
            <Ionicons name="trash-outline" size={16} color="#FFFFFF" />
            <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 13 }}>リセット（テスト用）</Text>
          </Button>
        </>
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
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  detailGrid: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  detailLabel: {
    fontSize: 13,
    color: colors.textMuted,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.text,
  },
  weeklyCount: {
    fontSize: 14,
    fontWeight: "800",
    color: colors.streak,
  },
  weeklyProgress: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  weekGrid: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  dayItem: {
    alignItems: "center",
    gap: spacing.xs,
  },
  dayDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  dayText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  dayTextRecorded: {
    color: colors.text,
    fontWeight: "600",
  },
});
