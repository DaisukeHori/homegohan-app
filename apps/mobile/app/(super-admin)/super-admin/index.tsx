import { Link } from "expo-router";
import { Text, View } from "react-native";

export default function SuperAdminHomePage() {
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>Super Admin</Text>
      <Text style={{ color: "#666" }}>最高権限機能（実装中）</Text>

      <View style={{ gap: 10, marginTop: 8 }}>
        <Link href="/super-admin/admins">管理者管理</Link>
        <Link href="/super-admin/settings">システム設定</Link>
        <Link href="/super-admin/feature-flags">機能フラグ</Link>
        <Link href="/super-admin/database">データベース</Link>
      </View>

      <View style={{ marginTop: 12 }}>
        <Link href="/home">アプリに戻る</Link>
      </View>
    </View>
  );
}



