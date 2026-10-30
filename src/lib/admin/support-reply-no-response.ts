// src/lib/admin/support-reply-no-response.ts
// 問い合わせの詳細 (src/app/admin/support/[id]/page.tsx) で、返信・内部メモの送信の応答を受け取れなかったときに、
// チケットを読み直して送れていたかを決める (#2093 W1)。
//
// 返信の route (POST /api/admin/support/tickets/[id]/messages) は、行を insert したあと顧客へのメールの送信を待ってから応答する。
// その間に時間切れ (本文に API の文の無い 502 / 503 / 504) や通信の切断が起きると、返信は保存され、メールも送られていることがある。
// support_ticket_messages には一意の制約が無いので、押し直すと同じ返信が 2 行入り、顧客にメールが 2 通届く (メールは取り消せない)。
// そこで画面は、応答を受け取れなかったら、まずチケットを読み直し、送った返信が届いていれば済んだとして入力欄を空にする。
// まだ無ければ (サーバーが書き込みの途中かもしれない)、送信を止めたまま読み直しで確かめさせる (#2107 Y1)。
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

/** 読み直したメッセージの行のうち、届いていたかの判定に使う項目 */
export interface ReplyMessageRow {
  readonly id: string;
  readonly body: string;
  readonly is_internal: boolean;
}

/** 送った返信 (body は入力欄の値そのまま。route と同じく前後の空白を除いて比べる) */
export interface SentReply {
  readonly body: string;
  readonly isInternal: boolean;
}

/**
 * 読み直したメッセージに、送った返信が届いていたか。
 * 送る前に画面が持っていたメッセージ (knownIds) に無い行で、種類 (外部返信 / 内部メモ) と本文 (route は createMessageSchema の trim の後の本文を保存する)
 * が同じものがあれば届いている。
 * 「送った時刻より後の行」を、ブラウザの時計ではなく送る前に無かった行で決める (ブラウザとサーバーの時計がずれていても、届いた返信を見落とさない)
 */
export function isReplyDelivered(
  messages: readonly ReplyMessageRow[],
  knownIds: ReadonlySet<string>,
  sent: SentReply,
): boolean {
  const body = sent.body.trim();
  return messages.some((message) => !knownIds.has(message.id) && message.is_internal === sent.isInternal && message.body === body);
}

/**
 * 返信が済んだ (応答で・読み直しで) ときに、入力欄が送った本文のままか。送った本文のままなら入力欄を空にし、
 * 送信の応答を待つあいだに書き足した文は消さない (#2107 Y7)。
 * route は前後の空白を除いた本文を保存するので、前後の空白・改行だけの違いは書き足しと見なさない。
 * 送れた (201) 経路と読み直しの経路の両方がこの関数で比べる (経路によって比べ方がずれると、
 * 空白だけを書き足したときに送った本文が入力欄に残り、押し直すと顧客に同じ返信のメールが 2 通届きうる。#2120 W4)
 */
export function isReplyInputAsSent(current: string, sentBody: string): boolean {
  return current.trim() === sentBody.trim();
}

/** 読み直したら届いていたときに続ける文 */
export const REPLY_DELIVERED_GUIDE = '読み込み直したところ、送った内容は保存されていました';

/** 外部返信が届いていたときに添える文 (route は保存のあとにメールを送るので、応答が切れたときはメールが届いたかは分からない) */
export const REPLY_DELIVERED_EMAIL_UNKNOWN_GUIDE = 'お客様へのメールの通知が届いたかは分かりません';

/**
 * 読み直しても送った返信がまだ無かったときに続ける文 (#2107 Y1)。
 * 行がまだ無いことは送られていないことの確かめにならない (route は insert のあとメールを送ってから応答するので、サーバーが書き込みの途中なら、
 * 押し直すと同じ返信が 2 行入り、顧客にメールが 2 通届く。#2101 X2 の admin-create-no-response.ts の not-found と同じ考え方)。
 * そこで押し直しを促さない。画面は送信を止めたまま「再試行」(読み直し) を出す
 */
export const REPLY_NOT_DELIVERED_GUIDE =
  '読み込み直したところ、送った内容はまだ見つかりません。サーバーが書き込みの途中かもしれないので、少し待って確かめ直してください';

/** 送信を止めたときに、押し直す道を言う文 (チケットを開き直すと、メッセージを読み直したうえで送れる。#2107 Y1) */
export const REPLY_REOPEN_TO_RETRY_GUIDE = 'もう一度送るときは、チケットを開き直してください';

/** 読み直しにも失敗したときに続ける文。画面は送信を止め、「再試行」でチケットを読み直して確かめるまで送らせない */
export const REPLY_RELOAD_FAILED_GUIDE =
  'チケットも読み込めなかったため、送られたか分かりません。「再試行」で読み込み直して確かめるまで、もう一度は送れません';

/**
 * 読み直しが、読み込み直しても変わらない理由 (401 ログインが切れた・403 権限が外れた・404 チケットが消えた) で断られたときに続ける文 (#2101 X3)。
 * このあとに理由の文 (「ログインし直してください」など) を続ける。画面は送信を止めたまま、「再試行」は出さない (押しても必ず断られるため)
 */
export const REPLY_RELOAD_UNAVAILABLE_GUIDE = 'チケットも読み込めなかったため、送られたか分かりません';

/** 応答を受け取れなかったときの文の頭 (summary) と、読み直しの結果に合わせた続きの文をつなぐ */
export function replyNoResponseMessage(summary: string, ...guides: readonly string[]): string {
  return [summary, ...guides].join('。');
}
