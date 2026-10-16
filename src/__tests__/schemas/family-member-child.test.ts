/**
 * 子供の追加の Zod (#1173 / 設計書 docs/design/cross/14-parental-consent.md §6.5.3・§6.13 D の T-ZD1〜T-ZD3)
 * route の it とは別に、schema を直接 parse して確かめる。
 */
import { describe, expect, it } from 'vitest';
import { PARENTAL_CONSENT_DOCUMENT, SIGNED_NAME_MAX_LENGTH } from '@homegohan/shared';
import {
  AddFamilyChildBodySchema,
  AddFamilyChildResponseDataSchema,
  CHILD_DISPLAY_NAME_MAX_LENGTH,
  ParentalConsentInputSchema,
} from '@/schemas/membership/family-member';

const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const MEMBER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const CONSENT = { version: PARENTAL_CONSENT_DOCUMENT.version, signed_name: '山田 花子', guardian_attested: true };

describe('ParentalConsentInputSchema (T-ZD1)', () => {
  it('signed_name は前後の空白を除いて 1〜SIGNED_NAME_MAX_LENGTH 文字 (空白だけ・101 文字は失敗、前後の空白は除く)', () => {
    const trimmed = ParentalConsentInputSchema.parse({ ...CONSENT, signed_name: '  山田 花子  ' });
    expect(trimmed.signed_name).toBe('山田 花子');
    expect(ParentalConsentInputSchema.safeParse({ ...CONSENT, signed_name: '   ' }).success).toBe(false);
    expect(ParentalConsentInputSchema.safeParse({ ...CONSENT, signed_name: 'あ'.repeat(SIGNED_NAME_MAX_LENGTH + 1) }).success).toBe(false);
    expect(ParentalConsentInputSchema.safeParse({ ...CONSENT, signed_name: 'あ'.repeat(SIGNED_NAME_MAX_LENGTH) }).success).toBe(true);
  });

  it('guardian_attested は true だけ。version は PARENTAL_CONSENT_VERSION_PATTERN に合うものだけ。余計なキーは失敗 (.strict)', () => {
    expect(ParentalConsentInputSchema.safeParse({ ...CONSENT, guardian_attested: false }).success).toBe(false);
    expect(ParentalConsentInputSchema.safeParse({ ...CONSENT, version: 'v 1' }).success).toBe(false);
    expect(ParentalConsentInputSchema.safeParse({ ...CONSENT, version: 'x'.repeat(21) }).success).toBe(false);
    expect(ParentalConsentInputSchema.safeParse({ ...CONSENT, extra: 1 }).success).toBe(false);
    expect(ParentalConsentInputSchema.safeParse(CONSENT).success).toBe(true);
  });
});

describe('AddFamilyChildBodySchema (T-ZD2)', () => {
  const valid = { family_id: FAMILY_ID, display_name: 'たろう', birth_date: '2018-04-01' };

  it('birth_date は必須で形は YYYY-MM-DD (2000/01/01 は失敗。2001-02-30 は形としては通る = 暦の検査は route)', () => {
    expect(AddFamilyChildBodySchema.safeParse({ family_id: FAMILY_ID, display_name: 'たろう' }).success).toBe(false);
    expect(AddFamilyChildBodySchema.safeParse({ ...valid, birth_date: '2000/01/01' }).success).toBe(false);
    expect(AddFamilyChildBodySchema.safeParse({ ...valid, birth_date: '2001-02-30' }).success).toBe(true);
  });

  it('display_name は 1〜CHILD_DISPLAY_NAME_MAX_LENGTH 文字。child_profile を省くと {}。consent は省ける。余計なキーは失敗 (.strict)', () => {
    expect(CHILD_DISPLAY_NAME_MAX_LENGTH).toBe(60);
    expect(AddFamilyChildBodySchema.safeParse({ ...valid, display_name: '' }).success).toBe(false);
    expect(AddFamilyChildBodySchema.safeParse({ ...valid, display_name: 'あ'.repeat(CHILD_DISPLAY_NAME_MAX_LENGTH + 1) }).success).toBe(false);
    expect(AddFamilyChildBodySchema.safeParse({ ...valid, display_name: 'あ'.repeat(CHILD_DISPLAY_NAME_MAX_LENGTH) }).success).toBe(true);
    const parsed = AddFamilyChildBodySchema.parse(valid);
    expect(parsed.child_profile).toEqual({});
    expect(parsed.consent).toBeUndefined();
    expect(AddFamilyChildBodySchema.parse({ ...valid, consent: CONSENT }).consent).toEqual(CONSENT);
    expect(AddFamilyChildBodySchema.safeParse({ ...valid, user_id: MEMBER_ID }).success).toBe(false);
  });
});

describe('AddFamilyChildResponseDataSchema (T-ZD3)', () => {
  const member = {
    id: MEMBER_ID,
    family_id: FAMILY_ID,
    role: 'child',
    display_name: null,
    birth_date: '2018-04-01',
    user_id: null,
    child_profile: { gender: 'male' },
  };

  it('{ member: { id, family_id, role: child, display_name: null, birth_date, …他の列 }, consent_recorded } を受ける', () => {
    const parsed = AddFamilyChildResponseDataSchema.parse({ member, consent_recorded: true });
    expect(parsed.member).toMatchObject({ child_profile: { gender: 'male' }, user_id: null });
  });

  it('role が adult なら失敗、consent_recorded が無ければ失敗', () => {
    expect(AddFamilyChildResponseDataSchema.safeParse({ member: { ...member, role: 'adult' }, consent_recorded: true }).success).toBe(false);
    expect(AddFamilyChildResponseDataSchema.safeParse({ member }).success).toBe(false);
  });
});
