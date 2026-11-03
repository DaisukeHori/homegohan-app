/**
 * AI 相談の送信の応答 (SSE の最後の finalData) を受け取れずに会話を取り直したときの、前の依頼の自動実行の見分け方
 * (#2195 V3 でモバイルに入れたもの。#2201 U3 で Web とモバイルの共有にした)。
 *
 * 問題:
 *   サーバー (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts) は、AI の返答に提案があると、返答を保存してから
 *   提案の記録 (ai_action_logs) を実行中の印 (approved) で作り、その場で実行し、結果を応答の最後 (finalData の actionResult) で
 *   だけ返す (結果の一文は保存しない)。送信が時間切れになった・応答の本文を読めなかったときは finalData を受け取れないので、
 *   献立などが書き換わっていても、結果の一文もデータを出す画面の取り直しも出なかった。会話の GET は、実行できた提案を
 *   「出さない」(proposedActions が null) で返すが、提案の無い返答・断った提案も同じ形なので、GET だけでは見分けられない。
 *
 * 決まり:
 *   - 取り直した会話から、送った文 (送る前には無かった id の user のメッセージで、本文が送った文と同じもの) のすぐ後ろの
 *     AI の返答 (replyToSentMessageOf) を探し、その返答の提案の記録の状態を読む (previousRequestActionStateOf)
 *   - 実行できた行 (executed) があれば、短い一文 (PREVIOUS_REQUEST_EXECUTED_MESSAGE) を足し、データを出す画面に知らせる
 *   - 実行中の印 (approved) の行だけなら、まだ実行している最中か、実行のあとに状態を書き戻せなかったかのどちらか。
 *     実行したとも、していないとも言い切れないので、頼み直しを勧めない一文 (PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE) を足し、
 *     PREVIOUS_REQUEST_RECHECK_DELAY_MS だけ待ってから 1 回だけ記録を読み直す。実行できた行になっていれば、一文を
 *     PREVIOUS_REQUEST_EXECUTED_MESSAGE に置き換えて、データを出す画面に知らせる (#2201 U3。以前は何も出さなかった)
 *   - それ以外 (行が無い・実行を待つ・失敗・断った・記録を読めない) は何も足さない (実行したと言い切れない)
 *
 * このファイルは Web のブラウザとモバイルで読み込む (サーバー・DOM・React Native の依存を import しない)。
 */

/**
 * 提案の記録 (ai_action_logs.status) の値のうち、ここで見分けるもの。サーバーの src/lib/ai/consultation-action-lifecycle.ts の
 * AI_ACTION_LOG_STATUS.executed・AI_ACTION_LOG_STATUS.running と同じ (一致は tests/consultation-reply-reload-2201.test.ts が確かめる)
 */
export const PREVIOUS_REQUEST_ACTION_LOG_STATUS = {
  /** 実行できた */
  executed: 'executed',
  /** 実行中の印 (実行している最中か、実行のあとに状態を書き戻せなかった) */
  running: 'approved',
} as const;

/** 応答を受け取れずに取り直した会話で、送った文への返答の提案が実行されていたときに足す一文 */
export const PREVIOUS_REQUEST_EXECUTED_MESSAGE = '前の依頼は実行されました';

/**
 * 応答を受け取れずに取り直した会話で、送った文への返答の提案の記録が実行中の印のままのときに足す一文。
 * 実行したとも、していないとも言い切れないので、頼み直しを勧めない (頼み直すと献立を二重に作りうる)
 */
export const PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE = '前の依頼は実行中か実行済みです';

/**
 * 記録が実行中の印のままだったときに、記録を 1 回だけ読み直すまでの待ち (ミリ秒)。
 * 返答が取り直せた時点で AI の返答は保存済みで、残るのは提案の実行 (と行の書き戻し) だけ。終わる時刻は画面からは分からないので、
 * 待ちすぎて利用者が画面を離れる前に読み直せる、数秒の範囲の長めの側の 1 回にする (何度も読みにいかない)。
 * 読み直しても実行中の印のままなら、一文はそのまま残す (提案のカードと同じく頼み直しを勧めない)
 */
export const PREVIOUS_REQUEST_RECHECK_DELAY_MS = 10_000;

/**
 * 送った文への返答の提案の記録の状態。
 * executed = 実行できた行がある / running = 実行中の印の行だけがある (実行できた行は無い) / none = それ以外・読めない
 */
export type PreviousRequestActionState = 'executed' | 'running' | 'none';

/** 提案の記録の行 (status を持つもの) から、前の依頼の状態を決める。配列でない・status が無い行は数えない */
export function previousRequestActionStateOf(rows: unknown): PreviousRequestActionState {
  if (!Array.isArray(rows)) return 'none';
  const statuses = rows.map((row: unknown) =>
    typeof row === 'object' && row !== null && 'status' in row ? row.status : undefined,
  );
  if (statuses.includes(PREVIOUS_REQUEST_ACTION_LOG_STATUS.executed)) return 'executed';
  if (statuses.includes(PREVIOUS_REQUEST_ACTION_LOG_STATUS.running)) return 'running';
  return 'none';
}

/** 取り直した会話のメッセージのうち、見分けに使う項目 */
export type ReloadedMessage = { id: string; role: string; content: string };

/** 取り直した会話の中から送った文を見分けるのに使う、送信の項目 */
export type SentText = {
  /** 送った文 (前後の空白を除いたもの。サーバーも同じく除いて保存する) */
  text: string;
  /** 送る前に画面に出ていた、サーバーのメッセージの id (画面が楽観的に足したもの・ウェルカムは含めなくてよい) */
  knownMessageIds: readonly string[];
};

/**
 * 取り直した会話の中の、送った文の位置 (無ければ -1)。
 * 送った文 = 送る前には無かった id の user のメッセージで、本文が送った文と同じもの
 */
export function sentMessageIndexOf(sent: SentText, loaded: readonly ReloadedMessage[]): number {
  const known = new Set(sent.knownMessageIds);
  return loaded.findIndex(
    (message) => message.role === 'user' && !known.has(message.id) && message.content.trim() === sent.text,
  );
}

/**
 * 取り直した会話の中の、送った文への AI の返答 (送った文のすぐ後ろの assistant のメッセージ)。
 * 送った文が無い・返答がまだ無い・返答の前に別の user のメッセージがあるときは null
 * (別の依頼への返答を「前の依頼」として扱わない)
 */
export function replyToSentMessageOf<T extends ReloadedMessage>(sent: SentText, loaded: readonly T[]): T | null {
  const sentIndex = sentMessageIndexOf(sent, loaded);
  if (sentIndex < 0) return null;
  for (const message of loaded.slice(sentIndex + 1)) {
    if (message.role === 'assistant') return message;
    if (message.role === 'user') return null;
  }
  return null;
}

/** 前の依頼の結果の一文の id (同じ返答の結果は 1 つ。実行中の一文は、実行できたと分かったらこの id の一文に置き換える) */
export function previousRequestNoteIdOf(state: Exclude<PreviousRequestActionState, 'none'>, replyId: string): string {
  return state === 'executed' ? `action-result-${replyId}` : `action-running-${replyId}`;
}

/** 前の依頼の状態から、足す一文 (none のときは足さないので、ここには渡さない) */
export function previousRequestNoteTextOf(state: Exclude<PreviousRequestActionState, 'none'>): string {
  return state === 'executed' ? PREVIOUS_REQUEST_EXECUTED_MESSAGE : PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE;
}
