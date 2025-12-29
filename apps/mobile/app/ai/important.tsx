import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../src/lib/api";

type ImportantMessage = {
  id: string;
  role: string;
  content: string;
  reason: string | null;
  createdAt: string;
  session: { id: string; title: string };
};

export default function AiImportantMessagesPage() {
  const [items, setItems] = useState<ImportantMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ importantMessages: ImportantMessage[] }>("/api/ai/consultation/important-messages?limit=50");
      setItems(res.importantMessages ?? []);
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
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>重要メッセージ</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: "#666" }}>戻る</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>重要メッセージがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((m) => (
            <Pressable
              key={m.id}
              onPress={() => router.push(`/ai/${m.session.id}`)}
              style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}
            >
              <Text style={{ fontWeight: "900" }}>{m.session.title}</Text>
              <Text style={{ color: "#666" }}>{new Date(m.createdAt).toLocaleString("ja-JP")}</Text>
              <Text style={{ color: "#333" }}>{m.content}</Text>
              {m.reason ? <Text style={{ color: "#999" }}>理由: {m.reason}</Text> : null}
            </Pressable>
          ))}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


