import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { ScrollView, Text, View } from "react-native";

import { ListItem } from "../../../src/components/ui";
import { colors, spacing } from "../../../src/theme";

export default function SuperAdminHomePage() {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing["4xl"] }}>
      <View style={{ paddingTop: 56 }}>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text }}>Super Admin</Text>
        <Text style={{ fontSize: 14, color: colors.textMuted, marginTop: spacing.xs }}>最高権限機能</Text>
      </View>

      <View style={{ gap: spacing.sm }}>
        <ListItem
          title="管理者管理"
          subtitle="管理者ロールの付与・剥奪"
          left={<Ionicons name="shield-outline" size={22} color={colors.accent} />}
          right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          onPress={() => router.push("/super-admin/admins")}
        />
        <ListItem
          title="システム設定"
          subtitle="アプリケーション設定の管理"
          left={<Ionicons name="settings-outline" size={22} color={colors.blue} />}
          right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          onPress={() => router.push("/super-admin/settings")}
        />
        <ListItem
          title="機能フラグ"
          subtitle="機能のON/OFF切り替え"
          left={<Ionicons name="flag-outline" size={22} color={colors.purple} />}
          right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          onPress={() => router.push("/super-admin/feature-flags")}
        />
        <ListItem
          title="データベース"
          subtitle="DB統計・AI使用量"
          left={<Ionicons name="server-outline" size={22} color={colors.success} />}
          right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          onPress={() => router.push("/super-admin/database")}
        />
      </View>

      <View style={{ marginTop: spacing.sm }}>
        <ListItem
          title="アプリに戻る"
          subtitle="ホーム画面へ戻る"
          left={<Ionicons name="home-outline" size={22} color={colors.textLight} />}
          right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          onPress={() => router.push("/home")}
        />
      </View>
    </ScrollView>
  );
}
