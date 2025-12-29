import * as Linking from "expo-linking";
import { Link } from "expo-router";
import { useState } from "react";
import { Alert, Button, Text, TextInput, View } from "react-native";

import { supabase } from "../../../src/lib/supabase";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit() {
    const trimmed = email.trim();
    if (!trimmed) {
      Alert.alert("入力エラー", "メールアドレスを入力してください。");
      return;
    }

    setIsSubmitting(true);
    try {
      const redirectTo = Linking.createURL("/auth/reset-password");
      const { error } = await supabase.auth.resetPasswordForEmail(trimmed, { redirectTo });
      if (error) throw error;
      Alert.alert("送信しました", "パスワード再設定用のメールを送信しました。");
    } catch (e: any) {
      Alert.alert("送信失敗", e?.message ?? "送信に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <View style={{ flex: 1, padding: 20, justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "700" }}>パスワードを忘れた</Text>
      <Text style={{ color: "#666" }}>
        登録したメールアドレスへ、パスワード再設定リンクを送信します。
      </Text>

      <TextInput
        placeholder="メールアドレス"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 8 }}
      />

      <Button title={isSubmitting ? "送信中..." : "送信"} onPress={onSubmit} disabled={isSubmitting} />

      <View style={{ marginTop: 12 }}>
        <Link href="/login">ログインへ戻る</Link>
      </View>
    </View>
  );
}



