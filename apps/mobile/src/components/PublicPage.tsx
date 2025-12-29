import * as Linking from "expo-linking";
import { Link } from "expo-router";
import React from "react";
import { Button, ScrollView, Text, View } from "react-native";

function getWebBaseUrl(): string | null {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!base) return null;
  return base.replace(/\/+$/, "");
}

export function PublicPage(props: {
  title: string;
  children?: React.ReactNode;
  webPath?: string; // ex: "/pricing"
}) {
  const { title, children, webPath } = props;
  const webBaseUrl = getWebBaseUrl();
  const canOpenWeb = !!webBaseUrl && !!webPath;
  const url = canOpenWeb ? `${webBaseUrl}${webPath}` : null;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "800" }}>{title}</Text>

      {children ? (
        <View style={{ gap: 10 }}>{children}</View>
      ) : (
        <Text style={{ color: "#666" }}>
          このページはモバイル版で順次整備します。必要に応じてWeb版を参照してください。
        </Text>
      )}

      <View style={{ marginTop: 16, gap: 10 }}>
        <Link href="/">トップへ戻る</Link>
        {url ? (
          <Button
            title="Web版を開く"
            onPress={() => {
              Linking.openURL(url);
            }}
          />
        ) : null}
      </View>
    </ScrollView>
  );
}



