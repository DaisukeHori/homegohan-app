/**
 * 凍結の通知メールを、凍結した本人へ送信待ちに積む (#2026。docs/design/cross/24-freeze-notify-mail.md §7.4)
 *
 * - 呼び出し側 (POST /api/admin/users/[id]/freeze) が requireRole で認可を済ませ、凍結の UPDATE が 1 行だったとき、
 *   notify_user が true のときだけ呼ぶこと。403 / 404 / 409 / 500 では呼ばない (凍結されていない人に送らない)。
 * - 宛先は auth.users のメールアドレス。service_role の auth.admin.getUserById で 1 人分だけ取得する
 *   (listUsers は引数なしだと先頭 50 件しか返さず、51 人目以降を取りこぼすため使わない: #1204)。user_profiles に email の列は無い。
 * - 例外は投げない。送れなかった場合も結果 (skipped / failed) で返し、構造化ログ (app_logs) に記録する。
 *   凍結は済んでいるので、通知の失敗で凍結そのものを失敗させない (route は 200 のまま。結果は応答と監査に残る)。
 * - 送信待ち (email_outbox) に登録できたら sent と outbox_id を返す。登録したあとの送信の失敗はここでは分からない
 *   (worker が再試行し、届けられなければ dead の通知と /super-admin/email-outbox で運営が扱う: docs/design/operator/10-logs-and-mail-retry.md §6・§8)。
 * - ログに宛先のメールアドレスを残さない (sendEmail がマスクした宛先で残す)。ここで残すのは ban_id・対象の id・template だけ。
 * - 送信回数の制限 (invite-throttle) を通さない理由 (tests/email-send-throttle-contract.test.ts の EXEMPT_EMAIL_SENDERS):
 *   運営 (admin / super_admin) 専用の route が requireRole を通した後にだけ呼び、宛先は凍結した本人の登録アドレスに固定で、
 *   運営も利用者も宛先を指定できない。1 回の凍結につき 1 通 (Idempotency-Key account-frozen:<ban_id>)。
 */
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/emails/send';
import { isEmailFailure, logEmailFailures, type SendEmailResult } from '@/lib/emails/send-result';
import { ACCOUNT_FROZEN_EMAIL_TEMPLATE, renderAccountFrozenEmail } from '@/lib/emails/account/account-frozen';
import type { FreezeNotificationOutcome } from '@/lib/admin/freeze-notification-status';

/** 文面の template の名前 (email_outbox.template)。文面の側の定数と同じ値 */
export const FREEZE_NOTIFICATION_EMAIL_TEMPLATE = ACCOUNT_FROZEN_EMAIL_TEMPLATE;
/** Resend の Idempotency-Key の接頭辞。1 回の凍結 (ban_id) につき 1 通 (再試行・再送でも同じ鍵) */
export const FREEZE_NOTIFICATION_IDEMPOTENCY_PREFIX = 'account-frozen:';

export function freezeNotificationIdempotencyKey(banId: string): string {
  return `${FREEZE_NOTIFICATION_IDEMPOTENCY_PREFIX}${banId}`;
}

/** createLogger(...).withUser(actorId) が返すロガーのうち、ここで使う分 */
export interface FreezeNotificationLogger {
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, error?: unknown, metadata?: Record<string, unknown>) => void;
}

export interface SendFreezeNotificationEmailParams {
  /** 凍結した本人 (宛先の引き当てと email_outbox.user_id) */
  userId: string;
  /** 監査 admin.user.ban の ban_id。Idempotency-Key に使う */
  banId: string;
  /** user_profiles.frozen_at に書いた日時 */
  frozenAt: Date;
  /** user_profiles.unban_at に書いた日時。永久 BAN は null */
  unbanAt: Date | null;
  /** 運営のメッセージ (Zod が前後の空白を除いたもの)。無ければ null */
  operatorMessage: string | null;
  logger: FreezeNotificationLogger;
}

export interface SendFreezeNotificationEmailResult {
  outcome: FreezeNotificationOutcome;
  /** status が sent のときの email_outbox.id。ほかは null */
  outbox_id: string | null;
}

/** エラーから、ログに残してよい短い手がかり (コード・HTTP ステータス・名前) だけを取り出す。メッセージ本文は含めない */
function errorHints(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return {};
  const { code, status, name } = error as { code?: unknown; status?: unknown; name?: unknown };
  const hints: Record<string, unknown> = {};
  if (typeof code === 'string') hints.error_code = code;
  if (typeof status === 'number') hints.error_status = status;
  if (typeof name === 'string') hints.error_name = name;
  return hints;
}

async function deliverFreezeNotificationEmail(params: SendFreezeNotificationEmailParams): Promise<SendFreezeNotificationEmailResult> {
  const { userId, banId, frozenAt, unbanAt, operatorMessage, logger } = params;
  const logMeta = { ban_id: banId, target_id: userId, template: FREEZE_NOTIFICATION_EMAIL_TEMPLATE };

  // 1) 宛先 (凍結した本人のメールアドレス) を auth.users から取得する
  let recipient: string | undefined;
  try {
    const { data, error } = await getSupabaseAdmin().auth.admin.getUserById(userId);
    if (error) throw error;
    recipient = data.user?.email || undefined;
  } catch (err) {
    logger.error('freeze notification email: recipient lookup failed', err, { ...logMeta, ...errorHints(err) });
    return { outcome: { status: 'failed', reason: 'no_recipient' }, outbox_id: null };
  }
  if (!recipient) {
    logger.warn('freeze notification email: the user has no email address', logMeta);
    return { outcome: { status: 'failed', reason: 'no_recipient' }, outbox_id: null };
  }

  // 2) 文面を組み立てて送信待ちに登録する。sendEmail は失敗で例外を投げず、結果 (ok / skipped / error) で返す
  //    (失敗は sendEmail も app_logs に記録する。ここでは、どの凍結 (ban_id) の通知かが分かる形でも残す)。
  //    userId は退会時の伏せ字と送信待ちの画面の絞り込みに使う (email_outbox.user_id)。
  //    redactAfterSend は渡さない (秘密を含まない文面。送った文面を運営が /super-admin/email-outbox で追えるように残す)
  let result: SendEmailResult;
  try {
    result = await sendEmail(
      renderAccountFrozenEmail({ to_email: recipient, frozen_at: frozenAt, unban_at: unbanAt, operator_message: operatorMessage }),
      { userId, idempotencyKey: freezeNotificationIdempotencyKey(banId) },
    );
  } catch (err) {
    // 文面の組み立てなど、想定外の例外
    logger.error('freeze notification email: send failed', err, { ...logMeta, ...errorHints(err) });
    return { outcome: { status: 'failed', reason: 'send_failed' }, outbox_id: null };
  }
  // RESEND_API_KEY が無く、送らなかった (sendEmail が app_logs に警告を残している)
  if (result.skipped) {
    logger.warn('freeze notification email skipped: email sending is not configured', logMeta);
    return { outcome: { status: 'skipped', reason: 'not_configured' }, outbox_id: null };
  }
  // 封筒の不備・宛先停止リスト・送信待ちへの登録の失敗 (outbox_failed)。
  // 宛先停止リストで止めた (suppressed) ときは意図した動きなのでログは warn、ほかの失敗は error (#1577 の 7)。結果はどちらも failed
  if (isEmailFailure(result)) {
    logEmailFailures(logger, 'freeze notification email: send failed', [result.error], { ...logMeta, error_code: result.error.code });
    return { outcome: { status: 'failed', reason: 'send_failed' }, outbox_id: null };
  }

  // 送信待ちに受け付けた (送るのは worker。届いたかどうかは含まない)
  return { outcome: { status: 'sent' }, outbox_id: result.id };
}

export async function sendFreezeNotificationEmail(params: SendFreezeNotificationEmailParams): Promise<SendFreezeNotificationEmailResult> {
  try {
    return await deliverFreezeNotificationEmail(params);
  } catch (err) {
    // ここに来るのは想定外の例外だけ (ロガーが投げた等)。凍結は済んでいるので失敗させない
    try {
      params.logger.error('freeze notification email: unexpected error', err, { ban_id: params.banId, target_id: params.userId });
    } catch {
      // ログの出力自体の失敗でも、結果は返す
    }
    return { outcome: { status: 'failed', reason: 'send_failed' }, outbox_id: null };
  }
}
