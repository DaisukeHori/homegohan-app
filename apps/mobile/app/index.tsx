import { Ionicons } from "@expo/vector-icons";
import { Link, Redirect } from "expo-router";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { Button, Card } from "../src/components/ui";
import { colors, spacing, shadows, radius } from "../src/theme";
import { useAuth } from "../src/providers/AuthProvider";

export default function Index() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (session) return <Redirect href="/(tabs)/home" />;

  return (
    <View style={{ flex: 1, backgroundColor: "#FFF7ED" }}>
      {/* ヒーロー */}
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: spacing.xl }}>
        <View style={{
          width: 80, height: 80, borderRadius: 24,
          backgroundColor: colors.accent, alignItems: "center", justifyContent: "center",
          marginBottom: spacing.lg, ...shadows.lg,
        }}>
          <Ionicons name="restaurant" size={40} color="#fff" />
        </View>
        <Text style={{ fontSize: 36, fontWeight: "900", color: colors.text, marginBottom: spacing.sm }}>
          ほめゴハン
        </Text>
        <Text style={{ fontSize: 15, color: colors.textLight, textAlign: "center", lineHeight: 22 }}>
          AIで食事管理をもっと簡単に。{"\n"}写真で記録、献立提案、健康サポートまで。
        </Text>
      </View>

      {/* アクション */}
      <View style={{ paddingHorizontal: spacing.xl, paddingBottom: 60, gap: spacing.md }}>
        <Link href="/login" asChild>
          <Pressable style={{
            backgroundColor: colors.accent, borderRadius: radius.lg,
            paddingVertical: 16, alignItems: "center", ...shadows.md,
          }}>
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "800" }}>ログイン</Text>
          </Pressable>
        </Link>

        <Link href="/signup" asChild>
          <Pressable style={{
            backgroundColor: colors.card, borderRadius: radius.lg,
            paddingVertical: 16, alignItems: "center",
            borderWidth: 1.5, borderColor: colors.accent,
          }}>
            <Text style={{ color: colors.accent, fontSize: 16, fontWeight: "800" }}>新規登録</Text>
          </Pressable>
        </Link>

        <View style={{
          flexDirection: "row", justifyContent: "center", gap: spacing.lg,
          marginTop: spacing.md,
        }}>
          {[
            { href: "/about", label: "アプリについて" },
            { href: "/pricing", label: "料金" },
            { href: "/terms", label: "利用規約" },
            { href: "/privacy", label: "プライバシー" },
          ].map((item) => (
            <Link key={item.href} href={item.href as any}>
              <Text style={{ fontSize: 12, color: colors.textMuted }}>{item.label}</Text>
            </Link>
          ))}
        </View>
      </View>
    </View>
  );
}
