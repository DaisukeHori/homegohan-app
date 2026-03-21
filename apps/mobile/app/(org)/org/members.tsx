import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatusBadge, LoadingState, EmptyState } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing } from "../../../src/theme";

type Member = {
  id: string;
  nickname: string | null;
  roles: string[] | null;
  department: string | null;
  created_at: string;
};

export default function OrgMembersPage() {
  const router = useRouter();
  const [items, setItems] = useState<Member[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ members: Member[] }>("/api/org/users");
      setItems(res.members ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createUser() {
    const e = email.trim();
    const p = password.trim();
    const n = nickname.trim();
    if (!e || !p || !n || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/org/users", { email: e, password: p, nickname: n });
      setEmail("");
      setPassword("");
      setNickname("");
      Alert.alert("作成しました", "ユーザーを作成しました。");
      await load();
    } catch (err: any) {
      Alert.alert("作成失敗", err?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: spacing["4xl"] }}>
      {/* Header */}
      <View style={{ paddingTop: 56, paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Pressable onPress={() => router.push("/org/dashboard")} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text, flex: 1 }}>メンバー</Text>
        <Pressable onPress={load} hitSlop={8}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: spacing.xl, gap: spacing.lg }}>
        {/* Create Form */}
        <Card>
          <SectionHeader title="ユーザー作成（組織内）" />
          <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
            <Input value={email} onChangeText={setEmail} placeholder="example@email.com" label="メールアドレス" keyboardType="email-address" autoCapitalize="none" />
            <Input value={password} onChangeText={setPassword} placeholder="パスワード" label="パスワード" secureTextEntry />
            <Input value={nickname} onChangeText={setNickname} placeholder="ニックネーム" label="ニックネーム" />
            <Button onPress={createUser} loading={isSubmitting} disabled={isSubmitting}>
              {isSubmitting ? "作成中..." : "作成"}
            </Button>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="information-circle" size={16} color={colors.textMuted} />
              <Text style={{ fontSize: 12, color: colors.textMuted, flex: 1 }}>メール送信は未実装。初期パスワードでログインできます。</Text>
            </View>
          </View>
        </Card>

        {/* List */}
        <SectionHeader title="メンバー一覧" />

        {isLoading ? (
          <LoadingState message="メンバーを読み込み中..." />
        ) : error ? (
          <Card variant="error">
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{error}</Text>
            </View>
          </Card>
        ) : items.length === 0 ? (
          <EmptyState icon={<Ionicons name="people-outline" size={40} color={colors.textMuted} />} message="メンバーがいません。" />
        ) : (
          <View style={{ gap: spacing.md }}>
            {items.map((m) => (
              <Card key={m.id}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                  <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentLight, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name="person" size={22} color={colors.accent} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{m.nickname ?? "(no name)"}</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                      <Ionicons name="shield-checkmark" size={12} color={colors.textMuted} />
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>{(m.roles ?? []).join(", ") || "(none)"}</Text>
                    </View>
                    {m.department ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                        <Ionicons name="business" size={12} color={colors.textMuted} />
                        <Text style={{ fontSize: 13, color: colors.textMuted }}>{m.department}</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </Card>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
