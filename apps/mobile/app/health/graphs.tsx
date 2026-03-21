import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader, SectionHeader } from "../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../src/theme";
import { getApi } from "../../src/lib/api";

type HealthRecord = {
  id: string;
  record_date: string;
  weight: number | null;
  mood_score: number | null;
  sleep_quality: number | null;
};

export default function HealthGraphsPage() {
  const [records, setRecords] = useState<HealthRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ records: HealthRecord[] }>("/api/health/records?limit=30");
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

  const weights = useMemo(() => records.filter((r) => typeof r.weight === "number").map((r) => ({ date: r.record_date, value: r.weight as number })), [records]);

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
      ) : (
        <Card>
          <SectionHeader
            title="体重（直近30件）"
            right={<Ionicons name="fitness-outline" size={20} color={colors.accent} />}
          />
          {weights.length === 0 ? (
            <EmptyState
              icon={<Ionicons name="scale-outline" size={36} color={colors.textMuted} />}
              message="体重データがありません。"
            />
          ) : (
            <View style={styles.weightList}>
              {weights.map((w) => (
                <View key={w.date} style={styles.weightRow}>
                  <Text style={styles.weightDate}>{w.date}</Text>
                  <Text style={styles.weightValue}>
                    {w.value} <Text style={styles.weightUnit}>kg</Text>
                  </Text>
                </View>
              ))}
            </View>
          )}
        </Card>
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
  weightList: {
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  weightRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  weightDate: {
    fontSize: 14,
    color: colors.textLight,
  },
  weightValue: {
    fontSize: 16,
    fontWeight: "800",
    color: colors.text,
  },
  weightUnit: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textMuted,
  },
});
