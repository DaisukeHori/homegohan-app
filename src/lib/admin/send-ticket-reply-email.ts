/**
 * サポートチケットの顧客向け返信を、顧客本人へメールで知らせる (#1183)
 *
 * - 呼び出し側 (POST /api/admin/support/tickets/[id]/messages) が requireRole で認可を済ませ、
 *   顧客向けメッセージ (is_internal=false) のときだけ呼ぶこと。内部メモでは呼ばない。
 * - 宛先は auth.users のメールアドレス。service_role の auth.admin.getUserById で 1 人分だけ取得する
 *   (listUsers は引数なしだと先頭 50 件しか返さず、51 人目以降を取りこぼすため使わない: #1204)。
 * - 例外は投げない。送れなかった場合も結果 (skipped / failed) で返し、構造化ログ (app_logs) に記録する。
 *   返信メッセージは保存済みなので、通知の失敗で返信そのものを失敗させない。
 * - 送信できたら email_delivery_logs に 1 行残す (service_role で INSERT。実在する列だけを使う)。
 *   skipped / failed は status の CHECK 制約 (sent / delivered / bounced / complained / opened / clicked) に
 *   入れられないため、この表には残さず app_logs にだけ残す。
 */
import { z } from 'zod';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/emails/send';
import { renderTicketReplyEmail } from '@/lib/emails/support/ticket-reply';
import { getSiteUrl } from '@/lib/site-config';
import type { ReplyEmailOutcome } from '@/lib/admin/support-reply-email-status';

/** email_delivery_logs.template に入れる値 */
export const TICKET_REPLY_EMAIL_TEMPLATE = 'support_ticket_reply';

/** createLogger(...).withUser(userId) が返すロガーのうち、ここで使う分 */
export interface ReplyEmailLogger {
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, error?: unknown, metadata?: Record<string, unknown>) => void;
}

export interface SendTicketReplyEmailParams {
  ticket: { id: string; user_id: string; subject: string };
  /** 今回投稿した顧客向けメッセージの ID と本文 (過去のメッセージや内部メモは読まない) */
  messageId: string;
  messageBody: string;
  logger: ReplyEmailLogger;
}

const replyToSchema = z.string().email();

/** SUPPORT_REPLY_TO (任意)。未設定、または不正な値なら undefined (noreply のまま送る) */
function resolveReplyTo(logger: ReplyEmailLogger): string | undefined {
  const raw = process.env.SUPPORT_REPLY_TO?.trim();
  if (!raw) return undefined;
  if (!replyToSchema.safeParse(raw).success) {
    // 任意設定の誤りで顧客への通知を止めない。noreply のまま送り、本文でお問い合わせフォームへ誘導する
    logger.warn('SUPPORT_REPLY_TO is not a valid email address, ignoring it');
    return undefined;
  }
  return raw;
}

/** sendEmail は RESEND_API_KEY が無いと送らずに { skipped: true } を返す */
function isSkippedSend(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { skipped?: unknown }).skipped === true;
}

async function deliverTicketReplyEmail(params: SendTicketReplyEmailParams): Promise<ReplyEmailOutcome> {
  const { ticket, messageId, messageBody, logger } = params;
  const logMeta = { ticket_id: ticket.id, message_id: messageId };

  // 1) 宛先 (顧客本人のメールアドレス) を auth.users から取得する
  let admin: ReturnType<typeof getSupabaseAdmin>;
  let recipient: string | undefined;
  try {
    admin = getSupabaseAdmin();
    const { data, error } = await admin.auth.admin.getUserById(ticket.user_id);
    if (error) throw error;
    recipient = data.user?.email || undefined;
  } catch (err) {
    logger.error('support ticket reply email: recipient lookup failed', err, logMeta);
    return { status: 'failed', reason: 'no_recipient' };
  }
  if (!recipient) {
    logger.warn('support ticket reply email: customer has no email address', logMeta);
    return { status: 'failed', reason: 'no_recipient' };
  }

  // 2) 文面を組み立てて送る
  let resendMessageId: string;
  try {
    const result = await sendEmail(
      renderTicketReplyEmail({
        to_email: recipient,
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        reply_body: messageBody,
        contact_url: `${getSiteUrl()}/contact`,
        reply_to: resolveReplyTo(logger),
      }),
    );
    if (isSkippedSend(result)) {
      logger.warn('support ticket reply email skipped: email sending is not configured', logMeta);
      return { status: 'skipped', reason: 'not_configured' };
    }
    resendMessageId = result.id;
  } catch (err) {
    logger.error('support ticket reply email: send failed', err, logMeta);
    return { status: 'failed', reason: 'send_failed' };
  }

  // 3) 送信ログを残す。supabase-js は DB のエラーを例外にせず { error } で返すため、必ず error を確認する
  //    (旧実装は結果を見ておらず、INSERT が失敗してもログすら残らなかった)
  try {
    const { error } = await admin.from('email_delivery_logs').insert({
      user_id: ticket.user_id,
      email: recipient,
      template: TICKET_REPLY_EMAIL_TEMPLATE,
      resend_message_id: resendMessageId,
      status: 'sent',
      metadata: logMeta,
    });
    if (error) throw error;
  } catch (err) {
    // メールは送信済み。ログが残らなかったことだけを記録し、結果は sent のまま返す
    logger.error('support ticket reply email: delivery log insert failed', err, logMeta);
  }

  return { status: 'sent' };
}

export async function sendTicketReplyEmail(params: SendTicketReplyEmailParams): Promise<ReplyEmailOutcome> {
  try {
    return await deliverTicketReplyEmail(params);
  } catch (err) {
    // ここに来るのは想定外の例外だけ。返信メッセージは保存済みなので失敗させない
    params.logger.error('support ticket reply email: unexpected error', err, {
      ticket_id: params.ticket.id,
      message_id: params.messageId,
    });
    return { status: 'failed', reason: 'send_failed' };
  }
}
