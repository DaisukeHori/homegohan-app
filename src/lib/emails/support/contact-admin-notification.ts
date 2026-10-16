/**
 * お問い合わせが届いたことを運営 (ADMIN_NOTIFICATION_EMAIL) へ知らせるメール (#1193 で src/app/api/contact/route.ts から移した)。
 * 問い合わせた人のメールアドレスは、呼び出し側がマスクした形 (sender_masked) だけを載せる。
 * 退会の伏せ字 (prepare_account_deletion) はアカウントのアドレスでしか送信待ち (email_outbox) の行を引けず、
 * 別の連絡先アドレスで問い合わせた分を伏せられないため (docs/design/operator/10-logs-and-mail-retry.md §6.6)。
 */
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { getEmailFrom } from '@/lib/site-config';

export interface ContactAdminNotificationVars {
  /** 運営の宛先 (ADMIN_NOTIFICATION_EMAIL) */
  to_email: string;
  inquiry_id: string;
  inquiry_type: string;
  /** 問い合わせた人のメールアドレスをマスクしたもの (maskEmailAddress の結果) */
  sender_masked: string;
  subject: string;
  message: string;
  /** サポートの画面のお問い合わせの一覧の絶対 URL */
  inquiries_url: string;
}

/** EmailEnvelopeSchema の subject の上限 (src/lib/emails/envelope.ts) */
const SUBJECT_MAX_LENGTH = 100;
const SUBJECT_PREFIX = '[お問い合わせ] ';
const ELLIPSIS = '…';
const EMPTY_SUBJECT = '(件名なし)';

/** 改行・連続する空白を 1 つの空白にして、1 行にそろえる */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** UTF-16 の長さで max 以内に収める。サロゲートペアは途中で切らない */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - ELLIPSIS.length) break;
    out += ch;
  }
  return `${out}${ELLIPSIS}`;
}

export function renderContactAdminNotificationEmail(vars: ContactAdminNotificationVars): EmailEnvelope {
  const title = toSingleLine(vars.subject) || EMPTY_SUBJECT;
  return {
    template: 'contact_admin_notification',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `${SUBJECT_PREFIX}${truncate(title, SUBJECT_MAX_LENGTH - SUBJECT_PREFIX.length)}`,
    text: [
      '新しいお問い合わせが届きました。',
      '',
      `ID: ${vars.inquiry_id}`,
      `種別: ${vars.inquiry_type}`,
      `送信者: ${vars.sender_masked} (アドレスの全体はサポートの画面で確認してください)`,
      `件名: ${title}`,
      '',
      '--- 内容 ---',
      vars.message,
      '',
      'サポートの画面 (お問い合わせの一覧):',
      vars.inquiries_url,
    ].join('\n'),
  };
}
