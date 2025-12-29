import { Link, router } from "expo-router";
import * as Linking from "expo-linking";
import { useState } from "react";
import { Alert, Button, Text, TextInput, View } from "react-native";

import { supabase } from "../../src/lib/supabase";

export default function SignupScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      Alert.alert("入力エラー", "メールアドレスとパスワードを入力してください。");
      return;
    }
    if (password.length < 8) {
      Alert.alert("入力エラー", "パスワードは8文字以上にしてください。");
      return;
    }

    setIsSubmitting(true);
    try {
      const emailRedirectTo = Linking.createURL("/auth/verify");
      const { error } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          emailRedirectTo,
        },
      });
      if (error) throw error;
      Alert.alert("確認してください", "確認メールを送信しました。メール内のリンクから認証してください。");
      router.replace("/(auth)/login");
    } catch (e: any) {
      Alert.alert("登録失敗", e?.message ?? "登録に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <View style={{ flex: 1, padding: 20, justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "700" }}>新規登録</Text>

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
        placeholder="パスワード（8文字以上）"
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

      <Button title={isSubmitting ? "送信中..." : "登録"} onPress={onSubmit} disabled={isSubmitting} />

      <View style={{ marginTop: 12 }}>
        <Link href="/(auth)/login">ログインへ戻る</Link>
      </View>
    </View>
  );
}


