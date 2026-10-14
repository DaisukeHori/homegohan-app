/**
 * #1184 Resend の Webhook のイベントの振り分け (src/lib/emails/resend-webhook-event.ts)。
 */
import { describe, expect, it } from 'vitest';
import { classifyResendEvent, ResendWebhookEventSchema } from '@/lib/emails/resend-webhook-event';

const parse = (value: unknown) => ResendWebhookEventSchema.parse(value);

describe('classifyResendEvent', () => {
  it('email.bounced で bounce.type が Permanent (大文字小文字は問わない) ならハードバウンス = bounce', () => {
    for (const type of ['Permanent', 'permanent', ' PERMANENT ']) {
      expect(classifyResendEvent(parse({ type: 'email.bounced', data: { to: ['a@example.com'], bounce: { type } } }))).toEqual({
        action: 'blacklist',
        reason: 'bounce',
        addresses: ['a@example.com'],
      });
    }
  });

  it('email.bounced のそれ以外 (Temporary・Transient・Undetermined・bounce なし) はソフトバウンスとして記録しない', () => {
    const variants = [{ bounce: { type: 'Temporary' } }, { bounce: { type: 'Transient' } }, { bounce: { type: 'Undetermined' } }, {}];
    for (const extra of variants) {
      expect(classifyResendEvent(parse({ type: 'email.bounced', data: { to: ['a@example.com'], ...extra } }))).toEqual({
        action: 'ignore',
        why: 'soft_bounce',
      });
    }
  });

  it('email.complained は complaint', () => {
    expect(classifyResendEvent(parse({ type: 'email.complained', data: { to: ['b@example.com'] } }))).toEqual({
      action: 'blacklist',
      reason: 'complaint',
      addresses: ['b@example.com'],
    });
  });

  it('to が文字列 1 つでも受ける。空の宛先は除き、宛先が無ければ何もしない', () => {
    expect(classifyResendEvent(parse({ type: 'email.complained', data: { to: ' c@example.com ' } }))).toMatchObject({
      addresses: ['c@example.com'],
    });
    expect(classifyResendEvent(parse({ type: 'email.complained', data: { to: ['', '  '] } }))).toEqual({
      action: 'ignore',
      why: 'no_recipient',
    });
    expect(classifyResendEvent(parse({ type: 'email.complained' }))).toEqual({ action: 'ignore', why: 'no_recipient' });
  });

  it('ほかの種類は unhandled_type', () => {
    for (const type of ['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.opened', 'contact.created']) {
      expect(classifyResendEvent(parse({ type, data: { to: ['a@example.com'] } }))).toEqual({
        action: 'ignore',
        why: 'unhandled_type',
      });
    }
  });
});

describe('ResendWebhookEventSchema', () => {
  it('type が無い・空なら失敗する', () => {
    expect(ResendWebhookEventSchema.safeParse({ data: {} }).success).toBe(false);
    expect(ResendWebhookEventSchema.safeParse({ type: '' }).success).toBe(false);
  });
});
