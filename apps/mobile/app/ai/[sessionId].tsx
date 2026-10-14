import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { LoadingState, PageHeader } from "../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../src/theme";
import { getApi, getApiBaseUrl } from "../../src/lib/api";
import {
  AI_CHAT_STREAM_TIMEOUT_MS,
  TIMEOUT_DELIVERED_NO_REPLY_MESSAGE,
  TIMEOUT_NOTICE_MESSAGE,
  TIMEOUT_NOT_DELIVERED_MESSAGE,
  TIMEOUT_RELOAD_FAILED_MESSAGE,
  TIMEOUT_RELOAD_LABEL,
  clearInputIfDelivered,
  restoreInputAfterTimeout,
  timeoutReloadOutcomeOf,
  type TimedOutSend,
} from "../../src/lib/ai-chat-timeout";
import { supabase } from "../../src/lib/supabase";
import { handleAiConsentRequiredError } from "../../src/lib/ai-consent";
import { errorOfFailedResponse, isStoppedByServerError } from "../../src/lib/failed-response";

type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  proposedActions?: any;
  isImportant?: boolean;
  importanceReason?: string | null;
  createdAt: string;
  imageUri?: string; // ローカル表示用（楽観的UI）
};

export default function AiSessionPage() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [attachedImage, setAttachedImage] = useState<{ uri: string; base64: string } | null>(null);
  const [imagePreviewReady, setImagePreviewReady] = useState(false);
  // 送信が時間切れになった送信。あるあいだ「最新の会話を読み込む」を出す (#1049 F7-18。扱いは src/lib/ai-chat-timeout.ts)
  const [timedOutSend, setTimedOutSend] = useState<TimedOutSend | null>(null);
  const [reloadingAfterTimeout, setReloadingAfterTimeout] = useState(false);
  // 時間切れのときに添付欄へ戻した画像。届いていたと分かったら、添付欄がこの画像のままなら外す (二重に送らないため)
  const restoredImageRef = useRef<{ uri: string; base64: string } | null>(null);
  // 自動実行済みのメッセージID集合。GET レスポンスは proposed_actions を返し続けるため、
  // クライアント側でアクションボタンを非表示にするためのトラッキングに使用する。
  const executedMessageIds = useRef<Set<string>>(new Set());

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

  /**
   * 送信が時間切れになったあと、会話を取り直す (#1049 F7-18。AIAdvisorSheet と同じ扱い。src/lib/ai-chat-timeout.ts)。
   * 画面全体を読み込み中にはしない (入力欄に戻した文を残すため)。取れなければ、今の表示と案内を残してエラーを出す。
   * 送った文が届いていたら、入力欄に戻した文 (と添付の画像) を消す。返答がまだ無ければ案内を残す。
   * 届いていなければ、案内を消して、入力欄の文をもう一度送るように知らせる
   */
  async function reloadAfterTimeout() {
    const sent = timedOutSend;
    if (!sent || reloadingAfterTimeout) return;
    setReloadingAfterTimeout(true);
    try {
      let loaded: Message[];
      try {
        const res = await getApi().get<{ messages: Message[] }>(messagesPath);
        loaded = res.messages ?? [];
      } catch {
        setError(TIMEOUT_RELOAD_FAILED_MESSAGE);
        return;
      }
      setMessages(loaded);
      const outcome = timeoutReloadOutcomeOf(sent, loaded);
      if (outcome === "not-delivered") {
        setTimedOutSend(null);
        setError(TIMEOUT_NOT_DELIVERED_MESSAGE);
        return;
      }
      setError(null);
      setText((current) => clearInputIfDelivered(current, sent.text));
      const restoredImage = restoredImageRef.current;
      setAttachedImage((current) => (current !== null && current === restoredImage ? null : current));
      restoredImageRef.current = null;
      setTimedOutSend(outcome === "replied" ? null : { ...sent, delivered: true });
    } finally {
      setReloadingAfterTimeout(false);
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

  async function pickImage() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("権限が必要です", "画像を添付するにはカメラロールへのアクセスを許可してください。");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "images",
      allowsEditing: true,
      quality: 0.7,
      base64: true,
    });
    if (!result.canceled && result.assets.length > 0) {
      const asset = result.assets[0];
      if (asset.base64) {
        setImagePreviewReady(false);
        setAttachedImage({ uri: asset.uri, base64: asset.base64 });
      }
    }
  }

  async function send() {
    const trimmed = text.trim();
    if ((!trimmed && !attachedImage) || isSending) return;
    // 時間切れのあとの取り直しで、送った文が届いたかを見分けるため、送る前に出ていたサーバーのメッセージの id を持つ
    const knownMessageIds = messages.filter((m) => !m.id.startsWith("local-")).map((m) => m.id);

    setIsSending(true);
    setError(null);
    setStreamingContent(null);
    setTimedOutSend(null);
    restoredImageRef.current = null;

    const imageSnapshot = attachedImage;

    const optimistic: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
      imageUri: imageSnapshot?.uri,
    };
    setMessages((prev) => [...prev, optimistic]);
    setText("");
    setAttachedImage(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      const baseUrl = getApiBaseUrl();
      const url = `${baseUrl}${messagesPath}?stream=true`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), AI_CHAT_STREAM_TIMEOUT_MS);

      const body: Record<string, any> = { message: trimmed };
      if (imageSnapshot) {
        body.imageBase64 = imageSnapshot.base64;
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // 429 AI_DAILY_LIMIT (#1149)・503 の緊急停止・メンテナンス中 (#1457) は、固定の文の例外にする (生の本文を画面に出さない)
        throw errorOfFailedResponse(res.status, text);
      }

      if (!res.body) {
        // ReadableStream 非対応環境: 通常レスポンスとして処理
        await load();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let finalHandled = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6);
          if (raw === "[DONE]") continue;

          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }

          // ストリーミングチャンク: choices[0].delta.content
          const chunk = parsed?.choices?.[0]?.delta?.content;
          if (chunk) {
            accumulated += chunk;
            setStreamingContent(accumulated);
            continue;
          }

          // 完了メッセージ: aiMessage フィールドが存在
          if (parsed?.aiMessage) {
            finalHandled = true;
            setStreamingContent(null);
            const aiMsg: Message = {
              id: parsed.aiMessage.id ?? `ai-${Date.now()}`,
              role: "assistant",
              content: parsed.aiMessage.content ?? accumulated,
              proposedActions: parsed.aiMessage.proposedActions ?? null,
              createdAt: parsed.aiMessage.createdAt ?? new Date().toISOString(),
            };
            // サーバー側でアクションが自動実行された場合はそのメッセージ ID を記録し、
            // GET 再取得後もアクションボタンを非表示にする
            if (parsed.actionExecuted) {
              executedMessageIds.current.add(aiMsg.id);
              Alert.alert("アクション実行", "AIの提案が自動的に実行されました。");
            }
            // optimistic ユーザーメッセージを確定 ID に差し替え
            setMessages((prev) => {
              const withoutOptimistic = prev.filter((m) => !m.id.startsWith("local-"));
              const userMsg: Message = parsed.userMessage
                ? {
                    id: parsed.userMessage.id,
                    role: "user",
                    content: parsed.userMessage.content ?? trimmed,
                    isImportant: parsed.userMessage.isImportant ?? false,
                    createdAt: parsed.userMessage.createdAt ?? new Date().toISOString(),
                  }
                : optimistic;
              return [...withoutOptimistic, userMsg, aiMsg];
            });
          }
        }
      }

      if (!finalHandled) {
        // ストリームが完了データなしで終了した場合、蓄積テキストをUIに反映してリロード
        setStreamingContent(null);
        if (accumulated) {
          const aiMsg: Message = {
            id: `ai-${Date.now()}`,
            role: "assistant",
            content: accumulated,
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => {
            const withoutOptimistic = prev.filter((m) => !m.id.startsWith("local-"));
            return [...withoutOptimistic, optimistic, aiMsg];
          });
        } else {
          await load();
        }
      }
    } catch (e: any) {
      setStreamingContent(null);
      // 同意が必要で止められた (T15 / #1154): 同意画面への案内を出した。送らなかったので、メッセージを消して入力を戻す
      if (handleAiConsentRequiredError(e)) {
        setMessages((prev) => prev.filter((m) => !m.id.startsWith("local-")));
        setText(trimmed);
        return;
      }
      // 今日の AI の利用回数の上限 (#1149)・AI 相談の緊急停止中・メンテナンス中 (#1457)・同意の状況を読めなかった (#1486) で止められた:
      // 送らなかったので、メッセージを消して入力 (と添付の画像) を戻し、固定の文を出す
      if (isStoppedByServerError(e)) {
        setMessages((prev) => prev.filter((m) => !m.id.startsWith("local-")));
        setText(trimmed);
        if (imageSnapshot) setAttachedImage(imageSnapshot);
        setError(e.message);
        return;
      }
      if (e?.name === "AbortError") {
        // 待ちを打ち切っただけで、サーバーでは返答の保存が続いていることがある (#1049 F7-18)。
        // 失敗として終わらせず、会話を取り直す導線 (TIMEOUT_RELOAD_LABEL) を出し、送った文 (と添付の画像) を入力欄に戻す
        // (届いていたかは取り直しで分かる。届いていたら、戻した文と画像はそこで消す)
        setText((current) => restoreInputAfterTimeout(current, trimmed));
        if (imageSnapshot) {
          setAttachedImage((current) => {
            if (current !== null) return current;
            restoredImageRef.current = imageSnapshot;
            return imageSnapshot;
          });
        }
        if (sessionId) {
          setTimedOutSend({ sessionId, text: trimmed, knownMessageIds, delivered: false });
        } else {
          setError(TIMEOUT_NOTICE_MESSAGE);
        }
      } else {
        setError(e?.message ?? "送信に失敗しました。");
      }
      // optimistic メッセージを削除
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("local-")));
    } finally {
      setIsSending(false);
    }
  }

  async function executeActionByMessageId(messageId: string) {
    try {
      const api = getApi();
      await api.post(`/api/ai/consultation/actions/${messageId}/execute`, {});
      executedMessageIds.current.add(messageId);
      await load();
      Alert.alert("実行しました", "アクションを実行しました。");
    } catch (e: any) {
      // 同意が必要で止められた (T15 / #1154): 同意画面への案内を出したので、ここのエラー表示は出さない
      if (handleAiConsentRequiredError(e)) return;
      Alert.alert("実行失敗", e?.message ?? "実行に失敗しました。");
    }
  }

  async function rejectActionByMessageId(messageId: string) {
    try {
      const api = getApi();
      await api.del(`/api/ai/consultation/actions/${messageId}/execute`);
      executedMessageIds.current.add(messageId);
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
      // 同意が必要で止められた (T15 / #1154): 同意画面への案内を出したので、ここのエラー表示は出さない
      if (handleAiConsentRequiredError(e)) return;
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
    // proposed_actions が null/undefined、またはサーバー側で自動実行済みの場合はボタン非表示
    if (!proposed || executedMessageIds.current.has(messageId)) return null;
    return (
      <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap", marginTop: spacing.sm }}>
        <Pressable
          testID={`ai-chat-action-${messageId}-execute`}
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
          testID={`ai-chat-action-${messageId}-reject`}
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
      <View testID="ai-chat-screen" style={{ flex: 1 }}>
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
                  <Text testID="ai-chat-error-text" style={{ color: colors.error, fontSize: 13, flex: 1 }}>{error}</Text>
                </View>
              )}
              {messages.map((m) => {
                const isUser = m.role === "user";
                const isSystem = m.role === "system";

                return (
                  <View
                    key={m.id}
                    testID={`ai-chat-message-${m.id}`}
                    style={{
                      alignSelf: isUser ? "flex-end" : "flex-start",
                      maxWidth: "85%",
                    }}
                  >
                    <View
                      testID={isUser ? `ai-chat-message-user-${m.id}` : `ai-chat-message-assistant-${m.id}`}
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
                      {/* 添付画像（楽観的UI: ローカル URI を使用） */}
                      {isUser && m.imageUri && (
                        <Image
                          source={{ uri: m.imageUri }}
                          style={{ width: 180, height: 180, borderRadius: radius.md, marginBottom: spacing.xs }}
                          resizeMode="cover"
                        />
                      )}
                      {m.content ? (
                        <Text
                          style={{
                            color: isUser ? "#fff" : colors.text,
                            fontSize: 14,
                            lineHeight: 21,
                          }}
                        >
                          {m.content}
                        </Text>
                      ) : null}

                      {/* アクションボタン */}
                      {m.role === "assistant" && renderActionButtons(m.id, m.proposedActions)}

                      {/* 下部: 時刻 + 重要マーク */}
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                        <Text style={{ fontSize: 10, color: isUser ? "rgba(255,255,255,0.6)" : colors.textMuted }}>
                          {new Date(m.createdAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                        </Text>
                        {!isSystem && (
                          <Pressable testID={`ai-chat-mark-important-${m.id}`} onPress={() => toggleImportant(m)} hitSlop={8}>
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

              {/* ストリーミング中: リアルタイム表示 or ドットインジケータ */}
              {isSending && (
                <View testID="ai-chat-streaming-view" style={{ alignSelf: "flex-start", maxWidth: "85%" }}>
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
                    {streamingContent ? (
                      <Text style={{ color: colors.text, fontSize: 14, lineHeight: 21 }}>
                        {streamingContent}
                      </Text>
                    ) : (
                      <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textMuted }} />
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border }} />
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border }} />
                      </View>
                    )}
                  </View>
                </View>
              )}

              {/* 送信が時間切れになったときの、取り直しの導線 (#1049 F7-18) */}
              {timedOutSend != null && timedOutSend.sessionId === sessionId && !isSending && (
                <View
                  testID="ai-chat-timeout-notice"
                  style={{ gap: spacing.sm, padding: spacing.md, backgroundColor: colors.warningLight, borderRadius: radius.md }}
                >
                  <Text style={{ color: colors.warningText, fontSize: 13, lineHeight: 19 }}>
                    {timedOutSend.delivered ? TIMEOUT_DELIVERED_NO_REPLY_MESSAGE : TIMEOUT_NOTICE_MESSAGE}
                  </Text>
                  <Pressable
                    testID="ai-chat-timeout-reload"
                    accessibilityRole="button"
                    onPress={reloadAfterTimeout}
                    disabled={reloadingAfterTimeout}
                    style={{
                      alignSelf: "flex-start",
                      paddingVertical: spacing.sm,
                      paddingHorizontal: spacing.md,
                      borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor: colors.accent,
                      backgroundColor: colors.card,
                    }}
                  >
                    {reloadingAfterTimeout ? (
                      <ActivityIndicator size="small" color={colors.accent} />
                    ) : (
                      <Text style={{ color: colors.accent, fontWeight: "700", fontSize: 13 }}>{TIMEOUT_RELOAD_LABEL}</Text>
                    )}
                  </Pressable>
                </View>
              )}
            </ScrollView>

            {/* 入力バー */}
            <View
              style={{
                paddingHorizontal: spacing.md,
                paddingTop: spacing.sm,
                paddingBottom: spacing.sm,
                borderTopWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.card,
              }}
            >
              {/* 添付画像プレビュー */}
              {attachedImage && (
                <View style={{ marginBottom: spacing.sm }}>
                  <View style={{ position: "relative", alignSelf: "flex-start" }}>
                    <Image
                      testID="ai-chat-image-preview"
                      source={{ uri: attachedImage.uri }}
                      style={{ width: 80, height: 80, borderRadius: radius.md }}
                      resizeMode="cover"
                      onLoad={() => setImagePreviewReady(true)}
                    />
                    {imagePreviewReady && (
                      <View testID="ai-chat-image-preview-ready" style={{ position: "absolute", width: 0, height: 0 }} />
                    )}
                    <Pressable
                      testID="ai-chat-image-remove-button"
                      onPress={() => setAttachedImage(null)}
                      style={{
                        position: "absolute",
                        top: -6,
                        right: -6,
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        backgroundColor: colors.error,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Ionicons name="close" size={12} color="#fff" />
                    </Pressable>
                  </View>
                </View>
              )}

              <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "flex-end" }}>
                {/* 画像添付ボタン */}
                <Pressable
                  testID="ai-chat-image-attach-button"
                  onPress={pickImage}
                  disabled={isSending}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: attachedImage ? colors.accent : colors.bg,
                    borderWidth: attachedImage ? 0 : 1,
                    borderColor: colors.border,
                    alignItems: "center",
                    justifyContent: "center",
                    ...(pressed ? { opacity: 0.7 } : {}),
                  })}
                >
                  <Ionicons name="image-outline" size={20} color={attachedImage ? "#fff" : colors.textMuted} />
                </Pressable>

                <TextInput
                  testID="ai-chat-input"
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
                  testID="ai-chat-send-button"
                  onPress={send}
                  disabled={isSending || (!text.trim() && !attachedImage)}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: (text.trim() || attachedImage) ? colors.accent : colors.border,
                    alignItems: "center",
                    justifyContent: "center",
                    ...shadows.sm,
                    ...(pressed ? { opacity: 0.9 } : {}),
                  })}
                >
                  <Ionicons name="send" size={20} color="#fff" />
                </Pressable>
              </View>
            </View>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
