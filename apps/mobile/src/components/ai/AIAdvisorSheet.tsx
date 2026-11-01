import { consultationAutoActionOutcomeOf, type ConsultationActionOutcome } from "@homegohan/shared";
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
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import type { ScrollViewInstance } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text, TextInput } from "../ui/Text";

import { getApi, getApiBaseUrl } from "../../lib/api";
import { getJapaneseApiErrorMessage } from "../../lib/api-error";
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
} from "../../lib/ai-chat-timeout";
import { notifyAiConsultationDataChanged } from "../../lib/ai-consultation-data-changed";
import { supabase } from "../../lib/supabase";
import { colors, radius, shadows, spacing } from "../../theme";
import { AIDayMenuModal } from "./AIDayMenuModal";
import { aiSummarySkippedNote, isAiConsentRequiredError, promptAiConsentRequired } from "../../lib/ai-consent";
import { errorOfFailedResponse, isStoppedByServerError, stoppedByServerAlertTitleOf } from "../../lib/failed-response";
import { isLegalConsentRequiredError } from "../../lib/legal-consent";
import { SERVICE_UNAVAILABLE_ALERT_TITLE, serviceUnavailableMessageOf } from "../../lib/service-unavailable";

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

/**
 * 自動実行の結果 (成功・失敗) を、チャットに足す AI 側のメッセージにする (#2189 W2。Web の AIChatBubble.tsx の actionOutcomeChatMessage と同じ文)。
 * id は結果を出す AI の返答の id から作る (同じ返答の結果は 1 つ。サーバーには保存しないので、相談を開き直すと出ない — Web と同じ)
 */
function autoActionOutcomeMessageOf(outcome: ConsultationActionOutcome, aiMessageId: string): Message {
  return {
    id: `action-${outcome.kind === "executed" ? "result" : "failed"}-${aiMessageId}`,
    role: "assistant",
    content: outcome.content,
    createdAt: new Date().toISOString(),
  };
}

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
  // 送信が時間切れになった送信。あるあいだ「最新の会話を読み込む」を出す (#1049 F7-18。扱いは src/lib/ai-chat-timeout.ts)
  const [timedOutSend, setTimedOutSend] = useState<TimedOutSend | null>(null);
  const [reloadingAfterTimeout, setReloadingAfterTimeout] = useState(false);

  const scrollRef = useRef<ScrollViewInstance>(null);

  // 同意が必要で止められたとき (T15 / #1154) の案内。シートの上の 1日献立のモーダルと、このシート (モーダル) を閉じてから出す
  // (閉じないと、案内から開いた同意画面がモーダルの下に隠れる)。シートは閉じても外されない (AIFloatingFab が置いたまま) ので、
  // 会話と入力は残る。案内の前に閉じてよい。メッセージの送信と、1日献立の作成 (AIDayMenuModal が自分を閉じてから呼ぶ) の両方で使う
  function closeSheetAndPromptAiConsent() {
    setDayMenuModalVisible(false);
    onClose();
    promptAiConsentRequired();
  }

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
  }, [messages.length, streamingContent, sending, timedOutSend]);

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

  /** 相談のメッセージをサーバーから取る。取れなければ null (画面をどうするかは呼び出し側が決める) */
  async function fetchMessages(sessionId: string): Promise<Message[] | null> {
    try {
      const api = getApi();
      const msgRes = await api.get<{ messages: Message[] }>(
        `/api/ai/consultation/sessions/${sessionId}/messages`
      );
      return msgRes.messages ?? [];
    } catch {
      return null;
    }
  }

  async function loadMessages(sessionId: string) {
    const loaded = await fetchMessages(sessionId);
    if (loaded && loaded.length > 0) {
      setMessages(loaded);
    } else {
      setMessages([WELCOME_MESSAGE]);
    }
  }

  /**
   * 送信が時間切れになったあと、相談のメッセージを取り直す (#1049 F7-18。扱いは src/lib/ai-chat-timeout.ts)。
   * 取れなければ、今の表示と案内をそのまま残す (今の会話を消さない)。
   * 送った文が届いていたら、入力欄に戻した文を消す (二重に送らないため)。返答がまだ無ければ案内を残す。
   * 届いていなければ、案内を消して、入力欄の文をもう一度送るように知らせる
   */
  async function reloadAfterTimeout() {
    const sent = timedOutSend;
    if (!sent || reloadingAfterTimeout) return;
    setReloadingAfterTimeout(true);
    try {
      const loaded = await fetchMessages(sent.sessionId);
      if (loaded === null) {
        Alert.alert("エラー", TIMEOUT_RELOAD_FAILED_MESSAGE);
        return;
      }
      setMessages(loaded.length > 0 ? loaded : [WELCOME_MESSAGE]);
      const outcome = timeoutReloadOutcomeOf(sent, loaded);
      if (outcome === "not-delivered") {
        setTimedOutSend(null);
        Alert.alert("送信できませんでした", TIMEOUT_NOT_DELIVERED_MESSAGE);
        return;
      }
      setInputText((current) => clearInputIfDelivered(current, sent.text));
      setTimedOutSend(outcome === "replied" ? null : { ...sent, delivered: true });
    } finally {
      setReloadingAfterTimeout(false);
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
      setTimedOutSend(null);
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
    setTimedOutSend(null);
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
        // 先に新しいセッションを作る。createNewSession は成功すると messages を [WELCOME_MESSAGE] に置き換えるので、
        // 要約 (または要約を省いた旨の一文) をその前に足すと、作成を待つ間しか出ずに消えてしまう (Web の AIChatBubble と同じ順)
        await createNewSession();
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
        } else {
          // 同意が無くて (または同意の状況を読めなくて) サーバーが要約 (AI) を省いた (T15 / #1154): その旨を一言だけ出す
          const skippedNote = aiSummarySkippedNote(data);
          if (skippedNote) {
            setMessages((prev) => [
              ...prev,
              {
                id: `summary-skipped-${Date.now()}`,
                role: "assistant",
                content: skippedNote,
                createdAt: new Date().toISOString(),
              },
            ]);
          }
        }
      } else if (res.status === 400) {
        // Already closed: UI を最新に合わせる
        Alert.alert("情報", "このセッションは既にアーカイブ済みです。");
        await fetchSessions();
      } else {
        const err = await res.json().catch(() => ({}));
        // 規約・プライバシーポリシーへの同意が必要 (403 LEGAL_CONSENT_REQUIRED。#1442): errorOfFailedResponse が LegalConsentProvider に
        // 知らせ (ゲートが同意画面だけにする)、固定の文の例外を返す。本文は JSON で読んだ後なので文字列に戻して渡す
        // (`HTTP <状態>: <本文>` の Error を自分で作らない。tests/mobile-service-unavailable-raw-fetch.test.ts)。
        // 503 (緊急停止・メンテナンス中など) とそれ以外の失敗は、下の今の分岐のまま
        const failure = errorOfFailedResponse(res.status, JSON.stringify(err));
        if (isLegalConsentRequiredError(failure)) {
          Alert.alert(stoppedByServerAlertTitleOf(failure), failure.message);
          return;
        }
        // AI 相談の緊急停止中・メンテナンス中 (#1457)・同意の状況を読めなかった 503 (#1486): 本文の文字列ではなく、
        // code から決めた固定の文を出す (#1486 より前のサーバーは、メンテナンス中の本文の error がオブジェクトだった)
        const unavailableMessage = serviceUnavailableMessageOf(res.status, err);
        if (unavailableMessage) {
          Alert.alert(SERVICE_UNAVAILABLE_ALERT_TITLE, unavailableMessage);
          return;
        }
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

    // 時間切れのあとの取り直しで、送った文が届いたかを見分けるため、送る前に出ていたサーバーのメッセージの id を持つ
    const knownMessageIds = messages.filter((m) => m.id !== WELCOME_MESSAGE.id && !m.id.startsWith("local-")).map((m) => m.id);

    setSending(true);
    setInputText("");
    setStreamingContent(null);
    setTimedOutSend(null);

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

    // 時間切れのあとの取り直しに使うので、try の外で持つ
    let sessionId = currentSessionId;
    try {
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
      const timeoutId = setTimeout(() => controller.abort(), AI_CHAT_STREAM_TIMEOUT_MS);

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
        // 429 AI_DAILY_LIMIT (#1149)・503 の緊急停止・メンテナンス中 (#1457) は、固定の文の例外にする (生の本文を画面に出さない)
        throw errorOfFailedResponse(res.status, errText);
      }

      let accumulated = "";
      let finalHandled = false;

      // SSE の 1 行を読む。本文の断片は表示中の返答に足し、最後の finalData (aiMessage) で会話を確定させる
      const handleSseLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        const raw = line.slice(6);
        if (raw === "[DONE]") return;

        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }

        const chunk = parsed?.choices?.[0]?.delta?.content;
        if (chunk) {
          accumulated += chunk;
          setStreamingContent(accumulated);
          return;
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
          // サーバーが提案を自動で実行した結果 (finalData の actionResult) を、AI の返答のすぐ後に AI 側のメッセージで出す。
          // 失敗 (success が真でない) は成功の一文を出さず、失敗の文を出す。黙って失敗させない (#2189 W2。Web は #2183 Z1)
          const autoAction = consultationAutoActionOutcomeOf(parsed);
          const outcomeMessages: Message[] = autoAction ? [autoActionOutcomeMessageOf(autoAction.outcome, aiMsg.id)] : [];
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
            return [...withoutOptimistic, userMsg, aiMsg, ...outcomeMessages];
          });
          // 実行できたら、データ (献立・食事・買い物リストなど) を出すタブの WebView を読み込み直す (Web の mealPlanUpdated に当たる)
          if (autoAction?.outcome.kind === "executed") notifyAiConsultationDataChanged();
        }
      };

      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) handleSseLine(line);
        }
        buffer += decoder.decode();
        handleSseLine(buffer);
      } else {
        // 本文を流し読みできない環境: 最後まで受け取った本文を同じように行ごとに読む。
        // 以前はメッセージ一覧を取り直すだけで、自動実行の結果 (finalData の actionResult) を捨てていた (#2189 W2)。
        // 本文を読めない・何も読み取れなければ、下でメッセージ一覧を取り直す (以前と同じ)
        const text = await res.text().catch(() => "");
        for (const line of text.split("\n")) handleSseLine(line);
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
      // 同意が必要で止められた (T15 / #1154): 送らなかったので、メッセージを消して入力を戻す。
      // このシート (モーダル) を閉じてから同意画面への案内を出す (closeSheetAndPromptAiConsent)
      if (isAiConsentRequiredError(e)) {
        setMessages((prev) => prev.filter((m) => !m.id.startsWith("local-")));
        setInputText(trimmed);
        closeSheetAndPromptAiConsent();
        return;
      }
      // 今日の AI の利用回数の上限 (#1149)・AI 相談の緊急停止中・メンテナンス中 (#1457) で止められた:
      // 送らなかったので、メッセージを消して入力を戻し、固定の文を出す
      // (見出しは、緊急停止・メンテナンス中は「ご利用いただけません」、上限は「エラー」)
      if (isStoppedByServerError(e)) {
        setMessages((prev) => prev.filter((m) => !m.id.startsWith("local-")));
        setInputText(trimmed);
        Alert.alert(stoppedByServerAlertTitleOf(e), e.message);
        return;
      }
      if (e?.name === "AbortError") {
        // 待ちを打ち切っただけで、サーバーでは返答の保存が続いていることがある (#1049 F7-18)。
        // 失敗として終わらせず、会話を取り直す導線 (TIMEOUT_RELOAD_LABEL) を出し、送った文を入力欄に戻す
        // (届いていたかは取り直しで分かる。届いていたら、戻した文はそこで消す)
        setInputText((current) => restoreInputAfterTimeout(current, trimmed));
        if (sessionId) {
          setTimedOutSend({ sessionId, text: trimmed, knownMessageIds, delivered: false });
        } else {
          Alert.alert("タイムアウト", TIMEOUT_NOTICE_MESSAGE);
        }
      } else {
        // 本文の文だけを出す (`HTTP 404: {"error":…}` の生の文字列を出さない。#1917)
        Alert.alert("エラー", getJapaneseApiErrorMessage(e, "送信に失敗しました。"));
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

                  {/* 送信が時間切れになったときの、取り直しの導線 (#1049 F7-18) */}
                  {timedOutSend != null && timedOutSend.sessionId === currentSessionId && !sending && (
                    <View testID="ai-timeout-notice" style={styles.timeoutNotice}>
                      <Text style={styles.timeoutNoticeText}>
                        {timedOutSend.delivered ? TIMEOUT_DELIVERED_NO_REPLY_MESSAGE : TIMEOUT_NOTICE_MESSAGE}
                      </Text>
                      <Pressable
                        testID="ai-timeout-reload"
                        accessibilityRole="button"
                        onPress={reloadAfterTimeout}
                        disabled={reloadingAfterTimeout}
                        style={[styles.timeoutReloadBtn, reloadingAfterTimeout && styles.sendButtonDisabled]}
                      >
                        {reloadingAfterTimeout ? (
                          <ActivityIndicator size="small" color={colors.accent} />
                        ) : (
                          <Text style={styles.timeoutReloadLabel}>{TIMEOUT_RELOAD_LABEL}</Text>
                        )}
                      </Pressable>
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

      {/*
        1日献立モーダル。同意が必要で止められたら、このシートも閉じてから案内を出す (シートが同意画面を隠さないように)。
        シートが閉じられたら一緒に閉じる (visible && …。シートの上に重ねたモーダルだけが残らないように)
      */}
      <AIDayMenuModal
        visible={visible && dayMenuModalVisible}
        onClose={() => setDayMenuModalVisible(false)}
        onAiConsentRequired={closeSheetAndPromptAiConsent}
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
  timeoutNotice: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningLight,
  },
  timeoutNoticeText: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.warningText,
  },
  timeoutReloadBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.card,
  },
  timeoutReloadLabel: {
    fontSize: 13,
    color: colors.accent,
    fontWeight: "600",
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
