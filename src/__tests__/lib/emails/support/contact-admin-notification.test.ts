import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import {
  renderContactAdminNotificationEmail,
  type ContactAdminNotificationVars,
} from '@/lib/emails/support/contact-admin-notification';
import { DEFAULT_EMAIL_FROM } from '@/lib/site-config';

// #1193 お問い合わせの管理者通知の文面 (src/app/api/contact/route.ts から移した)。設計: docs/design/operator/10-logs-and-mail-retry.md §6.6・§12。

const INQUIRIES_URL = 'https://app.example.test/support/inquiries';
const SUBJECT_MAX_LENGTH = 100;

const baseVars: ContactAdminNotificationVars = {
  to_email: 'admin@example.com',
  inquiry_id: 'inq-1',
  inquiry_type: 'support',
  sender_masked: 'u***@example.com',
  subject: 'ログインできません',
  message: 'パスワードを再設定しても\nログインできません。',
  inquiries_url: INQUIRIES_URL,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderContactAdminNotificationEmail (#1193)', () => {
  it('EmailEnvelopeSchema で valid な封筒を返す', () => {
    expect(EmailEnvelopeSchema.safeParse(renderContactAdminNotificationEmail(baseVars)).success).toBe(true);
  });

  it('template は contact_admin_notification', () => {
    expect(renderContactAdminNotificationEmail(baseVars).template).toBe('contact_admin_notification');
  });

  it('to は運営の宛先、from は getEmailFrom (EMAIL_FROM が無ければ DEFAULT_EMAIL_FROM)', () => {
    vi.stubEnv('EMAIL_FROM', '');
    const envelope = renderContactAdminNotificationEmail(baseVars);
    expect(envelope.to).toBe('admin@example.com');
    expect(envelope.from).toBe(DEFAULT_EMAIL_FROM);

    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.test>');
    expect(renderContactAdminNotificationEmail(baseVars).from).toBe('ほめゴハン <noreply@mail.example.test>');
  });

  it('件名は [お問い合わせ] + 件名。100 文字の件名でも 100 文字以内に収まり、サロゲートペアの途中で切らない', () => {
    expect(renderContactAdminNotificationEmail(baseVars).subject).toBe('[お問い合わせ] ログインできません');

    const long = renderContactAdminNotificationEmail({ ...baseVars, subject: 'あ'.repeat(SUBJECT_MAX_LENGTH) });
    expect(long.subject.length).toBeLessThanOrEqual(SUBJECT_MAX_LENGTH);
    expect(long.subject.startsWith('[お問い合わせ] あ')).toBe(true);
    expect(long.subject.endsWith('…')).toBe(true);
    expect(EmailEnvelopeSchema.safeParse(long).success).toBe(true);

    const emoji = renderContactAdminNotificationEmail({ ...baseVars, subject: '😀'.repeat(SUBJECT_MAX_LENGTH / 2) });
    expect(emoji.subject.length).toBeLessThanOrEqual(SUBJECT_MAX_LENGTH);
    expect(() => encodeURIComponent(emoji.subject)).not.toThrow(); // 孤立サロゲートがあると URIError
    expect(emoji.subject.endsWith('😀…')).toBe(true);

    // ちょうど収まる長さは切らない
    const fits = 'い'.repeat(SUBJECT_MAX_LENGTH - '[お問い合わせ] '.length);
    expect(renderContactAdminNotificationEmail({ ...baseVars, subject: fits }).subject).toBe(`[お問い合わせ] ${fits}`);
  });

  it('件名の改行・連続する空白を 1 行にそろえ、空白だけなら (件名なし)', () => {
    expect(renderContactAdminNotificationEmail({ ...baseVars, subject: 'a\n\n b\t c' }).subject).toBe('[お問い合わせ] a b c');
    const blank = renderContactAdminNotificationEmail({ ...baseVars, subject: ' \n ' });
    expect(blank.subject).toBe('[お問い合わせ] (件名なし)');
    expect(blank.text).toContain('件名: (件名なし)');
  });

  it('本文に ID・種別・マスクした送信者・件名・内容があり、サポートの画面の URL が単独の行', () => {
    const text = renderContactAdminNotificationEmail(baseVars).text;
    const lines = text.split('\n');

    expect(lines).toContain('ID: inq-1');
    expect(lines).toContain('種別: support');
    expect(lines).toContain('送信者: u***@example.com (アドレスの全体はサポートの画面で確認してください)');
    expect(lines).toContain('件名: ログインできません');
    expect(text).toContain('--- 内容 ---\nパスワードを再設定しても\nログインできません。');
    expect(lines).toContain(INQUIRIES_URL);
  });
});
