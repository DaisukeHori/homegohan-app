/**
 * 凍結の通知メールの結果 (#2026。docs/design/cross/24-freeze-notify-mail.md §7.3)
 *
 * POST /api/admin/users/[id]/freeze が応答の data.notification に載せ、監査 admin.user.ban の details.notification にも同じ status / reason を残し、
 * 凍結の画面 (src/components/admin/UserFreezeForm.tsx) が「済み」の文に添える。
 * クライアントコンポーネントからも import されるため、サーバー専用のモジュール (supabase/server・db-logger・emails/send など) は import しないこと。
 * 形は #1183 のサポートの返信メールの結果 (src/lib/admin/support-reply-email-status.ts) と同じで、not_requested (チェックを外した) を足したもの。
 */

/**
 * sent は送信待ち (email_outbox) に受け付けた (届いたかどうかは含まない。送るのは worker: #1193)。
 * skipped はメール送信の設定が無く登録していない。failed は登録の時点で分かる失敗。not_requested は notify_user が false で送らなかった
 */
export type FreezeNotificationStatus = 'sent' | 'skipped' | 'failed' | 'not_requested';

export type FreezeNotificationReason =
  /** メール送信の設定 (RESEND_API_KEY) が無く、送信を試みていない */
  | 'not_configured'
  /** 凍結した本人のメールアドレスを取得できなかった (登録アドレスが無い・auth.users を引けなかった) */
  | 'no_recipient'
  /**
   * 送信待ちに登録できなかった、または宛先停止リスト・文面の不備で送らなかった
   * (登録したあとの送信の失敗はここには出ない。worker の再試行・dead の通知・/super-admin/email-outbox の再送で扱う)
   */
  | 'send_failed';

export interface FreezeNotificationOutcome {
  status: FreezeNotificationStatus;
  /** status が sent / not_requested 以外のときの理由 */
  reason?: FreezeNotificationReason;
}

/** notify_user が false のときの結果 (route がそのまま応答に載せる) */
export const FREEZE_NOTIFICATION_NOT_REQUESTED: FreezeNotificationOutcome = { status: 'not_requested' };

const STATUSES: ReadonlySet<string> = new Set<FreezeNotificationStatus>(['sent', 'skipped', 'failed', 'not_requested']);
const REASONS: ReadonlySet<string> = new Set<FreezeNotificationReason>(['not_configured', 'no_recipient', 'send_failed']);

/** 送れなかった理由ごとの、画面に出す文 (凍結そのものは済んでいることを必ず添える) */
const NOT_SENT_MESSAGES: Record<FreezeNotificationReason, string> = {
  not_configured: 'メール未送信: メール送信の設定が未完了のため、利用者には通知されていません。凍結は済んでいます',
  no_recipient: 'メール未送信: 利用者のメールアドレスを取得できなかったため、通知されていません。凍結は済んでいます',
  send_failed: 'メール未送信: メールの送信に失敗しました。凍結は済んでいますが、利用者には通知されていません',
};

/** 送った・送らなかったときの文 */
export const FREEZE_NOTIFICATION_SENT_MESSAGE = '通知メールを送信待ちに登録しました (届くまで数分かかることがあります)';
export const FREEZE_NOTIFICATION_NOT_REQUESTED_MESSAGE = '通知メールは送っていません';
/** 応答に結果が無い・読めないときの文 (古い API との食い違いなど) */
export const FREEZE_NOTIFICATION_UNKNOWN_MESSAGE = '通知メールの結果を確認できませんでした (利用者の詳細の監査ログで確認してください)';

/**
 * 応答の data.notification を読む。形が合わなければ null (画面は FREEZE_NOTIFICATION_UNKNOWN_MESSAGE を出す)。
 * status だけを見て、reason は表にある値のときだけ残す
 */
export function freezeNotificationOutcomeOf(value: unknown): FreezeNotificationOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const { status, reason } = value as { status?: unknown; reason?: unknown };
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;
  const outcome: FreezeNotificationOutcome = { status: status as FreezeNotificationStatus };
  if (typeof reason === 'string' && REASONS.has(reason)) outcome.reason = reason as FreezeNotificationReason;
  return outcome;
}

/** 凍結の画面の「済み」の文に添える 1 文。null (読めない) のときは FREEZE_NOTIFICATION_UNKNOWN_MESSAGE */
export function describeFreezeNotificationOutcome(outcome: FreezeNotificationOutcome | null): string {
  if (outcome === null) return FREEZE_NOTIFICATION_UNKNOWN_MESSAGE;
  if (outcome.status === 'sent') return FREEZE_NOTIFICATION_SENT_MESSAGE;
  if (outcome.status === 'not_requested') return FREEZE_NOTIFICATION_NOT_REQUESTED_MESSAGE;
  if (outcome.reason !== undefined) return NOT_SENT_MESSAGES[outcome.reason];
  // 理由が読み取れないときは status から推定する (describeReplyEmailOutcome と同じ)
  return outcome.status === 'skipped' ? NOT_SENT_MESSAGES.not_configured : NOT_SENT_MESSAGES.send_failed;
}
