import { describe, it, expect, vi } from 'vitest';
import { EMAIL_OUTBOX_ERROR_CODES } from '@/lib/emails/outbox';
import {
  EMAIL_SUPPRESSED_ERROR_CODE,
  EmailSendError,
  emailFailureReasons,
  isEmailFailure,
  isEmailSuppressedReason,
  logEmailFailures,
  type SendEmailFailed,
  type SendEmailResult,
  type SendEmailSent,
  type SendEmailSkipped,
} from '@/lib/emails/send-result';

// #1193 sendEmail の結果を見る関数。Resend やロガーを読み込まない純粋なモジュールなので、モックなしで確かめる。

const sent: SendEmailSent = { ok: true, id: 'email-1', attempts: 1, skipped: false, error: null };
const skipped: SendEmailSkipped = {
  ok: false,
  id: null,
  attempts: 0,
  skipped: true,
  error: new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED: RESEND_API_KEY が未設定', null, 0, false),
};
const failedError = new EmailSendError('rate_limit_exceeded', 'EMAIL_SEND_FAILED: Too many requests', 429, 4, true);
const failed: SendEmailFailed = { ok: false, id: null, attempts: 4, skipped: false, error: failedError };

describe('EmailSendError', () => {
  it('Error として扱え、コード・ステータス・回数・再試行の対象かを持つ', () => {
    expect(failedError).toBeInstanceOf(Error);
    expect(failedError.name).toBe('EmailSendError');
    expect(failedError.message).toBe('EMAIL_SEND_FAILED: Too many requests');
    expect(failedError.code).toBe('rate_limit_exceeded');
    expect(failedError.statusCode).toBe(429);
    expect(failedError.attempts).toBe(4);
    expect(failedError.retryable).toBe(true);
  });
});

describe('isEmailFailure', () => {
  it('送れなかった結果 (ok: false) だけが失敗', () => {
    expect(isEmailFailure(failed)).toBe(true);
    expect(isEmailFailure(sent)).toBe(false);
  });

  it('RESEND_API_KEY が無くて送らなかった (skipped) 結果は、失敗に数えない', () => {
    expect(isEmailFailure(skipped)).toBe(false);
  });

  it('ok を持たない古い形の値 ({ id } だけ) や、値が無いときは失敗にしない', () => {
    expect(isEmailFailure({ id: 'email-1' } as unknown as SendEmailResult)).toBe(false);
    expect(isEmailFailure(undefined as unknown as SendEmailResult)).toBe(false);
  });
});

describe('emailFailureReasons', () => {
  it('Promise.allSettled の結果から、reject された理由と、ok: false の結果の error を取り出す (skipped と成功は除く)', async () => {
    const thrown = new Error('unexpected');
    const settled = await Promise.allSettled<SendEmailResult>([
      Promise.resolve(sent),
      Promise.resolve(failed),
      Promise.resolve(skipped),
      Promise.reject(thrown),
    ]);

    expect(emailFailureReasons(settled)).toEqual([failedError, thrown]);
  });

  it('1 通も失敗していなければ空', async () => {
    const settled = await Promise.allSettled<SendEmailResult>([Promise.resolve(sent), Promise.resolve(skipped)]);

    expect(emailFailureReasons(settled)).toEqual([]);
    expect(emailFailureReasons([])).toEqual([]);
  });

  it('モックが返す古い形 ({ id } だけ) の成功は失敗に数えない', async () => {
    const settled = await Promise.allSettled([Promise.resolve({ id: 'email-1' } as unknown as SendEmailResult)]);

    expect(emailFailureReasons(settled)).toEqual([]);
  });
});

// #1577 の 7: 宛先停止リストで止めた (suppressed) ときは意図した動きなので、呼び出し側のログは warn。ほかの失敗は error のまま
describe('logEmailFailures / isEmailSuppressedReason (#1577 の 7)', () => {
  const suppressedError = new EmailSendError(
    'suppressed',
    'EMAIL_SUPPRESSED: 宛先停止リストに載っている宛先のため、メールを送信しませんでした',
    null,
    0,
    false,
  );
  const outboxFailedError = new EmailSendError('outbox_failed', 'EMAIL_OUTBOX_FAILED', null, 0, true);
  const invalidEnvelopeError = new EmailSendError('invalid_envelope', 'EMAIL_INVALID', null, 0, false);

  function makeLog() {
    return { warn: vi.fn(), error: vi.fn() };
  }

  it('suppressed のコードは、sendEmail が返す値 (EMAIL_OUTBOX_ERROR_CODES.suppressed) と同じ', () => {
    expect(EMAIL_SUPPRESSED_ERROR_CODE).toBe(EMAIL_OUTBOX_ERROR_CODES.suppressed);
  });

  it('isEmailSuppressedReason は EmailSendError で code が suppressed のときだけ真', () => {
    expect(isEmailSuppressedReason(suppressedError)).toBe(true);
    expect(isEmailSuppressedReason(outboxFailedError)).toBe(false);
    expect(isEmailSuppressedReason(invalidEnvelopeError)).toBe(false);
    // EmailSendError でないもの (想定外の例外・同じ code を持つただのオブジェクト) は意図した停止ではない
    expect(isEmailSuppressedReason(Object.assign(new Error('x'), { code: 'suppressed' }))).toBe(false);
    expect(isEmailSuppressedReason({ code: 'suppressed' })).toBe(false);
    expect(isEmailSuppressedReason(undefined)).toBe(false);
    expect(isEmailSuppressedReason(null)).toBe(false);
  });

  it('理由が suppressed だけなら warn にし、error は出さない。metadata に error_code を足す', () => {
    const log = makeLog();
    logEmailFailures(log, '送れませんでした', [suppressedError], { scope: 'org' });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('送れませんでした', { scope: 'org', error_code: 'suppressed' });
  });

  it('複数の理由がすべて suppressed なら warn を 1 回', () => {
    const log = makeLog();
    logEmailFailures(log, '一部を送れませんでした', [suppressedError, suppressedError], { failed_count: 2 });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('一部を送れませんでした', { failed_count: 2, error_code: 'suppressed' });
  });

  it.each([
    ['outbox_failed', outboxFailedError],
    ['invalid_envelope', invalidEnvelopeError],
    ['想定外の例外', new Error('boom')],
    ['文字列で投げられた例外', 'boom'],
  ])('suppressed でない失敗 (%s) は今までどおり error。warn は出さない', (_label, reason) => {
    const log = makeLog();
    logEmailFailures(log, '送れませんでした', [reason], { scope: 'family' });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith('送れませんでした', reason, { scope: 'family' });
  });

  it('suppressed とほかの失敗が混ざっていれば error。渡す error は suppressed でない最初の理由', () => {
    const log = makeLog();
    logEmailFailures(log, '一部を送れませんでした', [suppressedError, outboxFailedError, invalidEnvelopeError], {
      failed_count: 3,
    });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('一部を送れませんでした', outboxFailedError, { failed_count: 3 });
  });

  it('理由が undefined の reject (想定外) も suppressed でない失敗として error に数える', () => {
    const log = makeLog();
    logEmailFailures(log, '一部を送れませんでした', [suppressedError, undefined], {});
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('一部を送れませんでした', undefined, {});
  });

  it('理由が空なら何も残さない', () => {
    const log = makeLog();
    logEmailFailures(log, '送れませんでした', [], {});
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('metadata を省略しても warn に error_code が入る', () => {
    const log = makeLog();
    logEmailFailures(log, '送れませんでした', [suppressedError]);
    expect(log.warn).toHaveBeenCalledWith('送れませんでした', { error_code: 'suppressed' });
  });
});
