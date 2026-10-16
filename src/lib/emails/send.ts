/**
 * メール送信の入口 (送信待ちへの登録)。サーバー専用。#1193
 *
 * - sendEmail は Resend を呼ばない。封筒を検証し、宛先停止リストを引いて、送信待ち (email_outbox) に 1 行入れて返る。
 *   送るのは worker (GET /api/cron/email-outbox。Vercel Cron が 1 分おきに呼ぶ) だけ
 *   (docs/design/operator/10-logs-and-mail-retry.md §6)。
 * - 戻り値は { ok, id, attempts, error } (型は send-result.ts)。ok: true は「送信待ちに登録した」(id = email_outbox.id)。
 *   失敗では例外を投げない (DB の失敗も例外も outbox_failed の結果にする)。
 *   通知メールは招待・譲渡・解散などの本体の操作が済んだあとの best-effort で、メールの失敗で操作を巻き込まないため。
 *   戻り値を見ない呼び出し元でも、失敗は下の「失敗の記録」で必ず app_logs に残る。
 *   戻り値を見る必要があるのは、失敗したときに追加の処理 (画面への表示・文脈つきのログなど) をする呼び出し元だけ。
 *   その判定 (isEmailFailure / emailFailureReasons) は send-result.ts にある。
 * - 失敗の記録: createLogger('email') で app_logs に残す。残すのは文面の名前 (template)・マスクした宛先・エラーコードだけ。
 *   宛先のメールアドレス・件名・本文は残さない (表 email_outbox の中だけにある)。
 * - 再試行: worker が行う。一時的な失敗 (429 / 5xx / 通信エラー) は時間をおいて最大 EMAIL_OUTBOX_MAX_ATTEMPTS 回
 *   (既定 6 回。間隔 1 分 → 5 分 → 15 分 → 1 時間 → 4 時間) 送り、使い切ったら届けられなかった (dead) として残す。
 *   400 / 401 / 403 / 422 などは何度送っても直らないので、1 回目で dead にする (src/lib/emails/outbox.ts)。
 * - 二重送信の防止: worker が Resend の Idempotency-Key を付ける。キーは登録時に行に保存し、再試行・再送でも同じ値を使うので、
 *   1 回目が実は届いていたのに応答だけ失われた場合でも、同じメールが 2 通届かない。
 * - RESEND_API_KEY が無いときは登録せずに app_logs へ警告を残し、skipped: true を返す (ok は false)。
 * - 宛先停止リスト (email_blacklist。ハードバウンス・苦情・運営の手入力) に載っている宛先へは送らない (#1184)。
 *   登録時に載っていれば、送らなかった記録 (dead / suppressed) を残し、error.code = 'suppressed' の失敗 (ok: false / skipped: false) を返す。
 *   届いていないので、呼び出し側からは送れなかったメールに見える (isEmailFailure が true)。
 *   停止リストを引けなかったとき (DB の失敗・時間切れ) は登録し、worker が送る直前にもう一度引く。
 *   メールの種類で分けない (退会の完了の知らせ・譲渡の提案など、このモジュールを通るものはすべて止める)。
 *   サインアップの確認・パスワードの再設定のメールは Supabase Auth が送り、このモジュールを通らないので、ここでは止まらない。
 *   届かない・迷惑メールと報告された宛先へ送り続けると、送信元の評価が落ちて、ほかの人へのメールまで届きにくくなるため。
 *
 * 【規約】利用者が指定したアドレスへメールを送る処理は、このモジュールを呼ぶ前に
 * src/lib/membership/invite-throttle.ts の送信回数制限を通すこと (tests/email-send-throttle-contract.test.ts が検査する)。
 * worker の再試行は同じ 1 通を送り直すだけで、呼び出し側が数える「試行回数」には含めない。
 */
import { randomUUID } from 'crypto';
import { errorCodeOf, toLoggableError } from '@/lib/api/errors';
import { createLogger } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { EmailSendError, type SendEmailResult } from '@/lib/emails/send-result';
import { lookupEmailSuppression } from '@/lib/emails/suppression';
import {
  EMAIL_OUTBOX_ERROR_CODES,
  EMAIL_OUTBOX_TABLE,
  UNKNOWN_EMAIL_TEMPLATE,
  maskEmailAddress,
  redactEmailAddresses,
} from './outbox';
import { EmailEnvelopeSchema, type EmailEnvelope } from './envelope';

export type { SendEmailFailed, SendEmailResult, SendEmailSent, SendEmailSkipped } from '@/lib/emails/send-result';

// メールの形 (スキーマ) は envelope.ts に 1 つだけある (#1194)。
// 既存の import 先 (`@/lib/emails/send`) をそのまま使えるように、ここからも再エクスポートする。
export { EmailEnvelopeSchema, type EmailEnvelope };

// 宛先のマスクの本体は outbox.ts にある (#1193)。既存の import 先 (`@/lib/emails/send`) を保つため再エクスポートする
export { maskEmailAddress } from './outbox';

export interface SendEmailOptions {
  /** Resend の Idempotency-Key。省略すると登録ごとに randomUUID()。再試行・再送でも同じ値を使う (email_outbox.idempotency_key) */
  idempotencyKey?: string;
  /** 誰についてのメールか (email_outbox.user_id)。退会時の伏せ字と画面の絞り込みに使う。分かる呼び出し元だけ渡す */
  userId?: string;
  /** 送れたとき・届けられずに dead になったときに宛先・件名・本文を伏せ、登録時に停止リストに当たったら行を作らない (退会の完了メール)。既定 false */
  redactAfterSend?: boolean;
}

/** email_outbox.template の長さの上限 (migration の CHECK char_length(template) BETWEEN 1 AND 100) */
const OUTBOX_TEMPLATE_MAX_LENGTH = 100;
/** ログに出す文面の名前の長さの上限 (現行のまま) */
const LOG_TEMPLATE_MAX_LENGTH = 64;

/** ログに出す文面の名前とマスクした宛先。封筒が不正でも (to が無い・文字列でなくても) 例外にならない */
function describeEnvelope(envelope: unknown): { template: string; recipient: string } {
  const { template, to } = (envelope ?? {}) as { template?: unknown; to?: unknown };
  return {
    template: typeof template === 'string' && template ? template.slice(0, LOG_TEMPLATE_MAX_LENGTH) : UNKNOWN_EMAIL_TEMPLATE,
    recipient: typeof to === 'string' ? maskEmailAddress(to) : '***',
  };
}

/** 失敗の結果を作る (attempts は常に 0: Resend にはまだ送っていない) */
function failure(code: string, message: string, skipped: boolean): SendEmailResult {
  const error = new EmailSendError(code, message, null, 0, code === EMAIL_OUTBOX_ERROR_CODES.outboxFailed);
  return skipped ? { ok: false, id: null, attempts: 0, skipped: true, error } : { ok: false, id: null, attempts: 0, skipped: false, error };
}

export async function sendEmail(envelope: EmailEnvelope, options: SendEmailOptions = {}): Promise<SendEmailResult> {
  const logger = createLogger('email');
  const { template, recipient } = describeEnvelope(envelope);

  // 1. 封筒の検証 (ログの文面・error の形は現行のまま)
  const parsed = EmailEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    // 文面を作る側のバグ (件名が長すぎる・宛先が不正など)。zod のエラー文は値を含まない (どの項目がなぜ不正かだけ)
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join(', ');
    const result = failure('invalid_envelope', `EMAIL_INVALID_ENVELOPE: ${detail}`, false);
    logger.error('メールの内容が不正なため、送信しませんでした', result.error, {
      template,
      recipient,
      error_code: 'invalid_envelope',
      attempts: 0,
    });
    return result;
  }
  const v = parsed.data;

  // 2. 鍵が無ければ登録しない (開発・CI・未設定の本番で行を作らない)
  if (!process.env.RESEND_API_KEY) {
    // 本番で設定が漏れていたら、メールが 1 通も出なくなる。console だけでは気づけないので app_logs に残す
    logger.warn('RESEND_API_KEY が未設定のため、メールを送信しませんでした', { template, recipient });
    // 変数名はサーバーのログ (上の警告) にだけ残し、例外の message には入れない (#1182・#1490)。
    // 呼び出し元が message を応答の本文や記録に入れても、変数名が外に出ないようにするため
    return failure('not_configured', 'EMAIL_NOT_CONFIGURED: メールの送信の設定が無いため、メールを送信しませんでした', true);
  }

  // 3. 停止リスト。載っていれば dead の行を残し (best-effort)、現行と同じ suppressed の失敗を返す。引けなければ登録して worker に任せる。
  //    redactAfterSend (退会の完了メール) の行は残さない: 宛先を伏せる経路 (complete / fail) を通らず、退会した本人の生のアドレスが残るため (R-10)
  const suppression = await lookupEmailSuppression(v.to);
  const row = {
    template: v.template?.slice(0, OUTBOX_TEMPLATE_MAX_LENGTH) || UNKNOWN_EMAIL_TEMPLATE,
    to_email: v.to,
    from_email: v.from,
    reply_to: v.reply_to ?? null,
    subject: v.subject,
    text_body: v.text,
    html_body: v.html ?? null,
    user_id: options.userId ?? null,
    idempotency_key: options.idempotencyKey ?? randomUUID(),
    redact_after_send: options.redactAfterSend ?? false,
  };
  if (suppression.status === 'suppressed') {
    logger.warn('宛先停止リストに載っている宛先のため、メールを送信しませんでした', {
      template,
      recipient,
      suppression_reason: suppression.reason,
    });
    if (!row.redact_after_send) {
      // 記録は best-effort。例外 (service role の設定が無いなど) も受けて、結果は suppressed のまま返す (sendEmail は例外を投げない: R-01)
      try {
        const { error } = await getSupabaseAdmin()
          .from(EMAIL_OUTBOX_TABLE)
          .insert({
            ...row,
            status: 'dead',
            dead_at: new Date().toISOString(),
            last_error_code: EMAIL_OUTBOX_ERROR_CODES.suppressed,
          });
        if (error) logger.warn('送らなかった記録 (dead) を残せませんでした', { template, recipient, pg_code: error.code });
      } catch (err) {
        logger.warn('送らなかった記録 (dead) を残せませんでした', {
          template,
          recipient,
          error_message: redactEmailAddresses(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    return failure(
      EMAIL_OUTBOX_ERROR_CODES.suppressed,
      'EMAIL_SUPPRESSED: 宛先停止リストに載っている宛先のため、メールを送信しませんでした',
      false,
    );
  }
  if (suppression.status === 'lookup_failed') {
    logger.warn('宛先停止リストを引けなかったため、確かめずにメールを送信待ちに登録します', {
      template,
      recipient,
      error_code: errorCodeOf(suppression.error) ?? null,
      error_message: redactEmailAddresses(toLoggableError(suppression.error).message),
    });
  }

  // 4. 登録。失敗 ({ error }・行が返らない・例外) は outbox_failed (ok: false / retryable: true)。Resend へは送らない (同期の送信経路は無い)
  //    例外も受けるのは、sendEmail が例外を投げない約束 (R-01) を保つため (getSupabaseAdmin は service role の設定が無いと例外を投げる)
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(EMAIL_OUTBOX_TABLE)
      .insert({ ...row, status: 'queued' })
      .select('id')
      .single();
    if (error || !data) {
      // error.message だけを使う (error.details には行の値 = 宛先が入りうるので載せない: R-09)
      logger.error('メールを送信待ちに登録できませんでした', new Error(error?.message ?? 'no row'), {
        template,
        recipient,
        error_code: EMAIL_OUTBOX_ERROR_CODES.outboxFailed,
        pg_code: error?.code ?? null,
      });
      return failure(EMAIL_OUTBOX_ERROR_CODES.outboxFailed, 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした', false);
    }
    logger.info('メールを送信待ちに登録しました', { template, recipient, outbox_id: data.id });
    return { ok: true, id: data.id, attempts: 0, skipped: false, error: null };
  } catch (err) {
    logger.error(
      'メールを送信待ちに登録できませんでした',
      new Error(redactEmailAddresses(err instanceof Error ? err.message : String(err))),
      { template, recipient, error_code: EMAIL_OUTBOX_ERROR_CODES.outboxFailed, pg_code: null },
    );
    return failure(EMAIL_OUTBOX_ERROR_CODES.outboxFailed, 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした', false);
  }
}
