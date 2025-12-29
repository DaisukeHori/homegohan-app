import { Link } from "expo-router";
import { Text, View } from "react-native";

import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";

export default function ProfilePage() {
  const { user } = useAuth();
  const { profile } = useProfile();

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>マイページ</Text>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
        <Text style={{ fontWeight: "900" }}>{profile?.nickname ?? "ゲスト"}</Text>
        <Text style={{ color: "#666" }}>{user?.email ?? ""}</Text>
        <Text style={{ color: "#999" }}>roles: {profile?.roles?.join(", ") || "(none)"}</Text>
      </View>

      <View style={{ gap: 10 }}>
        <Link href="/onboarding">プロフィールを見直す（オンボーディング）</Link>
        <Link href="/badges">バッジ</Link>
        <Link href="/comparison">比較</Link>
      </View>
    </View>
  );
}



