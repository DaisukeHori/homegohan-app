/**
 * 保護者の同意の控えのメール (#1173 / 設計書 docs/design/cross/14-parental-consent.md §6.5.5・§6.10 の T-EM1)
 * 件名・template・本文の項目を確かめる。生年月日・年齢・署名の氏名は載せない (メールは転送されうる)。
 */
import { describe, expect, it } from 'vitest';
import { renderFamilyParentalConsentRecordedEmail } from '@/lib/emails/membership/family-parental-consent-recorded';

const VARS = {
  email_address: 'hanako@example.com',
  family_name: '山田家',
  child_display_name: 'たろう',
  consent_version: 'v2026.1',
  signed_at: '2026-10-15T01:00:00.000Z',
  document_url: 'https://app.example.test/legal/parental-consent',
  members_url: 'https://app.example.test/family/members',
};

describe('renderFamilyParentalConsentRecordedEmail (T-EM1)', () => {
  it('件名・template・宛先と、本文に家族名・呼び名・版・2 つの URL・同意日時 (JST) が入る', () => {
    const envelope = renderFamilyParentalConsentRecordedEmail(VARS);
    expect(envelope.template).toBe('family_parental_consent_recorded');
    expect(envelope.subject).toBe('【ほめゴハン】保護者の同意を記録しました');
    expect(envelope.to).toBe(VARS.email_address);
    expect(envelope.text).toContain('山田家');
    expect(envelope.text).toContain('たろう');
    expect(envelope.text).toContain('v2026.1');
    expect(envelope.text).toContain(VARS.document_url);
    expect(envelope.text).toContain(VARS.members_url);
    // 2026-10-15T01:00Z は日本時間の 10:00
    expect(envelope.text).toContain('2026/10/15 10:00:00');
  });

  it('生年月日と署名の氏名は本文に入らない (変数に無い)', () => {
    const envelope = renderFamilyParentalConsentRecordedEmail(VARS);
    expect(envelope.text).not.toMatch(/生年月日/);
    expect(envelope.text).not.toMatch(/\d{4}-\d{2}-\d{2}(?!T)/);
    expect(envelope.text).not.toContain('署名');
    expect(Object.keys(VARS)).not.toContain('signed_name');
    expect(Object.keys(VARS)).not.toContain('birth_date');
  });
});
