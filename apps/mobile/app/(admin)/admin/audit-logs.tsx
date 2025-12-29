import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type AuditLog = {
  id: string;
  adminName: string;
  actionType: string;
  targetId: string | null;
  severity: string | null;
  createdAt: string;
};

export default function AdminAuditLogsPage() {
  const [items, setItems] = useState<AuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [actionType, setActionType] = useState("");

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const qs = actionType.trim() ? `?action_type=${encodeURIComponent(actionType.trim())}` : "";
      const res = await api.get<{ logs: AuditLog[] }>(`/api/admin/audit-logs${qs}`);
      setItems(res.logs ?? []);
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
      <Text style={{ fontSize: 20, fontWeight: "900" }}>Audit Logs</Text>
      <Link href="/admin">Admin Home</Link>

      <View style={{ gap: 8 }}>
        <TextInput value={actionType} onChangeText={setActionType} placeholder="action_type で絞り込み（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 12 }} />
        <Pressable onPress={load} style={{ padding: 12, borderRadius: 12, backgroundColor: "#333", alignItems: "center" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>更新</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>ログがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.slice(0, 100).map((l) => (
            <View key={l.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}>
              <Text style={{ fontWeight: "900" }}>
                {l.actionType} / {l.severity ?? "-"}
              </Text>
              <Text style={{ color: "#666" }}>admin: {l.adminName}</Text>
              <Text style={{ color: "#999" }}>{new Date(l.createdAt).toLocaleString("ja-JP")}</Text>
              {l.targetId ? <Text style={{ color: "#999" }}>target: {l.targetId}</Text> : null}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}


