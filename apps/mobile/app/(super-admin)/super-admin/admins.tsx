import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type AdminRow = {
  id: string;
  nickname: string | null;
  roles: string[];
  organizationId: string | null;
  lastLoginAt: string | null;
  recentActionCount: number;
};

export default function SuperAdminAdminsPage() {
  const [items, setItems] = useState<AdminRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ admins: AdminRow[] }>("/api/super-admin/admins");
      setItems(res.admins ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleRole(userId: string, currentRoles: string[], role: string) {
    const next = currentRoles.includes(role) ? currentRoles.filter((r) => r !== role) : [...currentRoles, role];
    const roles = Array.from(new Set([...next, "user"]));
    try {
      const api = getApi();
      await api.put(`/api/super-admin/admins/${userId}`, { roles });
      await load();
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>管理者管理</Text>
      <Link href="/super-admin">Super Admin Home</Link>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>管理者がいません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((a) => (
            <View key={a.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
              <Text style={{ fontWeight: "900" }}>{a.nickname ?? "(no name)"}</Text>
              <Text style={{ color: "#666" }}>roles: {(a.roles ?? []).join(", ")}</Text>
              <Text style={{ color: "#666" }}>recent actions (7d): {a.recentActionCount}</Text>
              <Text style={{ color: "#999" }}>{a.id}</Text>

              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {(["admin", "support", "org_admin", "super_admin"] as const).map((r) => (
                  <Pressable
                    key={r}
                    onPress={() => toggleRole(a.id, a.roles ?? [], r)}
                    style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: (a.roles ?? []).includes(r) ? "#E07A5F" : "#333" }}
                  >
                    <Text style={{ color: "white", fontWeight: "900" }}>{r}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


