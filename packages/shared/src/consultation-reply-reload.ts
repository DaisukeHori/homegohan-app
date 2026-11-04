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
 *   - 実行中の印 (approved) の行だけなら、まだ実行している最中か、実行のあとに状態を書き戻せなかったかのどちらか
 *     (失敗・今日の上限で実行しなかった場合もある)。実行したとも、していないとも言い切れないので、結果をまだ確かめられないと
 *     伝える一文 (PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE。提案のカードの『確かめられませんでした』と同じ考え。頼み直しは勧めない)
 *     を足し、PREVIOUS_REQUEST_RECHECK_DELAY_MS だけ待ってから 1 回だけ記録を読み直す。実行できた行になっていれば一文を
 *     PREVIOUS_REQUEST_EXECUTED_MESSAGE に置き換えて、データを出す画面に知らせる (#2201 U3)。実行を待つ・失敗した行になって
 *     いれば、一文を PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE に置き換える (#2206 G2。以前は『実行中か実行済み』のまま残った)
 *   - 実行を待つ (pending)・失敗した (failed) 行だけなら、実行していない一文 (PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE) を足す
 *     (#2206 G2。読み直しで分かったときと同じ文)
 *   - 行がまだ無い・記録を読めないのに返答に提案がある (GET が提案を返した) ときは、実行中の印と同じく扱う (#2206 G2。
 *     サーバーは返答を保存してから行を作るので、その間に取り直しが当たると行がまだ無い)。ただし記録を読めず、GET が
 *     「実行する」を出すとした (GET が読んだ行は pending) ときは、実行していないとして扱う (#2227 H1)。読み直しても行が無ければ
 *     (サーバーが行を作れずに実行しなかった)、実行していない一文に置き換える (#2227 H1)
 *   - それ以外 (行が無い・断った・記録を読めない) は何も足さない (実行したと言い切れない)。記録を読めなかったときは、
 *     少し待って 1 回だけ読み直す (#2206 G2。実行できていれば一文を足して知らせる)
 *   - 取り直し (GET) とそのあとの記録の直読みは CONSULTATION_REPLY_RELOAD_TIMEOUT_MS で打ち切る (#2227 H1。Web とモバイルで同じ)
 *   - 届いたかを確かめられなかった送信は画面が覚え、後の取り直しで保存行が見つかったら入力欄に戻した文を消し、今回の送信の
 *     保存行を探すときはその行を除く (resolveUnconfirmedSends。送信ごとに当てた行も返すのは resolveUnconfirmedSendRows。#2227 H1)
 *   - この決まりは previousRequestNotePlanOf (取り直したとき) と previousRequestRecheckPlanOf・
 *     messagesAfterPreviousRequestRecheck (読み直したとき) の 1 か所で決め、Web とモバイルの画面はその結果を描くだけにする
 *     (#2206 G2。以前は画面ごとに判定を写していて、Web にだけ足した決まりがモバイルに無かった)
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
  /** 実行を待つ (自動実行がやり直せる失敗をした・今日の上限や同意で止めた。実行していない) */
  pending: 'pending',
  /** 失敗し、やり直せない (実行していない) */
  failed: 'failed',
} as const;

/** 応答を受け取れずに取り直した会話で、送った文への返答の提案が実行されていたときに足す一文 */
export const PREVIOUS_REQUEST_EXECUTED_MESSAGE = '前の依頼は実行されました';

/**
 * 応答を受け取れずに取り直した会話で、送った文への返答の提案の記録が実行中の印のままのときに足す一文 (#2206 G2)。
 * 実行中の印には、実行している最中・書き戻せなかった成功のほか、失敗・今日の上限で実行しなかった場合もあるので、
 * 実行したとも、していないとも言い切らない (提案のカードの『実行できたかを確かめられませんでした…開き直してください』と同じ考え)。
 * 頼み直しは勧めない (頼み直すと献立を二重に作りうる)。以前の『前の依頼は実行中か実行済みです』は、書き戻せなかった失敗でも
 * 『実行済み』と読めた
 */
export const PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE = '前の依頼の結果をまだ確かめられません。しばらくしてから相談を開き直してください。';

/**
 * 応答を受け取れずに取り直した会話で、送った文への返答の提案の記録が実行を待つ (pending)・失敗した (failed) 行だけのときに
 * 足す一文 (#2206 G2)。実行していないことは確か。頼み直しは勧めない (実行を待つ提案はカードの「実行する」から実行できる)
 */
export const PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE = '前の依頼は実行できませんでした';

/**
 * 記録が実行中の印のままだったときに、記録を 1 回だけ読み直すまでの待ち (ミリ秒)。
 * 返答が取り直せた時点で AI の返答は保存済みで、残るのは提案の実行 (と行の書き戻し) だけ。終わる時刻は画面からは分からないので、
 * 待ちすぎて利用者が画面を離れる前に読み直せる、数秒の範囲の長めの側の 1 回にする (何度も読みにいかない)。
 * 読み直しても実行中の印のままなら、一文はそのまま残す (提案のカードと同じく頼み直しを勧めない)
 */
export const PREVIOUS_REQUEST_RECHECK_DELAY_MS = 10_000;

/**
 * 応答を受け取れなかったあとの会話の取り直し (GET) と、そのあとの提案の記録の直読みを待つ上限 (ミリ秒。#2206 G2 で Web に入れ、
 * #2227 H1 でモバイルと共有にした)。会話の GET はメッセージと提案の記録を読むだけなので、ふだんは 1 秒もかからない。
 * 送信の待ち (Web 28 秒・モバイル 26 秒) より短く、通信が遅い端末でも返る長さにする。
 * 取り直しは送信中 (入力欄が止まっている間) に待つので、上限が無いと読み取りが返らないあいだ入力が止まる
 * (モバイルの /api/ai/ の下の GET は既定で 120 秒待つ。apps/mobile/src/lib/api.ts の SLOW_API_TIMEOUT_MS)
 */
export const CONSULTATION_REPLY_RELOAD_TIMEOUT_MS = 10_000;

/**
 * サーバーが失敗を知らせた (SSE で error の行が来た) とき、または応答が受け付けられなかったときの文 (返答は来ないので、
 * 頼み直してもらう。Web の以前からの文。#2227 H1 でモバイルと共有にした)
 */
export const CONSULTATION_REPLY_FAILED_MESSAGE = '応答に失敗しました。再試行してください。';

/**
 * promise が timeoutMs までに終わらなければ fallback で終える (#2227 H1。取り直しのあとの提案の記録の直読みに上限を付ける。
 * 読み取りそのものは止めない (結果は捨てる)。promise が reject したときはそのまま reject する)
 */
export function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * 送った文への返答の提案の記録の状態。
 * executed = 実行できた行がある / running = 実行中の印の行がある (実行できた行は無い) /
 * notExecuted = 実行を待つ・失敗した行だけがある (#2206 G2) / none = それ以外 (行が無い・断った)・読めない
 */
export type PreviousRequestActionState = 'executed' | 'running' | 'notExecuted' | 'none';

/** 一文を足す状態 (none のときは足さない) */
export type PreviousRequestNoteState = Exclude<PreviousRequestActionState, 'none'>;

/**
 * 提案の記録の行 (status を持つもの) から、前の依頼の状態を決める。配列でない・status が無い行は数えない。
 * 実行できた > 実行中の印 > 実行を待つ・失敗 の順 (どれかが実行できていれば、頼み直すと二重になる)
 */
export function previousRequestActionStateOf(rows: unknown): PreviousRequestActionState {
  if (!Array.isArray(rows)) return 'none';
  const statuses = rows.map((row: unknown) =>
    typeof row === 'object' && row !== null && 'status' in row ? row.status : undefined,
  );
  if (statuses.includes(PREVIOUS_REQUEST_ACTION_LOG_STATUS.executed)) return 'executed';
  if (statuses.includes(PREVIOUS_REQUEST_ACTION_LOG_STATUS.running)) return 'running';
  if (
    statuses.includes(PREVIOUS_REQUEST_ACTION_LOG_STATUS.pending) ||
    statuses.includes(PREVIOUS_REQUEST_ACTION_LOG_STATUS.failed)
  ) {
    return 'notExecuted';
  }
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
 * 送った文 = 送る前には無かった id の user のメッセージで、本文が送った文と同じもののうち、いちばん後ろのもの。
 * 前の送信が時間切れで確かめられず (画面には保存された id が無い)、同じ文を送り直したときは、前の送信の保存行も
 * 「送る前には無かった id」に入る。先頭から探すと前の送信を今回の送信と取り違え、前の返答の結果を出していた (#2206 G2)。
 * サーバーは作成順に返すので、今回の送信はいちばん後ろにある
 */
export function sentMessageIndexOf(sent: SentText, loaded: readonly ReloadedMessage[]): number {
  const known = new Set(sent.knownMessageIds);
  for (let index = loaded.length - 1; index >= 0; index -= 1) {
    const message = loaded[index];
    if (message.role === 'user' && !known.has(message.id) && message.content.trim() === sent.text) return index;
  }
  return -1;
}

/**
 * 取り直した会話の中の、送った文への AI の返答 (送った文のすぐ後ろの assistant のメッセージ)。
 * 送った文が無い・返答がまだ無い・返答の前に別の user のメッセージがあるときは null
 * (別の依頼への返答を「前の依頼」として扱わない)
 */
export function replyToSentMessageOf<T extends ReloadedMessage>(sent: SentText, loaded: readonly T[]): T | null {
  return replyAfterUserMessageAt(sentMessageIndexOf(sent, loaded), loaded);
}

/**
 * 取り直した会話の中の、id が userMessageId の user のメッセージへの AI の返答 (すぐ後ろの assistant のメッセージ。
 * 返答の前に別の user のメッセージがあれば null)。その user のメッセージが無い・返答がまだ無いときも null。
 * 送った文の保存行の id が分かったあと (一度取り直して、届いているが返答がまだ無いと分かったあとの読み直し) は、本文の一致
 * (replyToSentMessageOf) で探さずにこの id で探す。本文で探すと、待つ間に同じ文を送り直したとき、後の送信 (いちばん後ろの一致) と
 * その返答を前の送信の返答と取り違える (#2206 G2)
 */
export function replyToUserMessageIdOf<T extends ReloadedMessage>(userMessageId: string, loaded: readonly T[]): T | null {
  return replyAfterUserMessageAt(
    loaded.findIndex((message) => message.role === 'user' && message.id === userMessageId),
    loaded,
  );
}

/** loaded の index の user のメッセージのすぐ後ろの assistant のメッセージ (index が負・返答の前に別の user のメッセージ・返答が無い → null) */
function replyAfterUserMessageAt<T extends ReloadedMessage>(index: number, loaded: readonly T[]): T | null {
  if (index < 0) return null;
  for (const message of loaded.slice(index + 1)) {
    if (message.role === 'assistant') return message;
    if (message.role === 'user') return null;
  }
  return null;
}

/**
 * 取り直した会話から、送った文が届いていたか・返答があるかを決める (Web とモバイルの取り直しで共有する。#2206 G2)。
 * replied = 送った文への返答 (replyToSentMessageOf) がある / delivered-no-reply = 送った文はあるが返答がまだ無い /
 * not-delivered = 送った文が無い
 */
export type SentMessageReloadOutcome = 'replied' | 'delivered-no-reply' | 'not-delivered';

export function sentMessageReloadOutcomeOf(sent: SentText, loaded: readonly ReloadedMessage[]): SentMessageReloadOutcome {
  if (sentMessageIndexOf(sent, loaded) < 0) return 'not-delivered';
  return replyToSentMessageOf(sent, loaded) ? 'replied' : 'delivered-no-reply';
}

/** 送った文を入力欄に戻すときの入力欄 (空なら送った文を戻す。別の文が入っていれば、待っている間に書いた文なので残す) */
export function restoreInputAfterUndelivered(currentInput: string, sentText: string): string {
  return currentInput.trim() ? currentInput : sentText;
}

/**
 * 届いていたと分かったときの入力欄 (#1049 F7-18 のモバイルの決まり。#2227 H1 で Web と共有にした)。
 * 戻した文のまま (書き換えていない) なら消す (そのまま送ると同じ相談が二重に届くため)。書き換えていれば残す
 */
export function clearInputIfDelivered(currentInput: string, sentText: string): string {
  return currentInput.trim() === sentText ? '' : currentInput;
}

/**
 * 届いたかを確かめられなかった送信 (#2227 H1)。取り直せなかった・送った文が見つからなかった送信を画面が覚えておき、
 * 後の取り直し (相談を開き直したとき・次の送信の取り直し) で保存行を探す (resolveUnconfirmedSends)
 */
export type UnconfirmedSend = SentText & {
  /** 送った相談の id */
  sessionId: string;
};

/** resolveUnconfirmedSends の結果 */
export type UnconfirmedSendsResolution = {
  /** 保存行が見つかった (届いていた) 送信 (画面は入力欄に戻した文が戻したままなら消す。clearInputIfDelivered) */
  resolved: UnconfirmedSend[];
  /** まだ保存行が見つからない送信 (覚えたままにする) */
  remaining: UnconfirmedSend[];
  /**
   * 確かめられなかった送信に当てた保存行の id (前から当てていたものを含む)。今回の送信の保存行を探すときは、
   * これを knownMessageIds に足して除く (前の送信の保存行を今回の送信と取り違えない)
   */
  claimedIds: string[];
};

/**
 * 取り直した相談 (sessionId) の会話 (loaded) から、確かめられなかった前の送信 (unconfirmed) の保存行を探して当てる (#2227 H1)。
 *
 * 問題:
 *   sentMessageIndexOf は、送る前には無かった id の行のうち本文が同じいちばん後ろを選ぶ。同じ文を続けて送り、前の送信が確かめられず
 *   (画面は保存行の id を知らない)、今回の送信も届いていないと、前の送信の保存行を今回の送信と取り違え、前の返答とその結果を今回の
 *   結果として出し、入力欄を消していた (今回が届いていないことが伝わらない)。
 *
 * 決まり:
 *   - 前の送信の保存行 = 前の送信の前には無かった id の user の行で、本文が同じで、まだどの送信にも当てていないもののうち、
 *     いちばん前のもの (前の送信は今回の送信より先に保存される)。古い送信から順に当てる
 *   - 今回の送信 (current) がサーバーに受け付けられていた (currentAccepted。サーバーは応答を返す前に送った文を保存するので、
 *     今回の保存行は必ずある) ときは、今回の送信の一致 (sentMessageIndexOf。いちばん後ろ) を前の送信に当てない
 *   - 当てた保存行の id は claimedIds に足す。前から当てていた id (previousClaimedIds) も残す
 */
export function resolveUnconfirmedSends(params: {
  sessionId: string;
  loaded: readonly ReloadedMessage[];
  unconfirmed: readonly UnconfirmedSend[];
  previousClaimedIds: readonly string[];
  current: SentText | null;
  currentAccepted: boolean;
}): UnconfirmedSendsResolution {
  const rows = resolveUnconfirmedSendRows(params);
  return { resolved: rows.resolved.map((row) => row.send), remaining: rows.remaining, claimedIds: rows.claimedIds };
}

/** resolveUnconfirmedSendRows の結果 (resolveUnconfirmedSends の結果に、見つかった送信ごとの保存行の id を足したもの) */
export type UnconfirmedSendRowsResolution<S extends UnconfirmedSend> = {
  /** 保存行が見つかった (届いていた) 送信と、その送信に当てた保存行の id (渡した順) */
  resolved: { send: S; savedMessageId: string }[];
  /** まだ保存行が見つからない送信 (渡したものをそのまま返す) */
  remaining: S[];
  /** resolveUnconfirmedSends の claimedIds と同じ */
  claimedIds: string[];
};

/**
 * resolveUnconfirmedSends と同じ決まりで当て、見つかった送信ごとに当てた保存行の id も返す (#2227 H1)。
 * 送信ごとに当てた行を覚える画面が使う (モバイルの AIAdvisorSheet。ある送信の取り直しの最中に、別の取り直しがその送信の保存行を
 * 先に当てたとき、後から返った取り直しはその行で送った文と返答を探す)。送信に画面の項目 (識別の番号など) を足して渡してよい
 */
export function resolveUnconfirmedSendRows<S extends UnconfirmedSend>(params: {
  sessionId: string;
  loaded: readonly ReloadedMessage[];
  unconfirmed: readonly S[];
  previousClaimedIds: readonly string[];
  current: SentText | null;
  currentAccepted: boolean;
}): UnconfirmedSendRowsResolution<S> {
  const { sessionId, loaded, unconfirmed, previousClaimedIds, current, currentAccepted } = params;
  const claimed = new Set(previousClaimedIds);
  const reservedId =
    current && currentAccepted
      ? (loaded[sentMessageIndexOf({ text: current.text, knownMessageIds: [...current.knownMessageIds, ...claimed] }, loaded)]?.id ?? null)
      : null;
  const resolved: { send: S; savedMessageId: string }[] = [];
  const remaining: S[] = [];
  for (const send of unconfirmed) {
    if (send.sessionId !== sessionId) {
      remaining.push(send);
      continue;
    }
    const known = new Set(send.knownMessageIds);
    const saved = loaded.find(
      (message) =>
        message.role === 'user' &&
        !known.has(message.id) &&
        !claimed.has(message.id) &&
        message.id !== reservedId &&
        message.content.trim() === send.text,
    );
    if (saved) {
      claimed.add(saved.id);
      resolved.push({ send, savedMessageId: saved.id });
    } else {
      remaining.push(send);
    }
  }
  return { resolved, remaining, claimedIds: [...claimed] };
}

/**
 * 前の依頼の結果の一文の id (同じ返答の結果は 1 つ。実行中の一文は、読み直して分かったらこの id の一文に置き換える)。
 * 実行できた・実行していないの id は、自動実行の結果の一文 (action-result-・action-failed-) と同じ形
 */
export function previousRequestNoteIdOf(state: PreviousRequestNoteState, replyId: string): string {
  if (state === 'executed') return `action-result-${replyId}`;
  if (state === 'notExecuted') return `action-failed-${replyId}`;
  return `action-running-${replyId}`;
}

/** 前の依頼の状態から、足す一文 (none のときは足さないので、ここには渡さない) */
export function previousRequestNoteTextOf(state: PreviousRequestNoteState): string {
  if (state === 'executed') return PREVIOUS_REQUEST_EXECUTED_MESSAGE;
  if (state === 'notExecuted') return PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE;
  return PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE;
}

/**
 * 取り直した会話の返答に、提案があるか (会話の GET の proposedActions。#2206 G2)。
 * GET は実行できた提案・提案の無い返答・断った提案を null で返し、それ以外 (実行を待つ・失敗・実行中の印・行がまだ無い) は
 * 提案を返す。Web とモバイルで同じ決まりにするため、ここで読む
 */
export function replyHasProposalOf(reply: { proposedActions?: unknown }): boolean {
  return Boolean(reply.proposedActions);
}

/**
 * 取り直した会話の返答の提案に、会話の GET が「実行する」を出すとしたか (proposedActionExecutable が true。#2227 H1)。
 * GET は提案の記録の行が実行を待つ (pending) ときだけ true にする (src/lib/ai/consultation-action-lifecycle.ts の
 * proposedActionViewOf)。記録の直読みだけが失敗したときに、GET が読んだ行の状態として使う
 */
export function replyProposalExecutableOf(reply: { proposedActionExecutable?: unknown }): boolean {
  return reply.proposedActionExecutable === true;
}

/** 返答の提案の記録を読んだ結果 (Web とモバイルの読み取りが返す。#2206 G2) */
export type PreviousRequestActionRead = {
  /** 記録の行から決めた状態 (previousRequestActionStateOf。読めなかったときは none) */
  state: PreviousRequestActionState;
  /** 記録を読めなかったか (行が無いのと分ける) */
  readFailed: boolean;
};

/** 取り直した返答に、前の依頼の一文をどう出すか (previousRequestNotePlanOf の結果) */
export type PreviousRequestNotePlan = {
  /** 返答の提案の状態。記録の行が無い・読めないのに返答に提案があるときは running (Web はこの状態で提案のカードを決める) */
  state: PreviousRequestActionState;
  /** 返答のすぐ後に足す一文の状態 (足さないときは null) */
  noteState: PreviousRequestNoteState | null;
  /** データを出す画面に知らせるか (実行できたとき) */
  notifyDataChanged: boolean;
  /** PREVIOUS_REQUEST_RECHECK_DELAY_MS 待ってから記録を 1 回だけ読み直すか (結果は previousRequestRecheckPlanOf で当てる) */
  recheck: boolean;
};

/**
 * 取り直した返答 (送った文への返答) の提案の記録を読んだ結果から、足す一文・知らせるか・読み直すかを決める
 * (Web の AIChatBubble とモバイルの AIAdvisorSheet が共有する。画面はこの結果を描くだけにする。#2206 G2)。
 *   - 記録の行が無い・読めないのに返答に提案がある (replyHasProposal): 実行中の印 (running) と同じく扱う。
 *     サーバー (messages の route) は返答を保存してから提案の記録の行を作るので、その間 (数十 ms) に取り直しが当たると行がまだ無い。
 *     ここで何も出さないと、あとで自動実行 (献立の生成など) が済んでも一文もデータの取り直しも出ない
 *   - 実行中の印 (running): 結果をまだ確かめられない一文を足し、1 回だけ読み直す
 *   - 実行できた (executed): 実行できた一文を足し、データを出す画面に知らせる
 *   - 実行を待つ・失敗 (notExecuted): 実行していない一文を足す
 *   - 行が無い・断った (none) で提案も無い: 何も足さない。ただし記録を読めなかった (readFailed) ときは、一文を足さずに
 *     1 回だけ読み直す (GET は実行できた提案を出さないので、読めないと実行できたかが分からない)
 *   - 記録の直読みだけが失敗し、会話の GET は「実行する」を出すとした (replyProposalExecutable。GET が読んだ行は実行を待つ
 *     pending): 実行していない (notExecuted) として扱う (#2227 H1。以前は行が無いときと同じく実行中の印として扱い、
 *     提案のカードの「実行する」が隠れた)。自動実行は行を実行中の印で作ってから実行し、終わってから pending に書き戻すので、
 *     GET が pending を読んだのなら自動実行は終わっている
 */
export function previousRequestNotePlanOf(input: {
  actionState: PreviousRequestActionState;
  readFailed: boolean;
  replyHasProposal: boolean;
  replyProposalExecutable: boolean;
}): PreviousRequestNotePlan {
  const state: PreviousRequestActionState =
    input.actionState === 'none' && input.replyHasProposal
      ? input.readFailed && input.replyProposalExecutable
        ? 'notExecuted'
        : 'running'
      : input.actionState;
  if (state === 'none') return { state, noteState: null, notifyDataChanged: false, recheck: input.readFailed };
  return { state, noteState: state, notifyDataChanged: state === 'executed', recheck: state === 'running' };
}

/** 読み直しで実行中の一文を置き換える状態 (実行中の印のままなら置き換えない) */
export type PreviousRequestSettledNoteState = Exclude<PreviousRequestNoteState, 'running'>;

/** 1 回の読み直しの結果をどう当てるか (previousRequestRecheckPlanOf の結果) */
export type PreviousRequestRecheckPlan = {
  /** 実行中の一文を置き換える一文の状態 (何もしないときは null) */
  noteState: PreviousRequestSettledNoteState | null;
  /** 実行中の一文が無いとき (記録を読めずに一文を出さなかったとき)、返答のすぐ後に一文を足すか */
  addNoteIfMissing: boolean;
  /** データを出す画面に知らせるか */
  notifyDataChanged: boolean;
};

/**
 * 前の依頼の記録を 1 回読み直した結果 (read) から、一文をどうするかを決める (Web とモバイルで共有する。#2201 U3・#2206 G2)。
 * replyHasProposal は、取り直したときの会話の GET で返答に提案があったか (replyHasProposalOf)。
 *   - 実行できた: 実行中の一文を『前の依頼は実行されました』に置き換える。一文が無ければ (記録を読めずに一文を出さなかった)
 *     返答のすぐ後に足す。データを出す画面に知らせる
 *   - 実行を待つ・失敗: 実行中の一文を『前の依頼は実行できませんでした』に置き換える (一文が無ければ足さない)
 *   - 読めたのに行がまだ無く、返答に提案がある: 実行を待つ・失敗と同じく扱う (#2227 H1)。サーバーは返答を保存してから数十 ms で
 *     行を作り、作れなかったら実行しない (messages の route の executeAndFinalizeAction)。読み直しの待ち
 *     (PREVIOUS_REQUEST_RECHECK_DELAY_MS) の後にも行が無いのは、行を作れずに実行しなかったとき。以前は『結果をまだ確かめられません』の
 *     ままで、開き直すと GET は『もう一度 AI に頼んでください』のカードになった
 *   - まだ実行中の印のまま・行が無い (提案も無い)・読めない: 何もしない (一文はそのまま。頼み直しを勧めない。読み直しは 1 回だけ)
 */
export function previousRequestRecheckPlanOf(
  read: PreviousRequestActionRead,
  replyHasProposal: boolean,
): PreviousRequestRecheckPlan {
  const state: PreviousRequestActionState =
    read.state === 'none' && !read.readFailed && replyHasProposal ? 'notExecuted' : read.state;
  if (state === 'executed') return { noteState: 'executed', addNoteIfMissing: true, notifyDataChanged: true };
  if (state === 'notExecuted') return { noteState: 'notExecuted', addNoteIfMissing: false, notifyDataChanged: false };
  return { noteState: null, addNoteIfMissing: false, notifyDataChanged: false };
}

/**
 * 読み直しの結果 (plan) を、画面のメッセージの一覧に当てる (Web とモバイルで共有する。#2206 G2)。
 *   - 実行中の一文 (previousRequestNoteIdOf('running', replyId)) があれば、plan.noteState の一文 (noteOf) に置き換える
 *   - 無ければ、plan.addNoteIfMissing のときだけ返答 (replyId) のすぐ後に足す (同じ一文がすでにあれば足さない)
 *   - 一文を置き換える・足すときは、返答に updateReply を当てる (Web の提案のカード。モバイルは渡さない)
 * 何も変えないとき (plan.noteState が null・実行中の一文も足す先の返答も無い) は、渡された一覧をそのまま返す
 * (別の相談に切り替えていれば、一文も返答も今の会話に無いので触らない)
 */
export function messagesAfterPreviousRequestRecheck<T extends { id: string }>(
  messages: T[],
  params: {
    replyId: string;
    plan: PreviousRequestRecheckPlan;
    noteOf: (state: PreviousRequestSettledNoteState) => T;
    updateReply?: (reply: T) => T;
  },
): T[] {
  const { replyId, plan, noteOf, updateReply } = params;
  if (plan.noteState === null) return messages;
  const runningNoteId = previousRequestNoteIdOf('running', replyId);
  const hasRunningNote = messages.some((m) => m.id === runningNoteId);
  if (!hasRunningNote && !(plan.addNoteIfMissing && messages.some((m) => m.id === replyId))) return messages;
  const note = noteOf(plan.noteState);
  const hasNote = hasRunningNote || messages.some((m) => m.id === note.id);
  return messages.flatMap((m) => {
    if (m.id === runningNoteId) return [note];
    if (m.id !== replyId) return [m];
    const reply = updateReply ? updateReply(m) : m;
    return hasNote ? [reply] : [reply, note];
  });
}
