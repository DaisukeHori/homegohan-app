import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, EmptyState, Input, LoadingState, StatusBadge } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing } from "../../../src/theme";

type UserRow = {
  id: string;
  nickname: string | null;
  roles: string[];
  organizationId: string | null;
  isBanned: boolean;
  lastLoginAt: string | null;
};

export default function SupportUsersPage() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<UserRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ users: any[] }>(`/api/admin/users?limit=50&q=${encodeURIComponent(q)}`);
      const users: UserRow[] = (res.users ?? []).map((u: any) => ({
        id: u.id,
        nickname: u.nickname ?? null,
        roles: Array.isArray(u.roles) ? u.roles : [],
        organizationId: u.organizationId ?? null,
        isBanned: !!u.isBanned,
        lastLoginAt: u.lastLoginAt ?? null,
      }));
      setItems(users);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing["4xl"] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: 56 }}>
        <Pressable onPress={() => router.back()} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text, flex: 1 }}>ユーザー検索</Text>
      </View>

      <Card>
        <View style={{ gap: spacing.sm }}>
          <Input
            value={q}
            onChangeText={setQ}
            placeholder="nickname or user id"
          />
          <Button onPress={load}>
            検索
          </Button>
        </View>
      </Card>

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState icon={<Ionicons name="people-outline" size={40} color={colors.textMuted} />} message="ユーザーがいません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((u) => (
            <Card key={u.id} onPress={() => router.push(`/support/users/${u.id}`)}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: u.isBanned ? colors.errorLight : colors.accentLight, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name={u.isBanned ? "ban-outline" : "person-outline"} size={20} color={u.isBanned ? colors.error : colors.accent} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{u.nickname ?? "(no name)"}</Text>
                    {u.isBanned && <StatusBadge variant="alert" label="BAN" />}
                  </View>
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>roles: {(u.roles ?? []).join(", ") || "(none)"}</Text>
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>{u.id}</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
