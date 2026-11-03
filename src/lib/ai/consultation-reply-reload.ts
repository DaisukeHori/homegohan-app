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
 *     『前の依頼は実行されました』を足して通知を投げる。実行中の印のままなら『前の依頼は実行中か実行済みです』を足し、
 *     少し待って 1 回だけ読み直す (実行できていれば一文を置き換えて通知を投げる)
 *   - 届いていない・返答がまだ無い・取り直せないときは、頼み直しを促す文を出し分ける (届いているのに頼み直すと二重に届く)
 *
 * このファイルはブラウザでだけ使う (サーバーの依存を import しない)。
 */
import { previousRequestActionStateOf, type PreviousRequestActionState } from '@homegohan/shared';

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

/** 応答を受け取れず、会話も取り直せなかったときの文 (時間切れ以外。以前からの文) */
export const AI_CHAT_REPLY_FAILED_MESSAGE = '応答に失敗しました。再試行してください。';

/** 取り直したら、送った文は届いていたが、返答がまだ無かったとき (頼み直すと二重に届くので、開き直してもらう) */
export const AI_CHAT_DELIVERED_NO_REPLY_MESSAGE =
  '相談はサーバーに届いています。返答を作っているところかもしれません。少し待ってから相談を開き直してください。';

/** 取り直したら、送った文が届いていなかったとき (入力欄に戻した文をもう一度送ってもらう) */
export const AI_CHAT_NOT_DELIVERED_MESSAGE = '相談はサーバーに届いていませんでした。もう一度送ってください。';

/** 返答の提案の記録の状態と、提案の種類 (データの更新の通知に添える。分からなければ null) */
export interface ReplyActionState {
  state: PreviousRequestActionState;
  actionType: string | null;
}

/**
 * 返答 (messageId) に付いた提案の記録 (ai_action_logs) の状態を読む。
 * 読むのは自分の相談の行だけ (行の安全は RLS の「自分の相談の行」の決まりが守る。モバイルの AIAdvisorSheet と同じ読み方)。
 * 読めなければ none (実行したと言い切れない)
 */
export async function readReplyActionStateOf(messageId: string): Promise<ReplyActionState> {
  try {
    const { data, error } = await createClient()
      .from('ai_action_logs')
      .select('status, action_type')
      .eq('message_id', messageId);
    if (error) return { state: 'none', actionType: null };
    const state = previousRequestActionStateOf(data);
    const actionType = Array.isArray(data)
      ? (data as Array<{ action_type?: unknown }>).map((row) => row.action_type).find((t): t is string => typeof t === 'string') ?? null
      : null;
    return { state, actionType };
  } catch {
    return { state: 'none', actionType: null };
  }
}
