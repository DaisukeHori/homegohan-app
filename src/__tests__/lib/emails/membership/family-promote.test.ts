import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// Resend モック (send.ts が resend を import するため)
vi.mock('resend', () => {
  class MockResend {
    emails = { send: vi.fn().mockResolvedValue({ data: { id: 'mock-id' }, error: null }) };
  }
  return { Resend: MockResend };
});

import { renderFamilyPromoteEmail } from '@/lib/emails/membership/family-promote';
import type { FamilyPromoteEmailVars } from '@/lib/emails/membership/family-promote';
import { EmailEnvelopeSchema } from '@/lib/emails/send';
import { DEFAULT_EMAIL_FROM } from '@/lib/site-config';

const acceptUrl = `https://app.example.test/family/promotions/${'a'.repeat(64)}`;

const baseVars: FamilyPromoteEmailVars = {
  email_address: 'taro@example.com',
  family_name: '山田家',
  member_display_name: 'たろう',
  requester_name: '山田花子',
  accept_url: acceptUrl,
  expires_at: '2026-10-21T02:00:00.000Z',
};

// 送信元の既定値 (src/lib/site-config.ts) を確かめるテスト。手元の EMAIL_FROM に左右されないよう未設定から始める
beforeEach(() => {
  vi.stubEnv('EMAIL_FROM', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderFamilyPromoteEmail', () => {
  it('EmailEnvelopeSchema で valid な envelope を返す', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    const result = EmailEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('to が email_address (対象者本人) と一致する', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    expect(envelope.to).toBe('taro@example.com');
  });

  it('件名が「家族グループへの参加確認のお願い」である', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    expect(envelope.subject).toBe('【ほめゴハン】家族グループへの参加確認のお願い');
  });

  it('from が ほめゴハン noreply である', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    expect(envelope.from).toBe(DEFAULT_EMAIL_FROM);
  });

  it('テキスト本文に email_address 様 が含まれる', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    expect(envelope.text).toContain('taro@example.com 様');
  });

  it('テキスト本文に accept_url (token 入りの承認ページ URL) が含まれる', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    expect(envelope.text).toContain(acceptUrl);
  });

  it('accept_url が本文中で単独の行になっている (メーラーの自動リンクが効く)', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    expect(envelope.text.split('\n')).toContain(acceptUrl);
  });

  it('テキスト本文に requester_name (依頼者) が含まれる', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    expect(envelope.text).toContain('山田花子');
  });

  it('テキスト本文に family_name (家族グループ名) が含まれる', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    expect(envelope.text).toContain('山田家');
  });

  it('テキスト本文に member_display_name (紐付け先のメンバー名) が含まれる', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    expect(envelope.text).toContain('たろう');
  });

  it('テキスト本文に有効期限が日本時間の toLocaleDateString("ja-JP") 形式の日付で含まれる', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    const expiresDate = new Date(baseVars.expires_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
    expect(envelope.text).toContain(`${expiresDate} まで有効です`);
    // ISO 文字列のまま本文に出さない
    expect(envelope.text).not.toContain(baseVars.expires_at);
  });

  it('有効期限の日付はサーバーのタイムゾーンによらず日本時間で決まる (UTC 16:00 は翌日)', () => {
    // 2026-10-21T16:00Z は日本時間 2026-10-22 01:00
    const envelope = renderFamilyPromoteEmail({ ...baseVars, expires_at: '2026-10-21T16:00:00.000Z' });
    expect(envelope.text).toContain('2026/10/22 まで有効です');
    expect(envelope.text).not.toContain('2026/10/21 まで有効です');
  });

  it('旧「アカウント発行通知」の文面 (アカウントが発行されました) を含まない', () => {
    const envelope = renderFamilyPromoteEmail(baseVars);
    expect(envelope.subject).not.toContain('アカウントが発行されました');
    expect(envelope.text).not.toContain('アカウントが発行されました');
  });
});
