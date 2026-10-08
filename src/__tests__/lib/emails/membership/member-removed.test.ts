import { describe, it, expect, vi } from 'vitest';

// Resend モック (send.ts が resend を import するため)
vi.mock('resend', () => {
  class MockResend {
    emails = { send: vi.fn().mockResolvedValue({ data: { id: 'mock-id' }, error: null }) };
  }
  return { Resend: MockResend };
});

import { renderMemberRemovedEmail } from '@/lib/emails/membership/member-removed';
import type { MemberRemovedEmailVars } from '@/lib/emails/membership/member-removed';
import { EmailEnvelopeSchema } from '@/lib/emails/send';

// #1160 家族グループ / 組織から外されたメンバー本人への通知メール (設計書 04-email-templates.md §6.1)

const familyVars: MemberRemovedEmailVars = {
  to_email: 'taro@example.com',
  scope: 'family',
  scope_name: '山田家',
};

const orgVars: MemberRemovedEmailVars = {
  to_email: 'taro@example.com',
  scope: 'organization',
  scope_name: '株式会社ほめゴハン',
};

/** 本文に含まれるメールアドレス */
const addressesIn = (text: string) => text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];

describe('renderMemberRemovedEmail', () => {
  it('EmailEnvelopeSchema で valid な envelope を返す (家族グループ・組織とも)', () => {
    for (const vars of [familyVars, orgVars]) {
      expect(EmailEnvelopeSchema.safeParse(renderMemberRemovedEmail(vars)).success).toBe(true);
    }
  });

  it('to が to_email (除名された本人) と一致し、from が ほめゴハン noreply である', () => {
    const envelope = renderMemberRemovedEmail(familyVars);

    expect(envelope.to).toBe('taro@example.com');
    expect(envelope.from).toBe('ほめゴハン <noreply@homegohan.app>');
  });

  it('件名: 家族グループ名つきで「外されました」と伝える', () => {
    expect(renderMemberRemovedEmail(familyVars).subject).toBe('【ほめゴハン】家族グループ「山田家」から外されました');
  });

  it('件名: 組織では「組織」と組織名になる', () => {
    expect(renderMemberRemovedEmail(orgVars).subject).toBe('【ほめゴハン】組織「株式会社ほめゴハン」から外されました');
  });

  it('本文: 何が起きたか (家族グループ名つき) を最初の段落で伝える', () => {
    const { text } = renderMemberRemovedEmail(familyVars);

    expect(text).toContain('家族グループ「山田家」のメンバーから外されました。');
    expect(text.indexOf('メンバーから外されました')).toBeLessThan(text.indexOf('個人アカウント'));
  });

  it('本文: 組織では「組織」と組織名で伝える (家族グループとは書かない)', () => {
    const { text } = renderMemberRemovedEmail(orgVars);

    expect(text).toContain('組織「株式会社ほめゴハン」のメンバーから外されました。');
    expect(text).toContain('組織で記録した個人データ');
    expect(text).not.toContain('家族グループ');
  });

  it('本文: 個人アカウントは引き続き使え、個人データは残ることを伝える (設計書 §6.1)', () => {
    const { text } = renderMemberRemovedEmail(familyVars);

    expect(text).toContain('個人アカウントは、引き続きご利用いただけます');
    expect(text).toContain('家族グループで記録した個人データも、あなたのアカウントに残ります');
  });

  it('本文: 問い合わせ先と署名がある (family-transfer-completed と同じ書式)', () => {
    const { text } = renderMemberRemovedEmail(familyVars);

    expect(text.startsWith('ほめゴハンをご利用いただきありがとうございます。')).toBe(true);
    expect(text).toContain('support@homegohan.app');
    expect(text.trimEnd().endsWith('ほめゴハン\nhttps://homegohan.app')).toBe(true);
  });

  it('本文: 載せる個人情報は無い。メールアドレスは問い合わせ先だけで、他のメンバーの名前も入らない', () => {
    for (const vars of [familyVars, orgVars]) {
      const { subject, text } = renderMemberRemovedEmail(vars);

      expect(addressesIn(text)).toEqual(['support@homegohan.app']);
      expect(subject).not.toContain('@');
      // 宛先本人のアドレスも、本文には書かない
      expect(text).not.toContain(vars.to_email);
    }
  });

  it('未設定の値が「undefined」「null」として本文・件名に出ない', () => {
    for (const vars of [familyVars, orgVars]) {
      const { subject, text } = renderMemberRemovedEmail(vars);

      expect(`${subject}\n${text}`).not.toMatch(/undefined|null|\[object/);
    }
  });

  it('名前を読めなかったとき (scope_name が null / 空) は、名前を省いた文面にする', () => {
    for (const scope_name of [null, '', '   ']) {
      const family = renderMemberRemovedEmail({ ...familyVars, scope_name });
      const org = renderMemberRemovedEmail({ ...orgVars, scope_name });

      expect(family.subject).toBe('【ほめゴハン】家族グループから外されました');
      expect(family.text).toContain('家族グループのメンバーから外されました。');
      expect(family.text).not.toContain('「');
      expect(org.subject).toBe('【ほめゴハン】組織から外されました');
      expect(org.text).toContain('組織のメンバーから外されました。');
      expect(EmailEnvelopeSchema.safeParse(family).success).toBe(true);
    }
  });

  it('名前が長くても件名は 100 文字以内に収まり (送信時の検証で落ちない)、本文には名前を省略せず載せる', () => {
    const longName = '長い名前'.repeat(60);
    const envelope = renderMemberRemovedEmail({ ...orgVars, scope_name: longName });

    expect(envelope.subject.length).toBeLessThanOrEqual(100);
    expect(envelope.subject.startsWith('【ほめゴハン】組織「')).toBe(true);
    expect(envelope.subject.endsWith('」から外されました')).toBe(true);
    expect(envelope.subject).toContain('…');
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.text).toContain(`組織「${longName}」のメンバーから外されました。`);
  });

  it('絵文字など 2 文字分の文字だけの長い名前でも、件名は 100 文字以内に収まり、文字の途中で切れない', () => {
    const envelope = renderMemberRemovedEmail({ ...familyVars, scope_name: '😀'.repeat(100) });

    expect(envelope.subject.length).toBeLessThanOrEqual(100);
    expect(envelope.subject).toContain(`「${'😀'.repeat(30)}…」`);
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('名前に改行などの制御文字が入っていても、件名は 1 行に収まる', () => {
    const envelope = renderMemberRemovedEmail({ ...familyVars, scope_name: '山田家\r\nBcc: attacker\t家' });

    expect(envelope.subject).not.toMatch(/[\r\n\t]/);
    expect(envelope.subject).toBe('【ほめゴハン】家族グループ「山田家 Bcc: attacker 家」から外されました');
  });
});
