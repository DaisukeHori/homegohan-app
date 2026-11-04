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
  AI_CHAT_RELOAD_TIMEOUT_MS,
  AI_CHAT_STREAM_TIMEOUT_MS,
  PREVIOUS_REQUEST_RECHECK_DELAY_MS,
  REPLY_FAILED_MESSAGE,
  TIMEOUT_DELIVERY_UNCONFIRMED_MESSAGE,
  TIMEOUT_DELIVERY_UNCONFIRMED_TITLE,
  TIMEOUT_NOTICE_MESSAGE,
  TIMEOUT_NOT_DELIVERED_MESSAGE,
  TIMEOUT_RELOAD_FAILED_MESSAGE,
  TIMEOUT_RELOAD_LABEL,
  clearInputIfDelivered,
  messagesAfterPreviousRequestRecheck,
  previousRequestActionStateOf,
  previousRequestNoteIdOf,
  previousRequestNotePlanOf,
  previousRequestNoteTextOf,
  previousRequestRecheckPlanOf,
  replyHasProposalOf,
  replyProposalExecutableOf,
  resolveUnconfirmedSendRows,
  restoreInputAfterTimeout,
  settleWithin,
  timedOutSendNoticeOf,
  timedOutSendReloadOf,
  type PreviousRequestActionRead,
  type PreviousRequestNoteState,
  type SentText,
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
  /**
   * 会話の GET が返す、返答の提案 (このシートは描かない)。取り直した返答に提案があるかを、共有の replyHasProposalOf で読む
   * (#2206 G2。提案の記録の行がまだ無いときも、実行中の印と同じく一文を出して読み直すため)
   */
  proposedActions?: unknown;
  /**
   * 会話の GET が返す、返答の提案に「実行する」を出すか (行が実行を待つ pending のときだけ true)。記録の直読みだけが失敗したときに、
   * 共有の replyProposalExecutableOf で読む (#2227 H1)
   */
  proposedActionExecutable?: unknown;
};

type Session = {
  id: string;
  title: string;
  messageCount: number;
  status?: string;
};

/**
 * 応答を最後まで受け取れなかった送信 (時間切れ・通信の切断・流れが途中で切れた。#2227 H1)。seq はこのシートの中で送信ごとに 1 つずつ
 * 増える番号で、送信の見分けと、古い順に並べるのに使う (同じ文を続けて送っても、別の送信として扱う)
 */
type PendingSend = TimedOutSend & { seq: number };

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

/**
 * 応答を受け取れずに取り直した会話で、送った文への返答 (replyId) の提案の状態 (実行できた・実行中の印のまま・実行していない) を
 * 知らせる一文 (#2195 V3・#2201 U3・#2206 G2。決まりは packages/shared/src/consultation-reply-reload.ts)。
 * id は状態ごとに決める (実行できた・実行していないときは自動実行の結果の一文 autoActionOutcomeMessageOf と同じ形。
 * 同じ返答の結果は 1 つ)。サーバーには保存しない
 */
function previousRequestNoteOf(state: PreviousRequestNoteState, replyId: string): Message {
  return {
    id: previousRequestNoteIdOf(state, replyId),
    role: "assistant",
    content: previousRequestNoteTextOf(state),
    createdAt: new Date().toISOString(),
  };
}

/** 記録を読めなかったときの結果 (実行したと言い切れない。共有の previousRequestNotePlanOf が 1 回だけ読み直させる) */
const UNREADABLE_REPLY_ACTION_STATE: PreviousRequestActionRead = { state: "none", readFailed: true };

/**
 * 返答 (messageId) に付いた提案の記録 (ai_action_logs) の状態 (#2195 V3・#2201 U3。扱いは src/lib/ai-chat-timeout.ts)。
 * 読むのは自分の相談の行だけ (行の安全は RLS の「自分の相談の行」の決まりが守る)。読めなければ none と readFailed
 * (実行したと言い切れない。行が無いのと分けて、共有の決まりが 1 回だけ読み直させる。#2206 G2。Web の readReplyActionStateOf と同じ)
 */
function replyActionStateOf(messageId: string): Promise<PreviousRequestActionRead> {
  // AI_CHAT_RELOAD_TIMEOUT_MS までに読めなければ、読めなかったときと同じにする (#2227 H1。取り直しは送信中に待つので、
  // 読み取りが返らないと送信中のまま入力が止まる。Web の readReplyActionStateOf と同じ)
  return settleWithin(replyActionStateWithoutLimitOf(messageId), AI_CHAT_RELOAD_TIMEOUT_MS, UNREADABLE_REPLY_ACTION_STATE);
}

/** replyActionStateOf の読み取りの本体 (待ちの上限は付けない) */
async function replyActionStateWithoutLimitOf(messageId: string): Promise<PreviousRequestActionRead> {
  try {
    const { data, error } = await supabase.from("ai_action_logs").select("status").eq("message_id", messageId);
    if (error) return UNREADABLE_REPLY_ACTION_STATE;
    return { state: previousRequestActionStateOf(data), readFailed: false };
  } catch {
    return UNREADABLE_REPLY_ACTION_STATE;
  }
}

/**
 * 取り直した会話に足す前の依頼の一文と、少し待って 1 回だけ読み直す返答 (読み直さないなら null。replyHasProposal は取り直した
 * 返答に提案があったか。読み直しで行がまだ無いときの扱いに使う。#2227 H1)
 */
type PreviousRequestNote = { notes: Message[]; recheck: { replyId: string; replyHasProposal: boolean } | null };

const NO_PREVIOUS_REQUEST_NOTE: PreviousRequestNote = { notes: [], recheck: null };

/**
 * 応答 (finalData) を受け取れずに取り直した会話で、送った文への AI の返答 (reply。timedOutSendReloadOf が探したもの) の提案の記録を読み、足す一文・
 * 知らせるか・読み直すかを共有の previousRequestNotePlanOf で決める (Web の AIChatBubble の placeReloadedReply と同じ決まり。
 * #2206 G2。以前はこのシートに判定の写しがあり、Web にだけ足した 2 つの決まりが無かった)。
 *   - 実行できていれば、実行できた一文を足し、データを出すタブの WebView に知らせる (notifyAiConsultationDataChanged)
 *   - 実行中の印のまま、または記録の行がまだ無い・読めないのに返答に提案がある (サーバーは返答を保存してから行を作る) なら、
 *     結果をまだ確かめられないと伝える一文 (頼み直しを勧めない) を足し、読み直す返答 (recheck) を返す (呼び出し側が
 *     recheckPreviousRequestLater で 1 回読み直す)
 *   - 実行を待つ・失敗した行なら、実行していない一文を足す
 *   - 提案が無く記録を読めなかったときは、一文を足さずに読み直す返答 (recheck) を返す (GET は実行できた提案を出さないので、
 *     読めないと実行できたかが分からない)
 *   - 行が無いなら空 (時間切れの取り直しと、応答を受け取れなかったときの取り直しの両方で使う。返答が無いときは呼ばない)
 */
async function previousRequestNoteAfterReload(reply: Message): Promise<PreviousRequestNote> {
  const read = await replyActionStateOf(reply.id);
  const replyHasProposal = replyHasProposalOf(reply);
  const plan = previousRequestNotePlanOf({
    actionState: read.state,
    readFailed: read.readFailed,
    replyHasProposal,
    replyProposalExecutable: replyProposalExecutableOf(reply),
  });
  if (plan.notifyDataChanged) notifyAiConsultationDataChanged();
  return {
    notes: plan.noteState ? [previousRequestNoteOf(plan.noteState, reply.id)] : [],
    recheck: plan.recheck ? { replyId: reply.id, replyHasProposal } : null,
  };
}

/** 送信の待ちの上限で本文の読み取りをやめたときの例外 (catch は name が AbortError の例外を時間切れとして扱う。#2206 G2) */
function streamTimeoutError(): Error {
  const error = new Error("AI 相談の応答の読み取りが待ちの上限を過ぎました");
  error.name = "AbortError";
  return error;
}

/**
 * 会話の続きの POST (SSE) の 1 行の data の形 (本文の断片か、最後の finalData)。サーバーは
 * src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts。自動実行の結果 (actionResult) は
 * consultationAutoActionOutcomeOf が unknown のまま読む
 */
type SseEvent = {
  choices?: { delta?: { content?: unknown } }[];
  /** サーバーが失敗を知らせた (userMessage が無く error だけの行は、失敗の行も DB に書けなかったとき。#2227 H1) */
  error?: unknown;
  userMessage?: { id: string; content?: string; createdAt?: string } | null;
  aiMessage?: { id?: string; content?: string; createdAt?: string } | null;
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
  // 送信が時間切れになった送信。あるあいだ「最新の会話を読み込む」を出す (#1049 F7-18。扱いは src/lib/ai-chat-timeout.ts)。
  // 案内は出すだけの入れ物で、届いたかを確かめていない送信の記録は pendingSendsRef が持つ (#2227 H1。案内を外す・書き換えるときに
  // 記録を気にしなくてよい)。書き換えは showTimedOutSend だけが行う (await をまたぐ処理が今の案内を timedOutSendRef で見る)
  const [timedOutSend, setTimedOutSend] = useState<PendingSend | null>(null);
  const timedOutSendRef = useRef<PendingSend | null>(null);
  const [reloadingAfterTimeout, setReloadingAfterTimeout] = useState(false);

  const scrollRef = useRef<ScrollViewInstance>(null);
  // 今出している相談の id。取り直し・送信の応答は await をまたぐので、その間に相談を切り替えたら、前の相談の会話・送った文を今の画面
  // (会話・入力欄) に書かない (#2227 H1。Web の AIChatBubble の currentSessionIdRef と同じ)。state ではなく ref で今の値を見る
  // 切り替えた時点で ref も変える (描画を待つと、切り替えの直後に返った取り直し・応答が古い値を見る)
  const currentSessionIdRef = useRef<string | null>(null);
  // 切り替えたら、流れの途中の本文 (streamingContent) も消す (#2227 H1。前の相談の返答の断片を今の画面に残さない。
  // 前の相談の送信の続きの断片は handleSseLine が今の画面に流さない)
  function showSessionId(sessionId: string | null) {
    if (currentSessionIdRef.current !== sessionId) setStreamingContent(null);
    currentSessionIdRef.current = sessionId;
    setCurrentSessionId(sessionId);
  }
  // 入力欄に送った文を戻した (戻すはずだった) 送信のうち、入力欄の始末がまだのもの (#2227 H1。Web の AIChatBubble が
  // 入力欄に戻すときに覚えるのと同じ)。入力欄に戻すその場で積む (registerPendingSend)。後の取り直しで保存行が見つかったら、
  // 入力欄が戻した文のままなら消す (settlePendingSends。そのまま送ると同じ相談に二重に届く)。
  //   - delivered が偽: 届いたかまだ分からない (後の取り直しで保存行を探す。決まりは共有の resolveUnconfirmedSendRows)
  //   - delivered が真: 届いていたと分かったが、別の相談を出していて入力欄の文を消せていない (その相談を出したときに消す)
  const pendingSendsRef = useRef<PendingSend[]>([]);
  // 送信の番号 (PendingSend の seq) の最後の値
  const lastSendSeqRef = useRef(0);
  // 届いていたと分かった送信 (seq) と、その送信に当てた送った文の保存行の id (#2227 H1)。ある送信の取り直しの最中に、別の取り直しが
  // その送信の保存行を先に当てたとき、後から返った取り直しはこの行で送った文と返答を探す (『届いていません』と取り違えない)
  const savedRowOfSendRef = useRef<Map<number, string>>(new Map());
  // 送信に当てた送った文の保存行の id (同じ文を続けて送ったときに、前の送信の保存行を今回の送信と取り違えない)
  const claimedSavedUserIdsRef = useRef<string[]>([]);
  // 前の依頼の記録が実行中の印のままだったときの、読み直しの予約 (#2201 U3)。シートを外すときに取り消す
  const previousRequestRecheckTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = previousRequestRecheckTimersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  /**
   * 前の依頼の記録が実行中の印のまま (行がまだ無いのに提案があるときも含む)・読めなかった返答 (replyId) を、
   * PREVIOUS_REQUEST_RECHECK_DELAY_MS 待ってから 1 回だけ読み直す (#2201 U3・#2206 G2)。一文をどうするか・知らせるかは
   * 共有の previousRequestRecheckPlanOf と messagesAfterPreviousRequestRecheck が決める (Web の AIChatBubble と同じ決まり)。
   * 実行できた行になっていれば、実行中の一文を『前の依頼は実行されました』に置き換え (一文が無ければ返答のすぐ後に足す。
   * 記録を読めずに一文を出さなかったとき)、データを出すタブの WebView に知らせる。
   * 実行を待つ・失敗した行になっていれば、実行中の一文を『前の依頼は実行できませんでした』に置き換える (#2206 G2。以前は
   * 実行中の一文のまま残った)。読めたのに行がまだ無く、返答に提案がある (replyHasProposal) ときも同じ (サーバーは行を作れなかったら
   * 実行しない。#2227 H1)。まだ実行中の印のまま・行が無い・読めないときは何もしない (一文はそのまま。頼み直しを勧めない)。
   * 別の相談に切り替えていても知らせる (データは変わっている)。一文は今の会話に無ければ触らない
   */
  function recheckPreviousRequestLater(replyId: string, replyHasProposal: boolean) {
    const timers = previousRequestRecheckTimersRef.current;
    const timer = setTimeout(() => {
      timers.delete(timer);
      void (async () => {
        const read = await replyActionStateOf(replyId);
        const plan = previousRequestRecheckPlanOf(read, replyHasProposal);
        if (plan.notifyDataChanged) notifyAiConsultationDataChanged();
        setMessages((prev) =>
          messagesAfterPreviousRequestRecheck(prev, {
            replyId,
            plan,
            noteOf: (noteState) => previousRequestNoteOf(noteState, replyId),
          }),
        );
      })();
    }, PREVIOUS_REQUEST_RECHECK_DELAY_MS);
    timers.add(timer);
  }

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

      // 出す相談の id を先に変えてから会話を取る (#2227 H1。selectSession・Web の AIChatBubble と同じ順。後に変えると、取り直しで
      // 確かめられなかった送信の保存行が見つかっても、前に出していた相談を今の相談と見て入力欄の文を消さなかった)
      const active = allSessions.find((s) => s.status === "active");
      if (active) {
        showSessionId(active.id);
        await loadMessages(active.id);
      } else if (allSessions.length > 0) {
        showSessionId(allSessions[0].id);
        await loadMessages(allSessions[0].id);
      } else {
        // 新規セッション作成
        const createRes = await api.post<{
          success: boolean;
          session: { id: string };
        }>("/api/ai/consultation/sessions", { title: "AI相談" });
        showSessionId(createRes.session.id);
        setMessages([WELCOME_MESSAGE]);
      }
    } catch {
      setMessages([WELCOME_MESSAGE]);
    }
  }

  /**
   * 相談のメッセージをサーバーから取る。取れなければ null (画面をどうするかは呼び出し側が決める)。
   * 応答を受け取れなかったあとの取り直し (reload) は、Web と同じ上限 (AI_CHAT_RELOAD_TIMEOUT_MS) で打ち切る (#2227 H1。
   * 取り直しは送信中に待つので、/api/ai/ の下の GET の既定 (120 秒) のままだと、GET が詰まると『送信中』で入力欄が止まった)
   */
  async function fetchMessages(sessionId: string, options: { reload: boolean }): Promise<Message[] | null> {
    try {
      const api = getApi();
      const path = `/api/ai/consultation/sessions/${sessionId}/messages`;
      const msgRes = options.reload
        ? await api.get<{ messages: Message[] }>(path, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS })
        : await api.get<{ messages: Message[] }>(path);
      return msgRes.messages ?? [];
    } catch {
      return null;
    }
  }

  async function loadMessages(sessionId: string) {
    const loaded = await fetchMessages(sessionId, { reload: false });
    if (loaded && loaded.length > 0) {
      setMessages(loaded);
    } else {
      setMessages([WELCOME_MESSAGE]);
    }
    // 確かめられなかった前の送信が届いていたら、入力欄に戻した文を消す (#2227 H1)。開き直した会話は以後の送信の
    // 「送る前に出ていた行」に入るので、見つからなかった送信は忘れる
    if (loaded) settlePendingSends({ sessionId, loaded, current: null, currentAccepted: false, forgetRemaining: true });
  }

  /** 送った文の保存行 (id) をその送信に当てた印を付ける (確かめられなかった前の送信がこの行を自分のものとして当てないように) */
  function claimSavedUserMessageId(id: unknown) {
    if (typeof id !== "string" || claimedSavedUserIdsRef.current.includes(id)) return;
    claimedSavedUserIdsRef.current = [...claimedSavedUserIdsRef.current, id];
  }

  /** 次の送信の番号 (PendingSend の seq) */
  function nextSendSeq(): number {
    lastSendSeqRef.current += 1;
    return lastSendSeqRef.current;
  }

  /**
   * 時間切れの案内 (timedOutSend) を出す・外す (#2227 H1)。案内は出すだけの入れ物なので、外すときに送信を覚える必要は無い
   * (届いたかを確かめていない送信は、入力欄に戻したときに registerPendingSend で積んである)
   */
  function showTimedOutSend(next: PendingSend | null) {
    timedOutSendRef.current = next;
    setTimedOutSend(next);
  }

  /**
   * 送った文を入力欄に戻した (別の相談を出していて戻さなかったときも) 送信を、届いたかを確かめられなかった送信として積む (#2227 H1。
   * Web の AIChatBubble の restoreInputIfSameSession と同じく、入力欄に戻すその場で積む)。もう積んであれば何もしない
   */
  function registerPendingSend(send: PendingSend) {
    if (pendingSendsRef.current.some((pending) => pending.seq === send.seq)) return;
    pendingSendsRef.current = [...pendingSendsRef.current, { ...send, delivered: false }];
  }

  /**
   * 取り直した相談 (sessionId) の会話 (loaded) で、確かめられなかった送信の保存行を探す (#2227 H1。共有の resolveUnconfirmedSendRows。
   * Web の AIChatBubble と同じ決まり)。古い送信から順に当てる。beforeSeq を渡したら、その番号より前に始めた送信だけを探す
   * (取り直している送信 (beforeSeq の送信) は呼び出し側が探す。その後に始めた送信に、取り直している送信の保存行を当てない)。
   * 届いていた送信は、今の相談がその相談なら入力欄が戻した文のままなら消して外し、別の相談を出していれば、届いていた印を付けて
   * 残す (その相談を出して取り直したときに消す)。相談を開き直したとき (forgetRemaining) は、見つからなかった送信を忘れる。
   * 戻り値は送信に当てた保存行の id (今回の送信を探すときに knownMessageIds に足して除く)
   */
  function settlePendingSends(params: {
    sessionId: string;
    loaded: readonly Message[];
    current: SentText | null;
    currentAccepted: boolean;
    forgetRemaining: boolean;
    beforeSeq?: number;
  }): string[] {
    const { sessionId, beforeSeq } = params;
    const pending = pendingSendsRef.current;
    const candidates = pending
      .filter((send) => !send.delivered && send.sessionId === sessionId && (beforeSeq === undefined || send.seq < beforeSeq))
      .sort((a, b) => a.seq - b.seq);
    const resolution = resolveUnconfirmedSendRows({
      sessionId,
      loaded: params.loaded,
      unconfirmed: candidates,
      previousClaimedIds: claimedSavedUserIdsRef.current,
      current: params.current,
      currentAccepted: params.currentAccepted,
    });
    claimedSavedUserIdsRef.current = resolution.claimedIds;
    const savedRowOf = new Map<number, string>(
      resolution.resolved.map(({ send, savedMessageId }): [number, string] => [send.seq, savedMessageId]),
    );
    savedRowOf.forEach((savedMessageId, seq) => savedRowOfSendRef.current.set(seq, savedMessageId));
    const showingSession = currentSessionIdRef.current === sessionId;
    const next: PendingSend[] = [];
    for (const send of pending) {
      const savedMessageId = savedRowOf.get(send.seq);
      const settled: PendingSend = savedMessageId === undefined ? send : { ...send, delivered: true, savedUserMessageId: savedMessageId };
      if (settled.sessionId !== sessionId) {
        next.push(settled);
      } else if (settled.delivered) {
        if (showingSession) setInputText((current) => clearInputIfDelivered(current, settled.text));
        else next.push(settled);
      } else if (!params.forgetRemaining) {
        next.push(settled);
      }
    }
    pendingSendsRef.current = next;
    return resolution.claimedIds;
  }

  /**
   * 送信が時間切れになったあと、相談のメッセージを取り直す (#1049 F7-18。扱いは src/lib/ai-chat-timeout.ts)。
   * 取れなければ、今の表示と案内をそのまま残す (今の会話を消さない。届いたかを確かめていない送信は入れ物に積んだまま)。
   * 送った文が届いていたら、入力欄に戻した文を消す (二重に送らないため)。返答がまだ無ければ案内を残す。
   * 届いていなければ、案内を消して、入力欄の文をもう一度送るように知らせる。
   * 返答の提案がサーバーで自動で実行されていたら、短い一文を足してタブに知らせる (#2195 V3)。実行中の印のまま (行がまだ無いのに
   * 提案があるときも含む) なら、頼み直しを勧めない一文を足し、少し待って 1 回だけ読み直す (#2201 U3・#2206 G2。
   * previousRequestNoteAfterReload。記録を読めなかったときも 1 回だけ読み直す)
   */
  async function reloadAfterTimeout() {
    // 押したときの案内 (描画の値ではなく今の値。#2227 H1)
    const sent = timedOutSendRef.current;
    if (!sent || reloadingAfterTimeout) return;
    setReloadingAfterTimeout(true);
    try {
      const loaded = await fetchMessages(sent.sessionId, { reload: true });
      if (loaded === null) {
        Alert.alert("エラー", TIMEOUT_RELOAD_FAILED_MESSAGE);
        return;
      }
      await showReloadedConversation(sent, loaded);
    } finally {
      setReloadingAfterTimeout(false);
    }
  }

  /**
   * 取り直した会話 (loaded) を出し、送った文 (sentAtStart) が届いていたか・返答があるかで、入力欄と案内を決める
   * (時間切れのあとの「最新の会話を読み込む」と、応答を受け取れなかったあとの取り直しで共有する。#2206 G2)。
   * 届いていなければ、確かめられなかった送信として積み (もう積んであればそのまま)、入力欄に送った文を戻し (入力欄に別の文があれば残す)、
   * もう一度送るように知らせる。応答を受ける前に終わった送信 (userSaveMayBeLate) は、送った文の保存が取り直しより後になりうるので
   * 『届いていません』と言い切らない (#2227 H1。Web と同じ)。サーバーが失敗を知らせた送信 (serverFailed) で返答が無ければ、返答は
   * 来ないので『返答を作っているところかもしれません』の案内を出さずに失敗の文を出す (#2227 H1。Web と同じ)。
   * 送った文の保存行は、確かめられなかった前の送信に当てた行を除いて探す (#2227 H1)。届いていたと分かったら、保存行の id を
   * この送信に当て (savedRowOfSendRef)、返答がまだ無ければ案内の送信に持たせる (savedUserMessageId)。次の「最新の会話を読み込む」・
   * この取り直しの最中に別の取り直しが保存行を先に当てたときの、後から返ったこの取り直しは、その id で送った文と返答を探す
   * (#2227 H1。本文の一致で探すと、この送信に当てた行として除かれ、届いていた送信を『届いていません』と取り違えた。timedOutSendReloadOf)。
   * 取り直しの最中に別の相談に切り替えていたら、会話・入力欄・案内は変えない (#2227 H1。前の相談の会話を今の画面に書かない。
   * データの更新の知らせ・前の依頼の読み直しは続ける)。入力欄に戻した文は、入れ物に残した届いていた印で、その相談を出したときに消す。
   * 案内は、この送信の案内のときだけ外し、届いているが返答がまだ無いときは、後に始めた送信の案内を書き換えない
   * (後の送信の案内は、その送信の確かめに使う。#2227 H1)
   */
  async function showReloadedConversation(sentAtStart: PendingSend, loaded: Message[]) {
    const knownSavedRow = sentAtStart.savedUserMessageId ?? savedRowOfSendRef.current.get(sentAtStart.seq);
    const sent: PendingSend =
      knownSavedRow === undefined ? sentAtStart : { ...sentAtStart, delivered: true, savedUserMessageId: knownSavedRow };
    // 保存行の id が分かっている送信は、その行をもうこの送信に当てている (確かめられなかった前の送信はこの行を当てない) ので、
    // 今回の送信の一致を前の送信から守らなくてよい
    const knowsSavedRow = knownSavedRow !== undefined;
    const claimedIds = settlePendingSends({
      sessionId: sent.sessionId,
      loaded,
      current: knowsSavedRow ? null : sent,
      currentAccepted: !knowsSavedRow && sent.userSaveMayBeLate !== true,
      forgetRemaining: false,
      beforeSeq: sent.seq,
    });
    const reloaded = timedOutSendReloadOf(sent, loaded, claimedIds);
    // 保存行の id が分かっている送信は届いている (この取り直しの会話が、行を見つけた取り直しより前に読んだものでも『届いていません』にしない)
    const outcome = knowsSavedRow && reloaded.outcome === "not-delivered" ? "delivered-no-reply" : reloaded.outcome;
    const savedUserMessageId = reloaded.savedUser?.id ?? knownSavedRow;
    if (outcome === "not-delivered" || savedUserMessageId === undefined) {
      registerPendingSend(sent);
      if (currentSessionIdRef.current !== sent.sessionId) return;
      setMessages(loaded.length > 0 ? loaded : [WELCOME_MESSAGE]);
      if (timedOutSendRef.current?.seq === sent.seq) showTimedOutSend(null);
      setInputText((current) => restoreInputAfterTimeout(current, sent.text));
      if (sent.userSaveMayBeLate) {
        Alert.alert(TIMEOUT_DELIVERY_UNCONFIRMED_TITLE, TIMEOUT_DELIVERY_UNCONFIRMED_MESSAGE);
      } else {
        Alert.alert("送信できませんでした", TIMEOUT_NOT_DELIVERED_MESSAGE);
      }
      return;
    }
    // 届いていた: 保存行をこの送信に当て、入れ物の行に届いていた印を付ける (下の await の間に走る別の取り直しが、この送信を探さず、
    // この行を別の送信に当てないように)
    claimSavedUserMessageId(savedUserMessageId);
    savedRowOfSendRef.current.set(sent.seq, savedUserMessageId);
    pendingSendsRef.current = pendingSendsRef.current.map((pending) =>
      pending.seq === sent.seq ? { ...pending, delivered: true, savedUserMessageId } : pending,
    );
    const previousRequest = reloaded.reply ? await previousRequestNoteAfterReload(reloaded.reply) : NO_PREVIOUS_REQUEST_NOTE;
    if (previousRequest.recheck) {
      recheckPreviousRequestLater(previousRequest.recheck.replyId, previousRequest.recheck.replyHasProposal);
    }
    if (currentSessionIdRef.current !== sent.sessionId) return;
    // 入力欄の始末をするので、入れ物から外す
    pendingSendsRef.current = pendingSendsRef.current.filter((pending) => pending.seq !== sent.seq);
    setMessages(loaded.length > 0 ? [...loaded, ...previousRequest.notes] : [WELCOME_MESSAGE]);
    setInputText((current) => clearInputIfDelivered(current, sent.text));
    const notice = timedOutSendRef.current;
    if (outcome === "delivered-no-reply" && sent.serverFailed) {
      if (notice?.seq === sent.seq) showTimedOutSend(null);
      Alert.alert("エラー", REPLY_FAILED_MESSAGE);
      return;
    }
    if (outcome === "replied") {
      if (notice?.seq === sent.seq) showTimedOutSend(null);
      return;
    }
    if (notice === null || notice.seq <= sent.seq) showTimedOutSend({ ...sent, delivered: true, savedUserMessageId });
  }

  /**
   * 応答 (finalData) を受け取れなかったあと (finalData が無いまま流れが終わった・受け付けたあとの例外)、会話を取り直す
   * (#2206 G2。Web の resolveIncompleteReply と揃える)。以前は、流れてきた本文があればそれだけを返答として出し
   * (自動実行の一文もタブの読み込み直しも出なかった)、受け付けたあとの例外では Alert を出して送った文を消していた。
   * 取り直せなければ、送った文を入力欄に戻し、「最新の会話を読み込む」と途中で切れた旨の案内を出す (時間切れと同じ導線)
   */
  async function reloadAfterIncompleteReply(sent: PendingSend) {
    const loaded = await fetchMessages(sent.sessionId, { reload: true });
    if (loaded === null) {
      // 届いたかは分からないので、確かめられなかった送信として積む (#2227 H1。後の取り直しで届いていたら入力欄の文を消す)。
      // 取り直しの最中に別の相談に切り替えていたら、入力欄と案内は変えない (#2227 H1)。
      // サーバーが失敗を知らせていた (serverFailed) ときは返答は来ないので、取り直しの導線ではなく失敗の文を出す (#2227 H1。Web と同じ)
      registerPendingSend(sent);
      if (currentSessionIdRef.current !== sent.sessionId) return;
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("local-")));
      setInputText((current) => restoreInputAfterTimeout(current, sent.text));
      if (sent.serverFailed) {
        Alert.alert("エラー", REPLY_FAILED_MESSAGE);
        return;
      }
      // いま終わった送信がいちばん後に始めた送信なので、案内はこの送信のものにする
      showTimedOutSend(sent);
      return;
    }
    await showReloadedConversation(sent, loaded);
  }

  async function createNewSession() {
    try {
      const api = getApi();
      const createRes = await api.post<{
        success: boolean;
        session: { id: string };
      }>("/api/ai/consultation/sessions", { title: "AI相談" });
      showSessionId(createRes.session.id);
      setMessages([WELCOME_MESSAGE]);
      // 案内を外すだけ (#2227 H1。確かめていない送信は、入力欄に戻したときに積んである。作成を待つ間に終わった送信も同じ)
      showTimedOutSend(null);
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
    showSessionId(sessionId);
    // 案内を外すだけ (#2227 H1。確かめていない送信は、入力欄に戻したときに積んである。開き直した相談の取り直しで、届いていたら
    // 入力欄の文を消す)
    showTimedOutSend(null);
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
    // この送信の番号 (応答を最後まで受け取れなかったときに、確かめられなかった送信・案内の送信として見分ける。#2227 H1)
    const seq = nextSendSeq();

    setSending(true);
    setInputText("");
    setStreamingContent(null);
    // 「最新の会話を読み込む」で確かめる前に次を送ったら、前の送信の案内を外す (#2227 H1。前の送信は、入力欄に戻したときに
    // 確かめられなかった送信として積んであるので、同じ文を送り直しても前の送信の保存行を今回の送信と取り違えない)
    showTimedOutSend(null);

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
    // 最後の finalData (aiMessage) で会話を確定させたか。確定した後の例外 (流し読みの続きの失敗など) では、
    // 送信の失敗の Alert を出さない (成功の一文と失敗の Alert が両方出ていた。#2195 V3)。catch で見るので try の外で持つ
    let finalHandled = false;
    // サーバーが送信を受け付けた (2xx の応答が来た) か。受け付けたあとの例外では、返答の保存と自動実行が済んでいることがあるので、
    // 失敗の Alert を出さずに会話を取り直す (#2206 G2。Web の responseAccepted と同じ)。catch で見るので try の外で持つ
    let responseAccepted = false;
    // 送信の待ちの上限のタイマー。本文の読み取りが終わるまで外さない (#2206 G2)。finally で外すので try の外で持つ
    let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
    // サーバーが失敗を知らせた (SSE で userMessage の無い error だけの行が来た) か。返答は来ないので、取り直しで返答が無ければ
    // 失敗の文を出す (#2227 H1。Web の serverFailed と同じ)。以前はこの行を読み捨て、『返答を作っているところかもしれません』を出し続けた
    let serverFailed = false;
    try {
      if (!sessionId) {
        const api = getApi();
        const createRes = await api.post<{
          success: boolean;
          session: { id: string };
        }>("/api/ai/consultation/sessions", { title: "AI相談" });
        sessionId = createRes.session.id;
        showSessionId(sessionId);
      }

      // SSEストリーミング送信
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      const baseUrl = getApiBaseUrl();
      const url = `${baseUrl}/api/ai/consultation/sessions/${sessionId}/messages?stream=true`;

      // 送信の待ちの上限 (AI_CHAT_STREAM_TIMEOUT_MS) は、応答の見出しを受けた後の本文の読み取りまで含める (#2206 G2。以前は
      // 見出しを受けた時点でタイマーを外していたので、本文が途中で止まると送信中のまま待ち続けた)。外すのは下の finally
      const controller = new AbortController();
      streamTimeoutId = setTimeout(() => controller.abort(), AI_CHAT_STREAM_TIMEOUT_MS);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message: trimmed }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        // 429 AI_DAILY_LIMIT (#1149)・503 の緊急停止・メンテナンス中 (#1457) は、固定の文の例外にする (生の本文を画面に出さない)
        throw errorOfFailedResponse(res.status, errText);
      }
      responseAccepted = true;

      let accumulated = "";

      // SSE の 1 行を読む。本文の断片は表示中の返答に足し、最後の finalData (aiMessage) で会話を確定させる
      const handleSseLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        const raw = line.slice(6);
        if (raw === "[DONE]") return;

        let parsed: SseEvent | null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }

        const chunk = parsed?.choices?.[0]?.delta?.content;
        if (typeof chunk === "string" && chunk) {
          accumulated += chunk;
          // 送信の最中に別の相談に切り替えていたら、前の相談の返答の断片を今の画面に流さない (#2227 H1)
          if (currentSessionIdRef.current === sessionId) setStreamingContent(accumulated);
          return;
        }

        // サーバーの失敗 (失敗の行も DB に書けなかった): userMessage の無い error だけの行 (Web の AIChatBubble と同じ見分け方)
        if (parsed?.error && !parsed.userMessage) {
          serverFailed = true;
          return;
        }

        if (parsed?.aiMessage) {
          finalHandled = true;
          claimSavedUserMessageId(parsed.userMessage?.id);
          // 流れの途中の本文は、相談を切り替えていても消す (送信は 1 つずつなので、出ている断片はこの送信のもの。#2227 H1)
          setStreamingContent(null);
          // 送信の最中に別の相談に切り替えていたら、前の相談の会話を今の画面に書かない (#2227 H1)。自動実行の知らせは続ける
          if (currentSessionIdRef.current !== sessionId) {
            if (consultationAutoActionOutcomeOf(parsed)?.outcome.kind === "executed") notifyAiConsultationDataChanged();
            return;
          }
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
          const savedUserMessage = parsed.userMessage;
          setMessages((prev) => {
            // 送信の最中に相談を切り替えて戻ってくると、開き直した会話に送った文 (と返答) の保存行がもう入っていることがある。
            // 同じ id の行は除いてから足す (同じ送った文・返答を 2 つ並べない。#2227 H1)
            const withoutOptimistic = prev.filter(
              (m) => !m.id.startsWith("local-") && m.id !== savedUserMessage?.id && m.id !== aiMsg.id
            );
            const userMsg: Message = savedUserMessage
              ? {
                  id: savedUserMessage.id,
                  role: "user",
                  content: savedUserMessage.content ?? trimmed,
                  createdAt:
                    savedUserMessage.createdAt ??
                    new Date().toISOString(),
                }
              : optimistic;
            return [...withoutOptimistic, userMsg, aiMsg, ...outcomeMessages];
          });
          // 実行できたら、データ (献立・食事・買い物リストなど) を出すタブの WebView に知らせる (Web の mealPlanUpdated に当たる)。
          // 読み込み直すかは各 WebView がページの上で決める (入力の途中のページでは読み込み直さない。webViewBridge.ts の buildReloadCurrentPageScript)
          if (autoAction?.outcome.kind === "executed") notifyAiConsultationDataChanged();
        }
      };

      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // 待ちの上限を過ぎたら本文の読み取りをやめる (読み取り中の read() は done で返る)。fetch が中断を本文に伝えない環境でも止める
        const stopReadingOnTimeout = () => {
          void reader.cancel().catch(() => {});
        };
        controller.signal.addEventListener("abort", stopReadingOnTimeout);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) handleSseLine(line);
          }
        } finally {
          controller.signal.removeEventListener("abort", stopReadingOnTimeout);
        }
        // 待ちの上限で読み取りをやめたときは、時間切れとして扱う (下の catch の AbortError と同じ導線)
        if (controller.signal.aborted && !finalHandled) throw streamTimeoutError();
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
        // finalData が無いまま終わった (接続が切れた・流れが途中で切れた など): 本文が流れてきていても、それだけを返答として
        // 出さずに会話を取り直す (#2206 G2。Web と同じ。サーバーでは返答の保存と自動実行が済んでいることがあり、本文だけでは
        // 自動実行の一文もタブの読み込み直しも出ない)。返答の提案がサーバーで自動で実行されていたら、finalData の結果の一文の
        // 代わりに短い一文を足し、タブに知らせる (#2195 V3)。実行中の印のままなら、頼み直しを勧めない一文を足し、少し待って
        // 1 回だけ読み直す (#2201 U3。previousRequestNoteAfterReload)
        await reloadAfterIncompleteReply({
          seq,
          sessionId,
          text: trimmed,
          knownMessageIds,
          delivered: false,
          interrupted: true,
          userSaveMayBeLate: false,
          serverFailed,
        });
      }
    } catch (e: any) {
      setStreamingContent(null);
      // 会話を確定させた後の例外 (流し読みの続きの reader.read() の失敗など): 返答と結果はもう出ているので、
      // 送信の失敗として扱わない (Alert を出さない・メッセージを消さない。#2195 V3)
      if (finalHandled) return;
      // 受け付けたあとの例外 (時間切れを除く。本文の読み取りの失敗など): サーバーでは返答の保存と自動実行が済んでいることがあるので、
      // 失敗の Alert を出さずに会話を取り直す (#2206 G2。Web と同じ。以前は Alert を出して送った文を消していた)
      if (responseAccepted && sessionId && e?.name !== "AbortError") {
        await reloadAfterIncompleteReply({
          seq,
          sessionId,
          text: trimmed,
          knownMessageIds,
          delivered: false,
          interrupted: true,
          userSaveMayBeLate: false,
          serverFailed,
        });
        return;
      }
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
      // 応答を受ける前に通信が切れた (React Native の fetch は TypeError を投げる): 送信はサーバーに届いて、返答の保存と
      // 自動実行が続いていることがある (#2206 G2。Web と同じく、失敗の Alert だけで終わらせない)。時間切れと同じ導線にする
      const isNetworkError = !responseAccepted && e instanceof TypeError;
      if (e?.name === "AbortError" || (isNetworkError && sessionId)) {
        // 待ちを打ち切っただけで、サーバーでは返答の保存が続いていることがある (#1049 F7-18)。
        // 失敗として終わらせず、会話を取り直す導線 (TIMEOUT_RELOAD_LABEL) を出し、送った文を入力欄に戻す
        // (届いていたかは取り直しで分かる。届いていたら、戻した文はそこで消す)。送信の最中に別の相談に切り替えていたら、
        // 今の相談の入力欄には戻さない (#2227 H1)
        if (sessionId) {
          const timedOut: PendingSend = {
            seq,
            sessionId,
            text: trimmed,
            knownMessageIds,
            delivered: false,
            interrupted: isNetworkError,
            // 応答を受ける前に終わった: 送った文の保存が取り直しより後になりうる (#2227 H1。Web の userSaveMayBeLate)
            userSaveMayBeLate: !responseAccepted,
            serverFailed,
          };
          // 入力欄に戻すその場で、確かめられなかった送信として積む (#2227 H1。この後に案内を外しても書き換えても、後の取り直しで
          // 届いていたと分かれば入力欄の文を消す)
          registerPendingSend(timedOut);
          if (currentSessionIdRef.current === sessionId) {
            setInputText((current) => restoreInputAfterTimeout(current, trimmed));
          }
          showTimedOutSend(timedOut);
        } else {
          setInputText((current) => restoreInputAfterTimeout(current, trimmed));
          Alert.alert("タイムアウト", TIMEOUT_NOTICE_MESSAGE);
        }
      } else {
        // 本文の文だけを出す (`HTTP 404: {"error":…}` の生の文字列を出さない。#1917)
        Alert.alert("エラー", getJapaneseApiErrorMessage(e, "送信に失敗しました。"));
      }
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("local-")));
    } finally {
      if (streamTimeoutId !== null) clearTimeout(streamTimeoutId);
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
                        {timedOutSendNoticeOf(timedOutSend)}
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
