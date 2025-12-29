import { Link, router } from "expo-router";
import { useState } from "react";
import { Alert, Button, Text, TextInput, View } from "react-native";

import { supabase } from "../../src/lib/supabase";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit() {
    const trimmedEmail = email.trim();
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
      if (error) throw error;
      router.replace("/");
    } catch (e: any) {
      Alert.alert("ログイン失敗", e?.message ?? "ログインに失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <View style={{ flex: 1, padding: 20, justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "700" }}>ログイン</Text>

      <TextInput
        placeholder="メールアドレス"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 12,
          borderRadius: 8,
        }}
      />

      <TextInput
        placeholder="パスワード"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 12,
          borderRadius: 8,
        }}
      />

      <Button title={isSubmitting ? "送信中..." : "ログイン"} onPress={onSubmit} disabled={isSubmitting} />

      <View style={{ marginTop: 12, gap: 8 }}>
        <Link href="/auth/forgot-password">パスワードを忘れた</Link>
        <Link href="/signup">新規登録はこちら</Link>
      </View>
    </View>
  );
}


