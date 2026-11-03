/**
 * Web の AI 相談 (src/components/AIChatBubble.tsx) が、送信の応答 (SSE の最後の finalData) を受け取れなかったあとに
 * 会話を取り直して、前の依頼の結果を出すための部品 (#2201 U3。モバイルの #2195 V3 と同じ直し)。
 *
 * 問題:
 *   Web は送信が時間切れになると「しばらく待ってから再度お試しください」だけを出し、finalData が欠けたとき (流れが途中で切れた・
 *   応答を受けたあとに読み取りが失敗した) も同じく失敗の文だけを出していた。サーバーでは AI の返答の保存と提案の自動実行
 *   (献立の生成など) が済んでいることがあり、頼み直すと献立を二重に作りうる。データの更新の通知 (mealPlanUpdated) も投げないので、
 *   開いているページは取り直さなかった。
 *
 * 決まり (見分け方と一文は packages/shared/src/consultation-reply-reload.ts でモバイルと共有):
 *   - 応答を受け取れなかったら、会話の GET を取り直し、送った文が届いていたか・返答があるかを見分ける
 *   - 返答があれば、その返答の提案の記録 (ai_action_logs) の状態を読む (readReplyActionStateOf)。実行できていれば
 *     『前の依頼は実行されました』を足して通知を投げる。実行中の印のままなら『前の依頼の結果をまだ確かめられません…』を足し、
 *     少し待って 1 回だけ読み直す (実行できていれば一文を置き換えて通知を投げる。実行を待つ・失敗なら『実行できませんでした』に
 *     置き換える。#2206 G2)
 *   - 届いていない・返答がまだ無い・取り直せないときは、頼み直しを促す文を出し分ける (届いているのに頼み直すと二重に届く)。
 *     返答がまだ無いときは、少し待って 1 回だけ会話を取り直す (#2206 G2)
 *
 * このファイルはブラウザでだけ使う (サーバーの依存を import しない)。
 */
import {
  PREVIOUS_REQUEST_ACTION_LOG_STATUS,
  previousRequestActionStateOf,
  type PreviousRequestActionState,
} from '@homegohan/shared';

import { createClient } from '@/lib/supabase/client';

/**
 * Web の AI 相談の送信 (会話の続きの POST) を待つ上限 (ミリ秒)。
 * サーバーは AI への問い合わせを 25 秒で打ち切る (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts の
 * AbortSignal.timeout) ので、それに保存と通信の余裕を足した値
 */
export const AI_CHAT_SEND_TIMEOUT_MS = 28_000;

/** 時間切れになり、会話も取り直せなかったときの文 (返答はサーバーで続いていることがあるので、先に開き直してもらう) */
export const AI_CHAT_TIMEOUT_RELOAD_FAILED_MESSAGE =
  '応答に時間がかかっています。返答はサーバーで続いていることがあります。少し待ってから相談を開き直し、返答が無ければもう一度送ってください。';

/**
 * 時間切れでないのに応答を最後まで受け取れず (流れが途中で切れた・通信が切れた)、会話も取り直せなかったときの文 (#2206 G2)。
 * サーバーでは返答の保存と自動実行が済んでいることがあるので、時間切れのとき (AI_CHAT_TIMEOUT_RELOAD_FAILED_MESSAGE) と同じく
 * 頼み直しの前に開き直してもらう。以前は『応答に失敗しました。再試行してください。』か、流れてきた本文の断片を完全な返答のように
 * 残していた (#126 の決め。断片だけでは切れたことが分からず、実行済みのことがある)
 */
export const AI_CHAT_INTERRUPTED_RELOAD_FAILED_MESSAGE =
  '応答を最後まで受け取れませんでした。返答はサーバーで続いていることがあります。少し待ってから相談を開き直し、返答が無ければもう一度送ってください。';

/**
 * 応答を受け取れなかったときの文 (サーバーが失敗を知らせた・受け付けられなかった。返答は来ないので、頼み直してもらう。以前からの文)
 */
export const AI_CHAT_REPLY_FAILED_MESSAGE = '応答に失敗しました。再試行してください。';

/**
 * 会話の取り直し (GET) を待つ上限 (ミリ秒。#2206 G2)。以前は上限が無く、GET が返らないと送信中のまま入力が止まった。
 * 会話の GET はメッセージと提案の記録を読むだけなので、ふだんは 1 秒もかからない。送信の待ち (AI_CHAT_SEND_TIMEOUT_MS) より短く、
 * 通信が遅い端末でも返る長さにする
 */
export const AI_CHAT_RELOAD_TIMEOUT_MS = 10_000;

/** 取り直したら、送った文は届いていたが、返答がまだ無かったとき (頼み直すと二重に届くので、開き直してもらう) */
export const AI_CHAT_DELIVERED_NO_REPLY_MESSAGE =
  '相談はサーバーに届いています。返答を作っているところかもしれません。少し待ってから相談を開き直してください。';

/** 取り直したら、送った文が届いていなかったとき (入力欄に戻した文をもう一度送ってもらう) */
export const AI_CHAT_NOT_DELIVERED_MESSAGE = '相談はサーバーに届いていませんでした。もう一度送ってください。';

/**
 * 応答を受ける前に時間切れになり、取り直した会話に送った文が無かったとき (#2206 G2)。
 * サーバーは送った文を AI に問い合わせる前に保存するが、同意・上限の確かめが遅いと保存が時間切れより後になりうるので、
 * 『届いていません』とは言い切らない。入力欄に戻した文は残す
 */
export const AI_CHAT_DELIVERY_UNCONFIRMED_MESSAGE =
  '相談がサーバーに届いたかを確かめられませんでした。少し待ってから相談を開き直し、送った文が無ければ、入力欄の文をもう一度送ってください。';

/** 返答の提案の記録の状態と、データの更新の通知 (mealPlanUpdated) の detail に添える提案の種類と実行の結果 */
export interface ReplyActionState {
  state: PreviousRequestActionState;
  /** 提案の種類 (分からなければ null) */
  actionType: string | null;
  /**
   * 実行できた行 (executed) の実行の結果 (ai_action_logs.result。サーバーの messages の route が保存した、
   * finalData の actionResult.result と同じもの)。実行できた行が無い・読めないときは null。
   * 献立の生成 3 種類では { requestId, status: 'processing' } で、Web の取り直し (src/hooks/useAiConsultationDataRefetch.ts) は
   * これを見て生成が終わるまで見張り、終わったらもう一度取り直す (finalData を受け取れた経路と同じ detail にする)
   */
  result: unknown;
  /** 記録の行の状態 (ai_action_logs.status。提案のカードの出し方を GET と同じ決まりで作り直すのに使う。#2206 G2) */
  statuses: string[];
  /** 記録を読めなかったか (行が無いのと分ける。読めなかったときは画面が 1 回だけ読み直す。#2206 G2) */
  readFailed: boolean;
}

/** 読めなかったときの状態 (実行したと言い切れない) */
const UNREADABLE_REPLY_ACTION_STATE: ReplyActionState = {
  state: 'none',
  actionType: null,
  result: null,
  statuses: [],
  readFailed: true,
};

/** 記録の行のうち、ここで読む項目 */
type ReplyActionLogRow = { status?: unknown; action_type?: unknown; result?: unknown };

const isReplyActionLogRow = (row: unknown): row is ReplyActionLogRow => typeof row === 'object' && row !== null;

/**
 * 返答 (messageId) に付いた提案の記録 (ai_action_logs) の状態を読む。
 * 読むのは自分の相談の行だけ (行の安全は RLS の「自分の相談の行」の決まりが守る。モバイルの AIAdvisorSheet と同じ読み方)。
 * 読めなければ none (実行したと言い切れない)
 */
export async function readReplyActionStateOf(messageId: string): Promise<ReplyActionState> {
  try {
    const { data, error } = await createClient()
      .from('ai_action_logs')
      .select('status, action_type, result')
      .eq('message_id', messageId);
    if (error) return UNREADABLE_REPLY_ACTION_STATE;
    const state = previousRequestActionStateOf(data);
    const rows = Array.isArray(data) ? (data as unknown[]).filter(isReplyActionLogRow) : [];
    const actionType = rows.map((row) => row.action_type).find((t): t is string => typeof t === 'string') ?? null;
    const executedRow = rows.find((row) => row.status === PREVIOUS_REQUEST_ACTION_LOG_STATUS.executed);
    const result = state === 'executed' && executedRow !== undefined ? executedRow.result ?? null : null;
    const statuses = rows.map((row) => row.status).filter((status): status is string => typeof status === 'string');
    return { state, actionType, result, statuses, readFailed: false };
  } catch {
    return UNREADABLE_REPLY_ACTION_STATE;
  }
}

/**
 * 会話の GET を、AI_CHAT_RELOAD_TIMEOUT_MS を上限に取る (#2206 G2)。上限を過ぎた・通信が失敗した・2xx でないときは null
 * (呼び出し側は取り直せなかったとして扱う)。本文は JSON で読む
 */
export async function fetchConversationForReload(sessionId: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_CHAT_RELOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/ai/consultation/sessions/${sessionId}/messages`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('Failed to reload messages after an incomplete reply:', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
