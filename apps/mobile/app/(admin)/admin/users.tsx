import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatusBadge, LoadingState, EmptyState } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui";
import { colors, spacing, radius } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

type UserRow = {
  id: string;
  nickname: string | null;
  roles: string[];
  gender: string | null;
  organizationId: string | null;
  department: string | null;
  isBanned: boolean;
  bannedReason: string | null;
  lastLoginAt: string | null;
  createdAt: string;
};

export default function AdminUsersPage() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<UserRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ users: UserRow[] }>(`/api/admin/users?limit=50&q=${encodeURIComponent(q)}`);
      setItems(res.users ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function ban(id: string) {
    Alert.alert("BAN", "このユーザーをBANしますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "BAN",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.post(`/api/admin/users/${id}/ban`, { reason: "manual" });
            await load();
          } catch (e: any) {
            Alert.alert("失敗", e?.message ?? "失敗しました。");
          }
        },
      },
    ]);
  }

  async function unban(id: string) {
    try {
      const api = getApi();
      await api.del(`/api/admin/users/${id}/ban`);
      await load();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "失敗しました。");
    }
  }

  async function setRole(id: string, nextRoles: string[]) {
    try {
      const api = getApi();
      await api.put(`/api/admin/users/${id}/role`, { roles: nextRoles });
      await load();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "失敗しました。");
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: 56, paddingHorizontal: spacing.lg, paddingBottom: spacing["3xl"], gap: spacing.lg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>Users</Text>
      </View>

      {/* Search */}
      <Card>
        <View style={{ gap: spacing.md }}>
          <SectionHeader title="検索" />
          <Input
            value={q}
            onChangeText={setQ}
            placeholder="nickname or id で検索"
          />
          <Button onPress={load}>
            検索
          </Button>
        </View>
      </Card>

      {/* List */}
      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState icon={<Ionicons name="people-outline" size={40} color={colors.textMuted} />} message="ユーザーがいません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((u) => (
            <Card key={u.id}>
              <View style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: radius.full,
                      backgroundColor: u.isBanned ? colors.errorLight : colors.blueLight,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Ionicons name={u.isBanned ? "ban" : "person"} size={20} color={u.isBanned ? colors.error : colors.blue} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>
                      {u.nickname ?? "(no name)"}
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>{u.id}</Text>
                  </View>
                  {u.isBanned ? (
                    <StatusBadge variant="alert" label="BAN" />
                  ) : null}
                </View>

                <View style={{ paddingLeft: 52, gap: spacing.xs }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="shield" size={14} color={colors.textMuted} />
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>
                      roles: {(u.roles ?? []).join(", ") || "(none)"}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="business" size={14} color={colors.textMuted} />
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>
                      org: {u.organizationId ?? "-"} / dept: {u.department ?? "-"}
                    </Text>
                  </View>
                </View>

                <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap", marginTop: spacing.xs }}>
                  {u.isBanned ? (
                    <Button onPress={() => unban(u.id)} variant="secondary" size="sm">
                      BAN解除
                    </Button>
                  ) : (
                    <Button onPress={() => ban(u.id)} variant="destructive" size="sm">
                      BAN
                    </Button>
                  )}
                  <Button
                    onPress={() => setRole(u.id, Array.from(new Set([...(u.roles ?? []), "support", "user"])))}
                    variant="secondary"
                    size="sm"
                  >
                    support付与
                  </Button>
                  <Button
                    onPress={() => setRole(u.id, (u.roles ?? []).filter((r) => r !== "support").concat("user"))}
                    variant="secondary"
                    size="sm"
                  >
                    support解除
                  </Button>
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
