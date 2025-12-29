import * as Linking from "expo-linking";
import { Link, router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Text, TextInput, View } from "react-native";

import { extractSupabaseLinkParams } from "../../../src/lib/deeplink";
import { supabase } from "../../../src/lib/supabase";

export default function ResetPasswordPage() {
  const url = Linking.useURL();
  const params = useMemo(() => (url ? extractSupabaseLinkParams(url) : null), [url]);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
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
    <View style={{ flex: 1, padding: 20, justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "700" }}>パスワード再設定</Text>
      <Text style={{ color: "#666" }}>
        メールのリンクから開いた場合、ここで新しいパスワードを設定できます。
      </Text>

      {isSettingSession ? (
        <Text style={{ color: "#666" }}>セッション確認中...</Text>
      ) : !sessionReady ? (
        <Text style={{ color: "#c00" }}>
          セッションが確認できません。メールの再設定リンクから開き直してください。
        </Text>
      ) : null}

      <TextInput
        placeholder="新しいパスワード（8文字以上）"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 8 }}
      />
      <TextInput
        placeholder="確認用パスワード"
        secureTextEntry
        value={confirm}
        onChangeText={setConfirm}
        style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 8 }}
      />

      <Button
        title={isSubmitting ? "更新中..." : "更新"}
        onPress={onSubmit}
        disabled={isSubmitting || isSettingSession}
      />

      <View style={{ marginTop: 12 }}>
        <Link href="/login">ログインへ戻る</Link>
      </View>
    </View>
  );
}



