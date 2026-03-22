import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader } from "../../src/components/ui";
import { colors, spacing, radius } from "../../src/theme";
import { getApi } from "../../src/lib/api";

type HealthRecord = {
  id: string;
  record_date: string;
  weight: number | null;
  mood_score: number | null;
  sleep_quality: number | null;
};

function SimpleBarChart({ data, label, unit, color, maxBars = 14 }: {
  data: { date: string; value: number }[];
  label: string;
  unit: string;
  color: string;
  maxBars?: number;
}) {
  const sliced = data.slice(-maxBars);
  if (sliced.length === 0) return null;

  const values = sliced.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const latest = sliced[sliced.length - 1];
  const prev = sliced.length > 1 ? sliced[sliced.length - 2] : null;
  const diff = prev ? latest.value - prev.value : null;

  return (
    <View style={styles.chartCard}>
      <View style={styles.chartHeader}>
        <Text style={styles.chartLabel}>{label}</Text>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={[styles.chartValue, { color }]}>
            {latest.value.toFixed(1)}<Text style={styles.chartUnit}> {unit}</Text>
          </Text>
          {diff !== null && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              <Ionicons
                name={diff > 0 ? "trending-up" : diff < 0 ? "trending-down" : "remove"}
                size={12}
                color={diff > 0 ? colors.error : diff < 0 ? colors.success : colors.textMuted}
              />
              <Text style={{ fontSize: 11, color: diff > 0 ? colors.error : diff < 0 ? colors.success : colors.textMuted }}>
                {diff > 0 ? "+" : ""}{diff.toFixed(1)}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Bar chart */}
      <View style={styles.barsContainer}>
        {sliced.map((d, i) => {
          const pct = ((d.value - min) / range) * 0.8 + 0.2; // 20%-100%
          const isLast = i === sliced.length - 1;
          return (
            <View key={d.date} style={styles.barCol}>
              <View style={[styles.bar, {
                height: pct * 80,
                backgroundColor: isLast ? color : `${color}40`,
                borderRadius: 4,
              }]} />
              {i % Math.ceil(sliced.length / 5) === 0 || isLast ? (
                <Text style={styles.barLabel}>{d.date.slice(5)}</Text>
              ) : (
                <Text style={styles.barLabel}> </Text>
              )}
            </View>
          );
        })}
      </View>

      {/* Min/Max legend */}
      <View style={styles.legendRow}>
        <Text style={styles.legendText}>最小: {min.toFixed(1)} {unit}</Text>
        <Text style={styles.legendText}>最大: {max.toFixed(1)} {unit}</Text>
      </View>
    </View>
  );
}

function SimpleLineList({ data, label, unit }: {
  data: { date: string; value: number }[];
  label: string;
  unit: string;
}) {
  if (data.length === 0) return null;

  const MOOD_LABELS: Record<number, string> = { 1: "😫", 2: "😟", 3: "😐", 4: "😊", 5: "😄" };
  const SLEEP_LABELS: Record<number, string> = { 1: "😵", 2: "😪", 3: "😐", 4: "😴", 5: "🌟" };
  const labels = label.includes("気分") ? MOOD_LABELS : label.includes("睡眠") ? SLEEP_LABELS : {};

  return (
    <View style={styles.chartCard}>
      <Text style={styles.chartLabel}>{label}（直近7件）</Text>
      <View style={{ gap: 4, marginTop: spacing.sm }}>
        {data.slice(-7).map((d) => (
          <View key={d.date} style={styles.listRow}>
            <Text style={styles.listDate}>{d.date.slice(5)}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              {labels[d.value] && <Text style={{ fontSize: 16 }}>{labels[d.value]}</Text>}
              <Text style={styles.listValue}>{d.value}{unit}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

export default function HealthGraphsPage() {
  const [records, setRecords] = useState<HealthRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ records: HealthRecord[] }>("/api/health/records?limit=90");
      setRecords(res.records ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const weights = useMemo(() =>
    records.filter((r) => typeof r.weight === "number")
      .map((r) => ({ date: r.record_date, value: r.weight as number }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    [records]
  );

  const moods = useMemo(() =>
    records.filter((r) => typeof r.mood_score === "number")
      .map((r) => ({ date: r.record_date, value: r.mood_score as number }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    [records]
  );

  const sleeps = useMemo(() =>
    records.filter((r) => typeof r.sleep_quality === "number")
      .map((r) => ({ date: r.record_date, value: r.sleep_quality as number }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    [records]
  );

  return (
    <View style={styles.screen}>
      <PageHeader
        title="グラフ"
        right={
          <Link href="/health">
            <Text style={styles.linkText}>健康トップへ</Text>
          </Link>
        }
      />
      <ScrollView contentContainerStyle={styles.container}>

        {isLoading ? (
          <LoadingState message="データを読み込み中..." />
        ) : error ? (
          <Card variant="error">
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          </Card>
        ) : weights.length === 0 && moods.length === 0 && sleeps.length === 0 ? (
          <EmptyState
            icon={<Ionicons name="analytics-outline" size={48} color={colors.textMuted} />}
            message="データがありません。健康記録を開始しましょう。"
            actionLabel="記録する"
            onAction={() => {}}
          />
        ) : (
          <>
            {weights.length > 0 && (
              <SimpleBarChart data={weights} label="体重推移" unit="kg" color={colors.accent} />
            )}

            {moods.length > 0 && (
              <SimpleLineList data={moods} label="気分スコア" unit="点" />
            )}

            {sleeps.length > 0 && (
              <SimpleLineList data={sleeps} label="睡眠の質" unit="点" />
            )}
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
    gap: spacing.lg,
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
  chartCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chartHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing.md,
  },
  chartLabel: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
  },
  chartValue: {
    fontSize: 22,
    fontWeight: "900",
  },
  chartUnit: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textMuted,
  },
  barsContainer: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    height: 100,
    gap: 2,
  },
  barCol: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 4,
  },
  bar: {
    width: "80%",
    minHeight: 4,
  },
  barLabel: {
    fontSize: 8,
    color: colors.textMuted,
    textAlign: "center",
  },
  legendRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  legendText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  listRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  listDate: {
    fontSize: 13,
    color: colors.textLight,
  },
  listValue: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
  },
});
