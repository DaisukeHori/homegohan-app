import { LinearGradient } from "expo-linear-gradient";
import {
  Archive,
  Calendar,
  ChevronDown,
  MessageCircle,
  Send,
  Sparkles,
  X,
} from "lucide-react-native";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { getApi, getApiBaseUrl } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { colors, radius, shadows, spacing } from "../../theme";
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
// TypingIndicator
// ============================================================

const TypingIndicator: React.FC = () => {
  const animations = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    const sequences = animations.map((anim, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(anim, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }),
        ])
      )
    );
    sequences.forEach((s) => s.start());
    return () => sequences.forEach((s) => s.stop());
  }, []);

  return (
    <View style={styles.typingIndicatorContainer}>
      {animations.map((anim, i) => (
        <Animated.View
          key={i}
          style={[
            styles.typingDot,
            {
              transform: [
                {
                  translateY: anim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, -4],
                  }),
                },
              ],
              opacity: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [0.4, 1],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
};

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
  const [showSessionList, setShowSessionList] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [dayMenuModalVisible, setDayMenuModalVisible] = useState(false);
  const [isClosingSession, setIsClosingSession] = useState(false);

  const scrollRef = useRef<ScrollView>(null);

  // 起動時セッション一覧取得
  useEffect(() => {
    if (!visible) return;
    initSession();
  }, [visible]);

  // メッセージ追加時にスクロール
  useEffect(() => {
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 100);
    return () => clearTimeout(t);
  }, [messages.length, streamingContent, sending]);

  async function initSession() {
    try {
      const api = getApi();
      const res = await api.get<{ sessions: Session[] }>(
        "/api/ai/consultation/sessions?status=all"
      );
      const allSessions = res.sessions ?? [];
      setSessions(allSessions);

      const active = allSessions.find((s) => s.status === "active");
      if (active) {
        await loadMessages(active.id);
        setCurrentSessionId(active.id);
      } else if (allSessions.length > 0) {
        await loadMessages(allSessions[0].id);
        setCurrentSessionId(allSessions[0].id);
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
      setMessages([WELCOME_MESSAGE]);
    }
  }

  async function loadMessages(sessionId: string) {
    try {
      const api = getApi();
      const msgRes = await api.get<{ messages: Message[] }>(
        `/api/ai/consultation/sessions/${sessionId}/messages`
      );
      const loaded = msgRes.messages ?? [];
      if (loaded.length > 0) {
        setMessages(loaded);
      } else {
        setMessages([WELCOME_MESSAGE]);
      }
    } catch {
      setMessages([WELCOME_MESSAGE]);
    }
  }

  async function createNewSession() {
    try {
      const api = getApi();
      const createRes = await api.post<{
        success: boolean;
        session: { id: string };
      }>("/api/ai/consultation/sessions", { title: "AI相談" });
      setCurrentSessionId(createRes.session.id);
      setMessages([WELCOME_MESSAGE]);
      setShowSessionList(false);
      // セッション一覧を更新
      const res = await api.get<{ sessions: Session[] }>(
        "/api/ai/consultation/sessions?status=all"
      );
      setSessions(res.sessions ?? []);
    } catch {
      Alert.alert("エラー", "新しいセッションの作成に失敗しました。");
    }
  }

  async function selectSession(sessionId: string) {
    setCurrentSessionId(sessionId);
    setShowSessionList(false);
    await loadMessages(sessionId);
  }

  async function fetchSessions() {
    try {
      const api = getApi();
      const res = await api.get<{ sessions: Session[] }>(
        "/api/ai/consultation/sessions?status=all"
      );
      setSessions(res.sessions ?? []);
    } catch {
      // 取得失敗は無視
    }
  }

  async function archiveSession() {
    if (!currentSessionId || isClosingSession) return;

    // クライアント側で既に closed か確認
    const currentSession = sessions.find((s) => s.id === currentSessionId);
    if (currentSession?.status === "closed") {
      Alert.alert("情報", "このセッションは既にアーカイブ済みです。");
      return;
    }

    setIsClosingSession(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      const baseUrl = getApiBaseUrl();
      const res = await fetch(
        `${baseUrl}/api/ai/consultation/sessions/${currentSessionId}/close`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.summary) {
          setMessages((prev) => [
            ...prev,
            {
              id: `summary-${Date.now()}`,
              role: "assistant",
              content: `📝 相談を要約しました：\n\n${data.summary.summary}`,
              createdAt: new Date().toISOString(),
            },
          ]);
        }
        await createNewSession();
      } else if (res.status === 400) {
        // Already closed: UI を最新に合わせる
        Alert.alert("情報", "このセッションは既にアーカイブ済みです。");
        await fetchSessions();
      } else {
        const err = await res.json().catch(() => ({}));
        Alert.alert(
          "エラー",
          (err as any)?.message ||
            (err as any)?.error ||
            "セッションのアーカイブに失敗しました。"
        );
      }
    } catch {
      Alert.alert("エラー", "セッションのアーカイブに失敗しました。");
    } finally {
      setIsClosingSession(false);
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
    setMessages((prev) => {
      // ウェルカムメッセージを除いて追加
      const withoutWelcome = prev.filter((m) => m.id !== "welcome");
      return [...withoutWelcome, optimistic];
    });

    try {
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
        await loadMessages(sessionId);
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
              createdAt:
                parsed.aiMessage.createdAt ?? new Date().toISOString(),
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
                      parsed.userMessage.createdAt ??
                      new Date().toISOString(),
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
          await loadMessages(sessionId);
        }
      }
    } catch (e: any) {
      setStreamingContent(null);
      if (e?.name === "AbortError") {
        Alert.alert(
          "タイムアウト",
          "応答がタイムアウトしました。しばらく待ってから再度お試しください。"
        );
      } else {
        Alert.alert("エラー", e?.message ?? "送信に失敗しました。");
      }
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("local-")));
    } finally {
      setSending(false);
    }
  }

  // ウェルカムメッセージのみの状態かどうか
  const isWelcomeOnly =
    messages.length === 1 && messages[0].id === "welcome";

  // typing indicator を表示するか: 送信中かつストリームがまだ来ていない
  const showTypingIndicator = sending && streamingContent === null;

  return (
    <>
      <Modal
        testID="ai-advisor-sheet"
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
        >
          <SafeAreaView style={styles.safeArea}>
            <View style={styles.container}>
              {/* ヘッダー */}
              <View style={styles.header}>
                <View style={styles.headerLeft}>
                  <LinearGradient
                    colors={[colors.accent, colors.warning]}
                    style={styles.iconCircle}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                  >
                    <Sparkles size={16} color="#FFF" />
                  </LinearGradient>
                  <View>
                    <Text style={styles.headerTitle}>AIアドバイザー</Text>
                    <Text style={styles.headerSubtitle}>
                      いつでも相談できます
                    </Text>
                  </View>
                </View>
                <View style={styles.headerActions}>
                  <Pressable
                    testID="ai-archive-btn"
                    onPress={archiveSession}
                    disabled={
                      isClosingSession ||
                      !currentSessionId ||
                      sessions.find((s) => s.id === currentSessionId)
                        ?.status === "closed"
                    }
                    style={styles.headerActionBtn}
                  >
                    {isClosingSession ? (
                      <ActivityIndicator
                        size="small"
                        color={colors.textLight}
                      />
                    ) : (
                      <Archive size={20} color={colors.textLight} />
                    )}
                  </Pressable>
                  <Pressable
                    testID="ai-toggle-sessions"
                    onPress={() => setShowSessionList(!showSessionList)}
                    style={styles.headerActionBtn}
                  >
                    <ChevronDown size={20} color={colors.textLight} />
                  </Pressable>
                  <Pressable
                    testID="ai-close-btn"
                    onPress={onClose}
                    style={styles.headerActionBtn}
                  >
                    <X size={20} color={colors.textLight} />
                  </Pressable>
                </View>
              </View>

              {/* ボディ */}
              {showSessionList ? (
                /* セッション一覧モード */
                <ScrollView
                  style={styles.body}
                  contentContainerStyle={styles.bodyContent}
                >
                  <Pressable
                    testID="ai-new-session"
                    onPress={createNewSession}
                    style={styles.newSessionBtn}
                  >
                    <MessageCircle size={16} color={colors.accent} />
                    <Text style={styles.newSessionLabel}>
                      新しい相談を始める
                    </Text>
                  </Pressable>
                  {sessions.map((s) => (
                    <Pressable
                      key={s.id}
                      testID={`ai-session-${s.id}`}
                      onPress={() => selectSession(s.id)}
                      style={[
                        styles.sessionRow,
                        currentSessionId === s.id && styles.sessionRowActive,
                      ]}
                    >
                      <Text style={styles.sessionRowText}>
                        AI相談 ({s.messageCount}件)
                      </Text>
                      {s.status === "closed" && (
                        <View style={styles.closedBadge}>
                          <Text style={styles.closedBadgeText}>終了</Text>
                        </View>
                      )}
                    </Pressable>
                  ))}
                </ScrollView>
              ) : (
                /* 通常メッセージモード */
                <ScrollView
                  ref={scrollRef}
                  style={styles.body}
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

                  {/* 応答待ち typing indicator */}
                  {showTypingIndicator && (
                    <View style={styles.bubbleWrapperAssistant}>
                      <View style={styles.bubbleAssistant}>
                        <TypingIndicator />
                      </View>
                    </View>
                  )}

                  {/* クイック質問チップ (ウェルカムのみ表示時) */}
                  {isWelcomeOnly && (
                    <View style={styles.quickQuestions}>
                      {QUICK_QUESTIONS.map((q, i) => (
                        <Pressable
                          key={i}
                          testID={`ai-quick-${i}`}
                          onPress={() => sendMessage(q)}
                          style={styles.quickChip}
                        >
                          <Text style={styles.quickChipText}>{q}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </ScrollView>
              )}

              {/* クイックアクションバー */}
              <View style={styles.actionBar}>
                <Pressable
                  testID="ai-day-menu-btn"
                  onPress={() => setDayMenuModalVisible(true)}
                  style={styles.dayMenuBtn}
                >
                  <Calendar size={14} color={colors.accent} />
                  <Text style={styles.dayMenuBtnText}>1日献立変更</Text>
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
                    <Send size={16} color="#FFF" />
                  )}
                </Pressable>
              </View>
            </View>
          </SafeAreaView>
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
          {isStreaming && <Text style={styles.cursor}>▌</Text>}
        </Text>
      </View>
    </View>
  );
};

// ============================================================
// Styles
// ============================================================

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
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
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
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
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  headerActionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: spacing.md,
    gap: spacing.xs,
  },
  messageListContent: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  newSessionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    marginBottom: spacing.sm,
  },
  newSessionLabel: {
    fontSize: 13,
    color: colors.accent,
    fontWeight: "600",
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    marginBottom: spacing.xs,
    ...shadows.sm,
  },
  sessionRowActive: {
    backgroundColor: colors.accentLight,
  },
  sessionRowText: {
    flex: 1,
    fontSize: 13,
    color: colors.text,
  },
  closedBadge: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
  },
  closedBadgeText: {
    fontSize: 10,
    color: colors.textMuted,
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
    borderBottomRightRadius: radius.sm,
  },
  bubbleAssistant: {
    backgroundColor: colors.card,
    borderBottomLeftRadius: radius.sm,
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
  typingIndicatorContainer: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: 5,
  },
  typingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#999",
  },
});
