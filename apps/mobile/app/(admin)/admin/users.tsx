import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>Users</Text>

      <View style={{ gap: 8 }}>
        <Link href="/admin">Admin Home</Link>
        <TextInput value={q} onChangeText={setQ} placeholder="検索（nickname or id）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 12 }} />
        <Pressable onPress={load} style={{ padding: 12, borderRadius: 12, backgroundColor: "#333", alignItems: "center" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>検索</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>ユーザーがいません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((u) => (
            <View key={u.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
              <Text style={{ fontWeight: "900" }}>
                {u.nickname ?? "(no name)"} {u.isBanned ? "🚫" : ""}
              </Text>
              <Text style={{ color: "#666" }}>roles: {(u.roles ?? []).join(", ") || "(none)"}</Text>
              <Text style={{ color: "#666" }}>org: {u.organizationId ?? "-"} / dept: {u.department ?? "-"}</Text>
              <Text style={{ color: "#999" }}>{u.id}</Text>

              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {u.isBanned ? (
                  <Pressable onPress={() => unban(u.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
                    <Text style={{ color: "white", fontWeight: "900" }}>BAN解除</Text>
                  </Pressable>
                ) : (
                  <Pressable onPress={() => ban(u.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#c00" }}>
                    <Text style={{ color: "white", fontWeight: "900" }}>BAN</Text>
                  </Pressable>
                )}

                <Pressable
                  onPress={() => setRole(u.id, Array.from(new Set([...(u.roles ?? []), "support", "user"])))}
                  style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}
                >
                  <Text style={{ color: "white", fontWeight: "900" }}>support付与</Text>
                </Pressable>
                <Pressable
                  onPress={() => setRole(u.id, (u.roles ?? []).filter((r) => r !== "support").concat("user"))}
                  style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}
                >
                  <Text style={{ color: "white", fontWeight: "900" }}>support解除</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}


