import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./ui/Text";

import { Card } from "./ui";
import { webPageUrl } from "../lib/siteConfig";
import { colors, spacing, radius, shadows } from "../theme";

/*
 * 「Web版を開く」で開く URL は、siteConfig.ts の webPageUrl (利用規約・プライバシーポリシーと同じ、
 * webBaseUrl.ts の getWebBaseUrl() = EXPO_PUBLIC_WEB_URL か既定の Web のオリジン) から作る (#1049 F7-19)。
 * 以前は API のオリジン (EXPO_PUBLIC_API_BASE_URL) を流用していて、API と Web が別のオリジンのビルドでは
 * 利用規約などを API のサーバーで開こうとしていた。
 */

/**
 * 戻る先が無いとき (公開ページを直接開いた・リンクから開いた) に移る入口。app/index.tsx の最初の画面
 * (ログインしていればホームへ送る)。app/(public)/_layout.tsx の ErrorBoundary の「最初の画面へ戻る」と同じ。
 */
const ENTRY_HREF = "/";

/**
 * 自前のヘッダの戻る操作 (#1822)。app/(public)/_layout.tsx は native-stack のヘッダを出さないので、
 * 画面の上の戻る操作はここだけ。戻れる履歴があれば戻り、無ければ入口へ移る (行き止まりにしない)。
 */
function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace(ENTRY_HREF);
}

export function PublicPage(props: {
  title: string;
  children?: React.ReactNode;
  webPath?: string;
}) {
  const { title, children, webPath } = props;
  const url = webPath ? webPageUrl(webPath) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <View style={{
        flexDirection: "row", alignItems: "center", gap: spacing.md,
        paddingTop: 56, paddingBottom: spacing.md, paddingHorizontal: spacing.lg,
        backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border,
      }}>
        <Pressable onPress={goBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="戻る">
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text, flex: 1 }}>{title}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        {children ? (
          <Card>
            <View style={{ gap: spacing.md }}>{children}</View>
          </Card>
        ) : (
          <Card>
            <Text style={{ color: colors.textLight, lineHeight: 22 }}>
              このページの内容は、Web版でご覧いただけます。
            </Text>
          </Card>
        )}

        {url && (
          <Pressable
            onPress={() => Linking.openURL(url)}
            style={{
              flexDirection: "row", alignItems: "center", justifyContent: "center",
              gap: spacing.sm, backgroundColor: colors.card,
              borderRadius: radius.lg, paddingVertical: 14,
              borderWidth: 1, borderColor: colors.border, ...shadows.sm,
            }}
          >
            <Ionicons name="open-outline" size={18} color={colors.accent} />
            <Text style={{ fontSize: 14, fontWeight: "700", color: colors.accent }}>Web版を開く</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}
