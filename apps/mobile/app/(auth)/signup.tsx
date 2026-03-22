import { Ionicons } from "@expo/vector-icons";
import { Link, router } from "expo-router";
import * as Linking from "expo-linking";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { colors, spacing, radius, shadows } from "../../src/theme";
import { supabase } from "../../src/lib/supabase";

export default function SignupScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
        options: { emailRedirectTo },
      });
      if (error) throw error;
      Alert.alert("確認してください", "確認メールを送信しました。メール内のリンクから認証してください。", [
        { text: "OK", onPress: () => router.replace("/(auth)/login") },
      ]);
    } catch (e: any) {
      Alert.alert("登録失敗", e?.message ?? "登録に失敗しました。");
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

        {/* ロゴ */}
        <View style={{ alignItems: "center", marginBottom: 32 }}>
          <View style={{
            width: 64, height: 64, borderRadius: 20,
            backgroundColor: colors.accent, alignItems: "center", justifyContent: "center",
            marginBottom: spacing.md, ...shadows.md,
          }}>
            <Ionicons name="person-add" size={32} color="#fff" />
          </View>
          <Text style={{ fontSize: 28, fontWeight: "900", color: colors.text }}>新規登録</Text>
          <Text style={{ fontSize: 14, color: colors.textMuted, marginTop: 4 }}>はじめまして！</Text>
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
            <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
              8文字以上で設定してください
            </Text>
          </View>

          {/* 登録ボタン */}
          <Pressable
            onPress={onSubmit}
            disabled={isSubmitting}
            style={({ pressed }) => ({
              backgroundColor: isSubmitting ? colors.textMuted : colors.accent,
              borderRadius: radius.lg, paddingVertical: 16,
              alignItems: "center", ...shadows.md,
              opacity: pressed ? 0.9 : 1, marginTop: spacing.sm,
            })}
          >
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "800" }}>
              {isSubmitting ? "登録中..." : "アカウント作成"}
            </Text>
          </Pressable>
        </View>

        {/* ログインリンク */}
        <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 24, gap: 4 }}>
          <Text style={{ fontSize: 14, color: colors.textMuted }}>アカウントをお持ちの方は</Text>
          <Link href="/(auth)/login" asChild>
            <Pressable>
              <Text style={{ fontSize: 14, color: colors.accent, fontWeight: "700" }}>ログイン</Text>
            </Pressable>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
