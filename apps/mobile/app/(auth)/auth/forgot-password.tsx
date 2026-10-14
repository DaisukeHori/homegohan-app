import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { Link, router } from "expo-router";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { colors, spacing, radius, shadows } from "../../../src/theme";
import { supabase } from "../../../src/lib/supabase";
import { TurnstileWidget, useTurnstile } from "../../../src/components/auth/TurnstileWidget";
import { CAPTCHA_FAILED_MESSAGE, isCaptchaFailure } from "../../../src/lib/turnstile";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  // #1165: bot 対策 (Cloudflare Turnstile)。サイトキーが未設定なら無効で、今までどおりに動く
  const captcha = useTurnstile();

  async function onSubmit() {
    const trimmed = email.trim();
    if (!trimmed) {
      Alert.alert("入力エラー", "メールアドレスを入力してください。");
      return;
    }

    // #1165: トークンは 1 回しか使えない。取り出した時点で、ウィジェットが次のトークンを取り直す
    // (入力の検証で弾いた場合は取り出さないよう、検証の後で呼ぶ)。Turnstile が有効なのにトークンが無いときは送らない
    const captchaToken = captcha.takeToken();
    if (captcha.enabled && !captchaToken) {
      Alert.alert("しばらくお待ちください", "ボットではないことの確認が終わるまで、少しお待ちください。");
      return;
    }

    setIsSubmitting(true);
    try {
      const redirectTo = Linking.createURL("/auth/reset-password");
      // resetPasswordForEmail は他の認証 API と違い、captchaToken を options の中ではなく、
      // 第 2 引数の直下 (redirectTo と同じ階層) に渡す。options に入れても Supabase には届かない。
      // Turnstile が無効のときは captchaToken を付けない (今までのリクエストと同じ)
      const { error } = await supabase.auth.resetPasswordForEmail(trimmed, {
        redirectTo,
        ...(captchaToken ? { captchaToken } : {}),
      });
      if (error) throw error;
      const successMsg = "パスワード再設定用のメールを送信しました。";
      setSuccessMessage(successMsg);
      Alert.alert("送信しました", successMsg);
    } catch (e: any) {
      // #1165: 英語の生のエラー文は出さない (ウィジェットは取り直し済み)
      Alert.alert("送信失敗", isCaptchaFailure(e) ? CAPTCHA_FAILED_MESSAGE : (e?.message ?? "送信に失敗しました。"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      testID="forgot-screen"
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: spacing.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {/* 戻るボタン */}
        <Pressable
          onPress={() => router.back()}
          style={{ position: "absolute", top: 56, left: spacing.lg }}
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>

        {/* ヘッダー */}
        <View style={{ alignItems: "center", marginBottom: 32 }}>
          <View style={{
            width: 64, height: 64, borderRadius: 20,
            backgroundColor: colors.accent, alignItems: "center", justifyContent: "center",
            marginBottom: spacing.md, ...shadows.md,
          }}>
            <Ionicons name="key-outline" size={32} color="#fff" />
          </View>
          <Text style={{ fontSize: 28, fontWeight: "900", color: colors.text }}>パスワードを忘れた</Text>
          <Text style={{ fontSize: 14, color: colors.textMuted, marginTop: 4, textAlign: "center" }}>
            登録したメールアドレスへ、パスワード再設定リンクを送信します。
          </Text>
        </View>

        {/* フォーム */}
        <View style={{ gap: spacing.md }}>
          <View>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight, marginBottom: 6 }}>
              メールアドレス
            </Text>
            <View style={{
              flexDirection: "row", alignItems: "center",
              backgroundColor: colors.card, borderRadius: radius.lg,
              borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md,
            }}>
              <Ionicons name="mail-outline" size={18} color={colors.textMuted} />
              <TextInput
                testID="forgot-email-input"
                placeholder="email@example.com"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                value={email}
                onChangeText={setEmail}
                style={{
                  flex: 1, paddingVertical: 14, paddingHorizontal: spacing.sm,
                  fontSize: 15, color: colors.text,
                }}
              />
            </View>
          </View>

          {/* 送信成功メッセージ */}
          {successMessage !== null && (
            <Text
              testID="forgot-success-text"
              style={{ fontSize: 14, color: colors.success, textAlign: "center" }}
            >
              {successMessage}
            </Text>
          )}

          {/* bot 対策 (Turnstile)。サイトキーが未設定なら何も出ない */}
          <TurnstileWidget {...captcha.widgetProps} action="password-reset" />

          {/* 送信ボタン */}
          <Pressable
            testID="forgot-submit-button"
            onPress={onSubmit}
            disabled={isSubmitting || !captcha.ready}
            style={({ pressed }) => ({
              backgroundColor: isSubmitting || !captcha.ready ? colors.textMuted : colors.accent,
              borderRadius: radius.lg, paddingVertical: 16,
              alignItems: "center", ...shadows.md,
              opacity: pressed ? 0.9 : 1,
            })}
          >
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "800" }}>
              {isSubmitting ? "送信中..." : "送信"}
            </Text>
          </Pressable>
        </View>

        {/* ログインへ戻る */}
        <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 24, gap: 4 }}>
          <Text style={{ fontSize: 14, color: colors.textMuted }}>思い出しましたか？</Text>
          <Link href="/login" asChild>
            <Pressable>
              <Text style={{ fontSize: 14, color: colors.accent, fontWeight: "700" }}>ログインへ戻る</Text>
            </Pressable>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
