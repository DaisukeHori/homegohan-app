import { describe, it, expect, vi, afterEach } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/send';

// vi.mock はホイスト前提のため、factory 内にモック関数を定義する
const mockEmailsSend = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { id: 'mock-email-id' }, error: null }),
);

vi.mock('resend', () => {
  class MockResend {
    emails = { send: mockEmailsSend };
  }
  return { Resend: MockResend };
});

// モック定義後に動的 import
const { sendEmail } = await import('@/lib/emails/send');

const validEnvelope = {
  to: 'test@example.com',
  from: 'ほめゴハン <noreply@homegohan.app>',
  subject: 'テスト件名',
  text: 'テスト本文',
};

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.RESEND_API_KEY;
});

describe('EmailEnvelopeSchema', () => {
  it('正常な envelope を parse できる', () => {
    const result = EmailEnvelopeSchema.safeParse(validEnvelope);
    expect(result.success).toBe(true);
  });

  it('空件名 (空文字列) で parse エラーになる', () => {
    const result = EmailEnvelopeSchema.safeParse({ ...validEnvelope, subject: '' });
    expect(result.success).toBe(false);
  });

  it('100文字超の件名で parse エラーになる', () => {
    const result = EmailEnvelopeSchema.safeParse({
      ...validEnvelope,
      subject: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('不正な to (email 形式でない) で parse エラーになる', () => {
    const result = EmailEnvelopeSchema.safeParse({ ...validEnvelope, to: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('不正な reply_to (email 形式でない) で parse エラーになる', () => {
    const result = EmailEnvelopeSchema.safeParse({
      ...validEnvelope,
      reply_to: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('空 text で parse エラーになる', () => {
    const result = EmailEnvelopeSchema.safeParse({ ...validEnvelope, text: '' });
    expect(result.success).toBe(false);
  });
});

describe('sendEmail', () => {
  it('RESEND_API_KEY 未設定時に warn を出して skip を返す', async () => {
    delete process.env.RESEND_API_KEY;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sendEmail(validEnvelope);

    expect(warnSpy).toHaveBeenCalledWith(
      '[email] RESEND_API_KEY 未設定、送信スキップ',
      expect.objectContaining({ to: validEnvelope.to, subject: validEnvelope.subject }),
    );
    expect(result).toEqual({ id: 'dev-no-send', skipped: true });
    warnSpy.mockRestore();
  });

  it('RESEND_API_KEY 設定時に resend.emails.send を呼び出す', async () => {
    process.env.RESEND_API_KEY = 'test-api-key';
    mockEmailsSend.mockResolvedValueOnce({ data: { id: 'sent-id' }, error: null });

    const result = await sendEmail(validEnvelope);

    expect(mockEmailsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: validEnvelope.to,
        subject: validEnvelope.subject,
        text: validEnvelope.text,
      }),
    );
    expect(result).toEqual({ id: 'sent-id' });
  });

  it('Resend がエラーを返した場合に EMAIL_SEND_FAILED をスローする', async () => {
    process.env.RESEND_API_KEY = 'test-api-key';
    mockEmailsSend.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invalid API key', name: 'validation_error' },
    });

    await expect(sendEmail(validEnvelope)).rejects.toThrow('EMAIL_SEND_FAILED: Invalid API key');
  });
});
