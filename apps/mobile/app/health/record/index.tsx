import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader } from "../../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

type HealthRecord = {
  id: string;
  record_date: string;
  weight?: number | null;
  mood_score?: number | null;
  sleep_quality?: number | null;
};

const MOOD_EMOJI: Record<number, string> = { 1: "😞", 2: "😕", 3: "😐", 4: "😊", 5: "😄" };

export default function HealthRecordListPage() {
  const [records, setRecords] = useState<HealthRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setIsLoading(true);
      setError(null);
      try {
        const api = getApi();
        const res = await api.get<{ records: HealthRecord[] }>("/api/health/records?limit=30");
        if (!cancelled) setRecords(res.records ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "取得に失敗しました。");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View testID="health-record-list-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="健康記録" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      <Button testID="health-record-quick-button" onPress={() => router.push("/health/record/quick")}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Ionicons name="add-circle" size={20} color="#fff" />
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>クイック入力</Text>
        </View>
      </Button>

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <Card variant="error">
          <Text style={{ color: colors.error }}>{error}</Text>
        </Card>
      ) : records.length === 0 ? (
        <EmptyState
          testID="health-record-empty"
          icon={<Ionicons name="heart-outline" size={48} color={colors.textMuted} />}
          message="まだ記録がありません"
          actionLabel="記録する"
          onAction={() => router.push("/health/record/quick")}
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {records.map((r) => (
            <Pressable
              key={r.id}
              testID={`health-record-item-${r.id}`}
              onPress={() => router.push(`/health/record/${encodeURIComponent(r.record_date)}`)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: spacing.md,
                padding: spacing.lg,
                backgroundColor: colors.card,
                borderRadius: radius.lg,
                borderWidth: 1,
                borderColor: colors.border,
                ...shadows.sm,
                ...(pressed ? { opacity: 0.9 } : {}),
              })}
            >
              {/* 日付 */}
              <View style={{ alignItems: "center", minWidth: 44 }}>
                <Text style={{ fontSize: 11, color: colors.textMuted }}>
                  {new Date(r.record_date + "T00:00:00").toLocaleDateString("ja-JP", { month: "short" })}
                </Text>
                <Text style={{ fontSize: 20, fontWeight: "800", color: colors.text }}>
                  {r.record_date.slice(8)}
                </Text>
              </View>

              {/* データ */}
              <View style={{ flex: 1, flexDirection: "row", gap: spacing.lg }}>
                {r.weight != null && (
                  <View style={{ alignItems: "center" }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.purple }}>{r.weight}</Text>
                    <Text style={{ fontSize: 10, color: colors.textMuted }}>kg</Text>
                  </View>
                )}
                {r.mood_score != null && (
                  <View style={{ alignItems: "center" }}>
                    <Text style={{ fontSize: 18 }}>{MOOD_EMOJI[r.mood_score] ?? "😐"}</Text>
                    <Text style={{ fontSize: 10, color: colors.textMuted }}>気分</Text>
                  </View>
                )}
                {r.sleep_quality != null && (
                  <View style={{ alignItems: "center" }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.blue }}>{r.sleep_quality}</Text>
                    <Text style={{ fontSize: 10, color: colors.textMuted }}>睡眠</Text>
                  </View>
                )}
              </View>

              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
    </View>
  );
}
