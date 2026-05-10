// src/__tests__/lib/emails/membership/org-invite-existing.test.ts
// (設計書 04-email-templates.md §10)
import { describe, it, expect, vi } from 'vitest';

// resend モック (send.ts が top-level で new Resend() するため)
vi.mock('resend', () => {
  class MockResend {
    emails = { send: vi.fn() };
  }
  return { Resend: MockResend };
});

import { renderOrgInviteExistingEmail } from '@/lib/emails/membership/org-invite-existing';
import { EmailEnvelopeSchema } from '@/lib/emails/send';
import type { InviteEmailVars } from '@/lib/emails/membership/templates';

const baseVars: InviteEmailVars = {
  display_name: '山田太郎',
  email_address: 'taro@example.com',
  inviter_name: '田中花子',
  scope_name: 'ABC 株式会社',
  invite_url: 'https://homegohan.app/invite/abc123deadbeefabc123deadbeef0000000000000000000000000000000000000',
  expires_at: '2026-05-24',
  custom_message: null,
};

describe('renderOrgInviteExistingEmail', () => {
  it('Zod EmailEnvelope として valid', () => {
    const envelope = renderOrgInviteExistingEmail(baseVars);
    const result = EmailEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('件名に [ほめゴハン] を含む', () => {
    const { subject } = renderOrgInviteExistingEmail(baseVars);
    expect(subject).toContain('[ほめゴハン]');
  });

  it('件名に scope_name を含む', () => {
    const { subject } = renderOrgInviteExistingEmail(baseVars);
    expect(subject).toContain('ABC 株式会社');
  });

  it('本文に display_name 様を含む', () => {
    const { text } = renderOrgInviteExistingEmail(baseVars);
    expect(text).toContain('山田太郎 様');
  });

  it('本文に inviter_name を含む', () => {
    const { text } = renderOrgInviteExistingEmail(baseVars);
    expect(text).toContain('田中花子 様');
  });

  it('本文に invite_url を含む', () => {
    const { text } = renderOrgInviteExistingEmail(baseVars);
    expect(text).toContain(baseVars.invite_url);
  });

  it('本文に expires_at を含む', () => {
    const { text } = renderOrgInviteExistingEmail(baseVars);
    expect(text).toContain('2026-05-24');
  });

  it('display_name が null の場合は email_address を使う', () => {
    const { text } = renderOrgInviteExistingEmail({ ...baseVars, display_name: null });
    expect(text).toContain('taro@example.com 様');
  });

  it('custom_message がある場合は本文に含まれる', () => {
    const { text } = renderOrgInviteExistingEmail({
      ...baseVars,
      custom_message: '一緒に頑張りましょう！',
    });
    expect(text).toContain('一緒に頑張りましょう！');
    expect(text).toContain('田中花子 様からのメッセージ:');
  });

  it('custom_message が null の場合はメッセージセクションなし', () => {
    const { text } = renderOrgInviteExistingEmail(baseVars);
    expect(text).not.toContain('からのメッセージ:');
  });

  it('from が ほめゴハン <noreply@homegohan.app>', () => {
    const { from } = renderOrgInviteExistingEmail(baseVars);
    expect(from).toBe('ほめゴハン <noreply@homegohan.app>');
  });

  it('to が email_address', () => {
    const { to } = renderOrgInviteExistingEmail(baseVars);
    expect(to).toBe('taro@example.com');
  });
});
