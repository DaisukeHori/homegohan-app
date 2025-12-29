import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type OrgRow = {
  id: string;
  name: string;
  plan: string | null;
  industry: string | null;
  employeeCount: number | null;
  subscriptionStatus: string | null;
  contactEmail: string | null;
  memberCount: number;
  createdAt: string;
};

export default function AdminOrganizationsPage() {
  const [items, setItems] = useState<OrgRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ organizations: OrgRow[] }>("/api/admin/organizations?limit=50");
      setItems(res.organizations ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    const n = name.trim();
    if (!n || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/admin/organizations", { name: n });
      setName("");
      Alert.alert("作成しました", "組織を作成しました。");
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>Organizations</Text>
      <Link href="/admin">Admin Home</Link>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>作成</Text>
        <TextInput value={name} onChangeText={setName} placeholder="組織名" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <Pressable onPress={create} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "作成中..." : "作成"}</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>組織がありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((o) => (
            <View key={o.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}>
              <Text style={{ fontWeight: "900" }}>{o.name}</Text>
              <Text style={{ color: "#666" }}>
                members: {o.memberCount} / plan: {o.plan ?? "-"} / status: {o.subscriptionStatus ?? "-"}
              </Text>
              <Text style={{ color: "#999" }}>{o.id}</Text>
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


