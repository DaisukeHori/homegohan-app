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
