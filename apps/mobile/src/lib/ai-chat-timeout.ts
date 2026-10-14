/**
 * AI 相談の送信 (POST /api/ai/consultation/sessions/:id/messages?stream=true) を待つ上限 (ミリ秒) (#1049 F7-18)。
 *
 * サーバーは AI への問い合わせを 25 秒で打ち切る (AbortSignal.timeout(25000)。
 * src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts) ので、それに通信の余裕 1 秒を足した値。
 * React Native の fetch は応答を最後まで受け取ってから返す (ストリームを少しずつ読めない) ので、
 * この時間は「返答が全部届くまで」の上限になる。超えて打ち切っても、サーバーでは返答の保存が続いていることがあるため、
 * 画面は打ち切ったあとに会話を取り直せるようにする (AIAdvisorSheet の「最新の会話を読み込む」)。
 */
export const AI_CHAT_STREAM_TIMEOUT_MS = 26_000;

/*
 * ── 送信が時間切れになったあとの扱い (#1049 F7-18。AIAdvisorSheet と全画面の AI 相談 app/ai/[sessionId].tsx で共通) ──
 *
 * 時間切れで打ち切ったのは画面の待ちだけで、サーバーは送った文を先に保存し、返答の作成と保存を続けていることがある
 * (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts は、AI に問い合わせる前に送った文を保存する)。
 * 両方の画面とも、次のように扱う。
 *   1. 時間切れになったら、失敗として終わらせず、案内 (TIMEOUT_NOTICE_MESSAGE) と取り直しのボタン (TIMEOUT_RELOAD_LABEL) を出す。
 *      送った文は入力欄に戻す (restoreInputAfterTimeout。入力欄に別の文が入っていれば、それを消さない)。
 *   2. 取り直したら、サーバーの会話に送った文があるか (= 届いていたか) を timeoutReloadOutcomeOf で見分ける。
 *      - 届いていて返答もある ('replied'): 会話を出し、案内を消す。
 *      - 届いているが返答がまだ無い ('delivered-no-reply'): 会話を出し、返答の作成が続いていることがある旨の案内
 *        (TIMEOUT_DELIVERED_NO_REPLY_MESSAGE) と取り直しのボタンを残す。
 *      - 届いていない ('not-delivered'): 案内を消し、もう一度送るように知らせる (TIMEOUT_NOT_DELIVERED_MESSAGE)。
 *   3. 届いていたとき ('replied' と 'delivered-no-reply') は、入力欄に戻した文を消す (clearInputIfDelivered)。
 *      そのまま送ると、同じ相談がサーバーに二重に届く (AI の回数も二重に数えられる)ため。
 *      入力欄の文を書き換えていたら、それは新しい相談なので消さない。届いていなければ、戻した文を残す (そのまま送り直せる)。
 */

/** 時間切れになったときの案内。もう一度送るように促すのは、取り直しても届いていなかったときだけ (先に送り直すと二重に届く) */
export const TIMEOUT_NOTICE_MESSAGE =
  "応答に時間がかかっています。返答はサーバーで続いていることがあります。少し待ってから「最新の会話を読み込む」を押してください。返答が無ければ、もう一度送ってください。";
/** 取り直しのボタンの文 */
export const TIMEOUT_RELOAD_LABEL = "最新の会話を読み込む";
/** 取り直しで会話を読めなかったとき */
export const TIMEOUT_RELOAD_FAILED_MESSAGE = "会話を読み込めませんでした。通信の状態を確認して、もう一度お試しください。";
/** 取り直したら、送った文は届いていたが、返答がまだ無かったとき */
export const TIMEOUT_DELIVERED_NO_REPLY_MESSAGE =
  "相談はサーバーに届いています。返答を作っているところかもしれません。少し待ってから、もう一度「最新の会話を読み込む」を押してください。";
/** 取り直したら、送った文が届いていなかったとき */
export const TIMEOUT_NOT_DELIVERED_MESSAGE = "相談はサーバーに届いていませんでした。入力欄の文を、もう一度送ってください。";

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
};

/** 取り直しで読んだメッセージのうち、見分けに使う項目 */
export type ReloadedMessage = { id: string; role: string; content: string };

/** 取り直しの結果 */
export type TimeoutReloadOutcome = "replied" | "delivered-no-reply" | "not-delivered";

/**
 * 取り直した会話から、時間切れになった送信が届いていたか・返答があるかを決める。
 * 届いていた = 送る前には無かった id の user のメッセージで、本文が送った文と同じものがある。
 * 返答がある = その後ろに assistant のメッセージがある (サーバーは作成順に返す)。
 */
export function timeoutReloadOutcomeOf(sent: TimedOutSend, loaded: readonly ReloadedMessage[]): TimeoutReloadOutcome {
  const known = new Set(sent.knownMessageIds);
  const sentIndex = loaded.findIndex(
    (message) => message.role === "user" && !known.has(message.id) && message.content.trim() === sent.text,
  );
  if (sentIndex < 0) return "not-delivered";
  return loaded.slice(sentIndex + 1).some((message) => message.role === "assistant") ? "replied" : "delivered-no-reply";
}

/** 時間切れになったときの入力欄。空なら送った文を戻す。別の文が入っていれば (待っている間に書いた文)、それを残す */
export function restoreInputAfterTimeout(currentInput: string, sentText: string): string {
  return currentInput.trim() ? currentInput : sentText;
}

/** 届いていたと分かったときの入力欄。戻した文のまま (書き換えていない) なら消す (二重に送らないため)。書き換えていれば残す */
export function clearInputIfDelivered(currentInput: string, sentText: string): string {
  return currentInput.trim() === sentText ? "" : currentInput;
}
