import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { colors, radius, shadows, spacing } from "../../theme";
import { getApi, getApiBaseUrl } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { AIDayMenuModal } from "./AIDayMenuModal";

// ============================================================
// Types
// ============================================================

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type Session = {
  id: string;
  title: string;
  messageCount: number;
  status?: string;
};

// ============================================================
// Constants
// ============================================================

const WELCOME_MESSAGE: Message = {
  id: "welcome",
  role: "assistant",
  content:
    "こんにちは！🍳 ほめゴハンのAIアドバイザーです。\n\n食事や栄養のことで気になることがあれば、何でも聞いてくださいね。献立の提案や、買い物リストの作成もお手伝いできますよ！",
  createdAt: new Date().toISOString(),
};

const QUICK_QUESTIONS = [
  "献立を提案してほしい",
  "冷蔵庫の食材で作れるものは?",
  "今日の栄養バランスは?",
  "来週の献立を作りたい",
];

// ============================================================
// Props
// ============================================================

interface Props {
  visible: boolean;
  onClose: () => void;
}

// ============================================================
// Component
// ============================================================

export const AIAdvisorSheet: React.FC<Props> = ({ visible, onClose }) => {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [dayMenuModalVisible, setDayMenuModalVisible] = useState(false);

  const scrollRef = useRef<ScrollView>(null);

  // セッション初期化
  useEffect(() => {
    if (visible && !currentSessionId) {
      initSession();
    }
  }, [visible]);

  // メッセージ追加時にスクロール
  useEffect(() => {
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 100);
    return () => clearTimeout(t);
  }, [messages.length, streamingContent]);

  async function initSession() {
    try {
      const api = getApi();
      // 既存アクティブセッション取得
      const res = await api.get<{ sessions: Session[] }>(
        "/api/ai/consultation/sessions?status=active"
      );
      const sessions = res.sessions ?? [];
      if (sessions.length > 0) {
        setCurrentSessionId(sessions[0].id);
        // 既存メッセージを読み込む
        const msgRes = await api.get<{ messages: Message[] }>(
          `/api/ai/consultation/sessions/${sessions[0].id}/messages`
        );
        const loaded = msgRes.messages ?? [];
        if (loaded.length > 0) {
          setMessages(loaded);
        } else {
          setMessages([WELCOME_MESSAGE]);
        }
      } else {
        // 新規セッション作成
        const createRes = await api.post<{
          success: boolean;
          session: { id: string };
        }>("/api/ai/consultation/sessions", { title: "AI相談" });
        setCurrentSessionId(createRes.session.id);
        setMessages([WELCOME_MESSAGE]);
      }
    } catch {
      // セッション作成失敗時はウェルカムメッセージだけ表示
      setMessages([WELCOME_MESSAGE]);
    }
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setInputText("");
    setStreamingContent(null);

    const optimistic: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      // セッションがなければ作成
      let sessionId = currentSessionId;
      if (!sessionId) {
        const api = getApi();
        const createRes = await api.post<{
          success: boolean;
          session: { id: string };
        }>("/api/ai/consultation/sessions", { title: "AI相談" });
        sessionId = createRes.session.id;
        setCurrentSessionId(sessionId);
      }

      // SSEストリーミング送信
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      const baseUrl = getApiBaseUrl();
      const url = `${baseUrl}/api/ai/consultation/sessions/${sessionId}/messages?stream=true`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 26000);

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ message: trimmed }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      if (!res.body) {
        // SSE非対応環境: メッセージ一覧を再取得
        const api = getApi();
        const msgRes = await api.get<{ messages: Message[] }>(
          `/api/ai/consultation/sessions/${sessionId}/messages`
        );
        setMessages(msgRes.messages ?? [WELCOME_MESSAGE]);
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

          const chunk = parsed?.choices?.[0]?.delta?.content;
          if (chunk) {
            accumulated += chunk;
            setStreamingContent(accumulated);
            continue;
          }

          if (parsed?.aiMessage) {
            finalHandled = true;
            setStreamingContent(null);
            const aiMsg: Message = {
              id: parsed.aiMessage.id ?? `ai-${Date.now()}`,
              role: "assistant",
              content: parsed.aiMessage.content ?? accumulated,
              createdAt: parsed.aiMessage.createdAt ?? new Date().toISOString(),
            };
            setMessages((prev) => {
              const withoutOptimistic = prev.filter(
                (m) => !m.id.startsWith("local-")
              );
              const userMsg: Message = parsed.userMessage
                ? {
                    id: parsed.userMessage.id,
                    role: "user",
                    content: parsed.userMessage.content ?? trimmed,
                    createdAt:
                      parsed.userMessage.createdAt ?? new Date().toISOString(),
                  }
                : optimistic;
              return [...withoutOptimistic, userMsg, aiMsg];
            });
          }
        }
      }

      if (!finalHandled) {
        setStreamingContent(null);
        if (accumulated) {
          const aiMsg: Message = {
            id: `ai-${Date.now()}`,
            role: "assistant",
            content: accumulated,
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => {
            const withoutOptimistic = prev.filter(
              (m) => !m.id.startsWith("local-")
            );
            return [...withoutOptimistic, optimistic, aiMsg];
          });
        } else {
          // 蓄積なし: 一覧再取得
          const api = getApi();
          const msgRes = await api.get<{ messages: Message[] }>(
            `/api/ai/consultation/sessions/${sessionId}/messages`
          );
          setMessages(msgRes.messages ?? [WELCOME_MESSAGE]);
        }
      }
    } catch (e: any) {
      setStreamingContent(null);
      if (e?.name === "AbortError") {
        Alert.alert("タイムアウト", "応答がタイムアウトしました。しばらく待ってから再度お試しください。");
      } else {
        Alert.alert("エラー", e?.message ?? "送信に失敗しました。");
      }
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("local-")));
    } finally {
      setSending(false);
    }
  }

  function handleQuickQuestion(question: string) {
    sendMessage(question);
  }

  function handleClose() {
    onClose();
  }

  // ウェルカムメッセージのみの状態かどうか
  const isWelcomeOnly =
    messages.length === 1 && messages[0].id === "welcome";

  return (
    <>
      <Modal
        testID="ai-advisor-sheet"
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleClose}
      >
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
        >
          {/* ヘッダー */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.headerIcon}>
                <Ionicons name="sparkles" size={16} color={colors.accent} />
              </View>
              <View>
                <Text style={styles.headerTitle}>AIアドバイザー</Text>
                <Text style={styles.headerSubtitle}>いつでも相談できます</Text>
              </View>
            </View>
            <Pressable
              testID="ai-close-btn"
              onPress={handleClose}
              style={styles.closeButton}
            >
              <Ionicons name="close" size={20} color={colors.textLight} />
            </Pressable>
          </View>

          {/* メッセージリスト */}
          <ScrollView
            ref={scrollRef}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            showsVerticalScrollIndicator={false}
          >
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}

            {/* ストリーミング中の仮メッセージ */}
            {streamingContent != null && (
              <MessageBubble
                key="streaming"
                message={{
                  id: "streaming",
                  role: "assistant",
                  content: streamingContent,
                  createdAt: new Date().toISOString(),
                }}
                isStreaming
              />
            )}

            {/* クイック質問チップ (ウェルカムのみ表示時) */}
            {isWelcomeOnly && (
              <View style={styles.quickQuestions}>
                {QUICK_QUESTIONS.map((q, i) => (
                  <Pressable
                    key={i}
                    testID={`ai-quick-question-${i}`}
                    onPress={() => handleQuickQuestion(q)}
                    style={styles.quickChip}
                  >
                    <Text style={styles.quickChipText}>{q}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>

          {/* クイックアクションバー */}
          <View style={styles.actionBar}>
            <Pressable
              testID="ai-day-menu-btn"
              onPress={() => setDayMenuModalVisible(true)}
              style={styles.dayMenuBtn}
            >
              <Ionicons name="calendar" size={14} color={colors.accent} />
              <Text style={styles.dayMenuBtnText}>1日献立を作成</Text>
            </Pressable>
          </View>

          {/* 入力欄 */}
          <View style={styles.inputRow}>
            <TextInput
              testID="ai-input"
              style={styles.input}
              value={inputText}
              onChangeText={setInputText}
              placeholder="メッセージを入力..."
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={1000}
              editable={!sending}
            />
            <Pressable
              testID="ai-send-btn"
              onPress={() => sendMessage(inputText)}
              disabled={!inputText.trim() || sending}
              style={[
                styles.sendButton,
                (!inputText.trim() || sending) && styles.sendButtonDisabled,
              ]}
            >
              {sending ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <Ionicons name="send" size={16} color="#FFF" />
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* 1日献立モーダル */}
      <AIDayMenuModal
        visible={dayMenuModalVisible}
        onClose={() => setDayMenuModalVisible(false)}
      />
    </>
  );
};

// ============================================================
// MessageBubble
// ============================================================

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isStreaming,
}) => {
  const isUser = message.role === "user";
  return (
    <View
      style={[
        styles.bubbleWrapper,
        isUser ? styles.bubbleWrapperUser : styles.bubbleWrapperAssistant,
      ]}
    >
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
        ]}
      >
        <Text
          style={[
            styles.bubbleText,
            isUser ? styles.bubbleTextUser : styles.bubbleTextAssistant,
          ]}
        >
          {message.content}
          {isStreaming && (
            <Text style={styles.cursor}>▌</Text>
          )}
        </Text>
      </View>
    </View>
  );
};

// ============================================================
// Styles
// ============================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    ...shadows.sm,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  headerIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  headerSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  bubbleWrapper: {
    flexDirection: "row",
    marginVertical: spacing.xs / 2,
  },
  bubbleWrapperUser: {
    justifyContent: "flex-end",
  },
  bubbleWrapperAssistant: {
    justifyContent: "flex-start",
  },
  bubble: {
    maxWidth: "80%",
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubbleUser: {
    backgroundColor: colors.accent,
    borderBottomRightRadius: radius.xs,
  },
  bubbleAssistant: {
    backgroundColor: colors.card,
    borderBottomLeftRadius: radius.xs,
    ...shadows.sm,
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  },
  bubbleTextUser: {
    color: "#FFF",
  },
  bubbleTextAssistant: {
    color: colors.text,
  },
  cursor: {
    color: colors.accent,
  },
  quickQuestions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  quickChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.card,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.accent,
    ...shadows.sm,
  },
  quickChipText: {
    fontSize: 12,
    color: colors.accent,
    fontWeight: "600",
  },
  actionBar: {
    flexDirection: "row",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  dayMenuBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  dayMenuBtnText: {
    fontSize: 12,
    color: colors.accent,
    fontWeight: "600",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: colors.text,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    backgroundColor: colors.textMuted,
  },
});
