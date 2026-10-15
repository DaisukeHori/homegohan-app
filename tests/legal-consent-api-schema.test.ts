/**
 * 同意ゲート (#1442) の API の本文の Zod スキーマ (src/lib/legal-consent-api.ts) のテスト
 * (設計書 docs/design/cross/13a-legal-consent-api-server.md §6.14 B)
 *
 *   - LegalConsentRequiredBodySchema: middleware が返す 403 の本文 { error, code } (strict)
 *   - LegalConsentStatusSchema: GET /api/legal/status の応答 (required = enforced && !accepted を refine で固定)
 */
import { describe, expect, it } from 'vitest';
import {
  LEGAL_CONSENT_REQUIRED_CODE,
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  LEGAL_DOCUMENTS,
  legalConsentRequiredBody,
  resolveLegalConsentStatus,
  type AcceptedLegalVersions,
} from '@homegohan/shared';
import { LegalConsentRequiredBodySchema, LegalConsentStatusSchema } from '@/lib/legal-consent-api';

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;

const ACCEPTED_CASES: ReadonlyArray<[string, AcceptedLegalVersions | null]> = [
  ['未同意', null],
  ['旧版に同意', { terms_version_accepted: 'v0-old', privacy_version_accepted: CURRENT_PRIVACY }],
  ['同意済み', { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY }],
];

describe('LegalConsentRequiredBodySchema (T-S1)', () => {
  it('LegalConsentRequiredBodySchema: legalConsentRequiredBody() を通し、余分なキー・別の文・別のコードは通さない (strict)', () => {
    expect(LegalConsentRequiredBodySchema.safeParse(legalConsentRequiredBody()).success).toBe(true);

    const rejected: unknown[] = [
      { ...legalConsentRequiredBody(), detail: 'x' },
      { error: '同意が必要です', code: LEGAL_CONSENT_REQUIRED_CODE },
      { error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: 'AI_CONSENT_REQUIRED' },
      { error: { code: LEGAL_CONSENT_REQUIRED_CODE, message: LEGAL_CONSENT_REQUIRED_MESSAGE } },
      { code: LEGAL_CONSENT_REQUIRED_CODE },
      null,
    ];
    for (const body of rejected) {
      expect(LegalConsentRequiredBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('LegalConsentStatusSchema (T-S2・T-S3)', () => {
  it.each(ACCEPTED_CASES)(
    'LegalConsentStatusSchema: resolveLegalConsentStatus の結果 (未同意 / 旧版 / 同意済み × enforced の 2 値) を通す — %s',
    (_name, accepted) => {
      for (const enforced of [true, false]) {
        const status = resolveLegalConsentStatus({ accepted, enforced });
        const parsed = LegalConsentStatusSchema.safeParse(status);
        expect(parsed.success, `enforced=${enforced}`).toBe(true);
        if (parsed.success) expect(parsed.data).toEqual(status);
      }
    },
  );

  it('LegalConsentStatusSchema: required が enforced && !accepted と食い違う応答は通さない', () => {
    const notAccepted = resolveLegalConsentStatus({ accepted: null, enforced: true });
    const accepted = resolveLegalConsentStatus({
      accepted: { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY },
      enforced: true,
    });
    const off = resolveLegalConsentStatus({ accepted: null, enforced: false });

    expect(LegalConsentStatusSchema.safeParse({ ...notAccepted, required: false }).success).toBe(false);
    expect(LegalConsentStatusSchema.safeParse({ ...accepted, required: true }).success).toBe(false);
    expect(LegalConsentStatusSchema.safeParse({ ...off, required: true }).success).toBe(false);
    // 形の崩れ (余分なキー・版の形式外・施行日の形式外) も通さない
    expect(LegalConsentStatusSchema.safeParse({ ...notAccepted, extra: 1 }).success).toBe(false);
    expect(
      LegalConsentStatusSchema.safeParse({
        ...notAccepted,
        current: { ...notAccepted.current, terms_of_service: { version: 'v 1', effective_date: '2025-01-01' } },
      }).success,
    ).toBe(false);
    expect(
      LegalConsentStatusSchema.safeParse({
        ...notAccepted,
        current: { ...notAccepted.current, privacy_policy: { version: 'v1', effective_date: '2025/01/01' } },
      }).success,
    ).toBe(false);
  });
});
