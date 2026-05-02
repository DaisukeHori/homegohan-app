import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";

import { Button, Card, ChipSelector, EmptyState, LoadingState, PageHeader, SectionHeader } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { colors, spacing } from "../../src/theme";

type ComparisonResponse = {
  rankings: Array<{
    metric: { code: string; name: string; unit: string | null; higher_is_better: boolean };
    segments: Array<{
      segment: { code: string; name: string };
      rank: number;
      totalUsers: number;
      percentile: number;
      value: number;
      avgValue: number | null;
      vsAvgRate: number | null;
      prize: { name: string; icon: string; message: string } | null;
    }>;
  }>;
  highlights: Array<{ type: string; message: string; icon: string }>;
  periodType: string;
  periodStart: string;
  periodEnd: string;
};

const PERIOD_OPTIONS = [
  { value: "daily" as const, label: "日" },
  { value: "weekly" as const, label: "週" },
  { value: "monthly" as const, label: "月" },
];

export default function ComparisonPage() {
  const [periodType, setPeriodType] = useState<"daily" | "weekly" | "monthly">("weekly");
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<ComparisonResponse>(`/api/comparison/rankings?periodType=${periodType}`);
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [periodType]);

  async function trigger() {
    try {
      const api = getApi();
      const res = await api.post<any>("/api/comparison/trigger", { periodType });
      Alert.alert("実行しました", JSON.stringify(res));
      await load();
    } catch (e: any) {
      Alert.alert("実行失敗", e?.message ?? "失敗しました。");
    }
  }

  return (
    <View testID="comparison-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader
        title="比較"
        right={
          <Button testID="comparison-recalculate-button" onPress={trigger} variant="primary" size="sm">
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
              <Ionicons name="refresh" size={16} color="#FFFFFF" />
              <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 13 }}>再計算</Text>
            </View>
          </Button>
        }
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>

      <ChipSelector
        options={PERIOD_OPTIONS}
        selected={periodType}
        onSelect={setPeriodType}
        testIDPrefix="comparison-period"
      />

      {isLoading ? (
        <LoadingState message="ランキングを読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text testID="comparison-error-text" style={{ color: colors.error, fontSize: 14, fontWeight: "600" }}>{error}</Text>
          </View>
        </Card>
      ) : !data ? (
        <EmptyState
          testID="comparison-empty"
          icon={<Ionicons name="bar-chart-outline" size={48} color={colors.textMuted} />}
          message="データがありません。"
        />
      ) : (
        <>
          <Text style={{ fontSize: 13, color: colors.textMuted }}>
            期間: {data.periodStart} 〜 {data.periodEnd}
          </Text>

          <Card>
            <SectionHeader title="ハイライト" right={<Ionicons name="sparkles" size={18} color={colors.accent} />} />
            {data.highlights?.length ? (
              <View style={{ gap: spacing.sm }}>
                {data.highlights.map((h, idx) => (
                  <View key={idx} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Text style={{ fontSize: 16 }}>{h.icon}</Text>
                    <Text style={{ fontSize: 14, color: colors.textLight, flex: 1 }}>{h.message}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={{ fontSize: 14, color: colors.textMuted }}>まだありません。</Text>
            )}
          </Card>

          <View style={{ gap: spacing.md }}>
            {data.rankings?.map((m) => (
              <Card key={m.metric.code} testID={`comparison-ranking-item-${m.metric.code}`}>
                <SectionHeader title={m.metric.name} />
                <View style={{ gap: spacing.md }}>
                  {m.segments.map((s) => (
                    <View key={`${m.metric.code}-${s.segment.code}`} style={{ gap: spacing.xs }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                        <Ionicons name="podium-outline" size={16} color={colors.accent} />
                        <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>
                          {s.segment.name}: {s.rank}/{s.totalUsers}（{Math.round(s.percentile)}%）
                        </Text>
                      </View>
                      <Text style={{ fontSize: 13, color: colors.textMuted, marginLeft: spacing["2xl"] }}>
                        値: {s.value}
                        {m.metric.unit ? ` ${m.metric.unit}` : ""} / 平均: {s.avgValue ?? "-"} / 平均比: {s.vsAvgRate ? `${Math.round(s.vsAvgRate)}%` : "-"}
                      </Text>
                      {s.prize ? (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs, marginLeft: spacing["2xl"] }}>
                          <Text style={{ fontSize: 14 }}>{s.prize.icon}</Text>
                          <Text style={{ fontSize: 13, color: colors.accent, fontWeight: "600" }}>{s.prize.message}</Text>
                        </View>
                      ) : null}
                    </View>
                  ))}
                </View>
              </Card>
            ))}
          </View>
        </>
      )}

      <Button onPress={load} variant="ghost" size="sm">
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
          <Ionicons name="reload-outline" size={16} color={colors.textLight} />
          <Text style={{ color: colors.textLight, fontWeight: "600", fontSize: 14 }}>更新</Text>
        </View>
      </Button>
    </ScrollView>
    </View>
  );
}
