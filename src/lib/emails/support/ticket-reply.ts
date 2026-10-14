// src/lib/emails/support/ticket-reply.ts
// #1183: サポートチケットへの返信を顧客へ知らせるメール。
// 顧客向けのメッセージ (is_internal=false) の本文だけを載せる。
// 内部メモ (is_internal=true) は顧客に見せないため、この関数には渡さない (呼び出し側で除外する)。
// 顧客がチケットを閲覧できる画面は無く、このメールが唯一の通知経路なので、返信の全文を本文に入れる。
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom } from '@/lib/site-config';

export interface TicketReplyEmailVars {
  to_email: string; // 宛先 (チケットの顧客本人)
  ticket_id: string; // チケット ID (先頭 8 桁を受付番号として表示する)
  ticket_subject: string; // チケットの件名
  reply_body: string; // 顧客向けメッセージの本文 (内部メモは渡さない)
  contact_url: string; // お問い合わせフォームの絶対 URL
  reply_to?: string | null; // 返信先 (SUPPORT_REPLY_TO)。未指定なら noreply のまま、お問い合わせフォームへ誘導する
}

// EmailEnvelopeSchema の subject 上限
const SUBJECT_MAX_LENGTH = 100;

/** 管理画面 (チケット詳細) の表示と同じ、先頭 8 桁の受付番号 */
export function shortTicketId(ticketId: string): string {
  return ticketId.slice(0, 8);
}

/** 改行・連続する空白を 1 つの空白にして、1 行にそろえる */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** UTF-16 の長さで max 以内に収める。絵文字などのサロゲートペアは途中で切らない */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break; // 末尾の「…」の分を空ける
    out += ch;
  }
  return `${out}…`;
}

/**
 * 件名は 100 字以内 (EmailEnvelopeSchema)。チケットの件名は 200 字まで入るため、長い場合は切り詰める。
 * 受付番号は必ず残す。
 */
export function buildTicketReplySubject(ticketId: string, ticketSubject: string): string {
  const prefix = '【ほめゴハン】サポートからのご返信';
  const suffix = ` (#${shortTicketId(ticketId)})`;
  const title = toSingleLine(ticketSubject);
  if (!title) return `${prefix}${suffix}`;

  const room = SUBJECT_MAX_LENGTH - prefix.length - suffix.length - 2; // 「」の分
  return `${prefix}「${truncate(title, room)}」${suffix}`;
}

export function renderTicketReplyEmail(vars: TicketReplyEmailVars): EmailEnvelope {
  const title = toSingleLine(vars.ticket_subject) || '(件名なし)';
  const replyGuide = vars.reply_to
    ? `このメールにそのまま返信していただくと、サポート窓口に届きます。
お問い合わせフォームからもご連絡いただけます。`
    : `このメールの送信元アドレスは送信専用のため、返信しても届きません。
ご不明な点や追加のご連絡は、お問い合わせフォームからお願いします。`;

  return {
    template: 'support_ticket_reply',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: buildTicketReplySubject(vars.ticket_id, vars.ticket_subject),
    ...(vars.reply_to ? { reply_to: vars.reply_to } : {}),
    text: `いつもほめゴハンをご利用いただきありがとうございます。
サポート窓口です。

下記の件について、担当者からご連絡があります。

件名: ${title}
受付番号: #${shortTicketId(vars.ticket_id)}

▼ 担当者からのメッセージ
${vars.reply_body.trim()}

▼ ご不明な点・追加のご連絡
${replyGuide}
${vars.contact_url}

${emailSignature()}
`,
  };
}
