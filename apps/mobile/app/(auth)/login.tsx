import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { Link, router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { useState, useEffect } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { colors, spacing, radius, shadows } from "../../src/theme";
import { supabase } from "../../src/lib/supabase";

// #532: client-side rate limit 定数
const RATE_LIMIT_KEY = "auth_last_fail_ts";
const RATE_LIMIT_WINDOW_MS = 30_000; // 30秒

function GoogleIcon() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <Path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <Path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <Path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </Svg>
  );
}

export default function LoginScreen() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // #532: rate limit 残り秒数 (0 = 制限なし)
  const [rateLimitRemaining, setRateLimitRemaining] = useState(0);

  // #532: アプリ起動時に AsyncStorage から残り制限時間を復元
  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(RATE_LIMIT_KEY);
        if (stored) {
          const lastFailTs = parseInt(stored, 10);
          const elapsed = Date.now() - lastFailTs;
          if (elapsed < RATE_LIMIT_WINDOW_MS) {
            const remaining = Math.ceil((RATE_LIMIT_WINDOW_MS - elapsed) / 1000);
            setRateLimitRemaining(remaining);
          }
        }
      } catch {
        // AsyncStorage 読み取り失敗は無視
      }
    })();
  }, []);

  // #532: カウントダウンタイマー
  useEffect(() => {
    if (rateLimitRemaining <= 0) return;
    const timer = setTimeout(() => {
      setRateLimitRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [rateLimitRemaining]);

  async function onGoogleLogin() {
    setIsSubmitting(true);
    try {
      const redirectTo = Linking.createURL("/auth/verify");
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });
      if (error) throw error;
      if (!data?.url) throw new Error("OAuth URL が取得できませんでした。");

      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type === "success" && result.url) {
        // verify ページがディープリンクを処理するためルーティング
        router.replace("/auth/verify");
      }
    } catch (e: any) {
      Alert.alert("Googleログイン失敗", e?.message ?? "Googleログインに失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onSubmit() {
    setErrorMessage(null);
    // #532: rate limit チェック
    if (rateLimitRemaining > 0) {
      Alert.alert("しばらくお待ちください", `再試行まであと ${rateLimitRemaining} 秒お待ちください。`);
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !password) {
      Alert.alert("入力エラー", "メールアドレスとパスワードを入力してください。");
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });

      if (error) {
        // #532: ログイン失敗時に AsyncStorage へタイムスタンプを保存
        try {
          await AsyncStorage.setItem(RATE_LIMIT_KEY, String(Date.now()));
        } catch {
          // 保存失敗は無視
        }
        setRateLimitRemaining(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));

        // エラーメッセージをステータス別に分岐
        if (
          error.status === 429 ||
          error.message.includes("over_email_send_rate_limit") ||
          error.message.includes("For security purposes") ||
          error.message.includes("too many requests")
        ) {
          const msg = "しばらくしてから再度お試しください。";
          setErrorMessage(msg);
          Alert.alert("ログイン失敗", msg);
        } else if (
          error.message.includes("Invalid login credentials") ||
          error.message.includes("Invalid email or password")
        ) {
          const msg = "メールアドレスまたはパスワードが正しくありません。";
          setErrorMessage(msg);
          Alert.alert("ログイン失敗", msg);
        } else {
          const msg = "ログインに失敗しました。入力内容をご確認ください。";
          setErrorMessage(msg);
          Alert.alert("ログイン失敗", msg);
        }
        return;
      }

      // ログイン成功: AsyncStorage の rate limit タイムスタンプを削除
      try {
        await AsyncStorage.removeItem(RATE_LIMIT_KEY);
      } catch {
        // 削除失敗は無視
      }
      setRateLimitRemaining(0);

      // user_profiles から roles / onboarding 状態を取得して振り分け
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('roles, onboarding_started_at, onboarding_completed_at')
          .eq('id', user.id)
          .single();

        const roles: string[] = profile?.roles ?? [];

        // ?next= クエリパラメータがある場合はそのパスへ復帰 (/ 始まりのみ許可)
        const safeNext = typeof next === 'string' && next.startsWith('/') ? next : null;

        if (roles.includes('admin') || roles.includes('super_admin')) {
          router.replace('/admin');
        } else if (safeNext) {
          router.replace(safeNext as any);
        } else if (profile?.onboarding_completed_at) {
          // オンボーディング完了済み → ホームへ
          router.replace('/(tabs)/home');
        } else if (profile?.onboarding_started_at) {
          // オンボーディング進行中 → 再開ページへ
          router.replace('/onboarding/resume');
        } else {
          // 未開始 → 初回ウェルカムへ
          router.replace('/onboarding/welcome');
        }
      }
    } catch (e: any) {
      const msg = e?.message ?? "ログインに失敗しました。";
      setErrorMessage(msg);
      Alert.alert("ログイン失敗", msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      testID="login-screen"
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

        {/* ロゴ */}
        <View style={{ alignItems: "center", marginBottom: 32 }}>
          <View style={{
            width: 64, height: 64, borderRadius: 20,
            backgroundColor: colors.accent, alignItems: "center", justifyContent: "center",
            marginBottom: spacing.md, ...shadows.md,
          }}>
            <Ionicons name="restaurant" size={32} color="#fff" />
          </View>
          <Text style={{ fontSize: 28, fontWeight: "900", color: colors.text }}>ログイン</Text>
          <Text style={{ fontSize: 14, color: colors.textMuted, marginTop: 4 }}>おかえりなさい！</Text>
        </View>

        {/* レート制限バナー */}
        {rateLimitRemaining > 0 && (
          <View
            testID="login-rate-limit-banner"
            style={{
              backgroundColor: colors.errorLight, borderRadius: radius.lg,
              padding: spacing.md, marginBottom: spacing.md,
              flexDirection: "row", alignItems: "center", gap: spacing.sm,
            }}
          >
            <Ionicons name="time-outline" size={18} color={colors.error} />
            <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>
              再試行まであと {rateLimitRemaining} 秒お待ちください。
            </Text>
          </View>
        )}

        {/* エラーバナー */}
        {errorMessage !== null && (
          <View
            testID="login-error-banner"
            style={{
              backgroundColor: colors.errorLight, borderRadius: radius.lg,
              padding: spacing.md, marginBottom: spacing.md,
              flexDirection: "row", alignItems: "center", gap: spacing.sm,
            }}
          >
            <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
            <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{errorMessage}</Text>
          </View>
        )}

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
                testID="email-input"
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

          <View>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight, marginBottom: 6 }}>
              パスワード
            </Text>
            <View style={{
              flexDirection: "row", alignItems: "center",
              backgroundColor: colors.card, borderRadius: radius.lg,
              borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md,
            }}>
              <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} />
              <TextInput
                testID="password-input"
                placeholder="パスワード"
                placeholderTextColor={colors.textMuted}
                secureTextEntry={!showPassword}
                value={password}
                onChangeText={setPassword}
                style={{
                  flex: 1, paddingVertical: 14, paddingHorizontal: spacing.sm,
                  fontSize: 15, color: colors.text,
                }}
              />
              <Pressable testID="login-show-password-button" onPress={() => setShowPassword(!showPassword)} hitSlop={8}>
                <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          </View>

          {/* パスワード忘れた */}
          <View style={{ alignItems: "flex-end" }}>
            <Link href="/auth/forgot-password" asChild>
              <Pressable testID="login-forgot-password-link">
                <Text style={{ fontSize: 13, color: colors.accent, fontWeight: "600" }}>パスワードを忘れた？</Text>
              </Pressable>
            </Link>
          </View>

          {/* ログインボタン */}
          <Pressable
            testID="login-button"
            onPress={onSubmit}
            disabled={isSubmitting || rateLimitRemaining > 0}
            style={({ pressed }) => ({
              backgroundColor: isSubmitting || rateLimitRemaining > 0 ? colors.textMuted : colors.accent,
              borderRadius: radius.lg, paddingVertical: 16,
              alignItems: "center", ...shadows.md,
              opacity: pressed ? 0.9 : 1,
            })}
          >
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "800" }}>
              {isSubmitting
                ? "ログイン中..."
                : rateLimitRemaining > 0
                  ? `再試行まで ${rateLimitRemaining} 秒`
                  : "ログイン"}
            </Text>
          </Pressable>

          {/* 区切り線 */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
            <Text style={{ fontSize: 12, color: colors.textMuted }}>または</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
          </View>

          {/* Google ログインボタン */}
          <Pressable
            testID="login-google-button"
            onPress={onGoogleLogin}
            disabled={isSubmitting}
            style={({ pressed }) => ({
              flexDirection: "row", alignItems: "center", justifyContent: "center",
              gap: spacing.sm,
              backgroundColor: colors.card,
              borderRadius: radius.lg, paddingVertical: 14,
              borderWidth: 1, borderColor: colors.border,
              ...shadows.sm,
              opacity: pressed || isSubmitting ? 0.7 : 1,
            })}
          >
            <GoogleIcon />
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>
              Googleでログイン
            </Text>
          </Pressable>
        </View>

        {/* 新規登録リンク */}
        <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 24, gap: 4 }}>
          <Text style={{ fontSize: 14, color: colors.textMuted }}>アカウントをお持ちでない方は</Text>
          <Link href="/signup" asChild>
            <Pressable testID="login-signup-link">
              <Text style={{ fontSize: 14, color: colors.accent, fontWeight: "700" }}>新規登録</Text>
            </Pressable>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
