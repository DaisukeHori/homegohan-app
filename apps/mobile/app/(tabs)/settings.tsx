import { Link, router } from "expo-router";
import { Alert, Button, Text, View } from "react-native";

import { supabase } from "../../src/lib/supabase";
import { useProfile } from "../../src/providers/ProfileProvider";

export default function SettingsScreen() {
  const { roles, hasRole } = useProfile();

  async function onSignOut() {
    const ok = await new Promise<boolean>((resolve) => {
      Alert.alert("ログアウト", "ログアウトしますか？", [
        { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
        { text: "ログアウト", style: "destructive", onPress: () => resolve(true) },
      ]);
    });
    if (!ok) return;

    await supabase.auth.signOut();
    router.replace("/");
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "800" }}>設定</Text>

      <View style={{ gap: 10 }}>
        <Link href="/profile">マイページ</Link>
        <Link href="/settings/account">アカウント</Link>
        <Link href="/menus/weekly">週間献立</Link>
        <Link href="/meals/new">写真で記録</Link>
        <Link href="/health/record">健康記録</Link>
        <Link href="/health/settings">通知設定</Link>
        <Link href="/shopping-list">買い物リスト</Link>
        <Link href="/pantry">冷蔵庫</Link>
        <Link href="/recipes">レシピ</Link>
        <Link href="/badges">バッジ</Link>
        <Link href="/comparison">比較</Link>
        <Link href="/family">家族</Link>
        <Link href="/terms">利用規約</Link>
        <Link href="/privacy">プライバシー</Link>
      </View>

      <View style={{ marginTop: 8, gap: 8 }}>
        <Text style={{ fontWeight: "800" }}>管理メニュー（権限がある場合）</Text>
        <Text style={{ color: "#999" }}>roles: {roles.join(", ") || "(none)"}</Text>
        {hasRole("org_admin") ? <Link href="/org/dashboard">組織管理</Link> : null}
        {hasRole("support") || hasRole("admin") || hasRole("super_admin") ? <Link href="/support">サポート</Link> : null}
        {hasRole("admin") || hasRole("super_admin") ? <Link href="/admin">管理者</Link> : null}
        {hasRole("super_admin") ? <Link href="/super-admin">Super Admin</Link> : null}
      </View>

      <Button title="ログアウト" onPress={onSignOut} />
    </View>
  );
}


