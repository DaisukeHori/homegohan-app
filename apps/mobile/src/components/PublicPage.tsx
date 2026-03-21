import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Card } from "./ui";
import { colors, spacing, radius, shadows } from "../theme";

function getWebBaseUrl(): string | null {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!base) return null;
  return base.replace(/\/+$/, "");
}

export function PublicPage(props: {
  title: string;
  children?: React.ReactNode;
  webPath?: string;
}) {
  const { title, children, webPath } = props;
  const webBaseUrl = getWebBaseUrl();
  const canOpenWeb = !!webBaseUrl && !!webPath;
  const url = canOpenWeb ? `${webBaseUrl}${webPath}` : null;

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
