import { describe, it, expect, vi } from 'vitest';

// Resend モック (send.ts が resend を import するため)
vi.mock('resend', () => {
  class MockResend {
    emails = { send: vi.fn().mockResolvedValue({ data: { id: 'mock-id' }, error: null }) };
  }
  return { Resend: MockResend };
});

import { renderMemberLeftEmail } from '@/lib/emails/membership/member-left';
import type { MemberLeftEmailVars } from '@/lib/emails/membership/member-left';
import { EmailEnvelopeSchema } from '@/lib/emails/send';

// #1160 メンバーが自分で脱退したときの、家族グループの代表者 / 組織のオーナーへの通知メール
// (設計書 04-email-templates.md §6.2)

const familyVars: MemberLeftEmailVars = {
  to_email: 'hanako@example.com',
  scope: 'family',
  scope_name: '山田家',
  members_url: 'https://app.example.test/family/members',
};

const orgVars: MemberLeftEmailVars = {
  to_email: 'owner@example.com',
  scope: 'organization',
  scope_name: '株式会社ほめゴハン',
  members_url: 'https://app.example.test/org/members',
};

/** 本文に含まれるメールアドレス */
const addressesIn = (text: string) => text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];

describe('renderMemberLeftEmail', () => {
  it('EmailEnvelopeSchema で valid な envelope を返す (家族グループ・組織とも)', () => {
    for (const vars of [familyVars, orgVars]) {
      expect(EmailEnvelopeSchema.safeParse(renderMemberLeftEmail(vars)).success).toBe(true);
    }
  });

  it('to が to_email (代表者 / オーナー) と一致し、from が ほめゴハン noreply である', () => {
    const envelope = renderMemberLeftEmail(familyVars);

    expect(envelope.to).toBe('hanako@example.com');
    expect(envelope.from).toBe('ほめゴハン <noreply@homegohan.app>');
  });

  it('件名: 家族グループ名つきで「メンバーが脱退しました」と伝える', () => {
    expect(renderMemberLeftEmail(familyVars).subject).toBe(
      '【ほめゴハン】家族グループ「山田家」からメンバーが脱退しました',
    );
  });

  it('件名: 組織では「組織」と組織名になる', () => {
    expect(renderMemberLeftEmail(orgVars).subject).toBe(
      '【ほめゴハン】組織「株式会社ほめゴハン」からメンバーが脱退しました',
    );
  });

  it('本文(家族グループ): 何が起きたかと、代表者に送っていることを伝える', () => {
    const { text } = renderMemberLeftEmail(familyVars);

    expect(text.startsWith('ほめゴハンをご利用いただきありがとうございます。')).toBe(true);
    expect(text).toContain('家族グループ「山田家」のメンバーが 1 人、ご本人の操作で脱退しました。');
    expect(text).toContain('このメールは、家族グループの代表者にお送りしています。');
  });

  it('本文(組織): 何が起きたかと、オーナーに送っていることを伝える (家族グループとは書かない)', () => {
    const { text } = renderMemberLeftEmail(orgVars);

    expect(text).toContain('組織「株式会社ほめゴハン」のメンバーが 1 人、ご本人の操作で脱退しました。');
    expect(text).toContain('このメールは、組織のオーナーにお送りしています。');
    expect(text).not.toContain('家族グループ');
  });

  it('本文: メンバー管理画面の URL が単独の行になっている (メーラーの自動リンクが効く)', () => {
    for (const vars of [familyVars, orgVars]) {
      expect(renderMemberLeftEmail(vars).text.split('\n')).toContain(vars.members_url);
    }
  });

  it('本文: 問い合わせ先と署名がある (family-transfer-completed と同じ書式)', () => {
    const { text } = renderMemberLeftEmail(familyVars);

    expect(text).toContain('support@homegohan.app');
    expect(text.trimEnd().endsWith('ほめゴハン\nhttps://homegohan.app')).toBe(true);
  });

  it('本文: 脱退した人を特定する個人情報は載せない。メールアドレスは問い合わせ先だけ', () => {
    for (const vars of [familyVars, orgVars]) {
      const { subject, text } = renderMemberLeftEmail(vars);

      expect(addressesIn(text)).toEqual(['support@homegohan.app']);
      expect(subject).not.toContain('@');
      // 宛先本人のアドレスも、本文には書かない
      expect(text).not.toContain(vars.to_email);
    }
  });

  it('未設定の値が「undefined」「null」として本文・件名に出ない', () => {
    for (const vars of [familyVars, orgVars]) {
      const { subject, text } = renderMemberLeftEmail(vars);

      expect(`${subject}\n${text}`).not.toMatch(/undefined|null|\[object/);
    }
  });

  it('名前を読めなかったとき (scope_name が null / 空) は、名前を省いた文面にする', () => {
    for (const scope_name of [null, '', '   ']) {
      const family = renderMemberLeftEmail({ ...familyVars, scope_name });
      const org = renderMemberLeftEmail({ ...orgVars, scope_name });

      expect(family.subject).toBe('【ほめゴハン】家族グループからメンバーが脱退しました');
      expect(family.text).toContain('家族グループのメンバーが 1 人、ご本人の操作で脱退しました。');
      expect(family.text).not.toContain('「');
      expect(org.subject).toBe('【ほめゴハン】組織からメンバーが脱退しました');
      expect(org.text).toContain('組織のメンバーが 1 人、ご本人の操作で脱退しました。');
      expect(EmailEnvelopeSchema.safeParse(family).success).toBe(true);
    }
  });

  it('名前が長くても件名は 100 文字以内に収まり (送信時の検証で落ちない)、本文には名前を省略せず載せる', () => {
    const longName = '長い名前'.repeat(60);
    const envelope = renderMemberLeftEmail({ ...orgVars, scope_name: longName });

    expect(envelope.subject.length).toBeLessThanOrEqual(100);
    expect(envelope.subject.startsWith('【ほめゴハン】組織「')).toBe(true);
    expect(envelope.subject.endsWith('」からメンバーが脱退しました')).toBe(true);
    expect(envelope.subject).toContain('…');
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.text).toContain(`組織「${longName}」のメンバーが 1 人`);
  });

  it('絵文字など 2 文字分の文字だけの長い名前でも、件名は 100 文字以内に収まり、文字の途中で切れない', () => {
    const envelope = renderMemberLeftEmail({ ...familyVars, scope_name: '😀'.repeat(100) });

    expect(envelope.subject.length).toBeLessThanOrEqual(100);
    expect(envelope.subject).toContain(`「${'😀'.repeat(30)}…」`);
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('名前に改行などの制御文字が入っていても、件名は 1 行に収まる', () => {
    const envelope = renderMemberLeftEmail({ ...familyVars, scope_name: '山田家\r\nBcc: attacker\t家' });

    expect(envelope.subject).not.toMatch(/[\r\n\t]/);
    expect(envelope.subject).toBe('【ほめゴハン】家族グループ「山田家 Bcc: attacker 家」からメンバーが脱退しました');
  });
});
