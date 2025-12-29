import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type ModerationItem = {
  id: string;
  type: "meal" | "recipe" | "ai_content";
  targetId?: string | null;
  userId?: string | null;
  reporterId?: string | null;
  flagType?: string | null;
  reason?: string | null;
  status?: string | null;
  createdAt: string;
  outputContent?: string | null;
  flagReason?: string | null;
};

export default function AdminModerationPage() {
  const [status, setStatus] = useState("pending");
  const [items, setItems] = useState<ModerationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<any>(`/api/admin/moderation?status=${encodeURIComponent(status)}&limit=50`);
      const merged: ModerationItem[] = [
        ...(res.mealFlags ?? []),
        ...(res.recipeFlags ?? []),
        ...(res.aiFlags ?? []),
      ];
      setItems(merged);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [status]);

  async function act(item: ModerationItem, action: "approve" | "reject" | "delete", deleteContent?: boolean) {
    Alert.alert("実行", `${item.type}/${action} を実行しますか？`, [
      { text: "キャンセル", style: "cancel" },
      {
        text: "実行",
        onPress: async () => {
          try {
            const api = getApi();
            await api.put(`/api/admin/moderation/${item.id}`, {
              type: item.type,
              action,
              note: note.trim() || null,
              deleteContent: !!deleteContent,
            });
            await load();
          } catch (e: any) {
            Alert.alert("失敗", e?.message ?? "失敗しました。");
          }
        },
      },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>Moderation</Text>
      <Link href="/admin">Admin Home</Link>

      <View style={{ flexDirection: "row", gap: 8 }}>
        {["pending", "resolved", "rejected"].map((s) => (
          <Pressable key={s} onPress={() => setStatus(s)} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: status === s ? "#E07A5F" : "#eee" }}>
            <Text style={{ fontWeight: "900", color: status === s ? "white" : "#333" }}>{s}</Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="操作メモ（任意）"
        style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 12 }}
      />

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>対象がありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((it) => (
            <View key={`${it.type}-${it.id}`} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
              <Text style={{ fontWeight: "900" }}>
                {it.type} / {it.flagType ?? it.status ?? ""}
              </Text>
              <Text style={{ color: "#666" }}>{it.reason ?? it.flagReason ?? it.outputContent ?? "-"}</Text>
              <Text style={{ color: "#999" }}>{new Date(it.createdAt).toLocaleString("ja-JP")}</Text>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <Pressable onPress={() => act(it, "approve")} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>承認</Text>
                </Pressable>
                <Pressable onPress={() => act(it, "reject")} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>却下</Text>
                </Pressable>
                {it.type !== "ai_content" ? (
                  <Pressable onPress={() => act(it, "delete", true)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#c00" }}>
                    <Text style={{ color: "white", fontWeight: "900" }}>削除</Text>
                  </Pressable>
                ) : null}
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


