/**
 * 設定 → アカウント管理 の「パスワードを変更」「メールアドレスを変更」(#1187)。
 *
 * Web の設定画面 (src/app/(main)/settings/account/page.tsx) と同じ構成にしている。
 * - メールアドレスとパスワードでログインしている人だけにフォームを出す。
 * - Google など、メール以外でログインしている人には、案内だけを出す
 *   (パスワードもメールアドレスも外部サービス側で管理されていて、ここで変えても食い違うだけなので)。
 * 変更の処理そのもの (再認証 → 更新 → 他の端末のログアウト / 確認メールの送信) は src/lib/account-credentials.ts。
 */

import { isSessionExpiredAuthError, PASSWORD_HINT_TEXT } from "@homegohan/shared";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { changePassword, requestEmailChange } from "../../lib/account-credentials";
import { getSupportMailtoUrl } from "../../lib/siteConfig";
import { supabase } from "../../lib/supabase";
import { colors, radius, spacing } from "../../theme";
import { Button, Card, Input, SectionHeader } from "../ui";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "signed-out" }
  | { kind: "ready"; email: string; provider: string | null };

function providerLabel(provider: string | null): string {
  if (provider === "google") return "Google";
  if (provider === "apple") return "Apple";
  return "外部サービス";
}

function ErrorText({ message, testID }: { message: string; testID: string }) {
  return (
    <View testID={testID} accessibilityRole="alert" style={[styles.banner, { backgroundColor: colors.errorLight }]}>
      <Text style={[styles.bannerText, { color: colors.dangerText }]}>{message}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// パスワードの変更
// ---------------------------------------------------------------------------
function PasswordChangeCard({ email }: { email: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // state の反映を待たずに効く、連打での二重送信の防止
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // 変更できたとき。othersSignedOut: 他の端末のログアウトまで確認できたか
  const [result, setResult] = useState<{ othersSignedOut: boolean } | null>(null);

  async function onSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const outcome = await changePassword(email, { currentPassword, newPassword, confirmPassword });
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setResult({ othersSignedOut: outcome.othersSignedOut });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Card testID="account-password-section" style={{ gap: spacing.md }}>
      <SectionHeader title="パスワードを変更" />
      <Text style={styles.note}>変更すると、いま使っている端末以外のログインはすべて解除されます。</Text>

      {result ? (
        <View testID="password-change-success" style={[styles.banner, { backgroundColor: colors.successLight }]}>
          <Text style={[styles.bannerTitle, { color: colors.successText }]}>パスワードを変更しました。</Text>
          <Text style={[styles.bannerText, { color: colors.successText }]}>
            {result.othersSignedOut
              ? "セキュリティのため、この端末以外のログインはすべて解除しました。他の端末では、新しいパスワードでログインし直してください。"
              : "ただし、他の端末のログアウトを確認できませんでした。心配な場合は、設定の「ログアウト」でこの端末もログアウトして、新しいパスワードでログインし直してください。"}
          </Text>
        </View>
      ) : null}

      <Input
        testID="account-current-password"
        label="現在のパスワード"
        value={currentPassword}
        onChangeText={setCurrentPassword}
        secureTextEntry={!showPasswords}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="current-password"
        textContentType="password"
      />
      <Input
        testID="account-new-password"
        label="新しいパスワード"
        value={newPassword}
        onChangeText={setNewPassword}
        secureTextEntry={!showPasswords}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <Text style={styles.note}>{PASSWORD_HINT_TEXT}。</Text>
      <Input
        testID="account-confirm-password"
        label="新しいパスワード（確認）"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        secureTextEntry={!showPasswords}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <Pressable
        testID="account-toggle-password-visibility"
        accessibilityRole="button"
        onPress={() => setShowPasswords((v) => !v)}
        hitSlop={8}
      >
        <Text style={styles.link}>{showPasswords ? "パスワードを隠す" : "パスワードを表示する"}</Text>
      </Pressable>

      {error ? <ErrorText testID="password-change-error" message={error} /> : null}

      <Button testID="account-password-submit" onPress={onSubmit} disabled={submitting} size="lg">
        {submitting ? "変更中…" : "パスワードを変更する"}
      </Button>

      <Text style={styles.note}>
        現在のパスワードを思い出せないときは、いったんログアウトして、ログイン画面の「パスワードを忘れた？」からパスワードを再設定してください。
      </Text>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// メールアドレスの変更
// ---------------------------------------------------------------------------
function EmailChangeCard({ currentEmail }: { currentEmail: string }) {
  const [newEmail, setNewEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // 確認メールを送った新しいメールアドレス
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSentTo(null);
    setError(null);
    try {
      const outcome = await requestEmailChange(newEmail, currentEmail);
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      setSentTo(outcome.sentTo);
      setNewEmail("");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Card testID="account-email-section" style={{ gap: spacing.md }}>
      <SectionHeader title="メールアドレスを変更" />
      <Text style={styles.note}>新しいメールアドレスに確認メールを送ります。メールのリンクを開くと変更が完了します。</Text>

      {sentTo ? (
        <View testID="email-change-sent" style={[styles.banner, { backgroundColor: colors.successLight, gap: spacing.xs }]}>
          <Text style={[styles.bannerTitle, { color: colors.successText }]}>確認メールを送りました。</Text>
          <Text style={[styles.bannerText, { color: colors.successText }]}>
            {sentTo} に届いたメールのリンクを開いてください（この端末で開くと、アプリに戻って確認の結果を表示します）。
          </Text>
          <Text style={[styles.bannerText, { color: colors.successText }]}>
            現在のメールアドレス（{currentEmail}）にも確認メールが届いた場合は、そちらのリンクも開いてください。セキュリティのため、両方の確認が必要になります。
          </Text>
          <Text style={[styles.bannerText, { color: colors.successText }]}>
            確認がすべて終わるまで、メールアドレスは変更されません。それまでは、今のメールアドレスでログインできます。変更が完了したら、次回から新しいメールアドレスでログインしてください。
          </Text>
          <Text style={[styles.bannerText, { color: colors.successText }]}>
            メールが届かないときは、迷惑メールフォルダも確認してください。
          </Text>
        </View>
      ) : null}

      <Input
        testID="account-new-email"
        label="新しいメールアドレス"
        value={newEmail}
        onChangeText={setNewEmail}
        placeholder="name@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
      />

      {error ? <ErrorText testID="email-change-error" message={error} /> : null}

      <Button testID="account-email-submit" onPress={onSubmit} disabled={submitting} size="lg">
        {submitting ? "送信中…" : "確認メールを送る"}
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Google など、メール以外でログインしている人への案内 (フォームは出さない)
// ---------------------------------------------------------------------------
function ExternalProviderGuidance({ provider, email }: { provider: string | null; email: string }) {
  const label = providerLabel(provider);
  return (
    <Card testID="account-external-provider-guidance" style={{ gap: spacing.sm }}>
      <SectionHeader title={`${label}アカウントでログインしています`} />
      <Text style={styles.body}>
        このアカウントは{label}のログインで利用しているため、パスワードとメールアドレスはここでは変更できません。
      </Text>
      <Text style={styles.body}>
        ・パスワード: ログインのパスワードは{label}側で管理されています。変更は{label}のアカウント設定で行ってください。
      </Text>
      <Text style={styles.body}>
        ・メールアドレス: ログインに使っているのは、{label}アカウントのメールアドレス{email ? `（${email}）` : ""}です。
      </Text>
      <Pressable accessibilityRole="link" onPress={() => Linking.openURL(getSupportMailtoUrl())} hitSlop={8}>
        <Text style={styles.body}>
          メールアドレスを変えたいなど、ご不明な点は<Text style={styles.link}>お問い合わせ</Text>からご連絡ください。
        </Text>
      </Pressable>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
export function AccountCredentialsSection() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  // 読み込みに失敗したときの「もう一度読み込む」用
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });

    async function run() {
      try {
        // 端末に保存したセッションの値ではなく、サーバーで確かめた今のメールアドレスを使う
        // (別の端末でメールアドレスの変更が済んでいると、保存した値は古いことがある)
        const { data, error } = await supabase.auth.getUser();
        if (cancelled) return;
        if (error) {
          if (isSessionExpiredAuthError(error)) {
            setLoad({ kind: "signed-out" });
            return;
          }
          throw error;
        }
        const user = data.user;
        if (!user) {
          setLoad({ kind: "signed-out" });
          return;
        }
        const provider = user.app_metadata?.provider;
        setLoad({ kind: "ready", email: user.email ?? "", provider: typeof provider === "string" ? provider : null });
      } catch (err) {
        if (cancelled) return;
        console.error("[settings/account] failed to load the user:", err);
        setLoad({ kind: "error" });
      }
    }
    run();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (load.kind === "loading") {
    return (
      <View testID="account-credentials-loading" style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (load.kind === "error") {
    return (
      <Card testID="account-load-error" style={{ gap: spacing.md }}>
        <ErrorText
          testID="account-load-error-text"
          message="ログイン情報を読み込めませんでした。通信の状態を確認して、もう一度お試しください。"
        />
        <Button testID="account-load-retry" variant="secondary" onPress={() => setAttempt((n) => n + 1)}>
          もう一度読み込む
        </Button>
      </Card>
    );
  }

  if (load.kind === "signed-out") {
    return (
      <Card testID="account-signed-out">
        <Text style={styles.body}>
          ログインの有効期限が切れています。設定の「ログアウト」から、いったんログアウトして、ログインし直してください。
        </Text>
      </Card>
    );
  }

  // パスワードとメールアドレスをこの画面で変えられるのは、メールアドレスとパスワードでログインしている人だけ。
  // provider が取れない場合も、フォームは出さない (パスワードを持たない人に「現在のパスワード」を求めないため)
  const canEditCredentials = load.provider === "email" && load.email !== "";

  return (
    <View style={{ gap: spacing.md }}>
      <Card testID="account-info" style={{ gap: spacing.sm }}>
        <SectionHeader title="ログイン情報" />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>メールアドレス</Text>
          <Text testID="account-current-email" style={styles.rowValue}>
            {load.email}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>ログイン方法</Text>
          <Text style={styles.rowValue}>
            {load.provider === "email" ? "メールアドレスとパスワード" : `${providerLabel(load.provider)}アカウント`}
          </Text>
        </View>
      </Card>

      {canEditCredentials ? (
        <>
          <PasswordChangeCard email={load.email} />
          <EmailChangeCard currentEmail={load.email} />
        </>
      ) : (
        <ExternalProviderGuidance provider={load.provider} email={load.email} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    paddingVertical: spacing.xl,
    alignItems: "center",
  },
  note: {
    fontSize: 12,
    color: colors.textLight,
  },
  body: {
    fontSize: 14,
    color: colors.text,
  },
  link: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.accent,
    textDecorationLine: "underline",
  },
  banner: {
    borderRadius: radius.md,
    padding: spacing.md,
  },
  bannerTitle: {
    fontSize: 14,
    fontWeight: "700",
  },
  bannerText: {
    fontSize: 13,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  rowLabel: {
    fontSize: 14,
    color: colors.textLight,
  },
  rowValue: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
    textAlign: "right",
  },
});
