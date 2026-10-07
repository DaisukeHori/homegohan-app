import { describe, it, expect, vi } from 'vitest';

// Resend モック (EmailEnvelopeSchema を使うために send.ts を import すると resend が読み込まれるため)
vi.mock('resend', () => {
  class MockResend {
    emails = { send: vi.fn().mockResolvedValue({ data: { id: 'mock-id' }, error: null }) };
  }
  return { Resend: MockResend };
});

import {
  buildTicketReplySubject,
  renderTicketReplyEmail,
  shortTicketId,
} from '@/lib/emails/support/ticket-reply';
import type { TicketReplyEmailVars } from '@/lib/emails/support/ticket-reply';
import { EmailEnvelopeSchema } from '@/lib/emails/send';

const ticketId = 'a1b2c3d4-0000-4000-8000-000000000001';
const contactUrl = 'https://homegohan.app/contact';

const baseVars: TicketReplyEmailVars = {
  to_email: 'taro@example.com',
  ticket_id: ticketId,
  ticket_subject: 'ログインできません',
  reply_body: 'ご不便をおかけしております。\nパスワードの再設定をお試しください。',
  contact_url: contactUrl,
};

// 対になっていないサロゲート (文字化けの原因) があるか
const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('renderTicketReplyEmail', () => {
  it('EmailEnvelopeSchema で valid な envelope を返す', () => {
    const result = EmailEnvelopeSchema.safeParse(renderTicketReplyEmail(baseVars));
    expect(result.success).toBe(true);
  });

  it('to がチケットの顧客本人、from が ほめゴハン noreply である', () => {
    const envelope = renderTicketReplyEmail(baseVars);
    expect(envelope.to).toBe('taro@example.com');
    expect(envelope.from).toBe('ほめゴハン <noreply@homegohan.app>');
  });

  it('件名はサポートからの返信であることと、チケットの件名・受付番号を含む', () => {
    const envelope = renderTicketReplyEmail(baseVars);
    expect(envelope.subject).toBe('【ほめゴハン】サポートからのご返信「ログインできません」 (#a1b2c3d4)');
  });

  it('本文に顧客向けの返信の全文が改行を含めてそのまま入る', () => {
    const envelope = renderTicketReplyEmail(baseVars);
    expect(envelope.text).toContain(
      '▼ 担当者からのメッセージ\nご不便をおかけしております。\nパスワードの再設定をお試しください。\n',
    );
  });

  it('返信の前後の空白は取り除く', () => {
    const envelope = renderTicketReplyEmail({ ...baseVars, reply_body: '\n\n  お待たせしました。  \n\n' });
    expect(envelope.text).toContain('▼ 担当者からのメッセージ\nお待たせしました。\n\n▼');
  });

  it('本文にチケットの件名と受付番号が入る', () => {
    const envelope = renderTicketReplyEmail(baseVars);
    expect(envelope.text).toContain('件名: ログインできません');
    expect(envelope.text).toContain('受付番号: #a1b2c3d4');
  });

  it('reply_to 未指定: reply_to を付けず、返信できない旨とお問い合わせフォームへの誘導を書く', () => {
    const envelope = renderTicketReplyEmail(baseVars);
    expect(envelope).not.toHaveProperty('reply_to');
    expect(envelope.text).toContain('返信しても届きません');
    expect(envelope.text).toContain('お問い合わせフォームからお願いします');
    // フォームの URL は単独の行にする (メーラーの自動リンクが効く)
    expect(envelope.text.split('\n')).toContain(contactUrl);
  });

  it('reply_to 指定: envelope.reply_to に入り、本文は「そのまま返信」を案内する', () => {
    const envelope = renderTicketReplyEmail({ ...baseVars, reply_to: 'support@homegohan.app' });
    expect(envelope.reply_to).toBe('support@homegohan.app');
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.text).toContain('そのまま返信していただくと');
    expect(envelope.text).not.toContain('返信しても届きません');
    expect(envelope.text.split('\n')).toContain(contactUrl);
  });

  it('reply_to が null なら未指定と同じ扱いになる', () => {
    const envelope = renderTicketReplyEmail({ ...baseVars, reply_to: null });
    expect(envelope).not.toHaveProperty('reply_to');
    expect(envelope.text).toContain('返信しても届きません');
  });

  it('チケットの件名が 200 字でも、件名は 100 字以内に収まり受付番号が残る', () => {
    const envelope = renderTicketReplyEmail({ ...baseVars, ticket_subject: 'あ'.repeat(200) });
    expect(envelope.subject.length).toBeLessThanOrEqual(100);
    expect(envelope.subject).toContain('…');
    expect(envelope.subject.endsWith(' (#a1b2c3d4)')).toBe(true);
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
    // 本文には切り詰めない件名の全文が入る
    expect(envelope.text).toContain(`件名: ${'あ'.repeat(200)}`);
  });

  it('切り詰める位置が絵文字 (サロゲートペア) でも文字を壊さない', () => {
    for (const filler of ['😀', 'a😀', 'ab😀']) {
      const subject = buildTicketReplySubject(ticketId, filler.repeat(150));
      expect(subject.length).toBeLessThanOrEqual(100);
      expect(hasLoneSurrogate(subject)).toBe(false);
      expect(subject.endsWith(' (#a1b2c3d4)')).toBe(true);
    }
  });

  it('件名ちょうど収まる長さなら切り詰めない', () => {
    // 固定部分 31 字 + 件名 69 字 = 100 字
    const title = 'あ'.repeat(69);
    const subject = buildTicketReplySubject(ticketId, title);
    expect(subject.length).toBe(100);
    expect(subject).toContain(title);
    expect(subject).not.toContain('…');
  });

  it('件名に改行や連続する空白があっても 1 行にそろえる', () => {
    const envelope = renderTicketReplyEmail({
      ...baseVars,
      ticket_subject: 'ログイン\r\nできません\n\n  Bcc: attacker@example.com',
    });
    expect(envelope.subject).not.toMatch(/[\r\n]/);
    expect(envelope.subject).toContain('ログイン できません Bcc: attacker@example.com');
    expect(envelope.text).toContain('件名: ログイン できません Bcc: attacker@example.com\n');
  });

  it('チケットの件名が空白だけなら、件名なしの件名と本文にする', () => {
    const envelope = renderTicketReplyEmail({ ...baseVars, ticket_subject: '  \n ' });
    expect(envelope.subject).toBe('【ほめゴハン】サポートからのご返信 (#a1b2c3d4)');
    expect(envelope.text).toContain('件名: (件名なし)');
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe('shortTicketId', () => {
  it('管理画面の表示 (#{id.slice(0, 8)}) と同じ先頭 8 桁を返す', () => {
    expect(shortTicketId(ticketId)).toBe('a1b2c3d4');
  });
});
