import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Card, EmptyState, ListItem, LoadingState, SectionHeader, StatCard } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing, radius, shadows } from "../../../src/theme";

type SupportStats = {
  overview: {
    pendingInquiries: number;
    inProgressInquiries: number;
    resolvedToday: number;
    totalInquiries: number;
    myResolvedThisWeek: number;
  };
  inquiriesByType: Record<string, number>;
  recentInquiries: Array<{ id: string; inquiryType: string; subject: string; status: string; createdAt: string; userName: string }>;
};

export default function SupportHomePage() {
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<SupportStats>("/api/support/stats");
      setStats(res);
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
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 56 }}>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text }}>Support Center</Text>
        <Pressable onPress={load} style={{ padding: spacing.sm }}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={{ gap: spacing.sm }}>
        <ListItem
          title="問い合わせ"
          subtitle="問い合わせ一覧を管理"
          left={<Ionicons name="chatbubbles-outline" size={22} color={colors.accent} />}
          right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          onPress={() => router.push("/support/inquiries")}
        />
        <ListItem
          title="ユーザー検索"
          subtitle="ユーザーを検索・管理"
          left={<Ionicons name="people-outline" size={22} color={colors.blue} />}
          right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          onPress={() => router.push("/support/users")}
        />
        <ListItem
          title="アプリに戻る"
          subtitle="ホーム画面へ戻る"
          left={<Ionicons name="home-outline" size={22} color={colors.success} />}
          right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          onPress={() => router.push("/home")}
        />
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
      ) : !stats ? (
        <EmptyState icon={<Ionicons name="analytics-outline" size={40} color={colors.textMuted} />} message="データがありません。" />
      ) : (
        <>
          <SectionHeader title="概要" />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <StatCard
              icon={<Ionicons name="hourglass-outline" size={22} color={colors.warning} />}
              label="Pending"
              value={stats.overview.pendingInquiries}
              accentColor={colors.warningLight}
              borderColor="#FFE0B2"
            />
            <StatCard
              icon={<Ionicons name="construct-outline" size={22} color={colors.blue} />}
              label="In Progress"
              value={stats.overview.inProgressInquiries}
              accentColor={colors.blueLight}
              borderColor="#BBDEFB"
            />
          </View>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <StatCard
              icon={<Ionicons name="checkmark-circle-outline" size={22} color={colors.success} />}
              label="本日解決"
              value={stats.overview.resolvedToday}
              accentColor={colors.successLight}
              borderColor="#C8E6C9"
            />
            <StatCard
              icon={<Ionicons name="star-outline" size={22} color={colors.purple} />}
              label="自分の解決(7d)"
              value={stats.overview.myResolvedThisWeek}
              accentColor={colors.purpleLight}
              borderColor="#D1C4E9"
            />
          </View>

          <SectionHeader title="種別（pending）" />
          <Card>
            {Object.keys(stats.inquiriesByType ?? {}).length === 0 ? (
              <Text style={{ color: colors.textMuted, fontSize: 14 }}>なし</Text>
            ) : (
              <View style={{ gap: spacing.sm }}>
                {Object.entries(stats.inquiriesByType).map(([k, v]) => (
                  <View key={k} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ fontSize: 14, color: colors.textLight }}>{k}</Text>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{v}</Text>
                  </View>
                ))}
              </View>
            )}
          </Card>
        </>
      )}
    </ScrollView>
  );
}
