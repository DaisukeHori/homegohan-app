import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { STORE_SUBSCRIPTION_DELETION_NOTICE, STORE_SUBSCRIPTION_MANAGEMENT_URL, type PurchaseStore } from "@homegohan/shared";
import { Text } from "../../src/components/ui/Text";

import { AccountCredentialsSection } from "../../src/components/settings/AccountCredentialsSection";
import { Button, Card, PageHeader, SectionHeader } from "../../src/components/ui";
import { accountDeletionErrorOf } from "../../src/lib/account-deletion-error";
import { DSR_SCREEN_ROUTE, DSR_SETTINGS_ENTRY_DESCRIPTION, DSR_SETTINGS_ENTRY_TITLE } from "../../src/lib/data-subject-requests";
import { MEMBERSHIP_SETTINGS_SCREEN_ROUTE } from "../../src/lib/membership-settings";
import { getApi } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";
import { signOutAfterAccountDeletion, signOutOnDevice } from "../../src/lib/signOut";
import { useAuth } from "../../src/providers/AuthProvider";
import { colors, spacing } from "../../src/theme";
import { typography } from "../../src/theme/typography";

/** 削除の API が失敗したときの Alert の見出し (組織のオーナー・家族の代表者で退会できないとき以外) */
const ACCOUNT_DELETE_FAILED_TITLE = "削除失敗";
/** 組織のオーナー・家族の代表者 (409) で退会できないときの Alert の見出し */
const ACCOUNT_DELETE_BLOCKED_TITLE = "退会できません";
/** 409 の Alert の、メンバーシップ設定 (譲渡と解散。Web の画面を WebView で開く) へ移るボタン (#1917) */
const ACCOUNT_DELETE_BLOCKED_OPEN_MEMBERSHIP = "メンバーシップ設定を開く";
/** 409 の Alert の、閉じるボタン */
const ACCOUNT_DELETE_BLOCKED_CLOSE = "閉じる";
/** ログインが切れていて (401) 退会できなかったときの Alert の見出し (#1562) */
const ACCOUNT_DELETE_UNAUTHORIZED_TITLE = "ログインが必要です";
/** 削除は済んだが、端末のログアウトに失敗したときの文 */
const ACCOUNT_DELETED_SIGN_OUT_FAILED_MESSAGE =
  "アカウントの削除は完了しましたが、端末側のログアウト処理に失敗しました。お手数ですが、アプリを再起動してください。";
/** 請求の項目の右の矢印の大きさ (退会のボタンのアイコンと同じ大きさにそろえる) */
const DATA_REQUESTS_CHEVRON_SIZE = 18;
/** 退会の確認の本文 (取り消せないことと、ストアの購読は退会で解約されないこと。billing/03 §10.4) */
const ACCOUNT_DELETE_CONFIRM_MESSAGE = `アカウントとデータを削除します。取り消しできません。\n\n${STORE_SUBSCRIPTION_DELETION_NOTICE}`;
/** 退会の確認から購読の管理を開くボタン (購入の画面 (billing/03 §10.6 の 2) のボタンと同じ文) */
const STORE_SUBSCRIPTION_MANAGE_BUTTON_LABEL = "定期購読の管理を開く";
/** この端末のストア (Android は Google Play、それ以外 (iOS) は App Store)。購読の管理のページの行き先を選ぶ */
const DEVICE_PURCHASE_STORE: PurchaseStore = Platform.OS === "android" ? "play_store" : "app_store";

export default function AccountSettingsPage() {
  const { clearSession } = useAuth();
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
      Alert.alert("アカウント削除", ACCOUNT_DELETE_CONFIRM_MESSAGE, [
        { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
        {
          text: STORE_SUBSCRIPTION_MANAGE_BUTTON_LABEL,
          // 購読の管理を開き、退会はしない (解約してから、もう一度「アカウント削除」を押す)。開けなかったときも退会しない
          onPress: () => {
            Linking.openURL(STORE_SUBSCRIPTION_MANAGEMENT_URL[DEVICE_PURCHASE_STORE]).catch(() => undefined);
            resolve(false);
          },
        },
        { text: "削除", style: "destructive", onPress: () => resolve(true) },
      ]);
    });
    if (!ok) {
      deletingRef.current = false;
      setDeleting(false);
      return;
    }

    // 削除前にユーザー ID を控える。削除のあとは getUser() がセッションの失効で失敗し得るため、
    // ユーザー別のローカルデータの掃除には、ここで控えた ID を使う。
    const { data: { user } } = await supabase.auth.getUser();

    // サーバーでの削除が成功したときだけ、端末のセッションとデータを消す。
    // 削除に失敗したらログインしたままにして、もう一度試せるようにする (以前は削除の前に端末のデータを消していたため、
    // 削除に失敗するとログインしたままデータだけが消えていた)。
    try {
      const api = getApi();
      await api.post("/api/account/delete", { confirm: true });
    } catch (e: unknown) {
      // 生の例外の文 (`HTTP 409 Conflict: {...}` など) は出さない。409 は譲渡や解散が先だというサーバーの案内を出す (#1447)
      const failure = accountDeletionErrorOf(e);
      if (failure.kind === "unauthorized") {
        // ログインが切れている (401。#1562)。汎用の「削除に失敗しました」ではなく、もう一度ログインするよう伝え、
        // 端末のセッションを消して入口 (ログインの画面) へ戻す (Web の設定画面がログインの画面へ移すのと揃える)。
        // アカウントは消えていないので、退会の後片付け (signOutAfterAccountDeletion) ではなく通常のログアウトを使う
        Alert.alert(ACCOUNT_DELETE_UNAUTHORIZED_TITLE, failure.message);
        await signOutOnDevice(user?.id ?? null, { clearSession });
        deletingRef.current = false;
        setDeleting(false);
        router.replace("/");
        return;
      }
      if (failure.kind === "blocked") {
        // 組織のオーナー・家族の代表者 (409)。譲渡か解散ができるメンバーシップ設定 (Web) を開けるようにする
        // (#1917。docs/design/family/11-self-dissolve.md §15.5)
        Alert.alert(ACCOUNT_DELETE_BLOCKED_TITLE, failure.message, [
          { text: ACCOUNT_DELETE_BLOCKED_CLOSE, style: "cancel" },
          { text: ACCOUNT_DELETE_BLOCKED_OPEN_MEMBERSHIP, onPress: () => router.push(MEMBERSHIP_SETTINGS_SCREEN_ROUTE) },
        ]);
      } else {
        Alert.alert(ACCOUNT_DELETE_FAILED_TITLE, failure.message);
      }
      deletingRef.current = false;
      setDeleting(false);
      return;
    }

    // ここから先は、サーバーでの削除は済んでいる。もう一度試しても削除の API は失敗するだけなので、
    // 端末の後片付けに失敗しても、削除の失敗とは別の文で知らせて、ログイン画面へ進める。
    // access token が失効していて更新もできないとき (とサインアウトが例外を投げたとき) は SIGNED_OUT が届かず、
    // AuthProvider がセッションを持ったままになる (access token が有効なうちの失敗では、supabase-js が保管庫を消して SIGNED_OUT を出す)。
    // そのまま "/" へ移ると、入口 (app/index.tsx) がホームへ戻してしまうので、signOutAfterAccountDeletion が
    // 保管庫のセッションを端末だけで消し、clearSession で画面の状態も消す (設定画面のログアウトと同じ共通処理。signOut.ts)。
    const { error } = await signOutAfterAccountDeletion(user?.id ?? null, { clearSession });
    if (error) {
      console.error("[account delete] sign out failed after server delete succeeded", error);
      Alert.alert("アカウントを削除しました", ACCOUNT_DELETED_SIGN_OUT_FAILED_MESSAGE);
    }
    router.replace("/");
  }

  return (
    <View testID="account-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="アカウント" />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      {/* #1187: ログイン情報・パスワードの変更・メールアドレスの変更 (Web の設定 → アカウントと同じ構成) */}
      <AccountCredentialsSection />

      {/* #1812: 個人情報の開示・訂正・利用停止・消去の請求。Web の請求の画面 (DSR_SETTINGS_PATH) を WebView で開く画面
          (app/settings/data-requests.tsx) へ移る。見出しと説明の文は Web の設定の項目と同じ (@homegohan/shared。
          設計 docs/design/cross/15-data-subject-requests.md §9・§19) */}
      <Card style={{ gap: spacing.sm }}>
        <SectionHeader title="データとプライバシー" />
        <Pressable
          testID="account-data-requests-row"
          accessibilityRole="button"
          accessibilityLabel={DSR_SETTINGS_ENTRY_TITLE}
          onPress={() => router.push(DSR_SCREEN_ROUTE)}
          style={styles.linkRow}
        >
          <View style={styles.linkTexts}>
            <Text style={[typography.bodyBold, styles.linkTitle]}>{DSR_SETTINGS_ENTRY_TITLE}</Text>
            <Text style={[typography.small, styles.linkDescription]}>{DSR_SETTINGS_ENTRY_DESCRIPTION}</Text>
          </View>
          <Ionicons name="chevron-forward" size={DATA_REQUESTS_CHEVRON_SIZE} color={colors.textMuted} />
        </Pressable>
      </Card>

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
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  linkTexts: {
    flex: 1,
    gap: spacing.xs,
  },
  linkTitle: {
    color: colors.text,
  },
  linkDescription: {
    color: colors.textLight,
  },
});
