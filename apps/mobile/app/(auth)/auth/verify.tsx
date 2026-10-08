import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { Redirect, router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";

import { colors, spacing, radius, shadows } from "../../../src/theme";
import { completeAuthLink } from "../../../src/lib/authLink";
import { extractSupabaseLinkParams } from "../../../src/lib/deeplink";
import { supabase } from "../../../src/lib/supabase";

export default function VerifyPage() {
  const eventUrl = Linking.useURL();
  // 起動時に開かれたリンク。undefined = まだ取得できていない (null = リンクなしで開かれた)。
  // useURL() は取得前も「リンクなし」も null を返すので、区別するために自分でも取得する
  const [initialUrl, setInitialUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    Linking.getInitialURL()
      .then((u) => alive && setInitialUrl(u ?? null))
      .catch(() => alive && setInitialUrl(null));
    return () => {
      alive = false;
    };
  }, []);

  const url = eventUrl ?? initialUrl ?? null;
  // リンクの取得が済むまでは「リンクが無い」とは判断しない (エラー表示がちらつくのを防ぐ)
  const linkResolved = eventUrl != null || initialUrl !== undefined;
  const params = useMemo(() => (url ? extractSupabaseLinkParams(url) : null), [url]);
  const [isProcessing, setIsProcessing] = useState(true);
  const [isDone, setIsDone] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!linkResolved) return;
    let cancelled = false;

    async function run() {
      setIsProcessing(true);
      setIsDone(false);
      setHasError(false);

      // 3 種類の Supabase auth リンク形式 (code / token_hash+type / access_token+refresh_token) を処理する
      const outcome = await completeAuthLink(params);
      if (cancelled) return;

      if (outcome.status === "link_error") {
        // リンクがエラーを運んできた (期限切れ・拒否など)
        setHasError(true);
        Alert.alert("エラー", outcome.message);
      } else if (outcome.status === "failed") {
        setHasError(true);
        Alert.alert("確認失敗", outcome.message);
      } else if (outcome.status === "empty") {
        // 処理できる情報が無い (リンクを経由せずに開いた・壊れたリンク)。
        // 以前はここでも完了扱いにして「確認が完了しました」と誤表示していた (#1038 F7-08)
        setHasError(true);
      }
      setIsDone(true);
      setIsProcessing(false);
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [linkResolved, params?.code, params?.token_hash, params?.type, params?.access_token, params?.refresh_token, params?.error, params?.error_description]);

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
