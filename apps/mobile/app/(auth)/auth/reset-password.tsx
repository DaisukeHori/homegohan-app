import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { Link, router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { colors, spacing, radius, shadows } from "../../../src/theme";
import { extractSupabaseLinkParams } from "../../../src/lib/deeplink";
import { supabase } from "../../../src/lib/supabase";

export default function ResetPasswordPage() {
  const url = Linking.useURL();
  const params = useMemo(() => (url ? extractSupabaseLinkParams(url) : null), [url]);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSettingSession, setIsSettingSession] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // すでにセッションがあればそのまま
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session) {
        setSessionReady(true);
        return;
      }

      if (!params) return;
      if (params.error) {
        Alert.alert("エラー", params.error_description ?? params.error);
        return;
      }

      setIsSettingSession(true);
      try {
        if (params.code) {
          const { error } = await supabase.auth.exchangeCodeForSession(params.code);
          if (error) throw error;
        } else if (params.access_token && params.refresh_token) {
          const { error } = await supabase.auth.setSession({
            access_token: params.access_token,
            refresh_token: params.refresh_token,
          });
          if (error) throw error;
        }

        const { data: after } = await supabase.auth.getSession();
        if (!cancelled) setSessionReady(!!after.session);
      } catch (e: any) {
        Alert.alert("セッションエラー", e?.message ?? "セッションの確立に失敗しました。");
      } finally {
        if (!cancelled) setIsSettingSession(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [params?.access_token, params?.refresh_token, params?.code]);

  async function onSubmit() {
    if (!password || !confirm) {
      Alert.alert("入力エラー", "新しいパスワードを入力してください。");
      return;
    }
    if (password.length < 8) {
      Alert.alert("入力エラー", "パスワードは8文字以上にしてください。");
      return;
    }
    if (password !== confirm) {
      Alert.alert("入力エラー", "パスワードが一致しません。");
      return;
    }
    if (!sessionReady) {
      Alert.alert("確認", "再設定リンクからこの画面を開いてください。");
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      Alert.alert("完了", "パスワードを更新しました。ログインし直してください。");
      await supabase.auth.signOut();
      router.replace("/login");
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
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
            <Ionicons name="shield-checkmark-outline" size={32} color="#fff" />
          </View>
          <Text style={{ fontSize: 28, fontWeight: "900", color: colors.text }}>パスワード再設定</Text>
          <Text style={{ fontSize: 14, color: colors.textMuted, marginTop: 4, textAlign: "center" }}>
            メールのリンクから開いた場合、ここで新しいパスワードを設定できます。
          </Text>
        </View>

        {/* ステータスメッセージ */}
        {isSettingSession ? (
          <View style={{
            backgroundColor: colors.blueLight, borderRadius: radius.lg,
            padding: spacing.md, marginBottom: spacing.md,
            flexDirection: "row", alignItems: "center", gap: spacing.sm,
          }}>
            <Ionicons name="hourglass-outline" size={18} color={colors.blue} />
            <Text style={{ fontSize: 14, color: colors.blue, flex: 1 }}>セッション確認中...</Text>
          </View>
        ) : !sessionReady ? (
          <View style={{
            backgroundColor: colors.errorLight, borderRadius: radius.lg,
            padding: spacing.md, marginBottom: spacing.md,
            flexDirection: "row", alignItems: "center", gap: spacing.sm,
          }}>
            <Ionicons name="warning-outline" size={18} color={colors.error} />
            <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>
              セッションが確認できません。メールの再設定リンクから開き直してください。
            </Text>
          </View>
        ) : null}

        {/* フォーム */}
        <View style={{ gap: spacing.md }}>
          <View>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight, marginBottom: 6 }}>
              新しいパスワード
            </Text>
            <View style={{
              flexDirection: "row", alignItems: "center",
              backgroundColor: colors.card, borderRadius: radius.lg,
              borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md,
            }}>
              <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} />
              <TextInput
                placeholder="8文字以上"
                placeholderTextColor={colors.textMuted}
                secureTextEntry={!showPassword}
                value={password}
                onChangeText={setPassword}
                style={{
                  flex: 1, paddingVertical: 14, paddingHorizontal: spacing.sm,
                  fontSize: 15, color: colors.text,
                }}
              />
              <Pressable onPress={() => setShowPassword(!showPassword)} hitSlop={8}>
                <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          </View>

          <View>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight, marginBottom: 6 }}>
              確認用パスワード
            </Text>
            <View style={{
              flexDirection: "row", alignItems: "center",
              backgroundColor: colors.card, borderRadius: radius.lg,
              borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md,
            }}>
              <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} />
              <TextInput
                placeholder="もう一度入力"
                placeholderTextColor={colors.textMuted}
                secureTextEntry={!showConfirm}
                value={confirm}
                onChangeText={setConfirm}
                style={{
                  flex: 1, paddingVertical: 14, paddingHorizontal: spacing.sm,
                  fontSize: 15, color: colors.text,
                }}
              />
              <Pressable onPress={() => setShowConfirm(!showConfirm)} hitSlop={8}>
                <Ionicons name={showConfirm ? "eye-off-outline" : "eye-outline"} size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          </View>

          {/* 更新ボタン */}
          <Pressable
            onPress={onSubmit}
            disabled={isSubmitting || isSettingSession}
            style={({ pressed }) => ({
              backgroundColor: (isSubmitting || isSettingSession) ? colors.textMuted : colors.accent,
              borderRadius: radius.lg, paddingVertical: 16,
              alignItems: "center", ...shadows.md,
              opacity: pressed ? 0.9 : 1,
            })}
          >
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "800" }}>
              {isSubmitting ? "更新中..." : "パスワードを更新"}
            </Text>
          </Pressable>
        </View>

        {/* ログインへ戻る */}
        <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 24, gap: 4 }}>
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
