import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>ユーザー検索</Text>
      <Link href="/support">Support Home</Link>

      <View style={{ gap: 8 }}>
        <TextInput value={q} onChangeText={setQ} placeholder="nickname or user id" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 12 }} />
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
            <Pressable
              key={u.id}
              onPress={() => router.push(`/support/users/${u.id}`)}
              style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}
            >
              <Text style={{ fontWeight: "900" }}>
                {u.nickname ?? "(no name)"} {u.isBanned ? "🚫" : ""}
              </Text>
              <Text style={{ color: "#666" }}>roles: {(u.roles ?? []).join(", ") || "(none)"}</Text>
              <Text style={{ color: "#999" }}>{u.id}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}


