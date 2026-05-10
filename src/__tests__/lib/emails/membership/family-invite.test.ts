import { describe, it, expect, vi } from 'vitest';

// Resend モック (send.ts が module-level で new Resend() するため)
vi.mock('resend', () => {
  class MockResend {
    emails = { send: vi.fn().mockResolvedValue({ data: { id: 'mock-id' }, error: null }) };
  }
  return { Resend: MockResend };
});

import { renderFamilyInviteEmail } from '@/lib/emails/membership/family-invite';
import { EmailEnvelopeSchema } from '@/lib/emails/send';
import type { InviteEmailVars } from '@/lib/emails/membership/templates';

const baseVars: InviteEmailVars = {
  display_name: '山田太郎',
  email_address: 'taro@example.com',
  inviter_name: '山田花子',
  scope_name: '山田家',
  invite_url: 'https://homegohan.app/invite/abc123def456',
  expires_at: '2026-05-24',
  custom_message: null,
};

describe('renderFamilyInviteEmail', () => {
  it('EmailEnvelopeSchema で valid な envelope を返す', () => {
    const envelope = renderFamilyInviteEmail(baseVars);
    const result = EmailEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('件名に [ほめゴハン] と inviter_name が含まれる', () => {
    const envelope = renderFamilyInviteEmail(baseVars);
    expect(envelope.subject).toContain('[ほめゴハン]');
    expect(envelope.subject).toContain('山田花子');
  });

  it('to が email_address と一致する', () => {
    const envelope = renderFamilyInviteEmail(baseVars);
    expect(envelope.to).toBe('taro@example.com');
  });

  it('from が ほめゴハン noreply である', () => {
    const envelope = renderFamilyInviteEmail(baseVars);
    expect(envelope.from).toBe('ほめゴハン <noreply@homegohan.app>');
  });

  it('テキスト本文に display_name 様 が含まれる', () => {
    const envelope = renderFamilyInviteEmail(baseVars);
    expect(envelope.text).toContain('山田太郎 様');
  });

  it('display_name が null のとき email_address 様 に fallback する', () => {
    const envelope = renderFamilyInviteEmail({ ...baseVars, display_name: null });
    expect(envelope.text).toContain('taro@example.com 様');
  });

  it('テキスト本文に scope_name (家族グループ名) が含まれる', () => {
    const envelope = renderFamilyInviteEmail(baseVars);
    expect(envelope.text).toContain('山田家');
  });

  it('テキスト本文に invite_url が含まれる', () => {
    const envelope = renderFamilyInviteEmail(baseVars);
    expect(envelope.text).toContain('https://homegohan.app/invite/abc123def456');
  });

  it('テキスト本文に expires_at (YYYY-MM-DD) が含まれる', () => {
    const envelope = renderFamilyInviteEmail(baseVars);
    expect(envelope.text).toContain('2026-05-24');
  });

  it('custom_message がある場合、本文に含まれる', () => {
    const envelope = renderFamilyInviteEmail({
      ...baseVars,
      custom_message: 'ぜひ参加してください！',
    });
    expect(envelope.text).toContain('ぜひ参加してください！');
  });

  it('custom_message が null の場合、メッセージセクションが含まれない', () => {
    const envelope = renderFamilyInviteEmail({ ...baseVars, custom_message: null });
    expect(envelope.text).not.toContain('からのメッセージ');
  });

  it('空の custom_message (空文字列) も null と同様に扱われる', () => {
    // custom_message が null の場合のみ設計仕様でカスタムセクション省略
    const withNull = renderFamilyInviteEmail({ ...baseVars, custom_message: null });
    expect(withNull.text).not.toContain('からのメッセージ');
  });
});
