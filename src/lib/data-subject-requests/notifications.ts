/**
 * #1178 個人情報の請求 (DSR) のメール。サーバー専用。sendEmail を呼ぶのはこのファイルだけ (設計 cross/15 §6・§10)。
 *
 * - すべて best-effort: 4 関数とも Promise<void> を resolve し、reject しない (例外を投げない)。送れなくても請求の操作は成功のまま。
 * - 宛先: 本人向け 3 通 (本人確認・受付・完了) は auth.users の登録アドレスを service_role の getUserById で引き、メモリ上だけで使う。
 *   運営向け 1 通は getOptionalEnv('ADMIN_NOTIFICATION_EMAIL')。利用者は宛先を指定できない。
 * - 分岐:
 *   - 本人向け: row.user_id が NULL (退会済み) → 送らず info ログ (getUserById を呼ばない)
 *   - 本人向け: getUserById が error を返す・email が無い・例外 → 送らず warn ログ
 *   - 運営向け: ADMIN_NOTIFICATION_EMAIL が未設定 → 送らず warn ログ
 *   - sendEmail が { ok: false } (skipped を含む) → warn ログ / sendEmail が例外 → catch して warn ログ
 * - ログに宛先のアドレスを入れない (請求の id と template 名と、エラーのコードだけ)。
 * - 送信回数の制限 (invite-throttle) を通さない理由は tests/email-send-throttle-contract.test.ts の EXEMPT_EMAIL_SENDERS。
 */
import { getOptionalEnv } from '@/lib/env';
import { sendEmail } from '@/lib/emails/send';
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { renderDsrVerificationEmail } from '@/lib/emails/dsr/verification';
import { renderDsrReceivedEmail } from '@/lib/emails/dsr/received';
import { renderDsrOperatorNoticeEmail } from '@/lib/emails/dsr/operator-notice';
import { renderDsrResolvedEmail } from '@/lib/emails/dsr/resolved';
import {
  DSR_ADMIN_PATH,
  DSR_SETTINGS_PATH,
  buildDsrVerifyUrl,
  type DsrNotificationRow,
} from '@/lib/data-subject-requests/core';
import type { DsrAdminClient, DsrLogger } from '@/lib/data-subject-requests/service';

/** 文面の名前 (ログ用。各 render*Email の template と同じ) */
export const DSR_EMAIL_TEMPLATES = {
  verification: 'dsr_verification',
  received: 'dsr_received',
  operatorNotice: 'dsr_operator_notice',
  resolved: 'dsr_resolved',
} as const;
type DsrEmailTemplate = (typeof DSR_EMAIL_TEMPLATES)[keyof typeof DSR_EMAIL_TEMPLATES];

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

function logMetadata(row: DsrNotificationRow, template: DsrEmailTemplate): Record<string, unknown> {
  return { dsr_request_id: row.id, template };
}

/**
 * 本人の登録アドレスを引く。送れない (退会済み・引けない・アドレスが無い) ときは null を返し、理由をログに残す。例外は投げない
 */
async function resolveRequesterEmail(
  admin: DsrAdminClient,
  row: DsrNotificationRow,
  template: DsrEmailTemplate,
  log: DsrLogger,
): Promise<string | null> {
  const metadata = logMetadata(row, template);
  if (!row.user_id) {
    log.info('dsr email: the requester has deleted the account; the email is not sent', metadata);
    return null;
  }
  try {
    const { data, error } = await admin.auth.admin.getUserById(row.user_id);
    if (error) {
      log.warn('dsr email: could not read the requester email address; the email is not sent', {
        ...metadata,
        ...errorHints(error),
      });
      return null;
    }
    const email = data?.user?.email;
    if (typeof email !== 'string' || email.trim() === '') {
      log.warn('dsr email: the requester has no email address; the email is not sent', metadata);
      return null;
    }
    return email;
  } catch (error) {
    log.warn('dsr email: reading the requester email address threw; the email is not sent', {
      ...metadata,
      ...errorHints(error),
    });
    return null;
  }
}

/**
 * 文面を組み立てて 1 通を送る。失敗 (skipped を含む) と例外 (組み立て・送信のどちらでも) は warn ログにだけ残す。例外は投げない
 */
async function renderAndDeliver(
  render: () => EmailEnvelope,
  row: DsrNotificationRow,
  template: DsrEmailTemplate,
  log: DsrLogger,
): Promise<void> {
  const metadata = logMetadata(row, template);
  try {
    const sent = await sendEmail(render());
    if (!sent.ok) {
      log.warn('dsr email: the email could not be sent', {
        ...metadata,
        error_code: sent.error.code,
        skipped: sent.skipped,
        attempts: sent.attempts,
      });
    }
  } catch (error) {
    log.warn('dsr email: building or sending the email threw', { ...metadata, ...errorHints(error) });
  }
}

/** 本人確認のお願い (作成・再送のとき)。token は生のトークン (メールにだけ入れる) */
export async function sendDsrVerificationEmail(
  admin: DsrAdminClient,
  row: DsrNotificationRow,
  token: string,
  siteUrl: string,
  log: DsrLogger,
): Promise<void> {
  const template = DSR_EMAIL_TEMPLATES.verification;
  const to = await resolveRequesterEmail(admin, row, template, log);
  if (!to) return;
  await renderAndDeliver(
    () =>
      renderDsrVerificationEmail({
        to_email: to,
        request_type: row.request_type,
        request_id: row.id,
        verify_url: buildDsrVerifyUrl(siteUrl, row.id, token),
      }),
    row,
    template,
    log,
  );
}

/** 受け付けました (本人確認が済んだとき) */
export async function sendDsrReceivedEmail(
  admin: DsrAdminClient,
  row: DsrNotificationRow,
  siteUrl: string,
  log: DsrLogger,
): Promise<void> {
  const template = DSR_EMAIL_TEMPLATES.received;
  const to = await resolveRequesterEmail(admin, row, template, log);
  if (!to) return;
  await renderAndDeliver(
    () =>
      renderDsrReceivedEmail({
        to_email: to,
        request_type: row.request_type,
        request_id: row.id,
        due_at: row.due_at,
        settings_url: `${siteUrl}${DSR_SETTINGS_PATH}`,
      }),
    row,
    template,
    log,
  );
}

/** 運営への知らせ (本人確認が済んだとき)。宛先は getOptionalEnv('ADMIN_NOTIFICATION_EMAIL')。未設定なら送らず warn ログ */
export async function sendDsrOperatorNotice(
  row: DsrNotificationRow,
  siteUrl: string,
  log: DsrLogger,
): Promise<void> {
  const template = DSR_EMAIL_TEMPLATES.operatorNotice;
  const operatorAddress = getOptionalEnv('ADMIN_NOTIFICATION_EMAIL');
  if (!operatorAddress) {
    log.warn('dsr email: ADMIN_NOTIFICATION_EMAIL is not set; the operator notice is not sent', logMetadata(row, template));
    return;
  }
  await renderAndDeliver(
    () =>
      renderDsrOperatorNoticeEmail({
        to_email: operatorAddress,
        request_type: row.request_type,
        request_id: row.id,
        due_at: row.due_at,
        admin_url: `${siteUrl}${DSR_ADMIN_PATH}/${row.id}`,
      }),
    row,
    template,
    log,
  );
}

/** 対応が完了しました (運営が fulfilled / rejected にしたとき)。それ以外の状態の行では送らない (warn ログ) */
export async function sendDsrResolvedEmail(
  admin: DsrAdminClient,
  row: DsrNotificationRow,
  siteUrl: string,
  log: DsrLogger,
): Promise<void> {
  const template = DSR_EMAIL_TEMPLATES.resolved;
  const status = row.status;
  if (status !== 'fulfilled' && status !== 'rejected') {
    log.warn('dsr email: the request is not resolved; the resolved email is not sent', {
      ...logMetadata(row, template),
      status,
    });
    return;
  }
  const to = await resolveRequesterEmail(admin, row, template, log);
  if (!to) return;
  await renderAndDeliver(
    () =>
      renderDsrResolvedEmail({
        to_email: to,
        request_type: row.request_type,
        request_id: row.id,
        status,
        settings_url: `${siteUrl}${DSR_SETTINGS_PATH}`,
      }),
    row,
    template,
    log,
  );
}
