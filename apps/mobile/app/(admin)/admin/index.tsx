import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatCard, LoadingState, EmptyState } from "../../../src/components/ui";
import { colors, spacing, radius } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

type AdminStats = {
  overview: {
    totalUsers: number;
    newUsersToday: number;
    activeUsers: number;
    totalMeals: number;
    completedMealsToday: number;
    healthRecordsToday: number;
    aiSessionsTotal: number;
    pendingInquiries: number;
    publicRecipes: number;
  };
  dailyStats: any[];
};

const NAV_ITEMS = [
  { href: "/admin/users", label: "Users", icon: "people" as const, color: colors.blue, bg: colors.blueLight },
  { href: "/admin/inquiries", label: "Inquiries", icon: "chatbubbles" as const, color: colors.accent, bg: colors.accentLight },
  { href: "/admin/announcements", label: "Announcements", icon: "megaphone" as const, color: colors.purple, bg: colors.purpleLight },
  { href: "/admin/organizations", label: "Organizations", icon: "business" as const, color: colors.success, bg: colors.successLight },
  { href: "/admin/moderation", label: "Moderation", icon: "shield-checkmark" as const, color: colors.warning, bg: colors.warningLight },
  { href: "/admin/audit-logs", label: "Audit Logs", icon: "document-text" as const, color: colors.textLight, bg: colors.bg },
];

export default function AdminHomePage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<AdminStats>("/api/admin/stats");
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
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: 56, paddingHorizontal: spacing.lg, paddingBottom: spacing["3xl"], gap: spacing.lg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <Pressable onPress={() => router.push("/home")} hitSlop={8}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>Admin Console</Text>
        </View>
        <Pressable onPress={load} hitSlop={8}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      {/* Navigation */}
      <SectionHeader title="Menu" />
      <View style={{ gap: spacing.sm }}>
        {NAV_ITEMS.map((item) => (
          <Card key={item.href} onPress={() => router.push(item.href as any)}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
              <View style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: item.bg, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name={item.icon} size={20} color={item.color} />
              </View>
              <Text style={{ flex: 1, fontSize: 15, fontWeight: "700", color: colors.text }}>{item.label}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </View>
          </Card>
        ))}
      </View>

      {/* Stats */}
      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{error}</Text>
          </View>
          <Button onPress={load} variant="outline" size="sm" style={{ marginTop: spacing.md }}>
            再試行
          </Button>
        </Card>
      ) : !stats ? (
        <EmptyState icon={<Ionicons name="analytics-outline" size={40} color={colors.textMuted} />} message="データがありません。" />
      ) : (
        <>
          <SectionHeader title="概要" />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <StatCard
              icon={<Ionicons name="people" size={20} color={colors.blue} />}
              label="Total Users"
              value={stats.overview.totalUsers}
              accentColor={colors.blueLight}
              borderColor={colors.blueLight}
            />
            <StatCard
              icon={<Ionicons name="person-add" size={20} color={colors.success} />}
              label="New Today"
              value={stats.overview.newUsersToday}
              accentColor={colors.successLight}
              borderColor={colors.successLight}
            />
          </View>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <StatCard
              icon={<Ionicons name="pulse" size={20} color={colors.accent} />}
              label="Active (30d)"
              value={stats.overview.activeUsers}
              accentColor={colors.accentLight}
              borderColor="#FED7AA"
            />
            <StatCard
              icon={<Ionicons name="restaurant" size={20} color={colors.purple} />}
              label="Meals"
              value={stats.overview.totalMeals}
              accentColor={colors.purpleLight}
              borderColor="#D1C4E9"
            />
          </View>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <StatCard
              icon={<Ionicons name="checkmark-circle" size={20} color={colors.success} />}
              label="Completed Today"
              value={stats.overview.completedMealsToday}
              accentColor={colors.successLight}
              borderColor="#C8E6C9"
            />
            <StatCard
              icon={<Ionicons name="heart" size={20} color={colors.error} />}
              label="Health Today"
              value={stats.overview.healthRecordsToday}
              accentColor={colors.errorLight}
              borderColor="#FFCDD2"
            />
          </View>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <StatCard
              icon={<Ionicons name="sparkles" size={20} color={colors.warning} />}
              label="AI Sessions"
              value={stats.overview.aiSessionsTotal}
              accentColor={colors.warningLight}
              borderColor="#FFE0B2"
            />
            <StatCard
              icon={<Ionicons name="chatbubble-ellipses" size={20} color={colors.accent} />}
              label="Pending Inquiries"
              value={stats.overview.pendingInquiries}
              accentColor={colors.accentLight}
              borderColor="#FED7AA"
            />
          </View>
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
              <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.successLight, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="book" size={20} color={colors.success} />
              </View>
              <View>
                <Text style={{ fontSize: 11, fontWeight: "500", color: colors.textMuted }}>Public Recipes</Text>
                <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text }}>{stats.overview.publicRecipes}</Text>
              </View>
            </View>
          </Card>
        </>
      )}
    </ScrollView>
  );
}
