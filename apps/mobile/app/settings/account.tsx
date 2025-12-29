import { router } from "expo-router";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";

export default function AccountSettingsPage() {
  async function deleteAccount() {
    const ok = await new Promise<boolean>((resolve) => {
      Alert.alert("アカウント削除", "アカウントとデータを削除します。取り消しできません。", [
        { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
        { text: "削除", style: "destructive", onPress: () => resolve(true) },
      ]);
    });
    if (!ok) return;

    try {
      const api = getApi();
      await api.post("/api/account/delete", { confirm: true });
      await supabase.auth.signOut();
      router.replace("/");
    } catch (e: any) {
      Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>アカウント</Text>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900", color: "#c00" }}>危険な操作</Text>
        <Text style={{ color: "#666" }}>
          アカウント削除は取り消しできません。必要なデータは事前に控えてください。
        </Text>
        <Pressable onPress={deleteAccount} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: "#c00" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>アカウント削除</Text>
        </Pressable>
      </View>

      <Pressable onPress={() => router.back()} style={{ alignItems: "center" }}>
        <Text style={{ color: "#666" }}>戻る</Text>
      </Pressable>
    </ScrollView>
  );
}



