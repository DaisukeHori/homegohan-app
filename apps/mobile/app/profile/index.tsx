import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Card, ListItem, PageHeader } from "../../src/components/ui";
import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";
import { colors, spacing, radius, shadows } from "../../src/theme";

export default function ProfilePage() {
  const { user } = useAuth();
  const { profile } = useProfile();

  const displayName = profile?.nickname || user?.email?.split("@")[0] || "ゲスト";

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="マイページ" />

      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
        {/* プロフィールカード */}
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
            <View style={{
              width: 52, height: 52, borderRadius: 26,
              backgroundColor: colors.accentLight,
              alignItems: "center", justifyContent: "center",
            }}>
              <Ionicons name="person" size={28} color={colors.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 18, fontWeight: "700", color: colors.text }}>
                {displayName}
              </Text>
              <Text style={{ fontSize: 14, color: colors.textMuted }}>{user?.email ?? ""}</Text>
            </View>
          </View>
        </Card>

        {/* メニュー */}
        <View style={{ gap: spacing.sm }}>
          <ListItem
            title="栄養目標"
            subtitle="目標値の確認・再計算"
            onPress={() => router.push("/profile/nutrition-targets")}
            left={
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.successLight, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="nutrition-outline" size={18} color={colors.success} />
              </View>
            }
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
          <ListItem
            title="プロフィールを見直す"
            subtitle="オンボーディング"
            onPress={() => router.push("/onboarding")}
            left={
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.blueLight, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="refresh-outline" size={18} color={colors.blue} />
              </View>
            }
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
          <ListItem
            title="バッジ"
            subtitle="獲得した実績"
            onPress={() => router.push("/badges")}
            left={
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.warningLight, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="trophy-outline" size={18} color={colors.warning} />
              </View>
            }
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
          <ListItem
            title="比較"
            subtitle="他のユーザーと比較"
            onPress={() => router.push("/comparison")}
            left={
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.purpleLight, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="bar-chart-outline" size={18} color={colors.purple} />
              </View>
            }
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
          <ListItem
            title="家族管理"
            subtitle="家族アカウント"
            onPress={() => router.push("/family")}
            left={
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accentLight, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="people-outline" size={18} color={colors.accent} />
              </View>
            }
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
        </View>
      </ScrollView>
    </View>
  );
}
