/**
 * サポートチケットの顧客向け返信メールの送信結果 (#1183)
 *
 * POST /api/admin/support/tickets/[id]/messages が応答の `email` に載せ、
 * 管理画面 (src/app/admin/support/[id]/page.tsx) が「メール未送信」の案内を出すのに使う。
 * クライアントコンポーネントからも import されるため、サーバー専用のモジュール
 * (supabase/server や db-logger など) は import しないこと。
 */

export type ReplyEmailStatus = 'sent' | 'skipped' | 'failed';

export type ReplyEmailReason =
  /** メール送信の設定 (RESEND_API_KEY) が無く、送信を試みていない */
  | 'not_configured'
  /** 顧客のメールアドレスを取得できなかった */
  | 'no_recipient'
  /** メールの送信 (Resend) がエラーになった */
  | 'send_failed';

export interface ReplyEmailOutcome {
  status: ReplyEmailStatus;
  /** status が sent 以外のときの理由 */
  reason?: ReplyEmailReason;
}

const NOT_SENT_MESSAGES: Record<ReplyEmailReason, string> = {
  not_configured:
    'メール未送信: メール送信の設定が未完了のため、お客様には通知されていません。返信メッセージは保存済みです。',
  no_recipient:
    'メール未送信: お客様のメールアドレスを取得できなかったため、通知されていません。返信メッセージは保存済みです。',
  send_failed:
    'メール未送信: メールの送信に失敗しました。返信メッセージは保存済みですが、お客様には通知されていません。',
};

/**
 * 管理画面に出す「メール未送信」の案内文を返す。
 * 送信済み (sent) と、結果が読み取れない場合 (内部メモなど email が無い応答) は null。
 */
export function describeReplyEmailOutcome(outcome: unknown): string | null {
  if (typeof outcome !== 'object' || outcome === null) return null;

  const { status, reason } = outcome as { status?: unknown; reason?: unknown };
  if (status !== 'skipped' && status !== 'failed') return null;

  if (typeof reason === 'string' && Object.prototype.hasOwnProperty.call(NOT_SENT_MESSAGES, reason)) {
    return NOT_SENT_MESSAGES[reason as ReplyEmailReason];
  }
  // 理由が読み取れないときは status から推定する
  return status === 'skipped' ? NOT_SENT_MESSAGES.not_configured : NOT_SENT_MESSAGES.send_failed;
}
