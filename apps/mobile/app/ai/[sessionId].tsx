import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { LoadingState, PageHeader } from "../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../src/theme";
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
    const next = !m.isImportant;
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, isImportant: next } : x)));
    try {
      const api = getApi();
      await api.post(`/api/ai/consultation/sessions/${sessionId}/messages/${m.id}/important`, {
        isImportant: next,
        reason: null,
      });
    } catch (e: any) {
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
      <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap", marginTop: spacing.sm }}>
        <Pressable
          onPress={() => executeActionByMessageId(messageId)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.md,
            borderRadius: radius.md,
            backgroundColor: colors.accent,
            ...(pressed ? { opacity: 0.9 } : {}),
          })}
        >
          <Ionicons name="checkmark-circle" size={16} color="#fff" />
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>実行</Text>
        </Pressable>
        <Pressable
          onPress={() => rejectActionByMessageId(messageId)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.md,
            borderRadius: radius.md,
            backgroundColor: colors.bg,
            borderWidth: 1,
            borderColor: colors.border,
            ...(pressed ? { opacity: 0.9 } : {}),
          })}
        >
          <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          <Text style={{ color: colors.textLight, fontWeight: "700", fontSize: 13 }}>却下</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1 }}>
        <PageHeader
          title="AIチャット"
          right={
            <View style={{ flexDirection: "row", gap: spacing.md, alignItems: "center" }}>
              <Pressable onPress={summarize} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Ionicons name="document-text-outline" size={18} color={colors.textLight} />
                <Text style={{ color: colors.textLight, fontWeight: "600", fontSize: 12 }}>要約</Text>
              </Pressable>
              <Pressable onPress={closeSession} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Ionicons name="close-circle-outline" size={18} color={colors.error} />
                <Text style={{ color: colors.error, fontWeight: "600", fontSize: 12 }}>終了</Text>
              </Pressable>
            </View>
          }
        />

        {isLoading ? (
          <LoadingState />
        ) : (
          <>
            <ScrollView
              ref={(r) => {
                scrollRef.current = r;
              }}
              contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
              keyboardShouldPersistTaps="handled"
            >
              {error && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, backgroundColor: colors.errorLight, borderRadius: radius.md }}>
                  <Ionicons name="alert-circle" size={16} color={colors.error} />
                  <Text style={{ color: colors.error, fontSize: 13, flex: 1 }}>{error}</Text>
                </View>
              )}
              {messages.map((m) => {
                const isUser = m.role === "user";
                const isSystem = m.role === "system";

                return (
                  <View
                    key={m.id}
                    style={{
                      alignSelf: isUser ? "flex-end" : "flex-start",
                      maxWidth: "85%",
                    }}
                  >
                    <View
                      style={{
                        padding: spacing.md,
                        borderRadius: radius.lg,
                        backgroundColor: isUser ? colors.accent : colors.card,
                        borderWidth: isUser ? 0 : 1,
                        borderColor: m.isImportant ? colors.warning : colors.border,
                        ...shadows.sm,
                        gap: spacing.xs,
                        // 吹き出しスタイル
                        borderBottomRightRadius: isUser ? 4 : radius.lg,
                        borderBottomLeftRadius: isUser ? radius.lg : 4,
                      }}
                    >
                      <Text
                        style={{
                          color: isUser ? "#fff" : colors.text,
                          fontSize: 14,
                          lineHeight: 21,
                        }}
                      >
                        {m.content}
                      </Text>

                      {/* アクションボタン */}
                      {m.role === "assistant" && renderActionButtons(m.id, m.proposedActions)}

                      {/* 下部: 時刻 + 重要マーク */}
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                        <Text style={{ fontSize: 10, color: isUser ? "rgba(255,255,255,0.6)" : colors.textMuted }}>
                          {new Date(m.createdAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                        </Text>
                        {!isSystem && (
                          <Pressable onPress={() => toggleImportant(m)} hitSlop={8}>
                            <Ionicons
                              name={m.isImportant ? "star" : "star-outline"}
                              size={16}
                              color={m.isImportant ? colors.warning : (isUser ? "rgba(255,255,255,0.5)" : colors.textMuted)}
                            />
                          </Pressable>
                        )}
                      </View>
                    </View>
                  </View>
                );
              })}

              {/* 送信中インジケータ */}
              {isSending && (
                <View style={{ alignSelf: "flex-start", maxWidth: "60%" }}>
                  <View
                    style={{
                      padding: spacing.md,
                      borderRadius: radius.lg,
                      borderBottomLeftRadius: 4,
                      backgroundColor: colors.card,
                      borderWidth: 1,
                      borderColor: colors.border,
                      ...shadows.sm,
                    }}
                  >
                    <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textMuted }} />
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border }} />
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border }} />
                    </View>
                  </View>
                </View>
              )}
            </ScrollView>

            {/* 入力バー */}
            <View
              style={{
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                borderTopWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.card,
                flexDirection: "row",
                gap: spacing.sm,
                alignItems: "flex-end",
              }}
            >
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="相談内容を入力..."
                placeholderTextColor={colors.textMuted}
                multiline
                style={{
                  flex: 1,
                  maxHeight: 100,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.bg,
                  padding: spacing.md,
                  borderRadius: radius.lg,
                  fontSize: 14,
                  color: colors.text,
                }}
              />
              <Pressable
                onPress={send}
                disabled={isSending || !text.trim()}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: text.trim() ? colors.accent : colors.border,
                  alignItems: "center",
                  justifyContent: "center",
                  ...shadows.sm,
                  ...(pressed ? { opacity: 0.9 } : {}),
                })}
              >
                <Ionicons name="send" size={20} color="#fff" />
              </Pressable>
            </View>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
