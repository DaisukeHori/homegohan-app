import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";

type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  proposedActions?: any;
  isImportant?: boolean;
  importanceReason?: string | null;
  createdAt: string;
};

export default function AiSessionPage() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");

  const scrollRef = useRef<ScrollView | null>(null);

  const messagesPath = useMemo(() => `/api/ai/consultation/sessions/${sessionId}/messages`, [sessionId]);

  async function load() {
    if (!sessionId) return;
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ messages: Message[] }>(messagesPath);
      setMessages(res.messages ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [sessionId]);

  useEffect(() => {
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 100);
    return () => clearTimeout(t);
  }, [messages.length]);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    setIsSending(true);
    setError(null);

    try {
      const api = getApi();
      const optimistic: Message = {
        id: `local-${Date.now()}`,
        role: "user",
        content: trimmed,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);
      setText("");

      const res = await api.post<{ success: boolean; message?: any; aiMessage?: any; assistantMessage?: any }>(
        messagesPath,
        { message: trimmed }
      );

      // POSTの戻りは実装により揺れるので、最新を再取得して確定させる
      await load();
      return res;
    } catch (e: any) {
      setError(e?.message ?? "送信に失敗しました。");
    } finally {
      setIsSending(false);
    }
  }

  async function executeActionByMessageId(messageId: string) {
    try {
      const api = getApi();
      await api.post(`/api/ai/consultation/actions/${messageId}/execute`, {});
      await load();
      Alert.alert("実行しました", "アクションを実行しました。");
    } catch (e: any) {
      Alert.alert("実行失敗", e?.message ?? "実行に失敗しました。");
    }
  }

  async function rejectActionByMessageId(messageId: string) {
    try {
      const api = getApi();
      await api.del(`/api/ai/consultation/actions/${messageId}/execute`);
      await load();
      Alert.alert("却下しました", "提案アクションを却下しました。");
    } catch (e: any) {
      Alert.alert("却下失敗", e?.message ?? "却下に失敗しました。");
    }
  }

  async function toggleImportant(m: Message) {
    if (!sessionId) return;
    // optimistic update
    const next = !m.isImportant;
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, isImportant: next } : x)));
    try {
      const api = getApi();
      await api.post(`/api/ai/consultation/sessions/${sessionId}/messages/${m.id}/important`, {
        isImportant: next,
        reason: null,
      });
    } catch (e: any) {
      // rollback
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, isImportant: !next } : x)));
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    }
  }

  async function summarize() {
    if (!sessionId) return;
    try {
      const api = getApi();
      const res = await api.post<{ success: boolean; summary: any }>(
        `/api/ai/consultation/sessions/${sessionId}/summarize`,
        {}
      );
      const s = res.summary;
      const text = s
        ? `${s.title ?? ""}\n\n${s.summary ?? ""}\n\nトピック: ${(s.key_topics ?? []).join("、")}`
        : "要約を生成できませんでした。";
      Alert.alert("要約", text);
    } catch (e: any) {
      Alert.alert("要約失敗", e?.message ?? "要約に失敗しました。");
    }
  }

  async function closeSession() {
    if (!sessionId) return;
    Alert.alert("セッション終了", "このAI相談を終了しますか？（自動で要約します）", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "終了",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.post(`/api/ai/consultation/sessions/${sessionId}/close`, {});
            router.back();
          } catch (e: any) {
            Alert.alert("終了失敗", e?.message ?? "終了に失敗しました。");
          }
        },
      },
    ]);
  }

  function renderActionButtons(messageId: string, proposed: any) {
    if (!proposed) return null;
    return (
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
        <Pressable
          onPress={() => executeActionByMessageId(messageId)}
          style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#333" }}
        >
          <Text style={{ color: "white", fontWeight: "900" }}>提案アクションを実行</Text>
        </Pressable>
        <Pressable
          onPress={() => rejectActionByMessageId(messageId)}
          style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#eee" }}
        >
          <Text style={{ fontWeight: "900" }}>却下</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <View style={{ padding: 16, borderBottomWidth: 1, borderColor: "#eee", flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 18, fontWeight: "900" }}>AI相談</Text>
          <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            <Pressable onPress={summarize}>
              <Text style={{ color: "#333", fontWeight: "900" }}>要約</Text>
            </Pressable>
            <Pressable onPress={closeSession}>
              <Text style={{ color: "#c00", fontWeight: "900" }}>終了</Text>
            </Pressable>
            <Pressable onPress={() => router.back()}>
              <Text style={{ color: "#666" }}>戻る</Text>
            </Pressable>
          </View>
        </View>

        {isLoading ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator />
          </View>
        ) : (
          <>
            <ScrollView
              ref={(r) => {
                // @ts-ignore
                scrollRef.current = r;
              }}
              contentContainerStyle={{ padding: 16, gap: 10 }}
            >
              {error ? <Text style={{ color: "#c00" }}>{error}</Text> : null}
              {messages.map((m) => (
                <View
                  key={m.id}
                  style={{
                    alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                    maxWidth: "90%",
                    padding: 12,
                    borderRadius: 12,
                    backgroundColor: m.role === "user" ? "#E07A5F" : "white",
                    borderWidth: m.role === "user" ? 0 : 1,
                    borderColor: "#eee",
                    gap: 6,
                  }}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
                    <Text style={{ color: m.role === "user" ? "white" : "#333", flex: 1 }}>{m.content}</Text>
                    {m.role !== "system" ? (
                      <Pressable onPress={() => toggleImportant(m)} style={{ paddingHorizontal: 6, paddingVertical: 2 }}>
                        <Text style={{ color: m.role === "user" ? "white" : "#333", fontWeight: "900" }}>
                          {m.isImportant ? "★" : "☆"}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {m.role === "assistant" ? renderActionButtons(m.id, m.proposedActions) : null}
                </View>
              ))}
            </ScrollView>

            <View style={{ padding: 12, borderTopWidth: 1, borderColor: "#eee", flexDirection: "row", gap: 10 }}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="相談内容を入力…"
                style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 12 }}
              />
              <Pressable
                onPress={send}
                disabled={isSending}
                style={{ paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: isSending ? "#999" : "#333", justifyContent: "center" }}
              >
                <Text style={{ color: "white", fontWeight: "900" }}>{isSending ? "…" : "送信"}</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}



