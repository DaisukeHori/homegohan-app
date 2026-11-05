"use client";

import { createElement, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageCircle, X, Send, Sparkles, ChevronDown,
  Check, XCircle, Loader2, Calendar, ShoppingCart,
  Target, UtensilsCrossed, BookOpen, Star, Archive, MoreVertical,
  Trash2, CheckCircle, Refrigerator, Heart, FolderPlus,
  Activity, User, Edit, CalendarDays
} from "lucide-react";
import { useV4MenuGeneration } from "@/hooks/useV4MenuGeneration";
import { notifyMenuGenerated } from "@/lib/local-notification";
import { useNativeAppMode } from "@/hooks/useNativeAppMode";
import { useAiConsent } from "@/hooks/useAiConsent";
import { AiConsentRequiredError, aiFetch, handleStoredAiConsentFailure, isAiConsentRequiredResponse } from "@/lib/ai/consent-required";
import { aiDailyLimitMessageOfResponse } from "@/lib/ai/daily-limit-client";
import { aiSummarySkippedNote } from "@/lib/ai/consent-config";
import { todayLocal, addDaysToDate, formatDateJa, isCalendarDate } from "@/lib/date-utils";
// AI 応答を HTML にして dangerouslySetInnerHTML へ渡すときは、必ずこの関数を通す (#1169)
import { parseMarkdown } from "@/lib/markdown-lite";
// AI 相談の緊急停止中 (503 + AI_CHAT_DISABLED) にサーバーが返すやさしい文面を、そのまま画面に出す (#1148)
import { readAiChatUnavailableMessage } from "@/lib/ai/ai-chat-unavailable";
// 『相談を終了』が失敗したときにチャットに出す文 (#2245 K1。出し分けはモバイルの AIAdvisorSheet と同じ)
import { CONSULTATION_CLOSE_FAILED_MESSAGE, consultationCloseFailureOf } from "@/lib/ai/consultation-close-failure";
// 提案の実行の結果 (成功・失敗) をチャットに出す一文。失敗 (success が偽) を『実行しました』と出さない (#2183 Z1)
import {
  AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE,
  consultationActionFailureMessageOf,
  consultationActionOutcomeOf,
  type ConsultationActionOutcome,
} from "@/lib/ai/consultation-action-outcome";
// 提案のカードに「実行する」を出せないとき (やり直せない失敗・実行中・記録が無い) の案内 (#2189 W1-a)。
// 案内の文は理由で分ける: 実行中・実行済みは頼み直しを勧めない (#2195 V2)
import {
  PROPOSED_ACTION_NOT_EXECUTABLE_REASON,
  aiProposedActionNotExecutableGuideOf,
  isProposedActionNotExecutableReason,
  proposedActionNotExecutableReasonOfView,
  proposedActionViewOf,
  type ProposedActionNotExecutableReason,
} from "@/lib/ai/consultation-action-lifecycle";

const colors = {
  primary: '#E07A5F',
  primaryLight: '#FDF0ED',
  secondary: '#3D5A80',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#F4A261',
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#8A8A8A',
  border: '#E8E8E8',
  purple: '#8B5CF6',
  purpleLight: '#F3E8FF',
};

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  proposedActions?: ProposedAction | null;
  /**
   * 提案のカードに「実行する」を出すか (#2189 W1-a)。false なら「実行する」を出さず、「もう一度頼んでください」の案内を出す
   * (サーバーの提案の行が pending でない・行が無い)。サーバーが返さないとき (欠けている) は出す
   */
  proposedActionExecutable?: boolean;
  /**
   * 「実行する」を出さないときの理由 (#2195 V2)。runningOrDone (実行中か実行済み) なら『実行中か実行済みです』、
   * unconfirmed (行が実行中の印のまま。#2201 U3) なら『実行できたかを確かめられませんでした…』、
   * それ以外 (欠けている・failed) は『もう一度 AI に頼んでください』の案内を出す
   */
  proposedActionNotExecutableReason?: ProposedActionNotExecutableReason;
  createdAt: string;
  isImportant?: boolean;
  isStreaming?: boolean; // ストリーミング表示中かどうか
}

interface ProposedAction {
  type: string;
  params: Record<string, any>;
  actionId?: string;
}

interface Session {
  id: string;
  title: string;
  messageCount: number;
  status?: string;
  summary?: string;
}

// 提案の種類の名前は共有の表 (@homegohan/shared の CONSULTATION_ACTION_LABELS) から引く。モバイルの AI 相談のシートの結果の一文と
// 同じ名前になる (#2195 V3)。satisfies で、この表の鍵が共有の表の鍵 (= 実行の側の種類) とちょうど同じことを型で確かめる
import { CONSULTATION_ACTION_LABELS, type ConsultationActionType } from "@homegohan/shared";
// 送信の応答 (finalData) を受け取れなかったあとに会話を取り直して、前の依頼の結果を出す (#2201 U3。モバイルの #2195 V3 と共有の決まり)
import {
  PREVIOUS_REQUEST_RECHECK_DELAY_MS,
  clearInputIfDelivered,
  messagesAfterPreviousRequestRecheck,
  previousRequestNoteIdOf,
  previousRequestNotePlanOf,
  previousRequestNoteTextOf,
  previousRequestRecheckPlanOf,
  replyHasProposalOf,
  replyProposalExecutableOf,
  replyToSentMessageOf,
  replyToUserMessageIdOf,
  resolveUnconfirmedSends,
  restoreInputAfterUndelivered,
  sentMessageIndexOf,
  sentMessageReloadOutcomeOf,
  type PreviousRequestActionState,
  type PreviousRequestNoteState,
  type SentText,
  type UnconfirmedSend,
} from "@homegohan/shared";
import {
  AI_CHAT_DELIVERED_NO_REPLY_MESSAGE,
  AI_CHAT_DELIVERY_UNCONFIRMED_MESSAGE,
  AI_CHAT_INTERRUPTED_RELOAD_FAILED_MESSAGE,
  AI_CHAT_NOT_DELIVERED_MESSAGE,
  AI_CHAT_RELOAD_TIMEOUT_MS,
  AI_CHAT_REPLY_FAILED_MESSAGE,
  AI_CHAT_SEND_TIMEOUT_MS,
  AI_CHAT_TIMEOUT_RELOAD_FAILED_MESSAGE,
  readReplyActionStateOf,
} from "@/lib/ai/consultation-reply-reload";

const ACTION_LABELS: Record<string, { label: string; icon: any; color: string }> = {
  // 献立関連
  generate_day_menu: { label: CONSULTATION_ACTION_LABELS.generate_day_menu, icon: Calendar, color: colors.primary },
  generate_week_menu: { label: CONSULTATION_ACTION_LABELS.generate_week_menu, icon: Calendar, color: colors.primary },
  generate_single_meal: { label: CONSULTATION_ACTION_LABELS.generate_single_meal, icon: Calendar, color: colors.primary },
  update_meal: { label: CONSULTATION_ACTION_LABELS.update_meal, icon: Edit, color: colors.warning },
  delete_meal: { label: CONSULTATION_ACTION_LABELS.delete_meal, icon: Trash2, color: '#EF4444' },
  complete_meal: { label: CONSULTATION_ACTION_LABELS.complete_meal, icon: CheckCircle, color: colors.success },
  
  // 買い物リスト関連
  add_to_shopping_list: { label: CONSULTATION_ACTION_LABELS.add_to_shopping_list, icon: ShoppingCart, color: colors.success },
  update_shopping_item: { label: CONSULTATION_ACTION_LABELS.update_shopping_item, icon: Edit, color: colors.warning },
  delete_shopping_item: { label: CONSULTATION_ACTION_LABELS.delete_shopping_item, icon: Trash2, color: '#EF4444' },
  check_shopping_item: { label: CONSULTATION_ACTION_LABELS.check_shopping_item, icon: CheckCircle, color: colors.success },
  
  // 冷蔵庫/パントリー関連
  add_pantry_item: { label: CONSULTATION_ACTION_LABELS.add_pantry_item, icon: Refrigerator, color: colors.secondary },
  update_pantry_item: { label: CONSULTATION_ACTION_LABELS.update_pantry_item, icon: Edit, color: colors.warning },
  delete_pantry_item: { label: CONSULTATION_ACTION_LABELS.delete_pantry_item, icon: Trash2, color: '#EF4444' },
  
  // レシピ関連
  suggest_recipe: { label: CONSULTATION_ACTION_LABELS.suggest_recipe, icon: BookOpen, color: colors.secondary },
  like_recipe: { label: CONSULTATION_ACTION_LABELS.like_recipe, icon: Heart, color: '#EC4899' },
  add_recipe_to_collection: { label: CONSULTATION_ACTION_LABELS.add_recipe_to_collection, icon: FolderPlus, color: colors.purple },
  
  // 栄養目標関連
  update_nutrition_target: { label: CONSULTATION_ACTION_LABELS.update_nutrition_target, icon: Target, color: colors.purple },
  
  // 健康目標関連
  set_health_goal: { label: CONSULTATION_ACTION_LABELS.set_health_goal, icon: Target, color: colors.success },
  update_health_goal: { label: CONSULTATION_ACTION_LABELS.update_health_goal, icon: Edit, color: colors.warning },
  delete_health_goal: { label: CONSULTATION_ACTION_LABELS.delete_health_goal, icon: Trash2, color: '#EF4444' },
  
  // 健康記録関連
  add_health_record: { label: CONSULTATION_ACTION_LABELS.add_health_record, icon: Activity, color: colors.success },
  update_health_record: { label: CONSULTATION_ACTION_LABELS.update_health_record, icon: Edit, color: colors.warning },
  
  // プロフィール関連
  update_profile_preferences: { label: CONSULTATION_ACTION_LABELS.update_profile_preferences, icon: User, color: colors.secondary },
} satisfies Record<ConsultationActionType, { label: string; icon: unknown; color: string }>;

/** アクションの種類の名前 (ACTION_LABELS に無い種類は『アクション』) */
function actionLabelOf(type: unknown): string {
  return (typeof type === 'string' && ACTION_LABELS[type]?.label) || 'アクション';
}

/** 提案の実行の結果 (成功・失敗) を、チャットに足す AI 側のメッセージにする (#2183 Z1) */
function actionOutcomeChatMessage(outcome: ConsultationActionOutcome): Message {
  return {
    id: `action-${outcome.kind === 'executed' ? 'result' : 'failed'}-${Date.now()}`,
    role: 'assistant',
    content: outcome.content,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 応答を受け取れずに取り直した会話で、送った文への返答 (replyId) の提案の状態を知らせる一文 (#2201 U3)。
 * id は状態ごとに決める (実行中の一文は、読み直して分かったらこの id の一文に置き換える)。サーバーには保存しない
 */
function previousRequestNoteOf(state: PreviousRequestNoteState, replyId: string): Message {
  return {
    id: previousRequestNoteIdOf(state, replyId),
    role: 'assistant',
    content: previousRequestNoteTextOf(state),
    createdAt: new Date().toISOString(),
  };
}

/** 会話の GET の 1 件 (取り直しで使う項目) */
interface LoadedMessage {
  id: string;
  role: string;
  content: string;
  proposedActions?: ProposedAction | null;
  proposedActionExecutable?: unknown;
  proposedActionNotExecutableReason?: unknown;
  isImportant?: unknown;
  createdAt?: string;
}

/** 会話の GET の本文から、メッセージの一覧を読む (形の合わない行は除く)。読めなければ null */
function loadedMessagesOf(body: unknown): LoadedMessage[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { messages?: unknown }).messages)) return null;
  return ((body as { messages: unknown[] }).messages).filter(
    (m): m is LoadedMessage =>
      !!m && typeof m === 'object' && typeof (m as LoadedMessage).id === 'string' &&
      typeof (m as LoadedMessage).role === 'string' && typeof (m as LoadedMessage).content === 'string',
  );
}

/**
 * 送信の応答を受け取れなかったあとに、会話の GET を AI_CHAT_RELOAD_TIMEOUT_MS を上限に取り直す (#2201 U3・#2206 G2)。
 * 以前は上限が無く、GET が返らないと送信中のまま入力が止まった。上限を過ぎた・通信が失敗した・2xx でない・形が読めないときは
 * null (呼び出し側は取り直せなかったとして扱う)
 */
async function reloadConversationAfterIncompleteReply(sessionId: string): Promise<LoadedMessage[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_CHAT_RELOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/ai/consultation/sessions/${sessionId}/messages`, { signal: controller.signal });
    return res.ok ? loadedMessagesOf(await res.json()) : null;
  } catch (e) {
    console.error('Failed to reload messages after an incomplete reply:', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 提案の記録の行の状態から、提案のカードの「実行する」を出すか・出さない理由を作る (会話の GET と同じ決まり。
 * lifecycle の proposedActionViewOf。#2206 G2)。記録を読み直して、実行を待つ・失敗した行になっていたときに、GET を読んだ時点の
 * カード (実行中の印の『確かめられませんでした』) を今の行に合わせる
 */
function proposedActionCardFieldsOfStatuses(
  statuses: readonly string[],
): Pick<Message, 'proposedActionExecutable' | 'proposedActionNotExecutableReason'> {
  const view = proposedActionViewOf(statuses);
  const reason = proposedActionNotExecutableReasonOfView(view);
  return { proposedActionExecutable: view === 'executable', proposedActionNotExecutableReason: reason ?? undefined };
}

/** 実行中の印の行のカード (GET の unconfirmed と同じ。「実行する」を出さず『確かめられませんでした…開き直してください』) */
const UNCONFIRMED_CARD_FIELDS: Pick<Message, 'proposedActionExecutable' | 'proposedActionNotExecutableReason'> = {
  proposedActionExecutable: false,
  proposedActionNotExecutableReason: PROPOSED_ACTION_NOT_EXECUTABLE_REASON.unconfirmed,
};

/**
 * 取り直した返答を、画面のメッセージの提案の欄にする。state は共有の previousRequestNotePlanOf が決めた状態 (記録の行が無い・
 * 読めないのに返答に提案があるときは running。#2206 G2: サーバーは返答を保存してから提案の記録の行を作るので、その間に取り直しが
 * 当たると行がまだ無い。GET のとおりに『もう一度 AI に頼んでください』のカードを出すと、直後に行ができて実行が進んでいても
 * 頼み直しを勧めてしまう)。
 *   - 実行できていた (executed): カードを出さない (開き直したときの GET・finalData の成功のときと同じ。GET を読んだときは
 *     まだ実行中の印で、記録を読むまでに実行できた行になっていることがあり、GET を写すと『前の依頼は実行されました』とカードの文が
 *     食い違う)
 *   - 実行中の印 (running。行がまだ無い・読めないのに提案があるときも含む): GET の理由によらず『確かめられませんでした』のカード
 *     (#2206 G2。GET を読んだときは行が無く『もう一度 AI に頼んでください』でも、頼み直しを勧めない)
 *   - 実行を待つ・失敗した (notExecuted): 記録の行から GET と同じ決まりで作る (GET を読んだ後に行が変わっていても合わせる)。
 *     記録の行を読めなかった (statuses が空。記録の直読みだけが失敗し、GET が実行を待つとしたとき。#2227 H1) は GET を写す
 *     (以前は実行中の印として扱い、「実行する」が隠れた)
 *   - それ以外: GET が返した「実行する」を出すか・出さない理由を写す
 */
function proposedActionFieldsOfLoaded(
  reply: LoadedMessage,
  state: PreviousRequestActionState,
  statuses: readonly string[],
): Pick<Message, 'proposedActions' | 'proposedActionExecutable' | 'proposedActionNotExecutableReason'> {
  if (!reply.proposedActions || state === 'executed') return { proposedActions: null };
  if (state === 'running') return { proposedActions: reply.proposedActions, ...UNCONFIRMED_CARD_FIELDS };
  if (state === 'notExecuted' && statuses.length > 0) {
    return { proposedActions: reply.proposedActions, ...proposedActionCardFieldsOfStatuses(statuses) };
  }
  const reason = reply.proposedActionNotExecutableReason;
  return {
    proposedActions: reply.proposedActions,
    ...(typeof reply.proposedActionExecutable === 'boolean' ? { proposedActionExecutable: reply.proposedActionExecutable } : {}),
    ...(isProposedActionNotExecutableReason(reason) ? { proposedActionNotExecutableReason: reason } : {}),
  };
}

/**
 * 会話の続きの POST (SSE) の最後の finalData のうち、自動実行の結果を出すのに使う部分。
 * actionResult は messages route の executeAndFinalizeAction の戻り値 ({ success, result, actionType })
 */
interface AutoActionFinalData {
  actionResult?: { success?: unknown; result?: unknown; actionType?: unknown } | null;
  aiMessage?: { proposedActions?: { type?: unknown } | null } | null;
}

/**
 * 会話の続きの POST (SSE) の最後の finalData から、AI のメッセージの提案の欄を作る (送信欄から送ったときも、おすすめの質問から
 * 送ったときも同じ)。自動実行が成功したら提案のカードは出さない (#2189 W1-a。以前は残り、押すと 404 で失敗の alert が出た)。
 * 残すときは、サーバーが返した「実行する」を出すか (proposedActionExecutable) を写す
 */
function proposedActionFieldsOfFinalData(finalData: {
  aiMessage: {
    id: string;
    proposedActions?: Omit<ProposedAction, 'actionId'> | null;
    proposedActionExecutable?: unknown;
    proposedActionNotExecutableReason?: unknown;
  };
  actionResult?: { success?: unknown } | null;
}): Pick<Message, 'proposedActions' | 'proposedActionExecutable' | 'proposedActionNotExecutableReason'> {
  const proposed = finalData.aiMessage.proposedActions;
  if (!proposed || finalData.actionResult?.success === true) return { proposedActions: null };
  const reason = finalData.aiMessage.proposedActionNotExecutableReason;
  return {
    proposedActions: { ...proposed, actionId: finalData.aiMessage.id },
    ...(typeof finalData.aiMessage.proposedActionExecutable === 'boolean'
      ? { proposedActionExecutable: finalData.aiMessage.proposedActionExecutable }
      : {}),
    ...(isProposedActionNotExecutableReason(reason) ? { proposedActionNotExecutableReason: reason } : {}),
  };
}

/**
 * 実行の API の応答の本文から、「実行する」を出さない理由を読む (#2195 V2)。
 * 本文に理由が無い・読めないときは failed (『もう一度 AI に頼んでください』)
 */
function notExecutableReasonOfBody(body: unknown): ProposedActionNotExecutableReason {
  const reason = body && typeof body === 'object' ? (body as { notExecutableReason?: unknown }).notExecutableReason : undefined;
  return isProposedActionNotExecutableReason(reason) ? reason : PROPOSED_ACTION_NOT_EXECUTABLE_REASON.failed;
}

/** 実行の API の応答の本文が「もう一度押しても実行できない」(retryable: false) を示しているか (#2195 V2。500・429 にも付く) */
function isNotRetryableBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { retryable?: unknown }).retryable === false;
}

/**
 * 実行の API がこの状態コードを返したら、その提案はもうここからは実行できない (#2189 W1-a)。
 * 400 = すでに処理された (実行中・実行済み・断った)・対応していない種類 / 404 = 実行を待っている提案の行が無い
 */
const ACTION_NOT_EXECUTABLE_RESPONSE_STATUSES: ReadonlySet<number> = new Set([400, 404]);

/** 自動実行の結果のメッセージを、AI の応答を確定させてから足すまでの間 (ミリ秒)。応答の表示の直後に重ねず、少し遅らせて出す */
const AUTO_ACTION_OUTCOME_MESSAGE_DELAY_MS = 300;

/**
 * チャットを開いてから、続けて押しても開き直さない (二重に開かない) 間 (ミリ秒)。
 * 開くアニメーションが終わるまでの目安として #125 で入れた値 (それまではリテラルの 400 だった)
 */
const CHAT_OPEN_TOGGLE_LOCK_MS = 400;

/**
 * 部品を外すときに、まだ動いていない予約 (setTimeout) をすべて取り消す予約の関数を返す (#2201)。
 * 戻り値を持たないまま予約すると、部品が外れたあとに動いて、外れた部品への setState や、外れたあとの mealPlanUpdated の
 * 発火 (受け手のページが取り直しを走らせる) を起こす。このファイルで送信の待ちの上限と、会話の取り直しの GET の上限
 * (reloadConversationAfterIncompleteReply。#2206 G2。どちらも try/finally で取り消す) 以外の予約は、すべてこれで行う。動いた予約は一覧から外す
 * (くり返しの予約 (setInterval) の 1日献立の作成の状態の読み直し (DAY_MENU_STATUS_RECHECK_INTERVAL_MS。#2254 M1) は、effect の後始末で取り消す)。
 * 外れたあとに予約しようとしたとき (外す前に始めた送信・開く処理の続きが、外れたあとに終わったとき) は予約しない
 */
function useUnmountClearedTimeouts(): (callback: () => void, delayMs: number) => void {
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const unmountedRef = useRef(false);

  useEffect(() => {
    const timers = timersRef.current;
    // StrictMode の付け直し (外す → 付ける) でも、付けたら予約できる状態に戻す
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return useCallback((callback: () => void, delayMs: number) => {
    if (unmountedRef.current) return;
    const timers = timersRef.current;
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delayMs);
    timers.add(timer);
  }, []);
}

/** 1 日分の献立の既定の日を、JST の今日から何日後にするか (週の画面の表示の日が無い・今日のときの明日) */
const DAY_MENU_DEFAULT_OFFSET_DAYS = 1;

/** 1 日分の献立の日付の欄で選べる最後の日を、JST の今日から何日後にするか (欄の下の『今日から2週間先まで選択できます』) */
const DAY_MENU_MAX_OFFSET_DAYS = 14;

/** 止めている「1日献立変更」のボタンの不透明度 (#2245 K1 で式を名前にしただけ。値は以前のまま) */
const LOCKED_QUICK_ACTION_OPACITY = 0.5;

/** 押せない・処理中の「作成する」「実行する」のボタンの不透明度 (#2245 K1 で式を名前にしただけ。値は以前のまま) */
const BUSY_BUTTON_OPACITY = 0.7;

/**
 * 1日献立の作成の最中に、作成の依頼の状態を状態の確認 (GET /api/ai/menu/weekly/status) で読み直す間隔 (ミリ秒。#2254 M1)。
 * 作成の完了・失敗は主に依頼の行の変化 (Realtime) で知るが、Realtime は切れていた間 (タブを裏に回した・通信が途切れた) の変化を
 * 送り直さない。取りこぼすと作成の最中の止め (『相談を終了』・新しい相談・相談の切り替え・開き直しの読み直し) が下りないので、
 * その保険として読み直す (チャットを開いたとき・タブが前に戻ったときにも読み直す)。主の経路は Realtime なので、週の画面の
 * 状態の確認のポーリング (3 秒) より疎にする (作成は数十秒かかる。取りこぼしても、この間隔 1 回分の待ちで止めが下りる)。
 * 状態の確認は進まなくなった依頼 (src/lib/weekly-menu-request-stale.ts) を失敗にするので、作成が止まったときも止めが下りる。
 * 予約は setInterval で、作成の最中だけ置き、終わったとき・部品を外すときに effect の後始末で取り消す
 */
export const DAY_MENU_STATUS_RECHECK_INTERVAL_MS = 30_000;

/** 作成の依頼の状態を読み直したら失敗 (または依頼の行が無い) で、文が無いときに出す文 (フック useV4MenuGeneration の既定の文と同じ) */
const DAY_MENU_FAILED_FALLBACK_MESSAGE = '生成に失敗しました';

/** 状態の確認 (GET /api/ai/menu/weekly/status) の応答の状態のうち、作成が終わった (Realtime の変化をもう待たない) もの */
const DAY_MENU_REQUEST_COMPLETED_STATUS = 'completed';
/** 失敗 (進まなくなって失敗にした行・利用者の中止を含む) と、依頼の行が無い (not_found) */
const DAY_MENU_REQUEST_FAILED_STATUSES: ReadonlySet<string> = new Set(['failed', 'not_found']);

/**
 * JST の暦日 day (YYYY-MM-DD) を offsetDays 日ずらした暦日 (#2235 I8)。暦の計算 (addDaysToDate) だけで求めるので、端末の
 * タイムゾーンに左右されない (以前は端末の 0 時の Date を setDate でずらしてから JST の日付にしていて、端末が JST より東だと
 * 1 日戻った)。描画中に呼ぶので投げない: ずらした先が暦の計算で扱える範囲の外なら null (addDaysToDate が投げるのは、範囲の外と
 * 形の違う日付の RangeError だけ。day は todayLocal の YYYY-MM-DD なので、ここで投げうるのは範囲の外だけ)
 */
function shiftCalendarDayOrNull(day: string, offsetDays: number): string | null {
  try {
    return addDaysToDate(day, offsetDays);
  } catch {
    return null;
  }
}

/** 1 日分の献立の日付の欄で選べる範囲 (下限は JST の今日、上限は DAY_MENU_MAX_OFFSET_DAYS 日後。上限を計算できなければ null = 上限なし) */
function dayMenuDateRangeOf(today: string): { min: string; max: string | null } {
  return { min: today, max: shiftCalendarDayOrNull(today, DAY_MENU_MAX_OFFSET_DAYS) };
}

/**
 * 1 日分の献立を作ってよい日付か (#2245 K1)。実在する暦日 (isCalendarDate。日付の欄を空にした '' は入らない) で、日付の欄の
 * 範囲 (min〜max) の中のときだけ。以前は欄を空にして作成を押すと『NaN月NaN日の献立を作成中...』を出し、date '' で依頼していた
 */
function isDayMenuDateSelectable(date: string, range: { min: string; max: string | null }): boolean {
  if (!isCalendarDate(date)) return false;
  // YYYY-MM-DD の同じ桁数の文字列なので、文字列の大小が日付の前後と同じ
  if (date < range.min) return false;
  return range.max === null || date <= range.max;
}

/**
 * 1 日分の献立の日付の欄が空・形の崩れ・範囲の外で「作成する」を止めているときに、欄の下に出す理由の一文 (#2245 L1。以前は
 * ボタンが薄くなるだけで、なぜ押せないかが見えなかった。欄の下の『今日から2週間先まで選択できます』の案内とは別に出す)
 */
export const DAY_MENU_DATE_UNSELECTABLE_MESSAGE = 'この日付では作成できません。今日から2週間先までの日を選んでください';

/**
 * 1 日分の献立の日付の欄の既定の日 (#2245 L1)。週の画面の表示の日 (weeklyDate) が、今日以外の実在する暦日で、欄の範囲
 * (dayMenuDateRangeOf(today)) の中ならその日 (Bug-5 #21)。表示の日が無い・今日・範囲の外 (過去の週・15 日以上先・0 時を
 * またいだ前日) なら明日 (今日を黙って作り直さないため)。以前は範囲の外の表示の日もそのまま既定にしていて、K1 で範囲の外を
 * 止めてから「作成する」が理由も出ずに押せなかった。明日を暦の計算で扱えない日 (9999-12-31) は今日
 */
function defaultDayMenuDateOf(today: string, weeklyDate: unknown): string {
  if (
    typeof weeklyDate === 'string' &&
    weeklyDate !== today &&
    isDayMenuDateSelectable(weeklyDate, dayMenuDateRangeOf(today))
  ) {
    return weeklyDate;
  }
  return shiftCalendarDayOrNull(today, DAY_MENU_DEFAULT_OFFSET_DAYS) ?? today;
}

/** 献立の作成が、同意が無くて止められたときにチャットに出す一文 (T15 / #1154。同意画面は AiConsentRequiredHost が出す) */
const V4_CONSENT_REQUIRED_CHAT_NOTE =
  'AI へのデータ提供への同意が必要なため、献立は作成しませんでした。同意したあとに、もう一度お試しください。';

/**
 * 提案されたアクションのカードの見出し (アイコンと名前)。
 *
 * アイコンは JSX (`<Icon />`) ではなく createElement で描く。Next 15 (15.5.27) の SWC は、`<style jsx global>` がある
 * このファイルで、変数に入れたコンポーネント (`const Icon = actionInfo?.icon || Sparkles`) を JSX で描くと、
 * styled-jsx の変換 (SSR とブラウザ向け) が終わらなくなり、next build / next dev が止まった (#1444。
 * 同じ変数を createElement に渡すと止まらない)。描かれるものは JSX で書いたときと同じ。
 * 以前は AIChatBubble の JSX の中の即時関数だったものを、読みやすさのために切り出した。
 */
function ProposedActionHeading({ type }: { type: string }) {
  const actionInfo = ACTION_LABELS[type];
  const icon = createElement(actionInfo?.icon || Sparkles, { size: 16, color: actionInfo?.color || colors.purple });
  return (
    <>
      {icon}
      <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{actionInfo?.label || type}</span>
    </>
  );
}

export default function AIChatBubble() {
  const isNativeApp = useNativeAppMode();
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  // 外国の AI 事業者へのデータ提供の同意画面 (T15 / #1154)。初回の送信の直前だけ出す。
  // 「同意しない」なら送らない (未同意のまま送っても、サーバーが 403 AI_CONSENT_REQUIRED で止める)。
  // この部品は全ページに常駐するので、同意の状況は相談の画面を開くまで取りにいかない (毎ページの読み込みで API を呼ばない)
  const { ensureAiConsent, consentModal } = useAiConsent({ prefetch: isOpen });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  // 実行の応答待ちの提案のカード (メッセージの id) の集まり (#2254 M1)。1 つの値で持つと、2 枚のカードの実行が重なったとき、先に
  // 終わった実行がもう一方のカードの実行中の印を消し、まだ応答待ちのカードの「実行する」をまた押せた
  const [executingActionIds, setExecutingActionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [showSessionList, setShowSessionList] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [showMessageMenu, setShowMessageMenu] = useState<string | null>(null);
  const [isClosingSession, setIsClosingSession] = useState(false);
  const [isToggling, setIsToggling] = useState(false); // #125: 連続クリック防止フラグ
  const [showDayMenuModal, setShowDayMenuModal] = useState(false);
  // 1日献立の作成の最中 (チャットに『○月○日の献立を作成中...』を足してから、完了・失敗の一文を足すまで) か・提案の実行の API の
  // 応答待ちの最中か (#2254 M1)。この間は『相談を終了』を止める (止めないと、閉じたあとの新しい相談の画面の置き換え (createNewSession)
  // で作成中の一文が消え、完了・実行の結果の一文だけが新しい相談の画面に出た。#2245 K1 が直した向き (閉じる応答待ちの間の作成) の逆)。
  // 同意の確認を待つ間は入れない (その間に閉じるを押したら閉じる側が勝ち、作成・実行をしない。#2245 K1)。
  // 作成の最中をフックの isGenerating で見ないのは、依頼が失敗した (onError) あともフックの isGenerating が真のまま残り、閉じるが
  // ずっと押せなくなるため (作成の最中は、ここで始まりと終わり (完了・失敗) を自分で持つ)。終わりは Realtime の完了・失敗の通知のほか、
  // 依頼の状態の読み直し (recheckDayMenuRequest。チャットを開いたとき・タブが前に戻ったとき・DAY_MENU_STATUS_RECHECK_INTERVAL_MS ごと)
  // でも見つける (Realtime は切れていた間の変化を送り直さないので、通知だけを待つと、取りこぼしたときに止めがずっと下りない)。
  // 『新しい相談を始める』・相談の切り替えも同じ理由でこの間は止め、チャットを開き直したときの会話の読み直し (openChat) もしない
  // (どれも会話を置き換えるので、作成中の一文が消え、完了・結果の一文が別の相談の画面に出る (開き直しは同じ相談の画面で消える)。#2254 M1)。
  // ref でも持つのは、ボタンを止める描画を待たずに今の値を見て、同じ描画のうちの押下も止めるため (closingSessionRef と同じ形)。
  // 1日献立の作成は一度に 1 つだけ (generateDayMenu の入口で止める。完了・失敗の通知 (onGenerationComplete / onError) はどの依頼の
  // ものかを持たないので、重ねると先の完了で止めが外れる) なので真偽で持つ。提案の実行はカードごとに重なりうるので件数で持つ
  // (真偽で持つと、2 件の実行が重なったとき、先に終わった実行がもう一方の応答待ちの止めを外した)
  const [isDayMenuInFlight, setIsDayMenuInFlight] = useState(false);
  const dayMenuInFlightRef = useRef(false);
  const [actionRequestsInFlight, setActionRequestsInFlight] = useState(0);
  const actionRequestsInFlightRef = useRef(0);
  // 作成の最中の依頼の id (状態を読み直すため) と、その進捗の購読の解除 (#2254 M1。作成が終わったら外す)
  const dayMenuRequestIdRef = useRef<string | null>(null);
  const dayMenuUnsubscribeRef = useRef<(() => void) | null>(null);
  /** 1日献立の作成の最中にする (作成中の一文を足すとき。終わりは settleDayMenuRequest) */
  const markDayMenuInFlight = (inFlight: boolean) => {
    dayMenuInFlightRef.current = inFlight;
    setIsDayMenuInFlight(inFlight);
  };
  /**
   * 1日献立の作成が終わった (完了・失敗・依頼が始まらなかった・進捗を追えない): 止めを下ろし、進捗の購読を外す (#2254 M1)。
   * 作成の最中でなければ何もせず false を返す (終わりは Realtime の通知と状態の読み直しの両方から届きうるので、完了・失敗の一文を
   * 2 度足さない)。終わるのも画面の操作 (完了・失敗の一文を今の画面に足す): 一覧を待っている開く (openChat) に、この画面の会話を
   * 読み直させない (読み直すと会話がサーバーの写しで置き換わり、作成中・完了の一文が消える)
   */
  const settleDayMenuRequest = (): boolean => {
    if (!dayMenuInFlightRef.current) return false;
    markDayMenuInFlight(false);
    dayMenuRequestIdRef.current = null;
    const unsubscribe = dayMenuUnsubscribeRef.current;
    dayMenuUnsubscribeRef.current = null;
    unsubscribe?.();
    startViewOperation();
    return true;
  };
  /** 提案の実行の応答待ちを 1 件始める (終わったら必ず endActionRequest を 1 回呼ぶ) */
  const beginActionRequest = () => {
    actionRequestsInFlightRef.current += 1;
    setActionRequestsInFlight(actionRequestsInFlightRef.current);
  };
  /**
   * 提案の実行の応答待ちが 1 件終わった。終わるのも画面の操作 (#2254 M1。結果の一文を今の画面に足したあと。一覧を待っている開く
   * (openChat) に、この画面の会話を読み直させない。settleDayMenuRequest と同じ)
   */
  const endActionRequest = () => {
    actionRequestsInFlightRef.current -= 1;
    setActionRequestsInFlight(actionRequestsInFlightRef.current);
    startViewOperation();
  };
  /** 1日献立の作成の最中か・提案の実行の応答待ちが 1 件でもあるか (今の値。#2254 M1) */
  const resultRequestInFlight = () => dayMenuInFlightRef.current || actionRequestsInFlightRef.current > 0;
  // FAB ドラッグ位置 (right/bottom px)
  const [fabPosition, setFabPosition] = useState<{ x: number; y: number }>(() => {
    if (typeof window === 'undefined') return { x: 16, y: 96 };
    try {
      // Cookie 優先（タブ間共有）
      const cookieMatch = document.cookie.match(/aiChatBubblePosition=([^;]+)/);
      if (cookieMatch) {
        return JSON.parse(decodeURIComponent(cookieMatch[1]));
      }
      // フォールバック: localStorage
      const saved = localStorage.getItem('aiChatBubblePosition');
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return { x: 16, y: 96 };
  });
  const [isDragging, setIsDragging] = useState(false);
  // Bug-5 (#21): Default to the date currently displayed on the weekly menu
  // page (published via window.__weeklyCurrentDate). If unavailable, fall back
  // to *tomorrow* rather than today to avoid silently overwriting today's
  // existing menu when the user opens this modal for a future day.
  // 明日は、時計を 1 回だけ読んだ JST の今日から暦の計算でずらす (#2235 I8)。翌日を暦の計算で扱えない日 (9999-12-31) は今日。
  // 表示の日が日付の欄の範囲の外なら明日 (#2245 L1。defaultDayMenuDateOf)
  const computeDefaultDayMenuDate = (): string =>
    defaultDayMenuDateOf(todayLocal(), typeof window === 'undefined' ? undefined : window.__weeklyCurrentDate);
  const [selectedDate, setSelectedDate] = useState<string>(() => computeDefaultDayMenuDate());

  // Recompute default whenever the modal is opened, so it picks up the
  // latest currently-displayed date from the weekly page.
  const openDayMenuModal = () => {
    setSelectedDate(computeDefaultDayMenuDate());
    setShowDayMenuModal(true);
  };
  const [v4Progress, setV4Progress] = useState<string | null>(null);

  /**
   * 1日献立の作成が完了した (Realtime の通知・状態の読み直しのどちらからも呼ぶ)。止めを下ろして完了の一文を足す。
   * 作成の最中でなければ (もう一方の経路が先に終わりを見つけた) 何もしない (#2254 M1)
   */
  const completeDayMenu = () => {
    if (!settleDayMenuRequest()) return;
    setV4Progress(null);
    notifyMenuGenerated();
    // 成功メッセージをチャットに追加
    setMessages(prev => [...prev, {
      id: `v4-success-${Date.now()}`,
      role: 'assistant',
      content: '✅ 献立の作成が完了しました！献立表で確認できます。',
      createdAt: new Date().toISOString(),
    }]);
    // 他のコンポーネントに通知
    window.dispatchEvent(new CustomEvent('mealPlanUpdated', {
      detail: { actionType: 'generate_day_menu' }
    }));
  };
  /**
   * 1日献立の作成が失敗した (依頼の失敗・進捗の失敗。Realtime の通知・状態の読み直しのどちらからも呼ぶ)。止めを下ろして失敗の一文を
   * 足す。作成の最中でなければ (もう一方の経路が先に終わりを見つけた) 何もしない (#2254 M1)
   */
  const failDayMenu = (error: string) => {
    if (!settleDayMenuRequest()) return;
    setV4Progress(null);
    // 生成を受け付けたあとに、サーバーが同意の判定で止めた (未同意。T15 / #1154): 同意画面 (AiConsentRequiredHost) が案内する。
    // 同期で止められたとき (generateDayMenu の catch) と同じ一文だけを出し、失敗の文は出さない
    if (handleStoredAiConsentFailure(error)) {
      setMessages(prev => [...prev, {
        id: `v4-consent-${Date.now()}`,
        role: 'assistant',
        content: V4_CONSENT_REQUIRED_CHAT_NOTE,
        createdAt: new Date().toISOString(),
      }]);
      return;
    }
    setMessages(prev => [...prev, {
      id: `v4-error-${Date.now()}`,
      role: 'assistant',
      content: `❌ 献立の作成に失敗しました: ${error}`,
      createdAt: new Date().toISOString(),
    }]);
  };

  // V4 献立生成フック
  const {
    isGenerating: isGeneratingDayMenu,
    generate: generateV4,
    subscribeToProgress,
    cancelGeneration: resetDayMenuGeneration,
  } = useV4MenuGeneration({
    onGenerationComplete: () => completeDayMenu(),
    // 失敗の文は保存された文のことがあるので、同意で止めた文かを failDayMenu の中で見分ける (handleStoredAiConsentFailure)
    onError: (error) => failDayMenu(error),
  });

  /**
   * 作成の最中の依頼の状態を、状態の確認 (GET /api/ai/menu/weekly/status) で読み直す (#2254 M1)。Realtime の完了・失敗の通知を
   * 取りこぼした (タブを裏に回した・通信が途切れた) ときに、止め (『相談を終了』・新しい相談・相談の切り替え・開き直しの読み直し) を
   * 下ろすための保険。終わっていれば (完了・失敗・依頼の行が無い) 通知が届いたときと同じ処理をし、フックの作成中の印も下ろす
   * (フックの印は Realtime の通知でしか下りないので、そのままだと『1日献立変更』も押せないまま)。まだ作成中なら何もしない。
   * 読めなかったとき (401・500・通信の失敗) も何もしない (次の読み直しに任せる)
   */
  const recheckDayMenuRequest = async () => {
    const requestId = dayMenuRequestIdRef.current;
    if (!dayMenuInFlightRef.current || requestId === null) return;
    try {
      const res = await fetch(`/api/ai/menu/weekly/status?requestId=${encodeURIComponent(requestId)}`);
      if (!res.ok) return;
      const body: unknown = await res.json();
      const { status, errorMessage } = (body !== null && typeof body === 'object' ? body : {}) as {
        status?: unknown;
        errorMessage?: unknown;
      };
      // 読む間に終わりが届いた (止めを下ろした)・別の作成に変わった: 何もしない
      if (dayMenuRequestIdRef.current !== requestId) return;
      if (status === DAY_MENU_REQUEST_COMPLETED_STATUS) {
        resetDayMenuGeneration();
        completeDayMenu();
      } else if (typeof status === 'string' && DAY_MENU_REQUEST_FAILED_STATUSES.has(status)) {
        resetDayMenuGeneration();
        failDayMenu(typeof errorMessage === 'string' && errorMessage !== '' ? errorMessage : DAY_MENU_FAILED_FALLBACK_MESSAGE);
      }
    } catch (e) {
      console.error('Failed to recheck day menu request:', e);
    }
  };
  // 読み直しを effect (予約・タブの戻り) から呼ぶための、最新の描画の関数 (#2254 M1)
  const recheckDayMenuRequestRef = useRef<() => void>(() => {});
  useEffect(() => {
    recheckDayMenuRequestRef.current = () => {
      void recheckDayMenuRequest();
    };
  });
  // 作成の最中は、DAY_MENU_STATUS_RECHECK_INTERVAL_MS ごとと、タブが前に戻ったときに依頼の状態を読み直す (#2254 M1。
  // 作成が終わったら (isDayMenuInFlight が偽になったら)・部品を外すときに後始末で取り消す)
  useEffect(() => {
    if (!isDayMenuInFlight) return;
    const recheck = () => recheckDayMenuRequestRef.current();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    const timer = setInterval(recheck, DAY_MENU_STATUS_RECHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isDayMenuInFlight]);
  // 部品を外すときに、作成の最中の進捗の購読を外す (#2254 M1)
  useEffect(() => {
    return () => {
      dayMenuUnsubscribeRef.current?.();
      dayMenuUnsubscribeRef.current = null;
    };
  }, []);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamingRef = useRef<{ messageId: string; fullContent: string; currentIndex: number } | null>(null);
  const streamingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const fabDragStart = useRef<{ clientX: number; clientY: number; t: number; pos: { x: number; y: number } } | null>(null);
  const fabDraggingRef = useRef(false);
  const fabPositionRef = useRef<{ x: number; y: number }>({ x: 16, y: 96 });
  // #125: ref ベースの連続クリック防止（state の stale 値に依存しない）
  const isTogglingRef = useRef(false);
  // 開閉のフラグの解除・自動実行の結果の一文・前の依頼の読み直し (#2201 U3)・返答がまだ無かったときの会話の取り直し
  // (#2206 G2) の予約。部品を外すときにすべて取り消す (#2201)
  const scheduleUnmountClearedTimeout = useUnmountClearedTimeouts();
  // 今出している相談の id。応答を受け取れなかったあとの取り直しの最中に相談を切り替えたら、送った文を入力欄に戻さない
  // (別の相談の入力欄に戻ってしまう。#2206 G2)。取り直しは await をまたぐので、state ではなく ref で今の値を見る
  const currentSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);
  /**
   * 出す相談を変える (#2245 K1)。ref も同じ時に変える (描画を待つと、切り替えの直後に返った会話の読み込み (fetchMessages) が古い値を
   * 見て、前の相談の会話を今の画面に置く。モバイルの AIAdvisorSheet の showSessionId と同じ)
   */
  const showSessionId = (sessionId: string | null) => {
    // 出す相談を変えるのも画面の操作 (#2254 M1。前に始めた開く (openChat)・新しい相談の作成の結果で、この相談を上書きさせない)
    startViewOperation();
    currentSessionIdRef.current = sessionId;
    setCurrentSessionId(sessionId);
  };
  // 最新の画面の操作の番号 (#2254 M1。モバイルの AIAdvisorSheet の viewGenRef と同じ決まり)。チャットを開く (openChat)・新しい相談を
  // 作る (createNewSession)・出す相談を変える (showSessionId)・1日献立の作成と提案の実行を始める・終える (作成中・完了・結果の一文を
  // 今の画面に足す。settleDayMenuRequest・endActionRequest) たびに 1 つ進める。開く・作るは始めたときの番号を持ち、一覧・作成の応答が
  // 返ったときに番号が進んでいれば、出す相談と会話を変えない (最後の操作が勝つ)。以前は開く側が閉包の古い currentSessionId を見て、
  // 一覧を待つ間に始めた新しい相談・選んだ相談を、一覧を読んだ時点の相談で上書きした
  const viewGenRef = useRef(0);
  /** 画面の操作を 1 つ始め、その番号を返す */
  function startViewOperation(): number {
    viewGenRef.current += 1;
    return viewGenRef.current;
  }
  // 最後に始めた一覧の読み込み (fetchSessions) の番号 (#2254 M1)。一覧は応答の順でなく、最後に始めた読み込みの応答だけを置く
  // (閉じる応答待ちの前に始めた一覧が、閉じる側の読み直しより後に返ると、閉じた相談が終了でない一覧が出た)
  const sessionsRequestSeqRef = useRef(0);
  // 最後に始めた読み込み中の印 (isLoading) の番号 (#2254 M1)。印を下ろすのは最後に始めた読み込み (会話の読み込み・新しい相談の作成)
  // が終わったときだけ (前の相談の遅れた読み込みが終わったときに、今の読み込みの最中の印を早く消さない)
  const loadingSeqRef = useRef(0);
  /** 読み込み中の印を立て、その読み込みの番号を返す */
  const beginLoading = useCallback((): number => {
    loadingSeqRef.current += 1;
    setIsLoading(true);
    return loadingSeqRef.current;
  }, []);
  /** 読み込み (seq) が終わった: それが最後に始めた読み込みなら印を下ろす */
  const endLoading = useCallback((seq: number) => {
    if (loadingSeqRef.current === seq) setIsLoading(false);
  }, []);
  // 届いたかを確かめられなかった送信 (取り直せなかった・送った文が見つからなかった) と、送信に当てた送った文の保存行の id (#2227 H1)。
  // 後の取り直しで前の送信の保存行が見つかったら、入力欄に戻した文を消し (届いていたのにそのまま送ると二重に届く)、今回の送信の
  // 保存行を探すときはそれを除く (同じ文を続けて送ったときに、前の送信の保存行を今回の送信と取り違えない)。決まりは共有の
  // resolveUnconfirmedSends (モバイルの AIAdvisorSheet と同じ)
  const unconfirmedSendsRef = useRef<UnconfirmedSend[]>([]);
  const claimedSavedUserIdsRef = useRef<string[]>([]);
  // 送信中か・相談を閉じる (/close) の応答待ちの最中か (#2235 I8。isSending / isClosingSession と同じ値を ref でも持つのは、
  // ボタンを止める描画を待たずに今の値を見て、同じ描画のうちの 2 度目の押下も止めるため。モバイルの AIAdvisorSheet の sendingRef /
  // closingSessionRef と同じ形)。閉じる応答待ちの間は、送信 (入力欄・送信ボタン・クイック質問)・新しい相談・相談の切り替えを止める
  // (止めないと、送った文は閉じる側の相談へ送られて閉じたあとの新しい相談で画面から消え、手で始めた新しい相談は閉じる側の作成と
  // 合わせて 2 つ作られ、選んだ相談は閉じたあとの新しい相談で上書きされた)。逆に送信中は閉じるを止める (送信の返答が閉じた相談にだけ
  // 保存され、新しい相談の画面には出ない)
  const sendingRef = useRef(false);
  const closingSessionRef = useRef(false);

  /** 送った文の保存行 (id) をその送信に当てた印を付ける (確かめられなかった前の送信がこの行を自分のものとして当てないように) */
  const claimSavedUserMessageId = useCallback((id: unknown) => {
    if (typeof id !== 'string' || claimedSavedUserIdsRef.current.includes(id)) return;
    claimedSavedUserIdsRef.current = [...claimedSavedUserIdsRef.current, id];
  }, []);

  /**
   * 取り直した相談 (sessionId) の会話 (loaded) で、確かめられなかった前の送信の保存行を探す (#2227 H1)。
   * 見つかった送信は、入力欄が戻した文のままなら消す (モバイルの clearInputIfDelivered と同じ決まり。今の相談のときだけ)。
   * 相談を開き直したとき (forgettable) は、forgettable に入っている送信のうち見つからなかったものを忘れる (開き直した会話は以後の
   * 送信の「送る前に出ていた行」に入るので、見つからない送信は届いていない)。忘れてよいのは、開き直しの GET を始める前に積んであった
   * 送信だけ (#2235 I1。GET を待つ間に終わった取り直しが積んだ送信は、保存が GET の写しより後になりうるので、写しに無くても忘れない。
   * 以前は呼んだ時点の入れ物をまるごと見て、その相談の残りを忘れていた。忘れる範囲はモバイルの AIAdvisorSheet の loadMessages と同じ写し)。
   * 保存行を探すのは呼んだ時点の入れ物の全部 (写しに保存行があれば届いていたので、GET を待つ間に積まれた送信も当ててよい。探す範囲は
   * モバイルより広い)。
   * current は今回の送信 (取り直しの途中のもの。無ければ null)、currentAccepted は今回の送信をサーバーが受け付けたか。
   * 戻り値は送信に当てた保存行の id (今回の送信を探すときに knownMessageIds に足して除く)
   */
  const settleUnconfirmedSends = useCallback(
    (params: {
      sessionId: string;
      loaded: readonly LoadedMessage[];
      current: SentText | null;
      currentAccepted: boolean;
      /** 見つからなければ忘れる送信 (開き直しの GET を始める前の入れ物の写し)。忘れない読み込みは空 */
      forgettable: readonly UnconfirmedSend[];
    }): string[] => {
      const resolution = resolveUnconfirmedSends({
        sessionId: params.sessionId,
        loaded: params.loaded,
        unconfirmed: unconfirmedSendsRef.current,
        previousClaimedIds: claimedSavedUserIdsRef.current,
        current: params.current,
        currentAccepted: params.currentAccepted,
      });
      const forgettable = new Set(params.forgettable);
      unconfirmedSendsRef.current = resolution.remaining.filter(
        send => !(send.sessionId === params.sessionId && forgettable.has(send)),
      );
      claimedSavedUserIdsRef.current = resolution.claimedIds;
      if (currentSessionIdRef.current === params.sessionId) {
        for (const send of resolution.resolved) setInputText(current => clearInputIfDelivered(current, send.text));
      }
      return resolution.claimedIds;
    },
    [],
  );

  // クライアントサイドでのみレンダリング
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // スクロールを最下部に
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages]);

  // ストリーミング表示のクリーンアップ
  useEffect(() => {
    return () => {
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
      }
    };
  }, []);

  // ストリーミング表示を開始
  const startStreaming = (messageId: string, fullContent: string) => {
    // 既存のストリーミングをクリア
    if (streamingIntervalRef.current) {
      clearInterval(streamingIntervalRef.current);
    }

    streamingRef.current = {
      messageId,
      fullContent,
      currentIndex: 0,
    };

    // 1文字ずつではなく、チャンク単位で表示（より自然に見える）
    const chunkSize = 3; // 一度に表示する文字数
    const intervalMs = 20; // 更新間隔（ミリ秒）

    streamingIntervalRef.current = setInterval(() => {
      if (!streamingRef.current) {
        clearInterval(streamingIntervalRef.current!);
        return;
      }

      const { messageId, fullContent, currentIndex } = streamingRef.current;
      const nextIndex = Math.min(currentIndex + chunkSize, fullContent.length);
      const displayContent = fullContent.slice(0, nextIndex);

      setMessages(prev => prev.map(m => 
        m.id === messageId 
          ? { ...m, content: displayContent, isStreaming: nextIndex < fullContent.length }
          : m
      ));

      if (nextIndex >= fullContent.length) {
        // ストリーミング完了
        clearInterval(streamingIntervalRef.current!);
        streamingRef.current = null;
        scrollToBottom();
      } else {
        streamingRef.current.currentIndex = nextIndex;
      }
    }, intervalMs);
  };

  // セッション一覧取得
  // 戻り値: null = 未認証, Session[] = セッション一覧 (空配列含む)
  const fetchSessions = useCallback(async (): Promise<Session[] | null> => {
    sessionsRequestSeqRef.current += 1;
    const requestSeq = sessionsRequestSeqRef.current;
    try {
      const res = await fetch('/api/ai/consultation/sessions?status=all');
      if (res.status === 401) {
        setIsAuthenticated(false);
        return null;
      }
      if (res.ok) {
        setIsAuthenticated(true);
        const data = await res.json();
        const fetched: Session[] = data.sessions || [];
        // 一覧を置くのは、これが最後に始めた一覧の読み込みのときだけ (#2254 M1。あとに始めた読み込みのほうが新しい)。
        // 呼び出し側 (openChat) には返す (出す相談を決めるかは、画面の操作の番号で呼び出し側が決める)
        if (sessionsRequestSeqRef.current === requestSeq) setSessions(fetched);
        return fetched;
      }
      return null;
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
      return null;
    }
  }, []);

  // メッセージ取得。会話を画面に置くのは、返ったときにまだその相談を出しているときだけ (#2245 K1。相談を A→B と切り替えた・閉じたあとの
  // 新しい相談に変わったあとに遅れて返った A の会話を、今の相談の画面に置かない。置くと、画面の会話と違う相談へ送られる)。
  // 確かめられなかった送信の settle は、今の相談でなくても行う (その相談の写しで届いたかが分かる。入力欄に触るのは今の相談のときだけ)。
  // 決まりはモバイルの AIAdvisorSheet の loadMessages と同じ
  const fetchMessages = useCallback(async (sessionId: string) => {
    const loading = beginLoading();
    // この読み込みで忘れてよいのは、読み込みを始める前に積んであった送信だけ (#2235 I1。読み込みの最中に終わった取り直しが積んだ
    // 送信は、GET の写しより後に保存されうるので、写しに無くても忘れない。モバイルの AIAdvisorSheet の loadMessages と同じ)
    const forgettable = [...unconfirmedSendsRef.current];
    try {
      const res = await fetch(`/api/ai/consultation/sessions/${sessionId}/messages`);
      if (res.ok) {
        const data = await res.json();
        if (currentSessionIdRef.current === sessionId) {
          setMessages((data.messages || []).map((m: any) => ({
            ...m,
            isImportant: m.isImportant || false,
          })));
        }
        // 確かめられなかった前の送信が届いていたら、入力欄に戻した文を消す (#2227 H1)
        const loaded = loadedMessagesOf(data);
        if (loaded) settleUnconfirmedSends({ sessionId, loaded, current: null, currentAccepted: false, forgettable });
      }
    } catch (e) {
      console.error('Failed to fetch messages:', e);
    } finally {
      // 印を下ろすのは、これが最後に始めた読み込みのときだけ (#2254 M1。A→B と切り替えたあとに遅れて終わった A の読み込みが、
      // B の読み込みの最中の印を消さない)
      endLoading(loading);
    }
  }, [settleUnconfirmedSends, beginLoading, endLoading]);

  // チャットを開く
  // Bug-6: 隣接 UI からの誤クリックでチャットが意図せず開くのを防ぐため、
  // event を受け取って stopPropagation し、既にモーダルが開いている場合は無視する。
  // #125: isToggling フラグで連続クリックによる二重表示を防止する。
  const openChat = async (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (showDayMenuModal) {
      // 別のモーダルが開いている間はチャットを開かない
      return;
    }
    // #125: transition 中の連続クリックを弾く（ref で stale state を回避）
    if (isTogglingRef.current) return;
    isTogglingRef.current = true;
    setIsToggling(true);
    setIsOpen(true);
    setHasUnread(false);
    try {
      // 1日献立の作成の最中に開いた: 依頼の状態を読み直す (#2254 M1。Realtime の完了・失敗の通知を取りこぼしていたら、ここで終わりを
      // 見つけて止めを下ろし、完了・失敗の一文を足す。終わるのも画面の操作なので、下の一覧のあとに会話を読み直さない)
      if (dayMenuInFlightRef.current) void recheckDayMenuRequest();
      // 相談を閉じる (/close) の応答待ちの間は、会話を読み込まない (#2245 K1。閉じる側が応答のあと一覧を読み直し、新しい相談を出す。
      // ここで読み込むと、閉じたあとの新しい相談の画面を、遅れて返った閉じた相談の会話や一覧で上書きしうる)。開くだけはする
      if (closingSessionRef.current) return;
      // 開くのも画面の操作 (#2254 M1)。一覧を待つ間にほかの画面の操作があったかを、この番号で見る
      const startedAt = startViewOperation();
      const fetchedSessions = await fetchSessions();

      if (fetchedSessions === null) {
        return; // 認証されていない場合は何もしない
      }
      // 一覧を待つ間に閉じるを押した: 読み込みは閉じる側に任せる (#2245 K1。上と同じ)。
      // 一覧を待つ間にほかの画面の操作 (新しい相談・相談の切り替え・開き直し) があった: 出す相談を変えず、会話も読み込まない
      // (#2254 M1。最後の操作が勝つ。以前は閉包の古い currentSessionId を見て、始めた新しい相談を一覧の相談で上書きした)
      if (closingSessionRef.current || viewGenRef.current !== startedAt) return;
      // 1日献立の作成の最中・提案の実行の応答待ちの最中 (チャットを閉じて開き直した): 出す相談を変えず、会話も読み直さない (#2254 M1。
      // 読み直すと会話がサーバーの写しで置き換わり、作成中の一文が消える。画面はもうその相談の会話を出している)。
      // 一覧を待つ間に作成・実行を始めた・終わった (完了・失敗・結果の一文を足した) ときは、始める・終わるのが画面の操作なので上の番号で止まる
      if (resultRequestInFlight()) return;

      // 既存のアクティブセッションがあればそれを使う、なければ新規作成
      // ※ fetchSessions() の返り値を直接参照（stale state 回避）。今出している相談も閉包の state でなく ref で見る (#2254 M1)
      const shownSessionId = currentSessionIdRef.current;
      if (fetchedSessions.length > 0 && !shownSessionId) {
        const activeSession = fetchedSessions.find(s => s.messageCount > 0) || fetchedSessions[0];
        showSessionId(activeSession.id);
        await fetchMessages(activeSession.id);
      } else if (!shownSessionId) {
        await createNewSession();
      } else {
        await fetchMessages(shownSessionId);
      }
    } finally {
      // #125: アニメーション完了まで少し待ってからフラグを解除
      scheduleUnmountClearedTimeout(() => {
        isTogglingRef.current = false;
        setIsToggling(false);
      }, CHAT_OPEN_TOGGLE_LOCK_MS);
    }
  };

  /**
   * 「新しい相談を始める」の押下 (#2235 I8)。相談を閉じる応答待ちの間は始めない (ボタンも止めている。ref で見るのは、閉じると同じ
   * 描画のうちの押下も止めるため)。閉じる側は応答のあと自分で新しい相談を作る (createNewSession) ので、ここで作ると 2 つになる。
   * 1日献立の作成の最中・提案の実行の応答待ちの最中も始めない (#2254 M1。新しい相談の画面の置き換えで作成中の一文が消え、完了・結果の
   * 一文が新しい相談の画面に出る。ボタンも止めている)
   */
  const pressNewSession = async () => {
    if (closingSessionRef.current || resultRequestInFlight()) return;
    await createNewSession();
  };

  // 新規セッション作成 (「新しい相談を始める」の押下 pressNewSession・チャットを開いたとき・相談を閉じたあとから呼ぶ)
  const createNewSession = async () => {
    // 作るのも画面の操作 (#2254 M1)。作成を待つ間にほかの画面の操作 (相談の切り替え・開き直し・別の新しい相談) があったら、
    // その画面を作った相談で上書きしない (最後の操作が勝つ。作った相談はサーバーに残り、次に一覧を読んだときに出る)
    const startedAt = startViewOperation();
    const loading = beginLoading();
    try {
      const res = await fetch('/api/ai/consultation/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'AI相談' }),
      });

      if (res.ok) {
        const data = await res.json();
        if (viewGenRef.current !== startedAt) return;
        showSessionId(data.session.id);
        setMessages([]);
        setShowSessionList(false);
        
        // 初期メッセージを表示
        setMessages([{
          id: 'welcome',
          role: 'assistant',
          content: 'こんにちは！🍳 ほめゴハンのAIアドバイザーです。\n\n食事や栄養のことで気になることがあれば、何でも聞いてくださいね。献立の提案や、買い物リストの作成もお手伝いできますよ！',
          createdAt: new Date().toISOString(),
        }]);
      } else {
        // #1148: AI 相談の緊急停止中は、サーバーのやさしい文面を出す (入力しても送れないので、セッションは作らない)
        const unavailableMessage = await readAiChatUnavailableMessage(res);
        if (unavailableMessage && viewGenRef.current === startedAt) {
          showSessionId(null);
          setMessages([{
            id: 'unavailable',
            role: 'assistant',
            content: unavailableMessage,
            createdAt: new Date().toISOString(),
          }]);
        }
      }
    } catch (e) {
      console.error('Failed to create session:', e);
    } finally {
      endLoading(loading);
    }
  };

  // 会話の続きの POST がアクションを自動で実行した結果 (SSE の finalData の actionResult) をチャットに出す。
  // 失敗 (success が偽) は『実行しました』と出さず、失敗の文を出す。黙って失敗させない (#2183 Z1)。提案 (proposedActions) は消さない
  const showAutoActionOutcome = (finalData: AutoActionFinalData) => {
    const actionResult = finalData.actionResult;
    if (!actionResult) return;
    // 種類は actionResult.actionType を先に読み、無ければ提案の種類から引く
    const actionType = actionResult.actionType ?? finalData.aiMessage?.proposedActions?.type;
    const outcome = consultationActionOutcomeOf({
      success: actionResult.success,
      result: actionResult.result,
      label: actionLabelOf(actionType),
    });
    scheduleUnmountClearedTimeout(() => {
      setMessages(prev => [...prev, actionOutcomeChatMessage(outcome)]);
      if (outcome.kind !== 'executed') return;
      window.dispatchEvent(new CustomEvent('mealPlanUpdated', {
        detail: { actionType, result: actionResult.result }
      }));
    }, AUTO_ACTION_OUTCOME_MESSAGE_DELAY_MS);
  };

  /** 読み直し・取り直しを PREVIOUS_REQUEST_RECHECK_DELAY_MS 後に 1 回だけ予約する (部品を外すときに取り消す) */
  const scheduleRecheck = (run: () => Promise<void>) => {
    scheduleUnmountClearedTimeout(() => {
      void run();
    }, PREVIOUS_REQUEST_RECHECK_DELAY_MS);
  };

  /**
   * 返答 (replyId) の提案の記録を、PREVIOUS_REQUEST_RECHECK_DELAY_MS 待ってから 1 回だけ読み直す (#2201 U3・#2206 G2)。
   * 一文をどうするか・知らせるかは共有の previousRequestRecheckPlanOf と messagesAfterPreviousRequestRecheck が決める
   * (モバイルの AIAdvisorSheet と同じ決まり)。
   *   - 実行できた行になっていれば: 実行中の一文を『前の依頼は実行されました』に置き換え (一文が無ければ返答のすぐ後に足す。
   *     記録を読めずに一文を出さなかったとき)、返答の提案のカードを外し (開き直したときの GET と同じ)、データの更新を知らせる
   *   - 実行を待つ・失敗した行になっていれば: 実行中の一文を『前の依頼は実行できませんでした』に置き換え、カードを今の行に合わせる
   *     (#2206 G2。以前は『実行中か実行済み』のまま残った)。実行中の一文が無ければ何もしない
   *   - 読めたのに行がまだ無く、返答に提案がある (replyHasProposal) ときも実行を待つ・失敗と同じ (サーバーは行を作れなかったら
   *     実行しない。#2227 H1。カードは GET と同じ『もう一度 AI に頼んでください』になる)
   *   - まだ実行中の印のまま・行が無い・読めないときは何もしない (一文とカードはそのまま。頼み直しを勧めない)
   * 別の相談に切り替えていても知らせる (データは変わっている)。一文とカードは今の会話に無ければ触らない
   */
  const recheckPreviousRequestLater = (replyId: string, replyHasProposal: boolean) =>
    scheduleRecheck(async () => {
      const actionState = await readReplyActionStateOf(replyId);
      const { actionType, result, statuses } = actionState;
      const plan = previousRequestRecheckPlanOf(actionState, replyHasProposal);
      setMessages(prev =>
        messagesAfterPreviousRequestRecheck(prev, {
          replyId,
          plan,
          noteOf: noteState => previousRequestNoteOf(noteState, replyId),
          // 実行できた: カードを外す (開き直したときの GET と同じ)。実行を待つ・失敗: カードを今の行に合わせる
          updateReply: m => {
            if (plan.noteState === 'executed') return { ...m, proposedActions: null };
            return m.proposedActions ? { ...m, ...proposedActionCardFieldsOfStatuses(statuses) } : m;
          },
        }),
      );
      if (plan.notifyDataChanged) {
        // finalData を受け取れた経路 (showAutoActionOutcome) と同じ detail (献立の生成なら、取り直す側が生成の完了まで見張る)
        window.dispatchEvent(new CustomEvent('mealPlanUpdated', { detail: { actionType, result } }));
      }
    });

  /**
   * 取り直した返答 (reply) を、画面の AI の仮のメッセージ (placeholderId) と置き換え、前の依頼の一文を足す (#2201 U3・#2206 G2)。
   * 返答の提案の記録を読み、一文・知らせるか・読み直すかは共有の previousRequestNotePlanOf が決める (モバイルと同じ決まり):
   * 実行できていれば『前の依頼は実行されました』を足してカードを外し、データの更新を知らせる。
   * 実行中の印 (行がまだ無い・読めないのに提案があるときも含む) なら『前の依頼の結果をまだ確かめられません…』を足して 1 回だけ
   * 読み直す (ただし、記録を読めず GET が「実行する」を出すとした (pending) ときは、実行していない一文を出す (#2227 H1))。実行を待つ・失敗なら『前の依頼は実行できませんでした』を足す。提案が無く記録を読めなかったときは、一文を足さずに
   * 1 回だけ読み直す (GET は実行できた提案のカードを出さないので、読めないと実行できたかが分からない。#2206 G2)。
   * savedUser があれば、楽観的に出した送った文 (tempId) も保存された行の id にする
   */
  const placeReloadedReply = async (params: {
    reply: LoadedMessage;
    placeholderId: string;
    savedUser?: { tempId: string; saved: LoadedMessage };
  }) => {
    const { reply, placeholderId, savedUser } = params;
    const actionState = await readReplyActionStateOf(reply.id);
    const replyHasProposal = replyHasProposalOf(reply);
    const plan = previousRequestNotePlanOf({
      actionState: actionState.state,
      readFailed: actionState.readFailed,
      replyHasProposal,
      replyProposalExecutable: replyProposalExecutableOf(reply),
    });
    const notes = plan.noteState ? [previousRequestNoteOf(plan.noteState, reply.id)] : [];
    setMessages(prev => prev.flatMap(m => {
      if (savedUser && m.id === savedUser.tempId) {
        return [{ ...m, id: savedUser.saved.id, isImportant: savedUser.saved.isImportant === true }];
      }
      if (m.id === placeholderId) {
        return [
          {
            ...m,
            id: reply.id,
            content: reply.content,
            ...proposedActionFieldsOfLoaded(reply, plan.state, actionState.statuses),
            isImportant: reply.isImportant === true,
            isStreaming: false,
          },
          ...notes,
        ];
      }
      return [m];
    }));
    if (plan.notifyDataChanged) {
      // finalData を受け取れた経路 (showAutoActionOutcome) と同じ detail (献立の生成なら、取り直す側が生成の完了まで見張る)
      window.dispatchEvent(new CustomEvent('mealPlanUpdated', { detail: { actionType: actionState.actionType, result: actionState.result } }));
    }
    if (plan.recheck) recheckPreviousRequestLater(reply.id, replyHasProposal);
  };

  /**
   * 取り直したら送った文は届いていたが返答がまだ無かったとき、PREVIOUS_REQUEST_RECHECK_DELAY_MS 待ってから 1 回だけ会話を取り直す
   * (#2206 G2。実行中の印の読み直しと同じ 1 回)。以前は予約が無く、あとで返答の保存と自動実行が済んでも、画面は
   * 『返答を作っているところかもしれません』のままで、データの更新 (mealPlanUpdated) も知らせなかった。
   * 返答があれば、開き直してもらう文 (placeholderId) を返答に置き換え、前の依頼の一文を足す (placeReloadedReply)。
   * 返答は、最初の取り直しで分かった送った文の保存行の id (savedUserMessageId) のすぐ後ろの assistant で探す (本文の一致では
   * 探さない。待つ間に同じ文を送り直すと、本文の一致は後の送信 (いちばん後ろの一致) とその返答を選び、前の送信の仮のメッセージに
   * 後の返答を入れて同じ返答が 2 つ並び、前の送信の返答が出なかった。#2206 G2)。
   * 返答がまだ無い・取り直せないときは何もしない (文はそのまま)
   */
  const recheckDeliveredNoReplyLater = (params: { sessionId: string; savedUserMessageId: string; placeholderId: string }) =>
    scheduleRecheck(async () => {
      const loaded = await reloadConversationAfterIncompleteReply(params.sessionId);
      if (!loaded) return;
      // 確かめられなかった前の送信が届いていたら、入力欄に戻した文を消す (#2227 H1)
      settleUnconfirmedSends({ sessionId: params.sessionId, loaded, current: null, currentAccepted: false, forgettable: [] });
      const reply = replyToUserMessageIdOf(params.savedUserMessageId, loaded);
      if (!reply) return;
      await placeReloadedReply({ reply, placeholderId: params.placeholderId });
    });

  /**
   * 送信の応答 (finalData) を受け取れなかったあと (時間切れ・流れが途中で切れた・応答を受けたあとの例外・通信が切れた)、会話を取り直して、
   * 送った文が届いていたか・返答があるか・返答の提案が自動で実行されていたかを出す (#2201 U3。モバイルの #2195 V3 と同じ直し)。
   *   - 取り直せない: 頼み直しの前に開き直してもらう文 (時間切れ・途中で切れたで文を分ける) を AI の吹き出しに出し、送った文を
   *     入力欄に戻す (#2206 G2。モバイルと同じ)。サーバーが失敗を知らせていた (serverFailed) ときは失敗の文
   *   - 届いていない: 頼み直してもらう文を出し、送った文を入力欄に戻す (restoreInput)。応答を受ける前に終わったとき
   *     (userSaveMayBeLate) は、送った文の保存が取り直しより後になりうるので『届いていません』と言い切らない (#2206 G2)
   *   - 届いているが返答がまだ無い: 開き直してもらう文を出し、少し待って 1 回だけ取り直す (recheckDeliveredNoReplyLater。#2206 G2)。
   *     サーバーが失敗を知らせていたら返答は来ないので、失敗の文を出す (#2206 G2。以前は『返答を作っているところかもしれません』に
   *     上書きしていた)
   *   - 流れてきた本文の断片は残さない (#2206 G2。以前は時間切れでないときに断片を完全な返答のように残していた (#126 の決め)。
   *     断片だけでは切れたことが分からず、サーバーでは返答と自動実行が済んでいることがある)
   *   - 返答がある: 楽観的に出した 2 件を、保存された送った文と返答に置き換え、前の依頼の一文を足す (placeReloadedReply)
   * 送った文を入力欄に戻すのは、取り直しの最中に相談を切り替えていないときだけ (#2206 G2。別の相談の入力欄に戻さない)。
   * 取り直せない・届いていない・確かめられないときは、送信を「確かめられなかった送信」として覚え、後の取り直しで保存行が
   * 見つかったら入力欄に戻した文を消す (#2227 H1。settleUnconfirmedSends)。送った文の保存行は、確かめられなかった前の送信に
   * 当てた行を除いて探す (同じ文を続けて送ったときに、前の送信の保存行を今回の送信と取り違えない。#2227 H1)
   */
  const resolveIncompleteReply = async (params: {
    sessionId: string;
    sentText: string;
    knownMessageIds: readonly string[];
    tempUserMsgId: string;
    tempAiMsgId: string;
    /** 送信が時間切れ (AbortError・TimeoutError) で終わったか */
    timedOut: boolean;
    /** サーバーが失敗を知らせた (SSE で error だけの行が来た)。返答は来ない */
    serverFailed: boolean;
    /** 応答を受ける前に終わった (時間切れ・通信の切断)。サーバーが送った文を保存するのが、取り直しより後になりうる */
    userSaveMayBeLate: boolean;
    restoreInput: () => void;
  }) => {
    const { sessionId, sentText, knownMessageIds, tempUserMsgId, tempAiMsgId, timedOut, serverFailed, userSaveMayBeLate, restoreInput } =
      params;
    const restoreInputIfSameSession = () => {
      unconfirmedSendsRef.current = [...unconfirmedSendsRef.current, { sessionId, text: sentText, knownMessageIds }];
      if (currentSessionIdRef.current === sessionId) restoreInput();
    };
    const setTempAiContent = (content: string) =>
      setMessages(prev => prev.map(m => (m.id === tempAiMsgId ? { ...m, content, isStreaming: false } : m)));

    const loaded = await reloadConversationAfterIncompleteReply(sessionId);
    if (!loaded) {
      // 会話を取り直せなかった: 時間切れ・途中で切れたときは、返答がサーバーで続いていることがあるので、頼み直しの前に開き直してもらう
      setTempAiContent(
        serverFailed
          ? AI_CHAT_REPLY_FAILED_MESSAGE
          : timedOut
            ? AI_CHAT_TIMEOUT_RELOAD_FAILED_MESSAGE
            : AI_CHAT_INTERRUPTED_RELOAD_FAILED_MESSAGE,
      );
      restoreInputIfSameSession();
      return;
    }

    // 確かめられなかった前の送信の保存行を先に当て、今回の送信を探すときはそれを除く (#2227 H1)
    const claimedIds = settleUnconfirmedSends({
      sessionId,
      loaded,
      current: { text: sentText, knownMessageIds },
      currentAccepted: !userSaveMayBeLate,
      forgettable: [],
    });
    const sent: SentText = { text: sentText, knownMessageIds: [...knownMessageIds, ...claimedIds] };
    const outcome = sentMessageReloadOutcomeOf(sent, loaded);
    if (outcome === 'not-delivered') {
      setTempAiContent(userSaveMayBeLate ? AI_CHAT_DELIVERY_UNCONFIRMED_MESSAGE : AI_CHAT_NOT_DELIVERED_MESSAGE);
      restoreInputIfSameSession();
      return;
    }
    const savedUser = loaded[sentMessageIndexOf(sent, loaded)];
    claimSavedUserMessageId(savedUser.id);
    const reply = replyToSentMessageOf(sent, loaded);
    if (!reply) {
      setMessages(prev => prev.map(m => {
        if (m.id === tempUserMsgId) return { ...m, id: savedUser.id, isImportant: savedUser.isImportant === true };
        if (m.id === tempAiMsgId) {
          return { ...m, content: serverFailed ? AI_CHAT_REPLY_FAILED_MESSAGE : AI_CHAT_DELIVERED_NO_REPLY_MESSAGE, isStreaming: false };
        }
        return m;
      }));
      if (!serverFailed) recheckDeliveredNoReplyLater({ sessionId, savedUserMessageId: savedUser.id, placeholderId: tempAiMsgId });
      return;
    }

    await placeReloadedReply({ reply, placeholderId: tempAiMsgId, savedUser: { tempId: tempUserMsgId, saved: savedUser } });
  };

  /** 送る前に出ていた、サーバーの user のメッセージの id (取り直しで、送った文を見分けるのに使う。楽観的に出したものは除く) */
  const knownUserMessageIdsOf = (current: readonly Message[]): string[] =>
    current.filter(m => m.role === 'user' && !m.id.startsWith('temp-')).map(m => m.id);

  /**
   * 文 (text) を相談に送る (リアルストリーミング対応)。送信欄 (入力欄の文) とおすすめの質問 (ボタンの文) の両方がここを通る
   * (モバイルの AIAdvisorSheet の sendMessage と同じ形)。
   * 以前はおすすめの質問のボタンに送信の流れの写しがあり、取り直しの縁の直しを 2 か所に書く必要があった。写しのほうは送った文を
   * 入力欄に戻さず、『入力欄の文をもう一度送ってください』の文が空の入力欄を指した (おすすめの質問は、ようこその一文だけのときに
   * 出るので、楽観的に出したメッセージで消え、押し直せない)。#2206 G2 で 1 つにまとめた。
   * 送らなかったとき (「同意しない」・同意が必要で止められた) と、取り直しで届いていない・確かめられない・取り直せないときは、
   * どちらから送っても、送った文を入力欄に戻す。
   * 送信中・相談を閉じる応答待ちの最中は送らない (#2235 I8。送信ボタン・入力欄・おすすめの質問も止めている。ref で見るのは、
   * 同じ描画のうちの 2 度目の押下も止めるため。閉じる応答待ちの最中に送ると、閉じる側の相談へ送られ、閉じたあとの新しい相談で
   * 送った文と返答が画面から消える)。sendingRef は送らなかったとき (「同意しない」) と送り終わったとき (finally) に下ろす
   */
  const sendMessage = async (text: string) => {
    const userMessage = text.trim();
    if (!userMessage || !currentSessionId || isSending || sendingRef.current || closingSessionRef.current) return;
    sendingRef.current = true;

    // 応答を受け取れなかったときの取り直しで、送った文を見分けるため、送る前に出ていたメッセージの id を持つ (#2201 U3)
    const knownMessageIds = knownUserMessageIdsOf(messages);
    setInputText('');
    setIsSending(true);

    // 楽観的UI更新：ユーザーメッセージを即時表示
    const tempUserMsgId = `temp-user-${Date.now()}`;
    const tempAiMsgId = `temp-ai-${Date.now()}`;

    setMessages(prev => [
      ...prev,
      {
        id: tempUserMsgId,
        role: 'user',
        content: userMessage,
        createdAt: new Date().toISOString(),
      },
      {
        id: tempAiMsgId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
        isStreaming: true,
      },
    ]);

    // 送らなかったとき (「同意しない」・同意が必要で止められた) は、楽観的に出したメッセージを消して、入力を戻す
    const undoOptimisticMessages = () => {
      setMessages(prev => prev.filter(m => m.id !== tempUserMsgId && m.id !== tempAiMsgId));
      setInputText(userMessage);
    };

    // 未同意なら同意画面を出す。選択を待つ時間をタイムアウトに含めないよう、タイマーを始める前に待つ。
    // 「同意しない」なら相談文を AI に送らない
    if ((await ensureAiConsent()) === 'declined') {
      undoOptimisticMessages();
      sendingRef.current = false;
      setIsSending(false);
      return;
    }

    // クライアント側タイムアウト (AI_CHAT_SEND_TIMEOUT_MS): サーバーが応答しない場合にユーザーへ通知
    const clientAbortController = new AbortController();
    const clientTimeoutId = setTimeout(() => clientAbortController.abort(), AI_CHAT_SEND_TIMEOUT_MS);
    // サーバーが送信を受け付けた (2xx の応答が来た) か。受け付けたあとの例外では、返答の保存と自動実行が済んでいることがあるので、
    // 失敗の文だけを出さずに会話を取り直す (#2201 U3)。catch で見るので try の外で持つ
    let responseAccepted = false;
    // サーバーが失敗を知らせた (SSE で error だけの行が来た) か。返答は来ないので、取り直しで返答が無ければ失敗の文を出す (#2206 G2)
    let serverFailed = false;
    // 流れてきた返答の本文 (流れている間の表示に使う。finalData を受け取れなかったときは取り直した返答で置き換える)
    let accumulatedContent = '';
    // 応答 (finalData) を受け取れなかったあとの取り直し (finalData の欠け・時間切れ・受け付けたあとの例外・通信の切断で 1 つを使う)。
    // 送った文を入力欄に戻すときは、入力欄に別の文があれば残す
    const resolveIncomplete = (timedOut: boolean) =>
      resolveIncompleteReply({
        sessionId: currentSessionId,
        sentText: userMessage,
        knownMessageIds,
        tempUserMsgId,
        tempAiMsgId,
        timedOut,
        serverFailed,
        // 応答を受ける前に終わった (時間切れ・通信の切断) ときは、送った文の保存が取り直しより後になりうる (#2206 G2)
        userSaveMayBeLate: !responseAccepted,
        restoreInput: () => setInputText(current => restoreInputAfterUndelivered(current, userMessage)),
      });

    try {
      // ストリーミングモードでAPI呼び出し
      const res = await aiFetch(`/api/ai/consultation/sessions/${currentSessionId}/messages?stream=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage }),
        signal: clientAbortController.signal,
      });

      // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内する。送らなかったので、メッセージを消して入力を戻す
      if (await isAiConsentRequiredResponse(res)) {
        undoOptimisticMessages();
        return;
      }

      if (!res.ok) {
        // #1148: AI 相談の緊急停止中は、サーバーのやさしい文面を AI の吹き出しに出す
        const unavailableMessage = await readAiChatUnavailableMessage(res);
        if (unavailableMessage) {
          setMessages(prev => prev.map(m =>
            m.id === tempAiMsgId
              ? { ...m, content: unavailableMessage, isStreaming: false }
              : m
          ));
          return;
        }
        throw new Error(`HTTP error: ${res.status}`);
      }
      responseAccepted = true;

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error('No reader available');
      }

      const decoder = new TextDecoder();
      let finalData: any = null;

      // SSEストリームを読み取り
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === '[DONE]') {
              // ストリーム完了
              continue;
            }

            try {
              const parsed = JSON.parse(data);

              // 最終データ（メタ情報含む、またはエラー応答）
              if (parsed.userMessage && parsed.aiMessage) {
                finalData = parsed;
                continue;
              }

              // サーバー側エラー（DB書き込み失敗など）: ユーザーメッセージなしのエラーのみ
              if (parsed.error && !parsed.userMessage) {
                serverFailed = true;
                setMessages(prev => prev.map(m =>
                  m.id === tempAiMsgId
                    ? { ...m, content: AI_CHAT_REPLY_FAILED_MESSAGE, isStreaming: false }
                    : m
                ));
                continue;
              }

              // コンテンツチャンク
              if (parsed.choices?.[0]?.delta?.content) {
                accumulatedContent += parsed.choices[0].delta.content;

                // UIをリアルタイム更新
                setMessages(prev => prev.map(m =>
                  m.id === tempAiMsgId
                    ? { ...m, content: accumulatedContent }
                    : m
                ));
              }
            } catch {
              // JSONパースエラーは無視
            }
          }
        }
      }

      // ストリーム完了後：メッセージを最終状態に更新
      if (finalData) {
        claimSavedUserMessageId(finalData.userMessage.id);
        // #126: コンテキスト切替後に空応答になるケースをフォールバック表示。
        // サーバーが失敗を知らせた finalData (error つき。本文を途中まで流したあとの失敗など) は、流れてきた本文の断片ではなく
        // サーバーが保存した失敗の文を出す (#2227 H1。以前は断片を完全な返答のように出し、失敗だと分からなかった。開き直すと
        // 失敗の文に変わった。モバイルは以前から finalData の本文を出す)
        const resolvedContent = finalData.error
          ? finalData.aiMessage.content || AI_CHAT_REPLY_FAILED_MESSAGE
          : accumulatedContent || finalData.aiMessage.content || '';
        const displayContent = resolvedContent.trim()
          ? resolvedContent
          : '応答の取得中にコンテキストが切り替わりました。もう一度お試しください。';

        setMessages(prev => prev.map(m => {
          if (m.id === tempUserMsgId) {
            return {
              ...m,
              id: finalData.userMessage.id,
              isImportant: finalData.userMessage.isImportant || false,
            };
          }
          if (m.id === tempAiMsgId) {
            return {
              ...m,
              id: finalData.aiMessage.id,
              content: displayContent,
              ...proposedActionFieldsOfFinalData(finalData),
              isStreaming: false,
            };
          }
          return m;
        }));

        // アクション自動実行結果を表示 (失敗も黙らずに出す。#2183 Z1)
        showAutoActionOutcome(finalData);
      } else {
        // finalData が無い (流れが途中で切れた・サーバーの失敗の行だけが来た): サーバーでは返答の保存と自動実行が済んでいることが
        // あるので、会話を取り直して結果を出す (#2201 U3)。取り直せなければ、開き直してもらう文を出す (#2206 G2)
        await resolveIncomplete(false);
      }

    } catch (e: any) {
      console.error('Failed to send message:', e);
      // エラー時はユーザーメッセージは残し、AI側にエラーメッセージを表示（サイレントにしない）
      const isTimeout = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      // 応答を受ける前に通信が切れた (ブラウザの fetch は TypeError を投げる): 送信はサーバーに届いて、返答の保存と自動実行が
      // 続いていることがある (#2206 G2。以前は失敗の文『再試行してください』だけを出していた)
      const isNetworkError = !responseAccepted && e instanceof TypeError;
      if (isTimeout || responseAccepted || isNetworkError) {
        // 時間切れ・受け付けたあとの例外・通信の切断: サーバーでは返答の保存と自動実行が済んでいることがあるので、頼み直しを促す前に
        // 会話を取り直して結果を出す (頼み直すと献立を二重に作りうる。#2201 U3)
        await resolveIncomplete(isTimeout);
        return;
      }
      setMessages(prev => prev.map(m =>
        m.id === tempAiMsgId
          ? { ...m, content: AI_CHAT_REPLY_FAILED_MESSAGE, isStreaming: false }
          : m
      ));
    } finally {
      clearTimeout(clientTimeoutId);
      sendingRef.current = false;
      setIsSending(false);
    }
  };

  // アクション実行
  const executeAction = async (actionId: string, messageId: string) => {
    // 相談を閉じる (/close) の応答待ちの間は実行しない (#2245 K1。1日献立変更と同じ。実行の結果の一文が閉じる側の新しい相談の画面の
    // 置き換えで消え、実行したかが見えなくなる。ボタンも止めている。ref で見るのは、閉じると同じ描画のうちの押下も止めるため)
    if (closingSessionRef.current) return;
    setExecutingActionIds(prev => new Set(prev).add(messageId));
    // この実行が応答待ちの件数に入れたか (finally で入れた分だけ出す)
    let actionRequestBegun = false;
    try {
      // 提案の実行は、サーバーで献立の生成などの AI の処理を始めることがある。未同意なら同意画面を出す (「同意しない」なら実行しない)
      if ((await ensureAiConsent()) === 'declined') return;
      // 同意の確認を待つ間に相談を閉じ始めた: 実行しない (#2245 K1。上と同じ)
      if (closingSessionRef.current) return;
      // ここから応答 (結果の一文) までは『相談を終了』・新しい相談・相談の切り替えを止める (#2254 M1。finally で件数から出す)
      beginActionRequest();
      actionRequestBegun = true;
      // 実行を始めるのも画面の操作 (#2254 M1。結果の一文を今の画面に足す。モバイルの AIAdvisorSheet が送信を画面の操作にするのと
      // 同じ決まり)。一覧を待っている開く (openChat) に、この画面の会話を読み直させない
      startViewOperation();

      // まずアクションログを取得
      const res = await aiFetch(`/api/ai/consultation/actions/${messageId}/execute`, {
        method: 'POST',
      });

      // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内する。提案は残っているので、同意したあとにもう一度実行できる
      if (await isAiConsentRequiredResponse(res)) return;

      if (res.ok) {
        const data = await res.json();

        // 実行の API は、アクションが失敗したときも 200 で { success: false, result } を返す。success が true のときだけ
        // 『実行しました』と出し、それ以外は失敗の文 (result.error か固定の文) を出す (#2183 Z1)
        const outcome = consultationActionOutcomeOf({
          success: data.success,
          result: data.result,
          label: actionLabelOf(data.actionType),
        });
        setMessages(prev => [...prev, actionOutcomeChatMessage(outcome)]);

        // 失敗: 提案は消さずに残し、データの更新の通知もしない。やり直せない失敗 (retryable が false。途中まで書いた可能性がある
        // 献立の生成など) なら「実行する」を出さず、「もう一度頼んでください」の案内にする (#2189 W1-a)
        if (outcome.kind !== 'executed') {
          if (isNotRetryableBody(data)) markProposedActionNotExecutable(messageId, notExecutableReasonOfBody(data));
          return;
        }

        // アクションを削除（実行済みとして）
        setMessages(prev => prev.map(m => 
          m.id === messageId ? { ...m, proposedActions: null } : m
        ));

        // 他のコンポーネントにデータ更新を通知（献立表ページなど）
        window.dispatchEvent(new CustomEvent('mealPlanUpdated', { 
          detail: { actionType: data.actionType, result: data.result }
        }));
      } else {
        // 今日の AI の利用回数の上限に達した (429 AI_DAILY_LIMIT。#1149): aiFetch が全画面共通の AiDailyLimitHost に固定の文を
        // 出させたので、ここでは重ねて出さない (提案は残っているので、明日また実行できる)。
        // ただし行を pending に戻せなかった (retryable: false) ときは、明日押しても実行できないので案内にする (#2195 V2)
        if (await aiDailyLimitMessageOfResponse(res)) {
          const limitBody: unknown = await res.json().catch(() => null);
          if (isNotRetryableBody(limitBody)) markProposedActionNotExecutable(messageId, notExecutableReasonOfBody(limitBody));
          return;
        }
        // それ以外の失敗も alert ではなくチャットに出す (#2189 W1-a)。文はサーバーの固定の文 (error) か固定の文。
        // すでに処理された・見つからない (400 / 404) 提案と、実行の中の例外のあともう押せない (500 で retryable: false。
        // 献立の生成・行を戻せなかった。#2195 V2) 提案は、ここからはもう実行できないので「実行する」を出さない。
        // 案内の文はサーバーが添えた理由 (notExecutableReason) で分ける (実行中・実行済みは頼み直しを勧めない)
        const body: unknown = await res.json().catch(() => null);
        setMessages(prev => [
          ...prev,
          actionOutcomeChatMessage({ kind: 'failed', content: consultationActionFailureMessageOf(body) }),
        ]);
        if (ACTION_NOT_EXECUTABLE_RESPONSE_STATUSES.has(res.status) || isNotRetryableBody(body)) {
          markProposedActionNotExecutable(messageId, notExecutableReasonOfBody(body));
        }
      }
    } catch (e) {
      console.error('Failed to execute action:', e);
      // 通信の失敗・応答が読めなかった: 黙らずに固定の失敗の文を出す (#2183 Z1)。提案は残っている
      setMessages(prev => [
        ...prev,
        actionOutcomeChatMessage({ kind: 'failed', content: AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE }),
      ]);
    } finally {
      // このカードの印だけを外す (#2254 M1。ほかのカードの実行がまだ応答待ちなら、その印と止めは残す)
      setExecutingActionIds(prev => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
      if (actionRequestBegun) endActionRequest();
    }
  };

  // 提案のカードの「実行する」を出さず、案内にする (#2189 W1-a)。案内の文は理由で分ける (#2195 V2)
  const markProposedActionNotExecutable = (messageId: string, reason: ProposedActionNotExecutableReason) => {
    setMessages(prev => prev.map(m =>
      m.id === messageId ? { ...m, proposedActionExecutable: false, proposedActionNotExecutableReason: reason } : m
    ));
  };

  // 実行できない提案のカードを閉じる (画面の上だけ。サーバーの行は pending でないので、断る API は呼ばない)
  const dismissProposedAction = (messageId: string) => {
    setMessages(prev => prev.map(m =>
      m.id === messageId ? { ...m, proposedActions: null } : m
    ));
  };

  // アクション拒否
  const rejectAction = async (messageId: string) => {
    try {
      await fetch(`/api/ai/consultation/actions/${messageId}/execute`, {
        method: 'DELETE',
      });
      
      // アクションを削除
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { ...m, proposedActions: null } : m
      ));
    } catch (e) {
      console.error('Failed to reject action:', e);
    }
  };

  // セッション切り替え
  const switchSession = async (sessionId: string) => {
    // 相談を閉じる応答待ちの最中は切り替えない (#2235 I8。相談の行も止めている。閉じたあとの新しい相談が、選んだ相談を上書きする)。
    // 1日献立の作成の最中・提案の実行の応答待ちの最中も切り替えない (#2254 M1。切り替えた先の会話の読み込みで作成中の一文が消え、
    // 完了・結果の一文が切り替えた先の相談の画面に出る。相談の行も止めている)
    if (closingSessionRef.current || resultRequestInFlight()) return;
    showSessionId(sessionId);
    setShowSessionList(false);
    await fetchMessages(sessionId);
  };

  // 重要マークをトグル
  const toggleImportant = async (messageId: string) => {
    if (!currentSessionId) return;
    
    try {
      const res = await fetch(
        `/api/ai/consultation/sessions/${currentSessionId}/messages/${messageId}/important`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      
      if (res.ok) {
        const data = await res.json();
        setMessages(prev => prev.map(m => 
          m.id === messageId ? { ...m, isImportant: data.isImportant } : m
        ));
      }
    } catch (e) {
      console.error('Failed to toggle important:', e);
    }
    setShowMessageMenu(null);
  };

  // セッションを終了して要約を生成
  const closeSession = async () => {
    // 送信中も閉じない (#2235 I8。送信の返答は閉じた相談にだけ保存され、閉じたあとの新しい相談の画面には出ない。ボタンも止めている。
    // ref で見るのは、同じ描画のうちの 2 度目の押下・送信と同じ描画のうちの押下も止めるため)
    if (!currentSessionId || isClosingSession || closingSessionRef.current || isSending || sendingRef.current) return;
    // 1日献立の作成の最中・提案の実行の応答待ちの最中も閉じない (#2254 M1。閉じたあとの新しい相談の画面の置き換えで、作成中の一文が
    // 消え、完了・結果の一文だけが新しい相談の画面に出る。ボタンも止めている。ref で見るのは、同じ描画のうちの押下も止めるため)
    if (resultRequestInFlight()) return;

    closingSessionRef.current = true;
    setIsClosingSession(true);
    // 閉じるを受け付けた (ok の応答が返った) か。受け付けたあとの例外 (本文が読めないなど) では『終了できませんでした』を出さない
    // (相談はサーバーで閉じている)
    let closeAccepted = false;
    try {
      const res = await fetch(
        `/api/ai/consultation/sessions/${currentSessionId}/close`,
        { method: 'POST' }
      );

      if (res.ok) {
        closeAccepted = true;
        const data = await res.json();
        // セッション一覧を更新
        await fetchSessions();
        // 新しいセッションを作成
        await createNewSession();

        if (data.summary) {
          // 要約完了メッセージを表示
          setMessages(prev => [
            ...prev,
            {
              id: `summary-${Date.now()}`,
              role: 'assistant',
              content: `📝 前回の相談を要約しました：\n\n${data.summary.summary}\n\nトピック: ${(data.summary.key_topics || []).join(', ')}`,
              createdAt: new Date().toISOString(),
            },
          ]);
        } else {
          // 同意が無くて (または同意の状況を読めなくて) サーバーが要約 (AI) を省いた (T15 / #1154): その旨を一言だけ出す
          const skippedNote = aiSummarySkippedNote(data);
          if (skippedNote) {
            setMessages(prev => [
              ...prev,
              {
                id: `summary-skipped-${Date.now()}`,
                role: 'assistant',
                content: skippedNote,
                createdAt: new Date().toISOString(),
              },
            ]);
          }
        }
      } else {
        // 失敗の応答も黙らずに知らせる (#2245 K1。以前は何も起きなかったように見えた。出し分けはモバイルの AIAdvisorSheet と同じ。
        // すでに終了していた (400) ときは、一覧を読み直して画面を今の状態に合わせてから出す)
        const body: unknown = await res.json().catch(() => null);
        const failure = consultationCloseFailureOf(res.status, body);
        if (failure.kind === 'already-closed') await fetchSessions();
        showCloseFailure(failure.message);
      }
    } catch (e) {
      console.error('Failed to close session:', e);
      // 通信の失敗 (応答が返らなかった): 固定の失敗の文を出す (#2245 K1)
      if (!closeAccepted) showCloseFailure(CONSULTATION_CLOSE_FAILED_MESSAGE);
    } finally {
      closingSessionRef.current = false;
      setIsClosingSession(false);
    }
  };

  /** 相談を終了できなかったことをチャットに出す (#2245 K1。ほかの失敗と同じく alert ではなくチャットに出す。#2189 W1-a) */
  const showCloseFailure = (content: string) => {
    setMessages(prev => [
      ...prev,
      {
        id: `close-failed-${Date.now()}`,
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  // 1日献立変更を実行（V4直接呼び出し）
  const generateDayMenu = async () => {
    // 相談を閉じる (/close) の応答待ちの間は作らない (#2245 K1。チャットに足す『○月○日の献立を作成中...』が、閉じる側の新しい相談の
    // 画面の置き換え (createNewSession) で消え、作成の結果が見えなくなる。ボタンも止めている。ref で見るのは、閉じると同じ描画のうちの
    // 押下も止めるため)
    // 作成の最中 (dayMenuInFlightRef) も作らない (#2254 M1。作成は一度に 1 つ。重ねると、先の作成の完了で『相談を終了』の止めが外れる)
    if (isGeneratingDayMenu || dayMenuInFlightRef.current || closingSessionRef.current) return;
    // 日付の欄が空・範囲の外なら作らない (#2245 K1。ボタンも止めている)
    if (!isDayMenuDateSelectable(selectedDate, dayMenuDateRangeOf(todayLocal()))) return;

    setShowDayMenuModal(false);

    // 未同意なら同意画面を出す (「同意しない」なら生成しない)
    if ((await ensureAiConsent()) === 'declined') return;
    // 同意の確認を待つ間に相談を閉じ始めた: 作らない (#2245 K1。上と同じ)。同意の確認を待つ間に別の作成が始まった: 作らない (#2254 M1)
    if (closingSessionRef.current || dayMenuInFlightRef.current) return;
    // ここから作成が終わる (完了・失敗の一文を足す) までは『相談を終了』・新しい相談・相談の切り替えを止める (#2254 M1。作成中の一文を
    // 会話の置き換えで消さない)
    markDayMenuInFlight(true);
    // 作成を始めるのも画面の操作 (#2254 M1。提案の実行と同じ)。一覧を待っている開く (openChat) に、この画面の会話を読み直させない
    startViewOperation();

    // 日付をフォーマット (#2235 I3。選んだ暦日 (YYYY-MM-DD) の年月日を formatDateJa で読む。以前の new Date(selectedDate) は
    // UTC の 0 時の瞬間を端末のローカル時刻 (getMonth / getDate) で読んでいたので、端末が UTC より西だと前の日になった)
    const formattedDate = formatDateJa(selectedDate);

    // 開始メッセージをチャットに追加
    setMessages(prev => [...prev, {
      id: `v4-start-${Date.now()}`,
      role: 'assistant',
      content: `🍳 ${formattedDate}の献立を作成中...`,
      createdAt: new Date().toISOString(),
    }]);

    try {
      // V4 API を直接呼び出し
      const targetSlots = [
        { date: selectedDate, mealType: 'breakfast' as const },
        { date: selectedDate, mealType: 'lunch' as const },
        { date: selectedDate, mealType: 'dinner' as const },
      ];

      const result = await generateV4({
        targetSlots,
        resolveExistingMeals: true,
        constraints: {},
        note: `${formattedDate}の献立を作成`,
        ultimateMode: false,
      });

      // 進捗を購読
      if (result?.requestId) {
        // 依頼の id を持つ (Realtime の通知を取りこぼしたときに、状態を読み直して終わりを見つけるため。#2254 M1)
        dayMenuRequestIdRef.current = result.requestId;
        const unsubscribe = subscribeToProgress(result.requestId, (progress) => {
          if (progress.message) {
            setV4Progress(progress.message);
          }
        });
        // 作成が終わったら購読を外す (settleDayMenuRequest。状態の読み直しで終わりを見つけたあとに、遅れた通知で一文を足さない)
        dayMenuUnsubscribeRef.current = typeof unsubscribe === 'function' ? unsubscribe : null;
      } else {
        // 進捗を追えない (完了・失敗が届かない): 『相談を終了』の止めを下ろす (#2254 M1。ずっと止めない)
        settleDayMenuRequest();
      }
    } catch (e: any) {
      // 依頼が失敗した (同意で止められたときも): 作成は始まっていないので『相談を終了』の止めを下ろす (#2254 M1。依頼の失敗は
      // フックの onError (failDayMenu) が先に下ろしているので、ここで下ろすのは同意で止められたとき)
      settleDayMenuRequest();
      if (e instanceof AiConsentRequiredError) {
        // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内する。作成中の表示を打ち消しておく
        setMessages(prev => [...prev, {
          id: `v4-consent-${Date.now()}`,
          role: 'assistant',
          content: V4_CONSENT_REQUIRED_CHAT_NOTE,
          createdAt: new Date().toISOString(),
        }]);
        return;
      }
      console.error('Failed to generate day menu:', e);
      // エラーはフックのonErrorで処理される
    }
  };

  // サーバーサイドでは何もレンダリングしない
  if (!isMounted) {
    return null;
  }

  // ネイティブアプリ (mode=app) ではモバイル側の AIFloatingFab に任せる
  if (isNativeApp) {
    return null;
  }

  // 送信・入力・おすすめの質問を止めるか: 送信中・相談を閉じる応答待ちの最中 (#2235 I8)
  const inputLocked = isSending || isClosingSession;
  // 1日献立の作成の最中か・提案の実行の応答待ちが 1 件でもあるか (#2254 M1。描画の側)
  const resultRequestPending = isDayMenuInFlight || actionRequestsInFlight > 0;
  // 『相談を終了』を止めるか: 閉じる応答待ち・送信中 (#2235 I8)・1日献立の作成の最中・提案の実行の応答待ちの最中 (#2254 M1)・相談が無い
  const closeSessionLocked = isClosingSession || isSending || resultRequestPending || !currentSessionId;
  // 『新しい相談を始める』・相談の行を止めるか: 閉じる応答待ち (#2235 I8。送信中は止めない)・1日献立の作成の最中・提案の実行の
  // 応答待ちの最中 (#2254 M1)
  const sessionSwitchLocked = isClosingSession || resultRequestPending;
  // 1 日分の献立の日付の欄の下限 (JST の今日) と上限 (その 14 日後)。時計は 1 回だけ読む (#2235 I8。以前は下限と上限で別々に読み、
  // 上限は端末の 0 時の Date を setDate でずらしていた)。上限を暦の計算で扱えない日は、上限を付けない
  const dayMenuRange = showDayMenuModal ? dayMenuDateRangeOf(todayLocal()) : null;
  const dayMenuToday = dayMenuRange === null ? null : dayMenuRange.min;
  const dayMenuMaxDate = dayMenuRange === null ? null : dayMenuRange.max;
  // 作成するを押せるか: 作成中・相談を閉じる応答待ちの最中でなく、日付が実在する暦日で欄の範囲の中のとき (#2245 K1)
  // 日付の欄が空・形の崩れ・範囲の外か (#2245 L1。欄の下に理由の一文を出す)
  const dayMenuDateUnselectable = dayMenuRange !== null && !isDayMenuDateSelectable(selectedDate, dayMenuRange);
  const dayMenuCreatable =
    !isGeneratingDayMenu && !isClosingSession && dayMenuRange !== null && !dayMenuDateUnselectable;
  // 1日献立変更を押せるか: 送信中・作成中・相談を閉じる応答待ちの最中でないとき (#2245 K1。閉じる応答待ちを足した)
  // 会話の読み込みの最中 (読み込み中の輪) も止める (#2254 M1。作成中の一文を足しても、読み込んだ会話で置き換わって消える)。
  // 作成の最中 (isDayMenuInFlight) も止める (作成は一度に 1 つ。generateDayMenu の入口でも止めている)
  const dayMenuButtonLocked = isSending || isGeneratingDayMenu || isDayMenuInFlight || isClosingSession || isLoading;

  return (
    <>
      {/* チャットバブルボタン */}
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            whileHover={isDragging ? undefined : { scale: 1.1 }}
            whileTap={isDragging ? undefined : { scale: 0.95 }}
            type="button"
            aria-label="AIアドバイザーを開く"
            data-testid="ai-chat-floating-button"
            className="fixed z-[51] w-14 h-14 rounded-full shadow-lg flex items-center justify-center touch-none select-none"
            style={{
              right: fabPosition.x,
              bottom: fabPosition.y,
              background: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.warning} 100%)`,
              cursor: isDragging ? 'grabbing' : 'grab',
            }}
            onPointerDown={(e: React.PointerEvent<HTMLButtonElement>) => {
              fabDragStart.current = {
                clientX: e.clientX,
                clientY: e.clientY,
                t: Date.now(),
                pos: { ...fabPosition },
              };
              fabDraggingRef.current = false;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e: React.PointerEvent<HTMLButtonElement>) => {
              if (!fabDragStart.current) return;
              const dx = e.clientX - fabDragStart.current.clientX;
              const dy = e.clientY - fabDragStart.current.clientY;
              if (!fabDraggingRef.current && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                fabDraggingRef.current = true;
                setIsDragging(true);
              }
              if (fabDraggingRef.current) {
                const newX = Math.max(8, Math.min(window.innerWidth - 64, fabDragStart.current.pos.x - dx));
                const newY = Math.max(8, Math.min(window.innerHeight - 64, fabDragStart.current.pos.y + dy));
                const newPos = { x: newX, y: newY };
                fabPositionRef.current = newPos;
                setFabPosition(newPos);
              }
            }}
            onPointerUp={(e: React.PointerEvent<HTMLButtonElement>) => {
              if (!fabDragStart.current) return;
              const elapsed = Date.now() - fabDragStart.current.t;
              const dx = Math.abs(e.clientX - fabDragStart.current.clientX);
              const dy = Math.abs(e.clientY - fabDragStart.current.clientY);
              const wasDrag = fabDraggingRef.current || dx > 5 || dy > 5 || elapsed > 250;
              if (wasDrag) {
                // ドラッグ終了 → 最終位置を保存 (ref から最新値を取得)
                try {
                  const json = JSON.stringify(fabPositionRef.current);
                  localStorage.setItem('aiChatBubblePosition', json);
                  // Cookie にも保存（タブ間共有、30日）
                  document.cookie = `aiChatBubblePosition=${encodeURIComponent(json)}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
                } catch {
                  // ignore
                }
              } else {
                // タップ → チャット展開
                openChat();
              }
              fabDragStart.current = null;
              fabDraggingRef.current = false;
              setIsDragging(false);
            }}
          >
            <Sparkles size={24} color="#fff" />
            {hasUnread && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full border-2 border-white" />
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* チャットウィンドウ */}
      {/* #125: mode='wait' でアニメーション完了を待ち、二重表示を防止 */}
      <AnimatePresence mode="wait">
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 100, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 100, scale: 0.9 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed bottom-24 right-4 z-[51] w-[calc(100vw-32px)] max-w-[380px] h-[500px] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
            style={{ background: colors.bg }}
          >
            {/* ヘッダー */}
            <div 
              className="flex items-center justify-between px-4 py-3 border-b"
              style={{ background: colors.card, borderColor: colors.border }}
            >
              <div className="flex items-center gap-2">
                <div 
                  className="w-8 h-8 rounded-full flex items-center justify-center"
                  style={{ background: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.warning} 100%)` }}
                >
                  <Sparkles size={16} color="#fff" />
                </div>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, color: colors.text, margin: 0 }}>
                    AIアドバイザー
                  </h3>
                  <p style={{ fontSize: 11, color: colors.textMuted, margin: 0 }}>
                    いつでも相談できます
                  </p>
                </div>
              </div>
              
              <div className="flex items-center gap-1">
                <button
                  onClick={closeSession}
                  disabled={closeSessionLocked}
                  className="p-2 rounded-full hover:bg-gray-100"
                  title="相談を終了して要約を保存"
                >
                  {isClosingSession ? (
                    <Loader2 size={16} color={colors.textMuted} className="animate-spin" />
                  ) : (
                    <Archive size={16} color={colors.textMuted} />
                  )}
                </button>
                <button
                  onClick={() => setShowSessionList(!showSessionList)}
                  className="p-2 rounded-full hover:bg-gray-100"
                >
                  <ChevronDown size={18} color={colors.textMuted} />
                </button>
                <button
                  onClick={() => { setIsOpen(false); setIsToggling(false); isTogglingRef.current = false; }}
                  aria-label="AIチャットを閉じる"
                  className="p-2 rounded-full hover:bg-gray-100"
                >
                  <X size={18} color={colors.textMuted} />
                </button>
              </div>
            </div>

            {/* セッションリスト（ドロップダウン） */}
            <AnimatePresence>
              {showSessionList && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="border-b overflow-hidden"
                  style={{ background: colors.card, borderColor: colors.border }}
                >
                  <div className="p-2 max-h-40 overflow-y-auto">
                    {/* 新しい相談・相談の切り替えは、相談を閉じる応答待ちの最中は止める (#2235 I8。送信中は止めない)。
                        1日献立の作成の最中・提案の実行の応答待ちの最中も止める (#2254 M1) */}
                    <button
                      onClick={pressNewSession}
                      disabled={sessionSwitchLocked}
                      className="w-full px-3 py-2 rounded-lg text-left flex items-center gap-2 hover:bg-gray-100 disabled:opacity-50"
                    >
                      <MessageCircle size={14} color={colors.primary} />
                      <span style={{ fontSize: 13, color: colors.primary, fontWeight: 500 }}>
                        新しい相談を始める
                      </span>
                    </button>
                    
                    {sessions.map(session => (
                      <button
                        key={session.id}
                        onClick={() => switchSession(session.id)}
                        disabled={sessionSwitchLocked}
                        className={`w-full px-3 py-2 rounded-lg text-left hover:bg-gray-100 disabled:opacity-50 ${
                          currentSessionId === session.id ? 'bg-gray-100' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span style={{ fontSize: 13, color: colors.text }}>
                            {session.title}
                          </span>
                          {session.status === 'closed' && (
                            <span 
                              className="px-1.5 py-0.5 rounded text-[10px]"
                              style={{ background: colors.border, color: colors.textMuted }}
                            >
                              終了
                            </span>
                          )}
                          <span style={{ fontSize: 11, color: colors.textMuted }}>
                            ({session.messageCount}件)
                          </span>
                        </div>
                        {session.summary && (
                          <p style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }} className="truncate">
                            {session.summary}
                          </p>
                        )}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* メッセージエリア */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {isAuthenticated === false ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-4">
                  <div 
                    className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
                    style={{ background: colors.primaryLight }}
                  >
                    <Sparkles size={28} color={colors.primary} />
                  </div>
                  <h4 style={{ fontSize: 16, fontWeight: 600, color: colors.text, margin: '0 0 8px 0' }}>
                    ログインが必要です
                  </h4>
                  <p style={{ fontSize: 13, color: colors.textMuted, margin: '0 0 16px 0', lineHeight: 1.5 }}>
                    AIアドバイザーと相談するには<br />ログインしてください
                  </p>
                  <a
                    href="/login"
                    className="px-6 py-2 rounded-full"
                    style={{ background: colors.primary, color: '#fff', fontSize: 14, fontWeight: 500, textDecoration: 'none' }}
                  >
                    ログインする
                  </a>
                </div>
              ) : isLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 size={24} color={colors.primary} className="animate-spin" />
                </div>
              ) : (
                <>
                  {/* Suggested prompts: welcome メッセージのみ表示、かつ messages.length === 1 の時のみ */}
                  {messages.length === 1 && messages[0]?.id === 'welcome' && (
                    <div className="flex flex-col gap-2 mt-2 mb-1">
                      {[
                        '献立を提案してほしい',
                        '冷蔵庫の食材で作れるものは?',
                        '今日の栄養バランスは?',
                        '来週の献立を作りたい',
                      ].map((prompt) => (
                        <button
                          key={prompt}
                          // 送信欄と同じ送信の流れ (sendMessage) を通す。取り直しの縁の扱いと、送った文を入力欄に戻すのも同じ (#2206 G2)
                          onClick={() => sendMessage(prompt)}
                          disabled={inputLocked}
                          className="w-full text-left px-3 py-2 rounded-xl border hover:bg-gray-50 transition-colors disabled:opacity-50"
                          style={{
                            borderColor: colors.border,
                            background: colors.card,
                            fontSize: 13,
                            color: colors.textLight,
                          }}
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  )}

                  {messages.map((msg) => (
                    <div key={msg.id} className="group relative">
                      {/* メッセージバブル */}
                      <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className="relative max-w-[85%]">
                          {/* 重要マーク */}
                          {msg.isImportant && (
                            <div 
                              className="absolute -top-1 -left-1 w-4 h-4 rounded-full flex items-center justify-center z-10"
                              style={{ background: colors.warning }}
                            >
                              <Star size={10} color="#fff" fill="#fff" />
                            </div>
                          )}
                          
                          <div
                            className="px-3 py-2 rounded-2xl markdown-content"
                            data-testid={msg.role === 'assistant' ? 'ai-message-bubble' : undefined}
                            style={{
                              background: msg.role === 'user' ? colors.primary : colors.card,
                              color: msg.role === 'user' ? '#fff' : colors.text,
                              borderBottomRightRadius: msg.role === 'user' ? 4 : 16,
                              borderBottomLeftRadius: msg.role === 'user' ? 16 : 4,
                              boxShadow: msg.role === 'assistant' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                              border: msg.isImportant ? `2px solid ${colors.warning}` : 'none',
                            }}
                          >
                            {msg.role === 'user' ? (
                              <p style={{ fontSize: 14, margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                                {msg.content}
                              </p>
                            ) : (
                              <div
                                className="markdown-body"
                                style={{ fontSize: 14, lineHeight: 1.6 }}
                              >
                                <span dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.content) }} />
                                {msg.isStreaming && (
                                  <span className="streaming-cursor" />
                                )}
                              </div>
                            )}
                          </div>

                          {/* メッセージメニューボタン */}
                          {!msg.id.startsWith('temp-') && !msg.id.startsWith('welcome') && !msg.id.startsWith('action-') && !msg.id.startsWith('summary-') && (
                            <button
                              onClick={() => setShowMessageMenu(showMessageMenu === msg.id ? null : msg.id)}
                              className="absolute top-1 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full hover:bg-gray-200"
                              style={{ 
                                right: msg.role === 'user' ? 'auto' : -24,
                                left: msg.role === 'user' ? -24 : 'auto',
                              }}
                            >
                              <MoreVertical size={14} color={colors.textMuted} />
                            </button>
                          )}

                          {/* メッセージメニュー */}
                          {showMessageMenu === msg.id && (
                            <div 
                              className="absolute top-6 z-20 py-1 rounded-lg shadow-lg border"
                              style={{ 
                                background: colors.card, 
                                borderColor: colors.border,
                                right: msg.role === 'user' ? 'auto' : -80,
                                left: msg.role === 'user' ? -80 : 'auto',
                              }}
                            >
                              <button
                                onClick={() => toggleImportant(msg.id)}
                                className="w-full px-3 py-2 text-left hover:bg-gray-100 flex items-center gap-2"
                              >
                                <Star size={14} color={msg.isImportant ? colors.warning : colors.textMuted} fill={msg.isImportant ? colors.warning : 'none'} />
                                <span style={{ fontSize: 12, color: colors.text }}>
                                  {msg.isImportant ? '重要を解除' : '重要としてマーク'}
                                </span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* アクション提案カード */}
                      {msg.proposedActions && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="mt-2 ml-2"
                        >
                          <div 
                            className="p-3 rounded-xl border"
                            style={{ 
                              background: colors.purpleLight, 
                              borderColor: colors.purple + '40',
                            }}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <ProposedActionHeading type={msg.proposedActions.type} />
                            </div>
                            
                            {msg.proposedActionExecutable === false ? (
                              // やり直せない失敗・実行中・記録が無い提案: 「実行する」を出さずに案内を出す (#2189 W1-a)。
                              // 文は理由で分ける: 実行中・実行済みは『実行中か実行済みです』(頼み直しを勧めない。#2195 V2)、
                              // 実行中の印のまま (書き戻せなかった) は『実行できたかを確かめられませんでした…』(#2201 U3)
                              <div className="flex items-start gap-2" data-testid="ai-proposed-action-not-executable">
                                <p style={{ flex: 1, fontSize: 12, margin: 0, color: colors.textLight, lineHeight: 1.5 }}>
                                  {aiProposedActionNotExecutableGuideOf(msg.proposedActionNotExecutableReason)}
                                </p>
                                <button
                                  onClick={() => dismissProposedAction(msg.id)}
                                  aria-label="提案を閉じる"
                                  className="px-3 py-2 rounded-lg"
                                  style={{ background: colors.border }}
                                >
                                  <XCircle size={14} color={colors.textMuted} />
                                </button>
                              </div>
                            ) : (
                              <div className="flex gap-2">
                                <button
                                  onClick={() => executeAction(msg.proposedActions!.type, msg.id)}
                                  disabled={executingActionIds.has(msg.id) || isClosingSession}
                                  className="flex-1 py-2 rounded-lg flex items-center justify-center gap-1"
                                  style={{ background: colors.success, opacity: (executingActionIds.has(msg.id) || isClosingSession) ? BUSY_BUTTON_OPACITY : 1 }}
                                >
                                  {executingActionIds.has(msg.id) ? (
                                    <Loader2 size={14} color="#fff" className="animate-spin" />
                                  ) : (
                                    <Check size={14} color="#fff" />
                                  )}
                                  <span style={{ fontSize: 12, color: '#fff', fontWeight: 500 }}>
                                    実行する
                                  </span>
                                </button>
                                <button
                                  onClick={() => rejectAction(msg.id)}
                                  className="px-3 py-2 rounded-lg"
                                  style={{ background: colors.border }}
                                >
                                  <XCircle size={14} color={colors.textMuted} />
                                </button>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </div>
                  ))}
                  
                  {isSending && (
                    <div className="flex justify-start">
                      <div 
                        className="px-4 py-3 rounded-2xl"
                        style={{ background: colors.card, borderBottomLeftRadius: 4 }}
                      >
                        <div className="flex gap-1">
                          <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            {/* クイックアクションバー */}
            {isAuthenticated !== false && currentSessionId && (
              <div
                className="px-3 pt-2 pb-1 border-t flex gap-2 overflow-x-auto"
                style={{ background: colors.card, borderColor: colors.border }}
              >
                <button
                  onClick={openDayMenuModal}
                  disabled={dayMenuButtonLocked}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border whitespace-nowrap hover:bg-gray-50 transition-colors"
                  style={{ borderColor: colors.primary, opacity: dayMenuButtonLocked ? LOCKED_QUICK_ACTION_OPACITY : 1 }}
                >
                  <CalendarDays size={14} color={colors.primary} />
                  <span style={{ fontSize: 12, color: colors.primary, fontWeight: 500 }}>
                    1日献立変更
                  </span>
                </button>
              </div>
            )}

            {/* 入力エリア */}
            {isAuthenticated !== false && (
              <div
                className="p-3 border-t"
                style={{ background: colors.card, borderColor: colors.border }}
              >
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {
                      // IME変換中（日本語入力の変換確定時など）は送信しない
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage(inputText);
                      }
                    }}
                    placeholder="メッセージを入力..."
                    className="flex-1 px-4 py-2 rounded-full border-none outline-none"
                    style={{
                      background: colors.bg,
                      fontSize: 14,
                      color: colors.text,
                    }}
                    disabled={inputLocked || !currentSessionId}
                  />
                  <button
                    onClick={() => sendMessage(inputText)}
                    disabled={!inputText.trim() || inputLocked || !currentSessionId}
                    aria-label="メッセージを送信"
                    className="w-10 h-10 rounded-full flex items-center justify-center"
                    style={{
                      background: inputText.trim() ? colors.primary : colors.border,
                      opacity: isSending ? 0.7 : 1,
                    }}
                  >
                    <Send size={18} color={inputText.trim() ? '#fff' : colors.textMuted} />
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 1日献立変更モーダル */}
      <AnimatePresence>
        {showDayMenuModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-[50]"
            onClick={() => setShowDayMenuModal(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-2xl p-5 mx-4 w-full max-w-[320px] shadow-xl"
            >
              <div className="flex items-center gap-3 mb-4">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center"
                  style={{ background: colors.primaryLight }}
                >
                  <CalendarDays size={20} color={colors.primary} />
                </div>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 600, color: colors.text, margin: 0 }}>
                    1日献立変更
                  </h3>
                  <p style={{ fontSize: 12, color: colors.textMuted, margin: 0 }}>
                    選択した日の献立を作り直します
                  </p>
                </div>
              </div>

              <div className="mb-4">
                <label style={{ fontSize: 13, color: colors.textLight, marginBottom: 6, display: 'block' }}>
                  日付を選択
                </label>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  min={dayMenuToday ?? undefined}
                  max={dayMenuMaxDate ?? undefined}
                  className="w-full px-4 py-3 rounded-xl border text-center"
                  style={{
                    borderColor: colors.border,
                    fontSize: 16,
                    color: colors.text,
                    background: colors.bg,
                  }}
                />
                <p style={{ fontSize: 11, color: colors.textMuted, marginTop: 6, textAlign: 'center' }}>
                  今日から2週間先まで選択できます
                </p>
                {dayMenuDateUnselectable && (
                  <p
                    role="alert"
                    data-testid="day-menu-date-unselectable"
                    style={{ fontSize: 12, color: colors.primary, marginTop: 6, textAlign: 'center' }}
                  >
                    {DAY_MENU_DATE_UNSELECTABLE_MESSAGE}
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    // Bug-6: 「キャンセル」のクリックが背後の AI フローティングボタンへ
                    // 伝播してチャットが開いてしまう事象を防ぐ
                    e.stopPropagation();
                    setShowDayMenuModal(false);
                  }}
                  className="flex-1 py-3 rounded-xl"
                  style={{ background: colors.border, color: colors.textLight, fontSize: 14, fontWeight: 500 }}
                >
                  キャンセル
                </button>
                <button
                  onClick={generateDayMenu}
                  disabled={!dayMenuCreatable}
                  className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2"
                  style={{ background: colors.primary, color: '#fff', fontSize: 14, fontWeight: 500, opacity: dayMenuCreatable ? 1 : BUSY_BUTTON_OPACITY }}
                >
                  {isGeneratingDayMenu ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Check size={16} />
                  )}
                  作成する
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 外国の AI 事業者へのデータ提供の同意画面 (T15)。未同意なら出る */}
      {consentModal}

      {/* マークダウン用スタイル */}
      <style jsx global>{`
        .markdown-body {
          word-wrap: break-word;
        }
        .markdown-body strong {
          font-weight: 600;
        }
        .markdown-body em {
          font-style: italic;
        }
        .markdown-body .md-h2 {
          font-size: 18px;
          font-weight: 700;
          margin: 12px 0 8px 0;
        }
        .markdown-body .md-h3 {
          font-size: 16px;
          font-weight: 600;
          margin: 10px 0 6px 0;
        }
        .markdown-body .md-h4 {
          font-size: 14px;
          font-weight: 600;
          margin: 8px 0 4px 0;
        }
        .markdown-body .md-ul,
        .markdown-body .md-ol {
          margin: 8px 0;
          padding-left: 20px;
        }
        .markdown-body .md-li {
          list-style-type: disc;
          margin: 4px 0;
        }
        .markdown-body .md-li-num {
          list-style-type: decimal;
          margin: 4px 0;
        }
        .markdown-body .md-inline-code {
          background: rgba(0,0,0,0.08);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: monospace;
          font-size: 13px;
        }
        .markdown-body .md-code-block {
          background: rgba(0,0,0,0.08);
          padding: 12px;
          border-radius: 8px;
          margin: 8px 0;
          overflow-x: auto;
        }
        .markdown-body .md-code-block code {
          font-family: monospace;
          font-size: 13px;
          white-space: pre-wrap;
        }
        .markdown-body .md-link {
          color: #3B82F6;
          text-decoration: underline;
        }
        .markdown-body .md-link:hover {
          color: #2563EB;
        }
        .streaming-cursor {
          display: inline-block;
          width: 2px;
          height: 1em;
          background: ${colors.primary};
          margin-left: 2px;
          animation: blink 0.8s infinite;
          vertical-align: text-bottom;
        }
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
    </>
  );
}
