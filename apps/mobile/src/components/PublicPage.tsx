import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Card } from "./ui";
import { buildWebPageUrl } from "../lib/webBaseUrl";
import { colors, spacing, radius, shadows } from "../theme";

export function PublicPage(props: {
  title: string;
  children?: React.ReactNode;
  webPath?: string;
}) {
  const { title, children, webPath } = props;
  // 「Web版を開く」の行き先は Web 版のオリジン (EXPO_PUBLIC_WEB_URL)。
  // 以前は API の基点 (EXPO_PUBLIC_API_BASE_URL) を流用していて、API の向き先を変えると
  // Web 版リンクまで巻き込まれ、未設定だとリンク自体が出なかった (#1049 F7-19)。
  const url = webPath ? buildWebPageUrl(webPath) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <View style={{
        flexDirection: "row", alignItems: "center", gap: spacing.md,
        paddingTop: 56, paddingBottom: spacing.md, paddingHorizontal: spacing.lg,
        backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border,
      }}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
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
              このページはモバイル版で順次整備します。必要に応じてWeb版を参照してください。
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
