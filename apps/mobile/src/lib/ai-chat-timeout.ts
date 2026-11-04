import {
  CONSULTATION_REPLY_FAILED_MESSAGE,
  CONSULTATION_REPLY_RELOAD_TIMEOUT_MS,
  PREVIOUS_REQUEST_ACTION_LOG_STATUS,
  PREVIOUS_REQUEST_EXECUTED_MESSAGE,
  PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE,
  PREVIOUS_REQUEST_RECHECK_DELAY_MS,
  PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE,
  messagesAfterPreviousRequestRecheck,
  previousRequestActionStateOf,
  previousRequestNoteIdOf,
  previousRequestNotePlanOf,
  previousRequestNoteTextOf,
  previousRequestRecheckPlanOf,
  replyHasProposalOf,
  replyProposalExecutableOf,
  replyToSentMessageOf,
  replyToUserMessageIdOf,
  resolveUnconfirmedSendRows,
  resolveUnconfirmedSends,
  sentMessageIndexOf,
  sentMessageReloadOutcomeOf,
  settleWithin,
  clearInputIfDelivered as sharedClearInputIfDelivered,
  restoreInputAfterUndelivered,
  type PreviousRequestActionRead,
  type PreviousRequestActionState,
  type PreviousRequestNoteState,
  type ReloadedMessage,
  type SentText,
  type UnconfirmedSend,
} from "@homegohan/shared";

/**
 * AI 相談の送信 (POST /api/ai/consultation/sessions/:id/messages?stream=true) を待つ上限 (ミリ秒) (#1049 F7-18)。
 *
 * サーバーは AI への問い合わせを 25 秒で打ち切る (AbortSignal.timeout(25000)。
 * src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts) ので、それに通信の余裕 1 秒を足した値。
 * React Native の fetch は応答を最後まで受け取ってから返す (ストリームを少しずつ読めない) ので、
 * この時間は「返答が全部届くまで」の上限になる。本文を少しずつ読める環境でも、本文の読み取りまで含めた上限にする
 * (#2206 G2。以前は応答の見出しを受けた時点で待ちを外していたので、本文の読み取りには上限が無かった)。
 * 超えて打ち切っても、サーバーでは返答の保存が続いていることがあるため、
 * 画面は打ち切ったあとに会話を取り直せるようにする (AIAdvisorSheet の「最新の会話を読み込む」)。
 */
export const AI_CHAT_STREAM_TIMEOUT_MS = 26_000;

/*
 * ── 送信が時間切れになったあとの扱い (#1049 F7-18。AIAdvisorSheet が使う。全画面の AI 相談のネイティブの画面は #1598 で消した) ──
 *
 * 時間切れで打ち切ったのは画面の待ちだけで、サーバーは送った文を先に保存し、返答の作成と保存を続けていることがある
 * (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts は、AI に問い合わせる前に送った文を保存する)。
 * 両方の画面とも、次のように扱う。
 *   1. 時間切れになったら、失敗として終わらせず、案内 (TIMEOUT_NOTICE_MESSAGE) と取り直しのボタン (TIMEOUT_RELOAD_LABEL) を出す。
 *      送った文は入力欄に戻す (restoreInputAfterTimeout。入力欄に別の文が入っていれば、それを消さない)。
 *   2. 取り直したら、サーバーの会話に送った文があるか (= 届いていたか) を timedOutSendReloadOf (本文の一致は timeoutReloadOutcomeOf)
 *      で見分ける。
 *      - 届いていて返答もある ('replied'): 会話を出し、案内を消す。
 *      - 届いているが返答がまだ無い ('delivered-no-reply'): 会話を出し、返答の作成が続いていることがある旨の案内
 *        (TIMEOUT_DELIVERED_NO_REPLY_MESSAGE) と取り直しのボタンを残す。見つけた保存行の id を持ち (savedUserMessageId)、
 *        もう一度押したときはその id で送った文と返答を探す (#2227 H1)。
 *      - 届いていない ('not-delivered'): 案内を消し、もう一度送るように知らせる (TIMEOUT_NOT_DELIVERED_MESSAGE)。
 *   3. 届いていたとき ('replied' と 'delivered-no-reply') は、入力欄に戻した文を消す (clearInputIfDelivered)。
 *      そのまま送ると、同じ相談がサーバーに二重に届く (AI の回数も二重に数えられる)ため。
 *      入力欄の文を書き換えていたら、それは新しい相談なので消さない。届いていなければ、戻した文を残す (そのまま送り直せる)。
 */

/** 時間切れになったときの案内。もう一度送るように促すのは、取り直しても届いていなかったときだけ (先に送り直すと二重に届く) */
export const TIMEOUT_NOTICE_MESSAGE =
  "応答に時間がかかっています。返答はサーバーで続いていることがあります。少し待ってから「最新の会話を読み込む」を押してください。返答が無ければ、もう一度送ってください。";
/**
 * 時間切れでないのに応答を最後まで受け取れず (流れが途中で切れた・受け付けたあとの例外)、会話も取り直せなかったときの案内 (#2206 G2)。
 * 時間切れのときと同じく、頼み直しの前に取り直してもらう (サーバーでは返答の保存と自動実行が済んでいることがある)
 */
export const INTERRUPTED_NOTICE_MESSAGE =
  "応答を最後まで受け取れませんでした。返答はサーバーで続いていることがあります。少し待ってから「最新の会話を読み込む」を押してください。返答が無ければ、もう一度送ってください。";
/** 取り直しのボタンの文 */
export const TIMEOUT_RELOAD_LABEL = "最新の会話を読み込む";
/** 取り直しで会話を読めなかったとき */
export const TIMEOUT_RELOAD_FAILED_MESSAGE = "会話を読み込めませんでした。通信の状態を確認して、もう一度お試しください。";
/** 取り直したら、送った文は届いていたが、返答がまだ無かったとき */
export const TIMEOUT_DELIVERED_NO_REPLY_MESSAGE =
  "相談はサーバーに届いています。返答を作っているところかもしれません。少し待ってから、もう一度「最新の会話を読み込む」を押してください。";
/** 取り直したら、送った文が届いていなかったとき */
export const TIMEOUT_NOT_DELIVERED_MESSAGE = "相談はサーバーに届いていませんでした。入力欄の文を、もう一度送ってください。";
/**
 * 応答を受ける前に時間切れ・通信の切断で終わり、取り直した会話に送った文が無かったとき (#2227 H1。Web の
 * AI_CHAT_DELIVERY_UNCONFIRMED_MESSAGE と同じ考え)。サーバーは送った文を AI に問い合わせる前に保存するが、同意・上限の確かめが
 * 遅いと保存が取り直しより後になりうるので、『届いていません』とは言い切らない。入力欄に戻した文は残す
 */
export const TIMEOUT_DELIVERY_UNCONFIRMED_MESSAGE =
  "相談がサーバーに届いたかを確かめられませんでした。少し待ってから相談を開き直し、送った文が無ければ、入力欄の文をもう一度送ってください。";
/** TIMEOUT_DELIVERY_UNCONFIRMED_MESSAGE の Alert の見出し (『送信できませんでした』と言い切らない) */
export const TIMEOUT_DELIVERY_UNCONFIRMED_TITLE = "送信を確かめられませんでした";
/**
 * サーバーが失敗を知らせた (SSE で error だけの行が来た) のに、取り直しても返答が無かったとき (#2227 H1。返答は来ないので、
 * 頼み直してもらう。Web の AI_CHAT_REPLY_FAILED_MESSAGE と同じ文)
 */
export const REPLY_FAILED_MESSAGE = CONSULTATION_REPLY_FAILED_MESSAGE;
/**
 * 応答を受け取れなかったあとの会話の取り直し (GET) と、提案の記録の直読みを待つ上限 (ミリ秒。#2227 H1。Web と共有の値)。
 * 取り直しは送信中 (入力欄が止まっている間) に待つ。/api/ai/ の下の GET の既定 (src/lib/api.ts の SLOW_API_TIMEOUT_MS = 120 秒)
 * のままだと、GET が詰まると最大 120 秒『送信中』で入力欄が止まった
 */
export const AI_CHAT_RELOAD_TIMEOUT_MS = CONSULTATION_REPLY_RELOAD_TIMEOUT_MS;

/** 時間切れになった送信。取り直しで、送った文がサーバーに届いていたかを見分けるために持つ */
export type TimedOutSend = {
  /** 送った相談の id */
  sessionId: string;
  /** 送った文 (前後の空白を除いたもの。サーバーも同じく除いて保存する) */
  text: string;
  /** 送る前に画面に出ていた、サーバーのメッセージの id (画面が楽観的に足したもの・ウェルカムは含めない) */
  knownMessageIds: readonly string[];
  /** 取り直しで、送った文が届いていたと分かったか (返答はまだ無い)。案内の文を切り替える */
  delivered: boolean;
  /** 時間切れでなく、応答が途中で切れた (finalData が無い・受け付けたあとの例外。#2206 G2)。案内の文を切り替える */
  interrupted?: boolean;
  /**
   * 応答を受ける前に終わった (時間切れ・通信の切断。#2227 H1。Web の userSaveMayBeLate)。サーバーが送った文を保存するのが
   * 取り直しより後になりうるので、送った文が見つからなくても『届いていません』と言い切らない
   */
  userSaveMayBeLate?: boolean;
  /** サーバーが失敗を知らせた (SSE で error だけの行が来た。#2227 H1)。返答は来ないので、取り直しで返答が無ければ失敗の文を出す */
  serverFailed?: boolean;
  /**
   * 取り直しで見つけた、送った文の保存行の id (届いているが返答がまだ無いと分かったときに持つ。#2227 H1)。
   * 次の「最新の会話を読み込む」では、本文の一致でなくこの id で送った文と返答を探す (timedOutSendReloadOf。Web の
   * recheckDeliveredNoReplyLater と同じ)。本文の一致で探すと、この行はもうこの送信に当てた行 (画面の claimedSavedUserIds) に
   * 入っているので除かれ、届いていた送信を『届いていません』と取り違えた
   */
  savedUserMessageId?: string;
};

/** 「最新の会話を読み込む」の上に出す案内 (届いていた → 返答がまだ無い / 途中で切れた / 時間切れ) */
export function timedOutSendNoticeOf(sent: TimedOutSend): string {
  if (sent.delivered) return TIMEOUT_DELIVERED_NO_REPLY_MESSAGE;
  return sent.interrupted ? INTERRUPTED_NOTICE_MESSAGE : TIMEOUT_NOTICE_MESSAGE;
}

/** 取り直しの結果 */
export type TimeoutReloadOutcome = "replied" | "delivered-no-reply" | "not-delivered";

/**
 * 取り直した会話から、時間切れになった送信が届いていたか・返答があるかを決める (#2206 G2 から Web と共有の決まり
 * sentMessageReloadOutcomeOf を読み直すだけ)。
 * 届いていた = 送った文 (sentMessageIndexOf。いちばん後ろの一致) がある。
 * 返答がある = 送った文のすぐ後ろ (別の user のメッセージを挟まない) に assistant のメッセージがある (replyToSentMessageOf)。
 */
export function timeoutReloadOutcomeOf(sent: TimedOutSend, loaded: readonly ReloadedMessage[]): TimeoutReloadOutcome {
  return sentMessageReloadOutcomeOf(sent, loaded);
}

/** 取り直した会話での、時間切れになった送信の結果と、送った文の保存行・その返答 (無ければ null) */
export type TimedOutSendReload<T extends ReloadedMessage> = {
  outcome: TimeoutReloadOutcome;
  savedUser: T | null;
  reply: T | null;
};

/**
 * 取り直した会話 (loaded) で、時間切れになった送信 (sent) の結果・送った文の保存行・返答を決める (#2227 H1)。
 *   - 前の取り直しで保存行の id が分かっている (sent.savedUserMessageId) ときは、その id の user の行と、そのすぐ後ろの返答
 *     (replyToUserMessageIdOf) で決める。この行はもうこの送信に当てた行なので、excludedIds に入っていても除かない
 *   - 分かっていない (または id の行が会話に無い) ときは、本文の一致 (sentMessageIndexOf。いちばん後ろ) で探す。
 *     excludedIds (確かめられなかった前の送信に当てた行) は除く。ただし sent.savedUserMessageId は除かない
 */
export function timedOutSendReloadOf<T extends ReloadedMessage>(
  sent: TimedOutSend,
  loaded: readonly T[],
  excludedIds: readonly string[],
): TimedOutSendReload<T> {
  const savedId = sent.savedUserMessageId;
  if (savedId !== undefined) {
    const savedUser = loaded.find((message) => message.role === "user" && message.id === savedId) ?? null;
    if (savedUser) {
      const reply = replyToUserMessageIdOf(savedId, loaded);
      return { outcome: reply ? "replied" : "delivered-no-reply", savedUser, reply };
    }
  }
  const sentByText: TimedOutSend = {
    ...sent,
    knownMessageIds: [...sent.knownMessageIds, ...excludedIds.filter((id) => id !== savedId)],
  };
  const outcome = timeoutReloadOutcomeOf(sentByText, loaded);
  if (outcome === "not-delivered") return { outcome, savedUser: null, reply: null };
  return { outcome, savedUser: loaded[sentMessageIndexOf(sentByText, loaded)], reply: replyToSentMessageOf(sentByText, loaded) };
}

/*
 * ── 応答を受け取れずに取り直したときの、自動実行の結果 (#2195 V3・#2201 U3) ──
 *
 * 送った文への AI の返答 (replyToSentMessageOf) の提案の記録 (ai_action_logs) の状態を読み、実行できた行があれば短い一文
 * (PREVIOUS_REQUEST_EXECUTED_MESSAGE) を足してタブに知らせる。実行中の印の行だけなら、結果をまだ確かめられないと伝える一文
 * (PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE。頼み直しを勧めない) を足し、少し待って (PREVIOUS_REQUEST_RECHECK_DELAY_MS) 1 回だけ読み直す。
 * 実行を待つ・失敗した行なら、実行していない一文 (PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE) を足す (読み直しで分かったときも
 * 一文を置き換える。#2206 G2)。
 * 記録の行がまだ無い・読めないのに返答に提案があるときは、実行中の印と同じく扱う (サーバーは返答を保存してから行を作る)。
 * 提案が無く記録を読めないときは何も足さず (実行したと言い切れない)、少し待って 1 回だけ読み直す (#2206 G2)。
 * 決まりと見分け方は Web と共有 (packages/shared/src/consultation-reply-reload.ts の previousRequestNotePlanOf・
 * previousRequestRecheckPlanOf・messagesAfterPreviousRequestRecheck)。ここはモバイルの既存の名前で読み直すだけ。
 */

/**
 * 提案の記録 (ai_action_logs.status) の「実行できた」の値。サーバーの src/lib/ai/consultation-action-lifecycle.ts の
 * AI_ACTION_LOG_STATUS.executed と同じ (一致は tests/mobile-ai-reload-executed-2195.test.ts が確かめる)
 */
export const AI_ACTION_LOG_STATUS_EXECUTED = PREVIOUS_REQUEST_ACTION_LOG_STATUS.executed;

export {
  PREVIOUS_REQUEST_EXECUTED_MESSAGE,
  PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE,
  PREVIOUS_REQUEST_RECHECK_DELAY_MS,
  PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE,
  messagesAfterPreviousRequestRecheck,
  previousRequestActionStateOf,
  previousRequestNoteIdOf,
  previousRequestNotePlanOf,
  previousRequestNoteTextOf,
  previousRequestRecheckPlanOf,
  replyHasProposalOf,
  replyProposalExecutableOf,
  replyToSentMessageOf,
  replyToUserMessageIdOf,
  resolveUnconfirmedSendRows,
  resolveUnconfirmedSends,
  sentMessageIndexOf,
  settleWithin,
  type PreviousRequestActionRead,
  type PreviousRequestActionState,
  type PreviousRequestNoteState,
  type ReloadedMessage,
  type SentText,
  type UnconfirmedSend,
};

/** 提案の記録の行 (status を持つもの) に、実行できた行があるか。配列でない・status が無い行は数えない */
export function hasExecutedActionLog(rows: unknown): boolean {
  return previousRequestActionStateOf(rows) === "executed";
}

/**
 * 時間切れになったときの入力欄。空なら送った文を戻す。別の文が入っていれば (待っている間に書いた文)、それを残す
 * (#2227 H1 から Web と共有の restoreInputAfterUndelivered を読み直すだけ)
 */
export function restoreInputAfterTimeout(currentInput: string, sentText: string): string {
  return restoreInputAfterUndelivered(currentInput, sentText);
}

/**
 * 届いていたと分かったときの入力欄。戻した文のまま (書き換えていない) なら消す (二重に送らないため)。書き換えていれば残す
 * (#2227 H1 から Web と共有の clearInputIfDelivered を読み直すだけ)
 */
export function clearInputIfDelivered(currentInput: string, sentText: string): string {
  return sharedClearInputIfDelivered(currentInput, sentText);
}
