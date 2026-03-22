import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Card, EmptyState, LoadingState, SectionHeader, StatCard } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing } from "../../../src/theme";

type DbStats = {
  tableCounts: Record<string, number>;
  todayStats: { newUsers: number; newMeals: number; aiSessions: number };
  aiUsage: { totalMessages: number; totalTokens: number; estimatedCost: number };
};

export default function SuperAdminDatabasePage() {
  const [data, setData] = useState<DbStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<DbStats>("/api/super-admin/db-stats");
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

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing["4xl"] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: 56 }}>
        <Pressable onPress={() => router.back()} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text, flex: 1 }}>データベース</Text>
        <Pressable onPress={load} style={{ padding: spacing.sm }}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : !data ? (
        <EmptyState icon={<Ionicons name="server-outline" size={40} color={colors.textMuted} />} message="データがありません。" />
      ) : (
        <>
          <SectionHeader title="今日の統計" />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <StatCard
              icon={<Ionicons name="person-add-outline" size={20} color={colors.success} />}
              label="新規ユーザー"
              value={data.todayStats.newUsers}
              accentColor={colors.successLight}
              borderColor="#C8E6C9"
            />
            <StatCard
              icon={<Ionicons name="restaurant-outline" size={20} color={colors.accent} />}
              label="新規食事"
              value={data.todayStats.newMeals}
              accentColor={colors.accentLight}
            />
          </View>
          <StatCard
            icon={<Ionicons name="chatbox-ellipses-outline" size={20} color={colors.purple} />}
            label="AIセッション"
            value={data.todayStats.aiSessions}
            accentColor={colors.purpleLight}
            borderColor="#D1C4E9"
          />

          <SectionHeader title="AI使用量" />
          <Card>
            <View style={{ gap: spacing.sm }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Ionicons name="chatbubbles-outline" size={18} color={colors.textMuted} />
                  <Text style={{ fontSize: 14, color: colors.textLight }}>メッセージ数</Text>
                </View>
                <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{data.aiUsage.totalMessages.toLocaleString()}</Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Ionicons name="code-slash-outline" size={18} color={colors.textMuted} />
                  <Text style={{ fontSize: 14, color: colors.textLight }}>トークン数</Text>
                </View>
                <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{data.aiUsage.totalTokens.toLocaleString()}</Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Ionicons name="cash-outline" size={18} color={colors.textMuted} />
                  <Text style={{ fontSize: 14, color: colors.textLight }}>推定コスト</Text>
                </View>
                <Text style={{ fontSize: 15, fontWeight: "700", color: colors.accent }}>${data.aiUsage.estimatedCost.toFixed(4)}</Text>
              </View>
            </View>
          </Card>

          <SectionHeader title="テーブル件数" />
          <Card>
            <View style={{ gap: spacing.sm }}>
              {Object.entries(data.tableCounts).map(([k, v]) => (
                <View key={k} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Ionicons name="layers-outline" size={16} color={colors.textMuted} />
                    <Text style={{ fontSize: 14, color: colors.textLight }}>{k}</Text>
                  </View>
                  <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{v.toLocaleString()}</Text>
                </View>
              ))}
            </View>
          </Card>
        </>
      )}
    </ScrollView>
  );
}
