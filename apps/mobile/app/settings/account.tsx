import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, PageHeader, SectionHeader } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";
import { clearUserScopedAsyncStorage } from "../../src/lib/user-storage";
import { colors, spacing } from "../../src/theme";
import { typography } from "../../src/theme/typography";

export default function AccountSettingsPage() {
  // Round-2 レビュー指摘 #3: 多重タップでの二重削除実行を防止するガード。
  // deleting (state) は Button の disabled/ラベル表示用。
  // deletingRef (ref) は state 更新の再レンダー反映を待たずに効く同期ガードで、
  // 連打が同一 tick 内で複数回 onPress を発火させても deleteAccount() の
  // 本体処理 (API 呼び出し) が二重実行されないようにする。
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  async function deleteAccount() {
    if (deletingRef.current) return; // 多重実行防止 (連打対策・同期ガード)
    deletingRef.current = true;
    // Alert.alert は確認結果を待つ間 await するため、ここで即座に deleting を立てて
    // ボタンを disable しないと、確認ダイアログ表示中の連打で deleteAccount() が
    // 複数回呼ばれてしまう (2 つ目以降の呼び出しは Alert.alert がキューイングするだけで
    // ブロックされない)。ユーザーがキャンセルした場合は false に戻す。
    setDeleting(true);

    const ok = await new Promise<boolean>((resolve) => {
      Alert.alert("アカウント削除", "アカウントとデータを削除します。取り消しできません。", [
        { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
        { text: "削除", style: "destructive", onPress: () => resolve(true) },
      ]);
    });
    if (!ok) {
      deletingRef.current = false;
      setDeleting(false);
      return;
    }

    try {
      // 削除前にユーザー ID を確保しておく。
      // サーバー側削除後は getUser() がセッション無効化により失敗しうるため、
      // ローカルストレージのスコープ解除には削除前に取得した ID を使う。
      const { data: { user } } = await supabase.auth.getUser();

      // Round-2 レビュー指摘 #3: サーバー側の削除 API が成功した場合のみ
      // ローカルセッション (AsyncStorage / Supabase セッション) を破棄する。
      // 削除に失敗した場合はログイン状態を維持し、ユーザーが再試行できるようにする
      // (旧実装は削除前にローカルを消していたため、削除失敗時にログインしたまま
      // ローカルデータだけ失われる不整合があった)。
      const api = getApi();
      await api.post("/api/account/delete", { confirm: true });

      await clearUserScopedAsyncStorage(user?.id ?? null);
      await supabase.auth.signOut();
      router.replace("/");
    } catch (e: any) {
      Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  return (
    <View testID="account-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="アカウント" />
      <ScrollView contentContainerStyle={styles.container}>

      <Card variant="error" style={{ gap: spacing.md }}>
        <SectionHeader
          title="危険な操作"
          right={<Ionicons name="warning-outline" size={20} color={colors.error} />}
        />
        <Text style={typography.body}>
          アカウント削除は取り消しできません。必要なデータは事前に控えてください。
        </Text>
        <Button testID="account-delete-button" onPress={deleteAccount} variant="destructive" size="lg" disabled={deleting}>
          <Ionicons name="trash-outline" size={18} color="#FFF" />
          <Text style={{ color: "#FFF", fontWeight: "700", fontSize: 16 }}>{deleting ? "削除中…" : "アカウント削除"}</Text>
        </Button>
      </Card>
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing["4xl"],
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  backText: {
    color: colors.textLight,
    fontSize: 14,
    fontWeight: "600",
  },
});
