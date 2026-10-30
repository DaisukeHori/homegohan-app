// src/lib/admin/support-reply-no-response.ts
// 問い合わせの詳細 (src/app/admin/support/[id]/page.tsx) で、返信・内部メモの送信の応答を受け取れなかったときに、
// チケットを読み直して送れていたかを決める (#2093 W1)。
//
// 返信の route (POST /api/admin/support/tickets/[id]/messages) は、行を insert したあと顧客へのメールの送信を待ってから応答する。
// その間に時間切れ (本文に API の文の無い 502 / 503 / 504) や通信の切断が起きると、返信は保存され、メールも送られていることがある。
// support_ticket_messages には一意の制約が無いので、押し直すと同じ返信が 2 行入り、顧客にメールが 2 通届く (メールは取り消せない)。
// そこで画面は、応答を受け取れなかったら、まずチケットを読み直し、送った返信が届いていれば済んだとして入力欄を空にする。
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

/** 読み直したら届いていたときに続ける文 */
export const REPLY_DELIVERED_GUIDE = '読み込み直したところ、送った内容は保存されていました';

/** 外部返信が届いていたときに添える文 (route は保存のあとにメールを送るので、応答が切れたときはメールが届いたかは分からない) */
export const REPLY_DELIVERED_EMAIL_UNKNOWN_GUIDE = 'お客様へのメールの通知が届いたかは分かりません';

/** 読み直したら届いていなかったときに続ける文 */
export const REPLY_NOT_DELIVERED_GUIDE = '読み込み直したところ、まだ送られていません。必要ならもう一度送ってください';

/** 読み直しにも失敗したときに続ける文。画面は送信を止め、「再試行」でチケットを読み直して確かめるまで送らせない */
export const REPLY_RELOAD_FAILED_GUIDE =
  'チケットも読み込めなかったため、送られたか分かりません。「再試行」で読み込み直して確かめるまで、もう一度は送れません';

/** 応答を受け取れなかったときの文の頭 (summary) と、読み直しの結果に合わせた続きの文をつなぐ */
export function replyNoResponseMessage(summary: string, ...guides: readonly string[]): string {
  return [summary, ...guides].join('。');
}
