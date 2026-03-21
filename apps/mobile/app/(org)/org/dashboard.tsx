import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatCard, LoadingState, EmptyState } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing, radius } from "../../../src/theme";

type OrgStats = {
  overview: {
    totalMembers: number;
    activeMembers: number;
    weeklyMeals: number;
    breakfastRate: number;
  };
  dailyStats: any[];
  departmentStats: Array<{ id: string; name: string; memberCount: number }>;
};

type NavItem = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: string;
  color: string;
  bg: string;
};

const NAV_ITEMS: NavItem[] = [
  { label: "メンバー", icon: "people", route: "/org/members", color: colors.accent, bg: colors.accentLight },
  { label: "招待", icon: "mail", route: "/org/invites", color: colors.blue, bg: colors.blueLight },
  { label: "部署", icon: "business", route: "/org/departments", color: colors.purple, bg: colors.purpleLight },
  { label: "チャレンジ", icon: "trophy", route: "/org/challenges", color: colors.warning, bg: colors.warningLight },
  { label: "設定", icon: "settings", route: "/org/settings", color: colors.textLight, bg: colors.bg },
];

export default function OrgDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<OrgStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<OrgStats>("/api/org/stats");
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
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: spacing["4xl"] }}>
      {/* Header */}
      <View style={{ paddingTop: 56, paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <Pressable onPress={() => router.push("/home")} hitSlop={8}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>組織ダッシュボード</Text>
        </View>
        <Pressable onPress={load} hitSlop={8}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: spacing.xl, gap: spacing.lg }}>
        {/* Navigation Grid */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
          {NAV_ITEMS.map((item) => (
            <Pressable
              key={item.route}
              onPress={() => router.push(item.route as any)}
              style={({ pressed }) => ({
                width: "30%",
                flexGrow: 1,
                alignItems: "center",
                paddingVertical: spacing.lg,
                backgroundColor: colors.card,
                borderRadius: radius.lg,
                borderWidth: 1,
                borderColor: colors.border,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <View style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: item.bg, alignItems: "center", justifyContent: "center", marginBottom: spacing.sm }}>
                <Ionicons name={item.icon} size={20} color={item.color} />
              </View>
              <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>{item.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* Stats */}
        {isLoading ? (
          <LoadingState message="データを読み込み中..." />
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
        ) : !data ? (
          <EmptyState icon={<Ionicons name="bar-chart-outline" size={40} color={colors.textMuted} />} message="データがありません。" />
        ) : (
          <>
            <SectionHeader title="概要" />
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <StatCard
                icon={<Ionicons name="people" size={20} color={colors.accent} />}
                label="総メンバー"
                value={data.overview.totalMembers}
                unit="人"
              />
              <StatCard
                icon={<Ionicons name="pulse" size={20} color={colors.success} />}
                label="アクティブ"
                value={data.overview.activeMembers}
                unit="人"
                accentColor={colors.successLight}
              />
            </View>
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <StatCard
                icon={<Ionicons name="restaurant" size={20} color={colors.blue} />}
                label="今週の食事"
                value={data.overview.weeklyMeals}
                unit="食"
                accentColor={colors.blueLight}
              />
              <StatCard
                icon={<Ionicons name="sunny" size={20} color={colors.warning} />}
                label="朝食率"
                value={data.overview.breakfastRate}
                unit="%"
                accentColor={colors.warningLight}
              />
            </View>

            <SectionHeader title="部署別" />
            {(data.departmentStats ?? []).length === 0 ? (
              <EmptyState icon={<Ionicons name="business-outline" size={36} color={colors.textMuted} />} message="部署がありません。" />
            ) : (
              <Card>
                <View style={{ gap: spacing.sm }}>
                  {data.departmentStats.map((d, i) => (
                    <View
                      key={d.id}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        paddingVertical: spacing.md,
                        borderTopWidth: i > 0 ? 1 : 0,
                        borderTopColor: colors.border,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                        <Ionicons name="business" size={18} color={colors.purple} />
                        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{d.name}</Text>
                      </View>
                      <Text style={{ fontSize: 14, fontWeight: "700", color: colors.textLight }}>{d.memberCount}人</Text>
                    </View>
                  ))}
                </View>
              </Card>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}
