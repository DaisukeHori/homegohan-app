// src/__tests__/lib/emails/membership/org-invite-new.test.ts
// (設計書 04-email-templates.md §10)
import { describe, it, expect, vi } from 'vitest';

// resend モック (send.ts が top-level で new Resend() するため)
vi.mock('resend', () => {
  class MockResend {
    emails = { send: vi.fn() };
  }
  return { Resend: MockResend };
});

import { renderOrgInviteNewEmail } from '@/lib/emails/membership/org-invite-new';
import { EmailEnvelopeSchema } from '@/lib/emails/send';
import type { InviteEmailVars } from '@/lib/emails/membership/templates';

const baseVars: InviteEmailVars = {
  display_name: null,  // 新規ユーザは null
  email_address: 'alice@example.com',
  inviter_name: '田中花子',
  scope_name: 'XYZ 株式会社',
  invite_url: 'https://homegohan.app/invite/xyz789deadbeefabc123deadbeef0000000000000000000000000000000000000',
  expires_at: '2026-06-01',
  custom_message: null,
};

describe('renderOrgInviteNewEmail', () => {
  it('Zod EmailEnvelope として valid', () => {
    const envelope = renderOrgInviteNewEmail(baseVars);
    const result = EmailEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('件名に [ほめゴハン] を含む', () => {
    const { subject } = renderOrgInviteNewEmail(baseVars);
    expect(subject).toContain('[ほめゴハン]');
  });

  it('件名に scope_name を含む', () => {
    const { subject } = renderOrgInviteNewEmail(baseVars);
    expect(subject).toContain('XYZ 株式会社');
  });

  it('件名に アカウント作成 文言を含む', () => {
    const { subject } = renderOrgInviteNewEmail(baseVars);
    expect(subject).toContain('アカウントを作成して参加');
  });

  it('本文に email_address を greeting として含む', () => {
    const { text } = renderOrgInviteNewEmail(baseVars);
    expect(text).toContain('alice@example.com 様');
  });

  it('本文に inviter_name を含む', () => {
    const { text } = renderOrgInviteNewEmail(baseVars);
    expect(text).toContain('田中花子 様');
  });

  it('本文に invite_url を含む', () => {
    const { text } = renderOrgInviteNewEmail(baseVars);
    expect(text).toContain(baseVars.invite_url);
  });

  it('本文に expires_at を含む', () => {
    const { text } = renderOrgInviteNewEmail(baseVars);
    expect(text).toContain('2026-06-01');
  });

  it('custom_message がある場合は本文に含まれる', () => {
    const { text } = renderOrgInviteNewEmail({
      ...baseVars,
      custom_message: 'ぜひ参加してください！',
    });
    expect(text).toContain('ぜひ参加してください！');
  });

  it('custom_message が null の場合はメッセージセクションなし', () => {
    const { text } = renderOrgInviteNewEmail(baseVars);
    expect(text).not.toContain('からのメッセージ:');
  });

  it('from が ほめゴハン <noreply@homegohan.app>', () => {
    const { from } = renderOrgInviteNewEmail(baseVars);
    expect(from).toBe('ほめゴハン <noreply@homegohan.app>');
  });

  it('to が email_address', () => {
    const { to } = renderOrgInviteNewEmail(baseVars);
    expect(to).toBe('alice@example.com');
  });
});
