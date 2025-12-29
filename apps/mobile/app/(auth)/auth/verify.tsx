import * as Linking from "expo-linking";
import { Link, Redirect, router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Text, View } from "react-native";

import { extractSupabaseLinkParams } from "../../../src/lib/deeplink";
import { supabase } from "../../../src/lib/supabase";

export default function VerifyPage() {
  const url = Linking.useURL();
  const params = useMemo(() => (url ? extractSupabaseLinkParams(url) : null), [url]);
  const [isProcessing, setIsProcessing] = useState(true);
  const [isDone, setIsDone] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setIsProcessing(true);

      try {
        if (params?.error) {
          Alert.alert("エラー", params.error_description ?? params.error);
          return;
        }

        // code or token が付いている場合はセッション確立を試みる
        if (params?.code) {
          const { error } = await supabase.auth.exchangeCodeForSession(params.code);
          if (error) throw error;
        } else if (params?.access_token && params?.refresh_token) {
          const { error } = await supabase.auth.setSession({
            access_token: params.access_token,
            refresh_token: params.refresh_token,
          });
          if (error) throw error;
        }
      } catch (e: any) {
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
  }, [params?.code, params?.access_token, params?.refresh_token, params?.error, params?.error_description]);

  // すでにログインできている場合はホームへ
  const [hasSession, setHasSession] = useState(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setHasSession(!!data.session));
  }, [isDone]);

  if (hasSession) return <Redirect href="/(tabs)/home" />;

  return (
    <View style={{ flex: 1, padding: 20, justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "700" }}>メール確認</Text>
      {isProcessing ? (
        <Text style={{ color: "#666" }}>確認中...</Text>
      ) : (
        <>
          <Text style={{ color: "#666" }}>
            {isDone ? "確認が完了しました。ログインしてください。" : "確認できませんでした。"}
          </Text>
          <Button title="ログインへ" onPress={() => router.replace("/login")} />
          <Link href="/login">ログインへ移動</Link>
        </>
      )}
    </View>
  );
}


