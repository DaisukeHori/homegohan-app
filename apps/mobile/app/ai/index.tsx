import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../src/lib/api";

type Session = {
  id: string;
  title: string;
  status: string;
  summary?: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export default function AiSessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ sessions: Session[] }>("/api/ai/consultation/sessions?status=active");
      setSessions(res.sessions ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createSession() {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const api = getApi();
      const res = await api.post<{ success: boolean; session: { id: string } }>("/api/ai/consultation/sessions", {
        title: "AI相談",
      });
      const sessionId = res.session.id;
      router.push(`/ai/${sessionId}`);
    } catch (e: any) {
      setError(e?.message ?? "作成に失敗しました。");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>AI相談</Text>
        <Pressable
          onPress={createSession}
          style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#333" }}
        >
          <Text style={{ color: "white", fontWeight: "900" }}>{isCreating ? "作成中..." : "新規"}</Text>
        </Pressable>
      </View>

      <View style={{ gap: 8 }}>
        <Link href="/ai/important">重要メッセージ一覧</Link>
        <Link href="/home">ホームへ</Link>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : sessions.length === 0 ? (
        <Text style={{ color: "#666" }}>アクティブなセッションがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {sessions.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => router.push(`/ai/${s.id}`)}
              style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}
            >
              <Text style={{ fontWeight: "900" }}>{s.title}</Text>
              <Text style={{ color: "#666" }}>
                {s.messageCount} messages / {new Date(s.updatedAt).toLocaleString("ja-JP")}
              </Text>
              {s.summary ? <Text style={{ color: "#999" }}>{s.summary}</Text> : null}
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



