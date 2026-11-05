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
  resolveUnconfirmedSends,
  restoreInputAfterTimeout,
  settleWithin,
  timedOutSendNoticeOf,
  timedOutSendReloadOf,
  type PreviousRequestActionRead,
  type PreviousRequestNoteState,
  type SentText,
  type TimedOutSend,
  type UnconfirmedSend,
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

/**
 * 応答 (finalData) を受け取れずに取り直した会話で、送った文への AI の返答 (reply。timedOutSendReloadOf が探したもの) の提案の記録を読み、足す一文・
 * 知らせるか・読み直すかを共有の previousRequestNotePlanOf で決める (Web の AIChatBubble の placeReloadedReply と同じ決まり。
 * #2206 G2。以前はこのシートに判定の写しがあり、Web にだけ足した 2 つの決まりが無かった)。
 *   - 実行できていれば、実行できた一文を足し、データを出すタブの WebView に知らせる (notifyAiConsultationDataChanged)
 *   - 実行中の印のまま、または記録の行がまだ無い・読めないのに返答に提案がある (サーバーは返答を保存してから行を作る) なら、
 *     結果をまだ確かめられないと伝える一文 (頼み直しを勧めない) を足し、読み直す返答 (recheck) を返す (呼び出し側が
 *     recheckPreviousRequestLater で 1 回読み直す)。ただし、記録を読めず GET が「実行する」を出すとした (pending) ときは、実行していない一文を出す (#2227 H1)
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
  // 応答を最後まで受け取れなかった送信 (時間切れ・通信の切断・流れが途中で切れた) の案内。あるあいだ「最新の会話を読み込む」を出す
  // (#1049 F7-18。扱いは src/lib/ai-chat-timeout.ts)。案内は出すだけで、届いたかを確かめていない送信は unconfirmedSendsRef が持つ
  // (#2227 H1)。入れ物の送信と案内の送信は同じもの (送信の見分けはもの自体で行う。同じ文を続けて送っても別の送信になる)
  const [timedOutSend, setTimedOutSend] = useState<TimedOutSend | null>(null);
  const [reloadingAfterTimeout, setReloadingAfterTimeout] = useState(false);

  const scrollRef = useRef<ScrollViewInstance>(null);
  // 今出している相談の id。送信の応答は await をまたぐので、その間に別の相談へ切り替えたら、前の相談の返答・送った文を今の画面
  // (会話・入力欄・案内) に書かない (#2227 H1。Web の AIChatBubble の currentSessionIdRef と同じ)。state ではなく ref で今の値を見る
  // (切り替えた時点で ref も変える。描画を待つと、切り替えの直後に返った応答が古い値を見る)
  const currentSessionIdRef = useRef<string | null>(null);
  // 最新の画面の操作の番号 (#2227 H1)。相談を出す (showSessionId)・シートを開き直す (initSession)・送る (sendMessage) たびに 1 つ進める。
  // 会話の取り直し (応答を受け取れなかったあとの取り直しと「最新の会話を読み込む」) は始めたときの番号を持ち、返ったときに番号が
  // 進んでいれば、会話・入力欄・案内を書かない (screenStillShows)。取り直した会話は GET を始めた時点の写しで、そのあと出し直した画面の
  // ほうが新しい。届いたかの確かめも、出し直したときの読み込み (loadMessages) が入れ物の送信で済ませる
  const viewGenRef = useRef(0);
  // 送信中か・「最新の会話を読み込む」の取り直しの最中か (#2227 H1)。送信と取り直しは重ねない (Web は取り直しを送信の中で待つので、
  // 重ならない)。重ねると、取り直しの最中に送った次の送信とその返答を、あとから返った取り直しの古い会話が画面から消した。
  // ボタンを止める描画を待たずに今の値を見るため ref でも持つ (同じ描画のうちの 2 度目の押下も止める)
  const sendingRef = useRef(false);
  const reloadingRef = useRef(false);
  // アーカイブの /close の応答待ちの最中か (#2227 H1 の整合ゲートの指摘)。アーカイブは応答のあと新しい相談を始める (createNewSession)
  // が、その入口は取り直しの最中なら黙って戻るので、応答待ちの間に「最新の会話を読み込む」を始めさせない。isClosingSession と同じ値を
  // ref でも持つのは、ボタンを止める描画を待たずに今の値を見るため (アーカイブと同じ描画のうちの取り直しの押下も止める)。
  // 応答待ちの間は、送信 (入力欄・送信ボタン・クイック質問)・新しい相談・相談の切り替えも止める (#2235 I7。止めないと、送った文は
  // 閉じる側の相談へ送られてアーカイブのあとの新しい相談で画面から消え、手で始めた新しい相談はアーカイブの作成と合わせて 2 つ
  // 作られ、選んだ相談はアーカイブのあとの新しい相談で上書きされた)。逆に送信中はアーカイブを止める (sendingRef。送信の返答が
  // 閉じた相談にだけ保存され、新しい相談の画面には出ない)
  const closingSessionRef = useRef(false);
  // 届いたかを確かめられなかった送信と、送信に当てた送った文の保存行の id (#2227 H1。Web の AIChatBubble と同じ入れ物と決まり。
  // 共有の resolveUnconfirmedSends)。応答を受け取れずに終わった送信は、その場で積む (registerUnconfirmedSend)。後の取り直しで
  // 保存行が見つかったら外し、入力欄が戻した文のままなら消す (そのまま送ると同じ相談に二重に届く)。今回の送信の保存行を探すときは、
  // 前の送信に当てた行を除く (同じ文を続けて送ったときに、前の送信の保存行を今回の送信と取り違えない)
  const unconfirmedSendsRef = useRef<UnconfirmedSend[]>([]);
  const claimedSavedUserIdsRef = useRef<string[]>([]);

  /** 画面の操作を 1 つ始める (最新の画面の操作の番号を進める。#2227 H1)。進めたあとの番号を返す (#2254 M1) */
  function startViewOperation(): number {
    viewGenRef.current += 1;
    return viewGenRef.current;
  }
  // 最後に始めた相談の一覧の読み込みの番号 (#2254 M1。Web の AIChatBubble の sessionsRequestSeqRef と同じ決まり)。一覧は応答の順で
  // なく、最後に始めた読み込みの応答だけを置く (アーカイブの前に始めた開き直しの一覧が、アーカイブのあとの読み直しより後に返ると、
  // 閉じた相談が終了でない一覧が出た)
  const sessionsRequestSeqRef = useRef(0);
  /** 相談の一覧の読み込みを 1 つ始め、その応答を置く関数を返す (置くのは、これが最後に始めた読み込みのときだけ) */
  function startSessionsRequest(): (sessions: Session[]) => void {
    sessionsRequestSeqRef.current += 1;
    const requestSeq = sessionsRequestSeqRef.current;
    return (loaded) => {
      if (sessionsRequestSeqRef.current === requestSeq) setSessions(loaded);
    };
  }

  // 出す相談を変える (画面の操作)。切り替えたら、流れの途中の本文 (streamingContent) も消す (#2227 H1。前の相談の返答の断片を
  // 今の画面に残さない。前の相談の送信の続きの断片は handleSseLine が今の画面に流さない)
  function showSessionId(sessionId: string | null) {
    startViewOperation();
    if (currentSessionIdRef.current !== sessionId) setStreamingContent(null);
    currentSessionIdRef.current = sessionId;
    setCurrentSessionId(sessionId);
  }

  /**
   * 相談 (sessionId) の会話の取り直しを今始めるとき、その結果を画面 (会話・入力欄・案内) に書いてよいかを返す関数 (#2227 H1)。
   * 書いてよいのは、始めたときにその相談を出していて、そのあと画面の操作 (相談の切り替え・新しい相談・開き直し・送信) が無いときだけ
   */
  function screenStillShows(sessionId: string): () => boolean {
    const startedAt = viewGenRef.current;
    const showing = currentSessionIdRef.current === sessionId;
    return () => showing && viewGenRef.current === startedAt;
  }
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
    // アーカイブの /close の応答待ちの間に開き直したら、読み込まない (#2245 K1。アーカイブが応答のあと新しい相談を作って出す
    // (createNewSession)。ここで読み込むと、アーカイブのあとの新しい相談の画面を、遅れて返った閉じた相談の一覧・会話で上書きしうる。
    // Web の AIChatBubble の openChat と同じ)
    if (closingSessionRef.current) return;
    // 開き直しも画面の操作 (#2227 H1。前の画面で始めた取り直しの結果を、開き直した画面に書かない)。前の画面の案内も外す
    // (案内の送信は、開き直した会話の読み込みが確かめる。外さないと、読み込みがこの送信に当てた保存行を、あとで押した
    // 「最新の会話を読み込む」が前の送信の行として除いて探し、届いていた送信を『届いていません』と取り違える。
    // 相談の切り替え・新しい相談と同じ)
    startViewOperation();
    const startedAt = viewGenRef.current;
    setTimedOutSend(null);
    try {
      const api = getApi();
      const applySessions = startSessionsRequest();
      const res = await api.get<{ sessions: Session[] }>(
        "/api/ai/consultation/sessions?status=all"
      );
      const allSessions = res.sessions ?? [];
      applySessions(allSessions);
      // 一覧を待つ間にアーカイブを始めた・ほかの画面の操作 (アーカイブのあとの新しい相談・相談の切り替え・送信) があった: 出す相談を
      // 変えない (#2245 K1。変えると、アーカイブのあとの新しい相談や選んだ相談を、一覧を読んだ時点の相談で上書きする)
      if (closingSessionRef.current || viewGenRef.current !== startedAt) return;

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
        // 作成を待つ間も上と同じ (#2245 K1)
        if (closingSessionRef.current || viewGenRef.current !== startedAt) return;
        showSessionId(createRes.session.id);
        setMessages([WELCOME_MESSAGE]);
      }
    } catch {
      // 失敗を待つ間に画面の操作があったら、その画面を消さない (#2245 K1。上と同じ)
      if (closingSessionRef.current || viewGenRef.current !== startedAt) return;
      setMessages([WELCOME_MESSAGE]);
    }
  }

  /**
   * 相談のメッセージをサーバーから取る。取れなければ null (画面をどうするかは呼び出し側が決める)。
   * 応答を受け取れなかったあとの取り直し (reload) は、Web と同じ上限 (AI_CHAT_RELOAD_TIMEOUT_MS) で打ち切る (#2227 H1。
   * 取り直しのあいだは送信と入力欄が止まるので、/api/ai/ の下の GET の既定 (120 秒) のままだと、GET が詰まると最大 120 秒入力が止まった)
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
    // この読み込みで確かめるのは、読み込みを始める前に積んであった送信だけ (#2227 H1。読み込みの最中に終わった送信は、GET の写しより
    // 後に保存されうるので、写しに無くても忘れない。その送信は自分の取り直しで確かめる)
    const settleable = [...unconfirmedSendsRef.current];
    const loaded = await fetchMessages(sessionId, { reload: false });
    // 会話を画面に置くのは、返ったときにまだその相談を出しているときだけ (#2245 K1。相談を A→B と切り替えた・アーカイブのあとの
    // 新しい相談に変わったあとに遅れて返った A の会話を、今の相談の画面に置かない。置くと、画面の会話と違う相談へ送られる。
    // Web の AIChatBubble の fetchMessages と同じ)。確かめられなかった送信の settle は今のまま行う (入力欄に触るのは今の相談のときだけ)
    if (currentSessionIdRef.current === sessionId) {
      if (loaded && loaded.length > 0) {
        setMessages(loaded);
      } else {
        setMessages([WELCOME_MESSAGE]);
      }
    }
    // 確かめられなかった前の送信が届いていたら、入力欄に戻した文を消す (#2227 H1)。開き直した会話は以後の送信の
    // 「送る前に出ていた行」に入るので、見つからなかった送信は忘れる
    if (loaded) {
      settleUnconfirmedSends({ sessionId, loaded, among: settleable, current: null, currentAccepted: false, forgetRemaining: true });
    }
  }

  /** 送った文の保存行 (id) をその送信に当てた印を付ける (確かめられなかった前の送信がこの行を自分のものとして当てないように) */
  function claimSavedUserMessageId(id: unknown) {
    if (typeof id !== "string" || claimedSavedUserIdsRef.current.includes(id)) return;
    claimedSavedUserIdsRef.current = [...claimedSavedUserIdsRef.current, id];
  }

  /**
   * 応答を受け取れずに終わった送信を、届いたかを確かめられなかった送信として積む (#2227 H1)。今の画面がその相談でなくても積む
   * (その相談を出したときの読み込みが確かめる)。もう積んであれば何もしない
   */
  function registerUnconfirmedSend(send: TimedOutSend) {
    if (unconfirmedSendsRef.current.includes(send)) return;
    unconfirmedSendsRef.current = [...unconfirmedSendsRef.current, send];
  }

  /**
   * 取り直した相談 (sessionId) の会話 (loaded) で、確かめられなかった送信の保存行を探す (#2227 H1。共有の resolveUnconfirmedSends が
   * 古い送信から順に当てる)。探すのは among に入っている送信だけ (取り直しの GET を始める前に積んであった送信。取り直している送信は
   * 呼び出し側が探すので除く)。忘れる範囲 (GET の前の写し) は Web の settleUnconfirmedSends と同じ。保存行を探す範囲は、Web は
   * 呼んだ時点の入れ物の全部、このシートは among (写し) の中だけ (写しの外の送信は次の読み込みで当てる)。
   * 見つかった送信は入れ物から外し、今の相談がその相談なら、入力欄が戻した文のままなら消す。相談を開き直したとき (forgetRemaining) は、
   * 見つからなかった送信を忘れる。戻り値は送信に当てた保存行の id (今回の送信を探すときに除く)
   */
  function settleUnconfirmedSends(params: {
    sessionId: string;
    loaded: readonly Message[];
    among: readonly UnconfirmedSend[];
    current: SentText | null;
    currentAccepted: boolean;
    forgetRemaining: boolean;
  }): string[] {
    const among = new Set(params.among);
    const resolution = resolveUnconfirmedSends({
      sessionId: params.sessionId,
      loaded: params.loaded,
      unconfirmed: unconfirmedSendsRef.current.filter((send) => among.has(send)),
      previousClaimedIds: claimedSavedUserIdsRef.current,
      current: params.current,
      currentAccepted: params.currentAccepted,
    });
    const settled = new Set<UnconfirmedSend>(resolution.resolved);
    if (params.forgetRemaining) {
      for (const send of resolution.remaining) if (send.sessionId === params.sessionId) settled.add(send);
    }
    unconfirmedSendsRef.current = unconfirmedSendsRef.current.filter((send) => !settled.has(send));
    claimedSavedUserIdsRef.current = resolution.claimedIds;
    if (currentSessionIdRef.current === params.sessionId) {
      for (const send of resolution.resolved) setInputText((current) => clearInputIfDelivered(current, send.text));
    }
    return resolution.claimedIds;
  }

  /**
   * 送信が時間切れになったあと、相談のメッセージを取り直す (#1049 F7-18。扱いは src/lib/ai-chat-timeout.ts)。
   * 取り直しのあいだは、送信・入力欄・クイック質問・新しい相談・相談の切り替え・アーカイブを止める (#2227 H1。送信と同じ扱い。
   * Web と同じく、取り直しと送信は重ならない)。アーカイブの応答待ちの最中は始めない (#2227 H1 の整合ゲートの指摘。アーカイブが
   * 応答のあとに呼ぶ createNewSession が、取り直しの最中だと黙って戻り、閉じた相談が今の相談のまま残る)。待つ上限は、GET と記録の直読みでそれぞれ AI_CHAT_RELOAD_TIMEOUT_MS。
   * 取り直しの最中にシートを開き直したら (止められない画面の操作)、結果は画面に書かない (screenStillShows。案内の送信は、開き直した
   * 会話の読み込みが確かめる)。
   * 取れなければ、今の表示と案内をそのまま残す (今の会話を消さない。届いたかを確かめていない送信は入れ物に積んだまま)。
   * 書き方は showReloadedConversation
   */
  async function reloadAfterTimeout() {
    const sent = timedOutSend;
    if (!sent || sendingRef.current || reloadingRef.current || closingSessionRef.current) return;
    reloadingRef.current = true;
    setReloadingAfterTimeout(true);
    try {
      const isFresh = screenStillShows(sent.sessionId);
      const among = unconfirmedSendsRef.current.filter((send) => send !== sent);
      const loaded = await fetchMessages(sent.sessionId, { reload: true });
      if (!isFresh()) {
        if (loaded) void notifyReplyOutcomeOfStaleReload(sent, loaded);
        return;
      }
      if (loaded === null) {
        Alert.alert("エラー", TIMEOUT_RELOAD_FAILED_MESSAGE);
        return;
      }
      await showReloadedConversation(sent, loaded, isFresh, among);
    } finally {
      reloadingRef.current = false;
      setReloadingAfterTimeout(false);
    }
  }

  /**
   * 取り直した会話 (loaded) を出し、送った文 (sent) が届いていたか・返答があるかで、入力欄と案内を決める
   * (時間切れのあとの「最新の会話を読み込む」と、応答を受け取れなかったあとの取り直しで共有する。#2206 G2)。
   * 呼ぶのは、取り直しの結果を画面に書いてよいとき (screenStillShows が真) だけ。このときは、取り直しと送信が重ならず、相談も
   * 切り替わっていないので、今の画面の会話・入力欄・案内はこの送信のものとしてそのまま書く (#2227 H1)。
   *   - 届いていない: 会話を出し、案内を消し、入力欄に送った文を戻し (入力欄に別の文があれば残す)、もう一度送るように知らせる。
   *     送信は入れ物に積んだまま (後の取り直しで届いていたら入力欄の文を消す)。応答を受ける前に終わった送信 (userSaveMayBeLate) は、
   *     送った文の保存が取り直しより後になりうるので『届いていません』と言い切らない (#2227 H1。Web と同じ)
   *   - 届いていた: 保存行をこの送信に当て、入れ物から外し、入力欄に戻した文を消す (二重に送らないため)。返答がまだ無ければ案内に
   *     保存行の id を持たせる (savedUserMessageId。次の「最新の会話を読み込む」はその id で送った文と返答を探す。Web の
   *     recheckDeliveredNoReplyLater と同じ)。サーバーが失敗を知らせた送信 (serverFailed) で返答が無ければ、返答は来ないので
   *     失敗の文を出す (#2227 H1。Web と同じ)。返答があれば案内を消し、返答の提案がサーバーで自動で実行されていたら短い一文を足して
   *     タブに知らせる (#2195 V3)。実行中の印のまま (行がまだ無いのに提案があるときも含む) なら、頼み直しを勧めない一文を足し、
   *     少し待って 1 回だけ読み直す (#2201 U3・#2206 G2。previousRequestNoteAfterReload。記録を読めなかったときも 1 回だけ読み直す)。
   *     会話と一文は記録を読んでから出すので、そのあいだに画面の操作があれば書かない
   * 送った文の保存行は、確かめられなかった前の送信 (among) に当てた行を除いて探す (#2227 H1)
   */
  async function showReloadedConversation(
    sent: TimedOutSend,
    loaded: Message[],
    isFresh: () => boolean,
    among: readonly UnconfirmedSend[],
  ) {
    // 保存行の id が分かっている送信 (前の取り直しで届いていたと分かった) は、その id で探すので、前の送信から守らなくてよい
    const knowsSavedRow = sent.savedUserMessageId !== undefined;
    const claimedIds = settleUnconfirmedSends({
      sessionId: sent.sessionId,
      loaded,
      among,
      current: knowsSavedRow ? null : sent,
      currentAccepted: !knowsSavedRow && sent.userSaveMayBeLate !== true,
      forgetRemaining: false,
    });
    const reloaded = timedOutSendReloadOf(sent, loaded, claimedIds);
    const shownConversation = loaded.length > 0 ? loaded : [WELCOME_MESSAGE];
    if (reloaded.outcome === "not-delivered" || reloaded.savedUser === null) {
      setMessages(shownConversation);
      setTimedOutSend(null);
      setInputText((current) => restoreInputAfterTimeout(current, sent.text));
      if (sent.userSaveMayBeLate) {
        Alert.alert(TIMEOUT_DELIVERY_UNCONFIRMED_TITLE, TIMEOUT_DELIVERY_UNCONFIRMED_MESSAGE);
      } else {
        Alert.alert("送信できませんでした", TIMEOUT_NOT_DELIVERED_MESSAGE);
      }
      return;
    }
    // 届いていた: 保存行をこの送信に当て、入れ物から外し、入力欄に戻した文を消す。入力欄は下の記録の読み取りを待たずに消す
    // (読み取りのあいだに開き直されると、開き直しの読み込みは入れ物から外したこの送信を確かめないので、届いていた文が残る)
    const savedUserMessageId = reloaded.savedUser.id;
    claimSavedUserMessageId(savedUserMessageId);
    unconfirmedSendsRef.current = unconfirmedSendsRef.current.filter((send) => send !== sent);
    setInputText((current) => clearInputIfDelivered(current, sent.text));
    if (reloaded.reply === null) {
      setMessages(shownConversation);
      if (sent.serverFailed) {
        setTimedOutSend(null);
        Alert.alert("エラー", REPLY_FAILED_MESSAGE);
        return;
      }
      setTimedOutSend({ ...sent, delivered: true, savedUserMessageId });
      return;
    }
    const previousRequest = await previousRequestNoteAfterReload(reloaded.reply);
    if (previousRequest.recheck) {
      recheckPreviousRequestLater(previousRequest.recheck.replyId, previousRequest.recheck.replyHasProposal);
    }
    // 記録を読むあいだに画面の操作 (開き直し・送信の中の取り直しなら相談の切り替えも) があれば、会話と案内は書かない
    if (!isFresh()) return;
    setMessages([...shownConversation, ...previousRequest.notes]);
    setTimedOutSend(null);
  }

  /**
   * 画面に書かない (取り直しの最中に画面の操作があった) 取り直しでも、送った文への返答の提案がサーバーで自動で実行されていれば、
   * データを出すタブに知らせる (#2227 H1。実行中の印のままなら、少し待って 1 回だけ読み直す。どちらも今の会話・入力欄・案内には
   * 書かない。読み直しの一文は、その返答が出ている会話にだけ書く)。入れ物は触らない (送信は積んであるか、出し直したときの読み込みが
   * 確かめた)。保存行は前の送信に当てた行を除かずに探す (同じ文の別の送信の返答を選んでも、その返答の記録を読んで知らせるだけ)
   */
  async function notifyReplyOutcomeOfStaleReload(sent: TimedOutSend, loaded: readonly Message[]) {
    const { reply } = timedOutSendReloadOf(sent, loaded, []);
    if (!reply) return;
    const previousRequest = await previousRequestNoteAfterReload(reply);
    if (previousRequest.recheck) {
      recheckPreviousRequestLater(previousRequest.recheck.replyId, previousRequest.recheck.replyHasProposal);
    }
  }

  /**
   * 応答 (finalData) を受け取れなかったあと (finalData が無いまま流れが終わった・受け付けたあとの例外)、会話を取り直す
   * (#2206 G2。Web の resolveIncompleteReply と揃える)。以前は、流れてきた本文があればそれだけを返答として出し
   * (自動実行の一文もタブの読み込み直しも出なかった)、受け付けたあとの例外では Alert を出して送った文を消していた。
   * 送信は呼ぶ前に入れ物に積んである (registerUnconfirmedSend)。取り直しは送信の中で待つ (送信中のあいだ「最新の会話を読み込む」は
   * 出ない)。始めたときに別の相談を出していた・取り直しの最中に相談を切り替えた・開き直したときは、結果を画面に書かない (#2227 H1。
   * screenStillShows。その相談を出したときの読み込みが、入れ物の送信を確かめる)。
   * 取り直せなければ、送った文を入力欄に戻し、「最新の会話を読み込む」と途中で切れた旨の案内を出す (時間切れと同じ導線)。
   * サーバーが失敗を知らせていた (serverFailed) ときは返答は来ないので、取り直しの導線ではなく失敗の文を出す (#2227 H1。Web と同じ)
   */
  async function reloadAfterIncompleteReply(sent: TimedOutSend) {
    const isFresh = screenStillShows(sent.sessionId);
    const among = unconfirmedSendsRef.current.filter((send) => send !== sent);
    const loaded = await fetchMessages(sent.sessionId, { reload: true });
    if (!isFresh()) {
      if (loaded) void notifyReplyOutcomeOfStaleReload(sent, loaded);
      return;
    }
    if (loaded === null) {
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("local-")));
      setInputText((current) => restoreInputAfterTimeout(current, sent.text));
      if (sent.serverFailed) {
        Alert.alert("エラー", REPLY_FAILED_MESSAGE);
        return;
      }
      setTimedOutSend(sent);
      return;
    }
    await showReloadedConversation(sent, loaded, isFresh, among);
  }

  /**
   * 「新しい相談を始める」の押下 (#2235 I7)。アーカイブの応答待ちの間は始めない (ボタンも止めている。ref で見るのは、アーカイブと
   * 同じ描画のうちの押下も止めるため)。アーカイブは応答のあと自分で新しい相談を作る (createNewSession) ので、ここで作ると 2 つになる
   */
  async function pressNewSession() {
    if (closingSessionRef.current) return;
    await createNewSession();
  }

  /**
   * 1日献立の作成を今始めてはいけないか (#2245 K1)。送信中・「最新の会話を読み込む」の取り直しの最中・アーカイブの応答待ちの最中
   * (ボタンを止めているのと同じ。ref で見るのは、止める描画を待たずに、同じ描画のうちの押下も止めるため)
   */
  function isDayMenuStartBlocked(): boolean {
    return sendingRef.current || reloadingRef.current || closingSessionRef.current;
  }

  /** 「1日献立変更」の押下 (#2245 K1。止めている間は開かない) */
  function openDayMenuModal() {
    if (isDayMenuStartBlocked()) return;
    setDayMenuModalVisible(true);
  }

  /** 新しい相談を作って出す (「新しい相談を始める」の押下 pressNewSession と、アーカイブの応答のあとから呼ぶ) */
  async function createNewSession() {
    // 取り直しの最中は始めない (#2227 H1。ボタンも止めている。同じ描画のうちの 2 度目の押下を止める)
    if (reloadingRef.current) return;
    // 作るのも画面の操作 (#2254 M1。Web の AIChatBubble の createNewSession と同じ)。作成を待つ間にほかの画面の操作 (相談の切り替え・
    // 開き直し・別の新しい相談) があったら、その画面を作った相談で上書きしない (最後の操作が勝つ。作った相談はサーバーに残り、
    // 次に一覧を読んだときに出る)
    const startedAt = startViewOperation();
    try {
      const api = getApi();
      const createRes = await api.post<{
        success: boolean;
        session: { id: string };
      }>("/api/ai/consultation/sessions", { title: "AI相談" });
      if (viewGenRef.current !== startedAt) return;
      showSessionId(createRes.session.id);
      setMessages([WELCOME_MESSAGE]);
      // 案内を外すだけ (#2227 H1。確かめていない送信は入れ物に積んである。作成を待つ間に終わった送信も同じ)
      setTimedOutSend(null);
      setShowSessionList(false);
      // セッション一覧を更新
      const applySessions = startSessionsRequest();
      const res = await api.get<{ sessions: Session[] }>(
        "/api/ai/consultation/sessions?status=all"
      );
      applySessions(res.sessions ?? []);
    } catch {
      Alert.alert("エラー", "新しいセッションの作成に失敗しました。");
    }
  }

  async function selectSession(sessionId: string) {
    // 取り直しの最中・アーカイブの応答待ちの最中は切り替えない (#2227 H1・#2235 I7。相談の行も止めている。アーカイブの応答のあとの
    // 新しい相談が、選んだ相談を上書きする)
    if (reloadingRef.current || closingSessionRef.current) return;
    showSessionId(sessionId);
    // 案内を外すだけ (#2227 H1。確かめていない送信は入れ物に積んである。開き直した相談の読み込みで、届いていたら入力欄の文を消す)
    setTimedOutSend(null);
    setShowSessionList(false);
    await loadMessages(sessionId);
  }

  async function fetchSessions() {
    try {
      const api = getApi();
      const applySessions = startSessionsRequest();
      const res = await api.get<{ sessions: Session[] }>(
        "/api/ai/consultation/sessions?status=all"
      );
      applySessions(res.sessions ?? []);
    } catch {
      // 取得失敗は無視
    }
  }

  async function archiveSession() {
    // 取り直しの最中はしない (#2227 H1。アーカイブのあとに新しい相談を始めるので、新しい相談と同じく止める)。送信中もしない
    // (#2235 I7。送信の返答は閉じた相談にだけ保存され、アーカイブのあとの新しい相談の画面には出ない。ボタンも止めている)
    if (
      !currentSessionId ||
      isClosingSession ||
      closingSessionRef.current ||
      reloadingRef.current ||
      sendingRef.current
    ) {
      return;
    }

    // クライアント側で既に closed か確認
    const currentSession = sessions.find((s) => s.id === currentSessionId);
    if (currentSession?.status === "closed") {
      Alert.alert("情報", "このセッションは既にアーカイブ済みです。");
      return;
    }

    closingSessionRef.current = true;
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
      closingSessionRef.current = false;
      setIsClosingSession(false);
    }
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    // 送信中・「最新の会話を読み込む」の取り直しの最中・アーカイブの応答待ちの最中は送らない (#2227 H1・#2235 I7。送信ボタン・
    // 入力欄・クイック質問も止めている。ref で見るのは、同じ描画のうちの 2 度目の押下も止めるため。アーカイブの最中に送ると、
    // 閉じる側の相談へ送られ、アーカイブのあとの新しい相談で送った文と返答が画面から消える)
    if (!trimmed || sendingRef.current || reloadingRef.current || closingSessionRef.current) return;
    sendingRef.current = true;
    // 送信も画面の操作 (#2227 H1)。取り直しの最中は送れないので、ふだんはこれで古くなる取り直しは無い (重ねて守る)
    startViewOperation();

    // 時間切れのあとの取り直しで、送った文が届いたかを見分けるため、送る前に出ていたサーバーのメッセージの id を持つ
    const knownMessageIds = messages.filter((m) => m.id !== WELCOME_MESSAGE.id && !m.id.startsWith("local-")).map((m) => m.id);

    setSending(true);
    setInputText("");
    setStreamingContent(null);
    // 「最新の会話を読み込む」で確かめる前に次を送ったら、前の送信の案内を外す (#2227 H1。前の送信は入れ物に積んであるので、
    // 同じ文を送り直しても前の送信の保存行を今回の送信と取り違えない)
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
    // 応答 (finalData) を受け取れなかったあとの取り直し (finalData の欠け・受け付けたあとの例外で 1 つを使う)。送信は先に、確かめられ
    // なかった送信として積む (#2227 H1。取り直しの最中に相談を切り替えた・開き直したときは、その相談を出したときの読み込みが確かめる)
    const reloadIncompleteSend = async (sendSessionId: string) => {
      const incomplete: TimedOutSend = {
        sessionId: sendSessionId,
        text: trimmed,
        knownMessageIds,
        delivered: false,
        interrupted: true,
        userSaveMayBeLate: false,
        serverFailed,
      };
      registerUnconfirmedSend(incomplete);
      await reloadAfterIncompleteReply(incomplete);
    };
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
          // 送信の最中に別の相談に切り替えていたら、前の相談の会話を今の画面に書かない (#2227 H1)。自動実行の知らせは続ける。
          // 送信の応答は、取り直しと違って番号 (screenStillShows) では見ない: 会話の写しで画面を置き換えず、この送信の保存行と返答を
          // id で足すだけなので、同じ相談を出し直した画面 (切り替えて戻った・開き直した) に書いても新しい行を消さない。送信は 1 つずつで、
          // 取り直しとも重ならないので、出し直した同じ相談の画面ではこの送信がいちばん新しい操作になる
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
        await reloadIncompleteSend(sessionId);
      }
    } catch (e: any) {
      setStreamingContent(null);
      // 会話を確定させた後の例外 (流し読みの続きの reader.read() の失敗など): 返答と結果はもう出ているので、
      // 送信の失敗として扱わない (Alert を出さない・メッセージを消さない。#2195 V3)
      if (finalHandled) return;
      // 受け付けたあとの例外 (時間切れを除く。本文の読み取りの失敗など): サーバーでは返答の保存と自動実行が済んでいることがあるので、
      // 失敗の Alert を出さずに会話を取り直す (#2206 G2。Web と同じ。以前は Alert を出して送った文を消していた)
      if (responseAccepted && sessionId && e?.name !== "AbortError") {
        await reloadIncompleteSend(sessionId);
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
        // 今の相談の入力欄に戻さず、案内も出さない (#2227 H1。送信の応答なので、同じ相談を出し直した画面には書く。finalData と同じ)
        if (sessionId) {
          const timedOut: TimedOutSend = {
            sessionId,
            text: trimmed,
            knownMessageIds,
            delivered: false,
            interrupted: isNetworkError,
            // 応答を受ける前に終わった: 送った文の保存が取り直しより後になりうる (#2227 H1。Web の userSaveMayBeLate)
            userSaveMayBeLate: !responseAccepted,
            serverFailed,
          };
          // 確かめられなかった送信として、今の画面がこの相談でなくても積む (#2227 H1。後の取り直し・その相談を出したときの読み込みで
          // 届いていたと分かれば、入力欄の文を消す)
          registerUnconfirmedSend(timedOut);
          if (currentSessionIdRef.current === sessionId) {
            setInputText((current) => restoreInputAfterTimeout(current, trimmed));
            setTimedOutSend(timedOut);
          }
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
      sendingRef.current = false;
      setSending(false);
    }
  }

  // ウェルカムメッセージのみの状態かどうか
  const isWelcomeOnly =
    messages.length === 1 && messages[0].id === "welcome";

  // typing indicator を表示するか: 送信中かつストリームがまだ来ていない
  const showTypingIndicator = sending && streamingContent === null;
  // 送信・入力・クイック質問を止めるか (#2227 H1。「最新の会話を読み込む」の取り直しの最中も送信中と同じく止める。取り直しと
  // 送信を重ねない。アーカイブの応答待ちの最中も止める (#2235 I7))
  const inputLocked = sending || reloadingAfterTimeout || isClosingSession;
  // 新しい相談・相談の切り替えを止めるか: 取り直しの最中・アーカイブの応答待ちの最中 (#2227 H1・#2235 I7。送信中は止めない)
  const sessionSwitchLocked = reloadingAfterTimeout || isClosingSession;
  // 「最新の会話を読み込む」を押せないとき: 取り直しの最中・アーカイブの応答待ちの最中 (#2227 H1 の整合ゲートの指摘)
  const reloadDisabled = reloadingAfterTimeout || isClosingSession;

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
                      reloadingAfterTimeout ||
                      sending ||
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
                  {/* 新しい相談・相談の切り替えは、「最新の会話を読み込む」の取り直しの最中・アーカイブの応答待ちの最中は止める
                      (#2227 H1・#2235 I7。送信中は止めない) */}
                  <Pressable
                    testID="ai-new-session"
                    onPress={pressNewSession}
                    disabled={sessionSwitchLocked}
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
                      disabled={sessionSwitchLocked}
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

                  {/* 送信が時間切れになったときの、取り直しの導線 (#1049 F7-18)。アーカイブの応答待ちの最中は押せない (#2227 H1 の
                      整合ゲートの指摘。reloadAfterTimeout の入口でも止めている) */}
                  {timedOutSend != null && timedOutSend.sessionId === currentSessionId && !sending && (
                    <View testID="ai-timeout-notice" style={styles.timeoutNotice}>
                      <Text style={styles.timeoutNoticeText}>
                        {timedOutSendNoticeOf(timedOutSend)}
                      </Text>
                      <Pressable
                        testID="ai-timeout-reload"
                        accessibilityRole="button"
                        onPress={reloadAfterTimeout}
                        disabled={reloadDisabled}
                        style={[styles.timeoutReloadBtn, reloadDisabled && styles.sendButtonDisabled]}
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
                          disabled={inputLocked}
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
                {/* 送信中・取り直しの最中・アーカイブの応答待ちの最中は止める (#2245 K1。以前は disabled が無く、いつでも押せた) */}
                <Pressable
                  testID="ai-day-menu-btn"
                  onPress={openDayMenuModal}
                  disabled={inputLocked}
                  style={[styles.dayMenuBtn, inputLocked && styles.dayMenuBtnDisabled]}
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
                  editable={!inputLocked}
                />
                <Pressable
                  testID="ai-send-btn"
                  onPress={() => sendMessage(inputText)}
                  disabled={!inputText.trim() || inputLocked}
                  style={[
                    styles.sendButton,
                    (!inputText.trim() || inputLocked) && styles.sendButtonDisabled,
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
        isStartBlocked={isDayMenuStartBlocked}
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
  // 止めている間 (#2245 K1)。枠の色を、止めている送信ボタンと同じ textMuted にする
  dayMenuBtnDisabled: {
    borderColor: colors.textMuted,
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
