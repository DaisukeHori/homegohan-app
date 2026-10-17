/**
 * sendEmail (send.ts) の結果の型と、結果を見るための小さな関数。#1193
 *
 * Resend やロガーを読み込まない純粋なモジュール。send.ts とは別ファイルにしてあるのは、呼び出し側のテストが
 * `vi.mock('@/lib/emails/send', () => ({ sendEmail: ... }))` で送信そのものを差し替えても、
 * ここにある関数は実物のまま使えるようにするため。
 */

/**
 * sendEmail が送れなかったときの理由。結果の error に入り、ログにも渡される。
 * message に宛先のメールアドレスは含めない (Resend のエラー文に含まれていた場合もマスクする)。
 */
export class EmailSendError extends Error {
  constructor(
    /**
     * 失敗のコード。sendEmail の結果に出るのは invalid_envelope (内容の不備) / not_configured (RESEND_API_KEY が無い) /
     * suppressed (宛先停止リスト email_blacklist に載っている宛先なので送らなかった。#1184) /
     * outbox_failed (送信待ち email_outbox への登録の失敗。#1193)。
     * sendEmail は Resend を呼ばない (送るのは worker) ので、Resend のエラーコード (rate_limit_exceeded / validation_error /
     * invalid_api_key など)・network_error・invalid_response は、worker が email_outbox.last_error_code に入れる
     */
    public readonly code: string,
    message: string,
    /** Resend が返した HTTP ステータス。Resend に届かなかった (通信エラー・送らなかった) ときは null */
    public readonly statusCode: number | null,
    /** sendEmail の中で Resend へ送った回数 (常に 0。送るのは worker: docs/design/operator/10-logs-and-mail-retry.md §6) */
    public readonly attempts: number,
    /** 再試行で直る見込みのある種類の失敗か (送信待ちへの登録の失敗 outbox_failed は true) */
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/** 送信待ち (email_outbox) に登録した (送るのは worker。届いたかどうかは含まない) */
export interface SendEmailSent {
  ok: true;
  /** email_outbox.id (受け付けの ID) */
  id: string;
  /** sendEmail の中で Resend へ送った回数 (常に 0。送るのは worker) */
  attempts: number;
  skipped: false;
  error: null;
}

/** RESEND_API_KEY が無く、送らなかった (開発・テスト環境、または本番の設定漏れ)。error.code は 'not_configured' */
export interface SendEmailSkipped {
  ok: false;
  id: null;
  attempts: 0;
  skipped: true;
  error: EmailSendError;
}

/**
 * 送ろうとしたが、送れなかった (送信待ちに登録できなかった = error.code 'outbox_failed'、または文面の不備、
 * または宛先停止リストに載っている宛先 = error.code 'suppressed')
 */
export interface SendEmailFailed {
  ok: false;
  id: null;
  attempts: number;
  skipped: false;
  error: EmailSendError;
}

export type SendEmailResult = SendEmailSent | SendEmailSkipped | SendEmailFailed;

/**
 * 送れなかった結果か。RESEND_API_KEY が無くて送らなかった (skipped) 結果は、失敗には数えない。
 * 失敗のときだけ追加のログや処理をする呼び出し側が使う。
 * 失敗の記録 (app_logs) は sendEmail が済ませているので、呼び出し側は戻り値を見なくてもよい。
 */
export function isEmailFailure(result: SendEmailResult): result is SendEmailFailed {
  return result?.ok === false && result.skipped !== true;
}

/**
 * Promise.allSettled([sendEmail(...), ...]) の結果から、送れなかったものの理由を取り出す。
 * reject された (想定外の例外) ものと、ok: false の結果 (skipped は除く) の error の両方を数える。
 * 理由は log.error(message, reasons[0], { failed_count: reasons.length }) のように、ログへそのまま渡せる。
 */
export function emailFailureReasons(settled: ReadonlyArray<PromiseSettledResult<SendEmailResult>>): unknown[] {
  const reasons: unknown[] = [];
  for (const entry of settled) {
    if (entry.status === 'rejected') reasons.push(entry.reason);
    else if (isEmailFailure(entry.value)) reasons.push(entry.value.error);
  }
  return reasons;
}

/**
 * 宛先停止リスト (email_blacklist) に載っている宛先なので送らなかったときの error.code (#1184)。
 * sendEmail が返す値は src/lib/emails/outbox.ts の EMAIL_OUTBOX_ERROR_CODES.suppressed (このファイルは Resend を読み込む outbox.ts を
 * import しないので、同じ値をここにも置く。食い違わないことは src/__tests__/lib/emails/send-result.test.ts が見る)
 */
export const EMAIL_SUPPRESSED_ERROR_CODE = 'suppressed';

/** 送れなかった理由が、宛先停止リストで止めた (意図した停止) ものか。sendEmail の結果の error (EmailSendError) で code が suppressed のときだけ真 */
export function isEmailSuppressedReason(reason: unknown): boolean {
  return reason instanceof EmailSendError && reason.code === EMAIL_SUPPRESSED_ERROR_CODE;
}

/** 送れなかった理由を残すログの出力先 (createLogger(...)・その withUser(...)・通知の部品が受け取るロガーのどれも満たす) */
export interface EmailFailureLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: unknown, metadata?: Record<string, unknown>): void;
}

/**
 * 送れなかった理由 (sendEmail の結果の error・想定外の例外) をログに残す。#1577 の 7
 * - 理由がすべて宛先停止リスト (suppressed) なら warn。止めた宛先へ送らないのは意図した動きで、error にすると
 *   エラー急増の通知 (GET /api/cron/app-log-alerts が app_logs の error を数える) の数に入るため。
 *   warn は error を受け取らないので、metadata に error_code (suppressed) を入れる
 * - ほかの理由が 1 つでもあれば、今までどおり error。渡す error は、suppressed でない最初の理由
 * reasons が空なら何も残さない。
 */
export function logEmailFailures(
  log: EmailFailureLogger,
  message: string,
  reasons: readonly unknown[],
  metadata: Record<string, unknown> = {},
): void {
  if (reasons.length === 0) return;
  const unexpectedIndex = reasons.findIndex((reason) => !isEmailSuppressedReason(reason));
  if (unexpectedIndex < 0) {
    log.warn(message, { ...metadata, error_code: EMAIL_SUPPRESSED_ERROR_CODE });
    return;
  }
  log.error(message, reasons[unexpectedIndex], metadata);
}
