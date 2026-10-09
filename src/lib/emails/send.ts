/**
 * メール送信 (Resend)。サーバー専用。#1193
 *
 * - 戻り値は { ok, id, attempts, error } (型は send-result.ts)。配信の失敗では例外を投げない。
 *   通知メールは招待・譲渡・解散などの本体の操作が済んだあとの best-effort で、メールの失敗で操作を巻き込まないため。
 *   戻り値を見ない呼び出し元でも、失敗は下の「失敗の記録」で必ず app_logs に残る。
 *   戻り値を見る必要があるのは、失敗したときに追加の処理 (送信記録の保存・画面への表示・文脈つきのログなど) をする呼び出し元だけ。
 *   その判定 (isEmailFailure / emailFailureReasons) は send-result.ts にある。
 * - 失敗の記録: createLogger('email') で app_logs に残す。残すのは文面の名前 (template)・マスクした宛先・
 *   Resend のエラーコード・送った回数だけ。宛先のメールアドレス・件名・本文は残さない。
 * - 再試行: 一時的な失敗 (429 / 5xx / 通信エラー) だけ、指数バックオフ (500ms → 1s → 2s) で最大 3 回再試行する。
 *   最初の 1 回と合わせて最大 4 回送る。400 / 401 / 403 / 422 などは何度送っても直らないので再試行しない。
 *   429 でも、送信数の上限 (daily_quota_exceeded / monthly_quota_exceeded) は待っても直らないので再試行しない。
 * - 二重送信の防止: Resend の Idempotency-Key を付ける。再試行では同じキーを使うので、1 回目が実は届いていたのに
 *   応答だけ失われた場合でも、同じメールが 2 通届かない。
 * - RESEND_API_KEY が無いときは送らずに app_logs へ警告を残し、skipped: true を返す (ok は false)。
 *
 * 【規約】利用者が指定したアドレスへメールを送る処理は、このモジュールを呼ぶ前に
 * src/lib/membership/invite-throttle.ts の送信回数制限を通すこと (tests/email-send-throttle-contract.test.ts が検査する)。
 * 再試行は同じ 1 通を送り直すだけで、呼び出し側が数える「試行回数」には含めない。
 */
import { randomUUID } from 'crypto';
import { Resend } from 'resend';
import { createLogger } from '@/lib/db-logger';
import { EmailSendError, type SendEmailResult } from '@/lib/emails/send-result';
import { EmailEnvelopeSchema, type EmailEnvelope } from './envelope';

export type { SendEmailFailed, SendEmailResult, SendEmailSent, SendEmailSkipped } from '@/lib/emails/send-result';

// メールの形 (スキーマ) は envelope.ts に 1 つだけある (#1194)。
// 既存の import 先 (`@/lib/emails/send`) をそのまま使えるように、ここからも再エクスポートする。
export { EmailEnvelopeSchema, type EmailEnvelope };

export interface SendEmailOptions {
  /**
   * Resend の Idempotency-Key。省略すると sendEmail の呼び出しごとに新しく作る (同じ呼び出しの再試行では同じ値を使う)。
   * 別々の呼び出しをまたいで「同じ出来事の通知は 1 通だけ」にしたいときだけ指定する。
   * Resend は同じキーを 24 時間覚え、2 回目以降は送らずに最初の結果を返す。中身が違うと 409 で失敗する。
   */
  idempotencyKey?: string;
}

/** 最初の 1 回に加えて再試行する最大回数 (合計で最大 4 回送る) */
const MAX_RETRIES = 3;
/** 再試行の待ち時間の基準 (ミリ秒)。n 回目の再試行の前に BASE * 2^(n-1) 待つ (500 → 1000 → 2000) */
const RETRY_BASE_DELAY_MS = 500;
/** template が分からないメールのログ上の名前 */
const UNKNOWN_TEMPLATE = 'unknown';

/** 429 でも、待てば直る種類ではないもの (Resend の送信数の上限)。再試行しても同じ結果になる */
const QUOTA_ERROR_CODES: ReadonlySet<string> = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded']);
/** statusCode が数値でないとき (null / 無い) に、名前で再試行の対象と見なすエラー */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'rate_limit_exceeded',
  'internal_server_error',
  'application_error',
  'concurrent_idempotent_requests',
]);

let resendInstance: Resend | null = null;
function getResend(): Resend {
  if (!resendInstance) {
    resendInstance = new Resend(process.env.RESEND_API_KEY ?? 're_dev_placeholder');
  }
  return resendInstance;
}

/**
 * ログに出す宛先のマスク (taro@example.com → t***@example.com)。ドメインは配信先ごとの傾向を調べるために残す。
 * ローカル部が 2 文字以下なら 1 文字目も隠す。メールアドレスの形でなければ *** だけを返す。
 * app_logs のサニタイザ (log-sanitizer) はメールアドレスを [email] に置き換えるが、* を含むこの形には反応しない。
 */
export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return '***';
  const local = [...address.slice(0, at)]; // サロゲートペアの途中で切るとログごと保存に失敗するので、コードポイント単位で扱う
  const domain = address.slice(at + 1);
  return `${local.length >= 3 ? local[0] : ''}***@${domain}`;
}

// 文章の中のメールアドレス。log-sanitizer の規則と同じ形で、量指定子は上限付き
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,4}\.[A-Za-z]{2,24}/g;

/** エラー文に宛先のメールアドレスが含まれていても、そのままログに出さない */
function redactEmailAddresses(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (address) => maskEmailAddress(address));
}

/** ログに出す文面の名前とマスクした宛先。封筒が不正でも (to が無い・文字列でなくても) 例外にならない */
function describeEnvelope(envelope: unknown): { template: string; recipient: string } {
  const { template, to } = (envelope ?? {}) as { template?: unknown; to?: unknown };
  return {
    template: typeof template === 'string' && template ? template.slice(0, 64) : UNKNOWN_TEMPLATE,
    recipient: typeof to === 'string' ? maskEmailAddress(to) : '***',
  };
}

/** Resend の応答のエラー (SDK の ErrorResponse と同じ形。statusCode が無い想定外の形も受ける) */
interface ResendErrorLike {
  name?: string;
  message?: string;
  statusCode?: number | null;
}

/** 再試行すれば直る見込みのある失敗か (429 / 5xx / 通信エラー)。400 / 401 / 403 / 422 などは false */
function isRetryableResendError(error: ResendErrorLike): boolean {
  const code = error.name ?? '';
  if (QUOTA_ERROR_CODES.has(code)) return false;
  const status = error.statusCode;
  // 数値が返っているときはステータスで判断する。409 のうち、同じキーのリクエストが処理中のものだけは待てば直る
  if (typeof status === 'number') {
    return status === 429 || status >= 500 || code === 'concurrent_idempotent_requests';
  }
  // statusCode が null (または無い) のときは名前で判断する。SDK は通信の失敗を application_error / statusCode: null で返す。
  // 同じ statusCode: null でも、SDK が送る前に弾いた入力の不備 (missing_required_field など) は再試行しても直らない
  return RETRYABLE_ERROR_CODES.has(code);
}

interface AttemptFailure {
  code: string;
  message: string;
  statusCode: number | null;
  retryable: boolean;
}
type AttemptOutcome = { ok: true; id: string } | { ok: false; failure: AttemptFailure };

/** Resend へ 1 回送る。応答のエラーも例外も、再試行するかどうかの判断つきの失敗として返す */
async function attemptSend(
  payload: Parameters<Resend['emails']['send']>[0],
  idempotencyKey: string,
): Promise<AttemptOutcome> {
  try {
    const response = await getResend().emails.send(payload, { idempotencyKey });
    if (response.error) {
      const code = response.error.name || 'unknown_error';
      return {
        ok: false,
        failure: {
          code,
          message: response.error.message || code,
          statusCode: response.error.statusCode ?? null,
          retryable: isRetryableResendError(response.error),
        },
      };
    }
    const id = response.data?.id;
    if (!id) {
      // 受け付けたのに ID が無い。何度送り直しても同じなので再試行しない
      return {
        ok: false,
        failure: {
          code: 'invalid_response',
          message: 'Resend の応答にメール ID がありません',
          statusCode: null,
          retryable: false,
        },
      };
    }
    return { ok: true, id };
  } catch (err) {
    // SDK は通信の失敗を例外にせず応答のエラーで返すが、想定外の例外も通信エラーと同じく再試行する
    return {
      ok: false,
      failure: {
        code: 'network_error',
        message: err instanceof Error ? err.message : String(err),
        statusCode: null,
        retryable: true,
      },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendEmail(envelope: EmailEnvelope, options: SendEmailOptions = {}): Promise<SendEmailResult> {
  const logger = createLogger('email');
  const { template, recipient } = describeEnvelope(envelope);

  const parsed = EmailEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    // 文面を作る側のバグ (件名が長すぎる・宛先が不正など)。zod のエラー文は値を含まない (どの項目がなぜ不正かだけ)
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join(', ');
    const error = new EmailSendError('invalid_envelope', `EMAIL_INVALID_ENVELOPE: ${detail}`, null, 0, false);
    logger.error('メールの内容が不正なため、送信しませんでした', error, {
      template,
      recipient,
      error_code: error.code,
      attempts: 0,
    });
    return { ok: false, id: null, attempts: 0, skipped: false, error };
  }
  const v = parsed.data;

  if (!process.env.RESEND_API_KEY) {
    // 本番で設定が漏れていたら、メールが 1 通も出なくなる。console だけでは気づけないので app_logs に残す
    logger.warn('RESEND_API_KEY が未設定のため、メールを送信しませんでした', { template, recipient });
    const error = new EmailSendError(
      'not_configured',
      'EMAIL_NOT_CONFIGURED: RESEND_API_KEY が未設定のため、メールを送信しませんでした',
      null,
      0,
      false,
    );
    return { ok: false, id: null, attempts: 0, skipped: true, error };
  }

  const payload = {
    from: v.from,
    to: v.to,
    subject: v.subject,
    text: v.text,
    html: v.html,
    replyTo: v.reply_to,
  };
  // 再試行でも同じキーを使う。呼び出しごとに別のキーなので、同じ内容のメールを別々に送る正当なケースは止まらない
  const idempotencyKey = options.idempotencyKey ?? randomUUID();

  let attempts = 0;
  let lastFailure: AttemptFailure | null = null;
  for (;;) {
    attempts += 1;
    const outcome = await attemptSend(payload, idempotencyKey);
    if (outcome.ok) {
      if (lastFailure) {
        // 一時的な失敗が再試行で回復した。失敗の記録は残らないが、上流の不調 (429 の多発など) に気づけるよう警告を残す
        logger.warn('メールの送信は再試行で成功しました', {
          template,
          recipient,
          attempts,
          last_error_code: lastFailure.code,
          last_status_code: lastFailure.statusCode,
        });
      }
      return { ok: true, id: outcome.id, attempts, skipped: false, error: null };
    }

    lastFailure = outcome.failure;
    // 直らない種類の失敗、または再試行を使い切った
    if (!lastFailure.retryable || attempts > MAX_RETRIES) break;
    // n 回目の再試行の前に BASE * 2^(n-1) 待つ。待つのは再試行する前だけ (最後の失敗のあとには待たない)
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempts - 1));
  }

  const error = new EmailSendError(
    lastFailure.code,
    `EMAIL_SEND_FAILED: ${redactEmailAddresses(lastFailure.message)}`,
    lastFailure.statusCode,
    attempts,
    lastFailure.retryable,
  );
  logger.error('メールの送信に失敗しました', error, {
    template,
    recipient,
    error_code: error.code,
    status_code: error.statusCode,
    attempts,
    retryable: error.retryable,
  });
  return { ok: false, id: null, attempts, skipped: false, error };
}
