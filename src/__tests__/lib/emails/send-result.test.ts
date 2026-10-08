import { describe, it, expect } from 'vitest';
import {
  EmailSendError,
  emailFailureReasons,
  isEmailFailure,
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
