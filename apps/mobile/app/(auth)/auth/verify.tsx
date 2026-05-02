import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { Redirect, router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";

import { colors, spacing, radius, shadows } from "../../../src/theme";
import { extractSupabaseLinkParams } from "../../../src/lib/deeplink";
import { supabase } from "../../../src/lib/supabase";

export default function VerifyPage() {
  const url = Linking.useURL();
  const params = useMemo(() => (url ? extractSupabaseLinkParams(url) : null), [url]);
  const [isProcessing, setIsProcessing] = useState(true);
  const [isDone, setIsDone] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setIsProcessing(true);

      try {
        if (params?.error) {
          Alert.alert("エラー", params.error_description ?? params.error);
          return;
        }

        // 3 種類の Supabase auth リンク形式に対応:
        //   1. PKCE/OAuth: code パラメータ
        //   2. OTP: token_hash + type パラメータ (#438)
        //   3. Legacy: access_token + refresh_token フラグメント
        if (params?.code) {
          const { error } = await supabase.auth.exchangeCodeForSession(params.code);
          if (error) throw error;
        } else if (params?.token_hash && params?.type) {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: params.token_hash,
            type: params.type as "signup" | "email" | "recovery" | "invite",
          });
          if (error) throw error;
        } else if (params?.access_token && params?.refresh_token) {
          const { error } = await supabase.auth.setSession({
            access_token: params.access_token,
            refresh_token: params.refresh_token,
          });
          if (error) throw error;
        }
      } catch (e: any) {
        if (!cancelled) setHasError(true);
        Alert.alert("確認失敗", e?.message ?? "確認に失敗しました。");
      } finally {
        if (!cancelled) {
          setIsDone(true);
          setIsProcessing(false);
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [params?.code, params?.token_hash, params?.type, params?.access_token, params?.refresh_token, params?.error, params?.error_description]);

  // 認証成功後のみホームへリダイレクト
  const [hasSession, setHasSession] = useState(false);
  useEffect(() => {
    if (isDone && !hasError) {
      supabase.auth.getSession().then(({ data }) => setHasSession(!!data.session));
    }
  }, [isDone, hasError]);

  if (hasSession && isDone && !hasError) return <Redirect href="/(tabs)/home" />;

  return (
    <View testID="verify-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* 戻るボタン */}
      <Pressable
        onPress={() => router.back()}
        style={{ position: "absolute", top: 56, left: spacing.lg, zIndex: 10 }}
        hitSlop={12}
      >
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>

      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.xl }}>
        {/* ヘッダー */}
        <View style={{ alignItems: "center", marginBottom: 32 }}>
          <View style={{
            width: 64, height: 64, borderRadius: 20,
            backgroundColor: isProcessing ? colors.blue : isDone ? colors.success : colors.accent,
            alignItems: "center", justifyContent: "center",
            marginBottom: spacing.md, ...shadows.md,
          }}>
            <Ionicons
              name={isProcessing ? "mail-outline" : isDone ? "checkmark-circle-outline" : "close-circle-outline"}
              size={32}
              color="#fff"
            />
          </View>
          <Text style={{ fontSize: 28, fontWeight: "900", color: colors.text }}>メール確認</Text>
        </View>

        {isProcessing ? (
          <View style={{
            backgroundColor: colors.card, borderRadius: radius.lg,
            padding: spacing.xl, alignItems: "center", gap: spacing.md,
            borderWidth: 1, borderColor: colors.border, ...shadows.sm,
            width: "100%",
          }}>
            <ActivityIndicator testID="verify-loading" size="large" color={colors.accent} />
            <Text style={{ fontSize: 15, color: colors.textMuted }}>確認中...</Text>
          </View>
        ) : (
          <View style={{
            backgroundColor: colors.card, borderRadius: radius.lg,
            padding: spacing.xl, alignItems: "center", gap: spacing.lg,
            borderWidth: 1, borderColor: colors.border, ...shadows.sm,
            width: "100%",
          }}>
            {isDone && !hasError ? (
              <View style={{
                backgroundColor: colors.successLight, borderRadius: radius.lg,
                padding: spacing.md, flexDirection: "row", alignItems: "center",
                gap: spacing.sm, width: "100%",
              }}>
                <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                <Text style={{ fontSize: 14, color: colors.success, flex: 1 }}>
                  確認が完了しました。ログインしてください。
                </Text>
              </View>
            ) : (
              <View
                testID="verify-error-text"
                style={{
                  backgroundColor: colors.errorLight, borderRadius: radius.lg,
                  padding: spacing.md, flexDirection: "row", alignItems: "center",
                  gap: spacing.sm, width: "100%",
                }}
              >
                <Ionicons name="warning-outline" size={20} color={colors.error} />
                <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>
                  確認できませんでした。
                </Text>
              </View>
            )}

            {/* ログインボタン */}
            <Pressable
              onPress={() => router.replace("/login")}
              style={({ pressed }) => ({
                backgroundColor: colors.accent,
                borderRadius: radius.lg, paddingVertical: 16,
                alignItems: "center", ...shadows.md,
                opacity: pressed ? 0.9 : 1,
                width: "100%",
              })}
            >
              <Text style={{ color: "#fff", fontSize: 16, fontWeight: "800" }}>ログインへ</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}
