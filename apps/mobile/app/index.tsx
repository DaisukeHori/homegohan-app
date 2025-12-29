import { Link, Redirect } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";

import { useAuth } from "../src/providers/AuthProvider";

export default function Index() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (session) return <Redirect href="/(tabs)/home" />;

  return (
    <View style={{ flex: 1, padding: 20, justifyContent: "center", gap: 16 }}>
      <Text style={{ fontSize: 28, fontWeight: "800" }}>ほめゴハン</Text>
      <Text style={{ color: "#666" }}>
        AIで食事管理をもっと簡単に。写真で記録、献立提案、健康サポートまで。
      </Text>

      <View style={{ gap: 10 }}>
        <Link href="/login">ログイン</Link>
        <Link href="/signup">新規登録</Link>
      </View>

      <View style={{ marginTop: 12, gap: 8 }}>
        <Text style={{ fontWeight: "700" }}>案内</Text>
        <Link href="/about">このアプリについて</Link>
        <Link href="/pricing">料金</Link>
        <Link href="/terms">利用規約</Link>
        <Link href="/privacy">プライバシー</Link>
      </View>
    </View>
  );
}


