/**
 * lib/legal-consent-minor.ts の withMinorGuardianStatus (#1173 / 設計書 docs/design/cross/14-parental-consent.md §6.5.8 の T-MG1)
 *
 * 18 歳未満の本人のときだけ rpc('legal_minor_has_guardian_path') を 1 回聞き、minor_guardian_ok に入れて返す。
 * 行が無い・生年月日が無い・18 歳以上では DB に聞かず、受け取った値をそのまま返す。失敗は素通り (true)。
 * 環境変数は使わない (今日は today の引数で渡す)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_DOCUMENTS } from '@homegohan/shared';
import { withMinorGuardianStatus } from '@/lib/legal-consent-minor';

const TODAY = '2026-10-16';
const BIRTH_DATE_17 = '2008-10-17';
const BIRTH_DATE_18_TODAY = '2008-10-16';
const ADULT_BIRTH_DATE = '1990-01-01';
const VERSIONS = {
  terms_version_accepted: LEGAL_DOCUMENTS.terms_of_service.version,
  privacy_version_accepted: LEGAL_DOCUMENTS.privacy_policy.version,
};

const rpc = vi.fn();
const client = { rpc } as unknown as Parameters<typeof withMinorGuardianStatus>[0];

beforeEach(() => {
  rpc.mockReset();
});

describe('withMinorGuardianStatus (T-MG1)', () => {
  it.each([
    ['profile が null', null],
    ['profile が undefined', undefined],
    ['birth_date なし', { ...VERSIONS, birth_date: null }],
    ['18 歳以上', { ...VERSIONS, birth_date: ADULT_BIRTH_DATE }],
    ['今日が誕生日の 18 歳', { ...VERSIONS, birth_date: BIRTH_DATE_18_TODAY }],
  ])('%s では rpc を呼ばずに同じ値を返す', async (_name, profile) => {
    const result = await withMinorGuardianStatus(client, profile, TODAY);
    expect(result).toBe(profile);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['data が true', { data: true, error: null }, true],
    ['data が false', { data: false, error: null }, false],
    ['data が null', { data: null, error: null }, false],
    ['error (素通り)', { data: null, error: { message: 'boom' } }, true],
  ])('17 歳では rpc(legal_minor_has_guardian_path) を 1 回呼ぶ — %s なら minor_guardian_ok = %s。元の列はそのまま残る', async (_name, response, expected) => {
    rpc.mockResolvedValue(response);
    const profile = { ...VERSIONS, birth_date: BIRTH_DATE_17, roles: ['user'] };

    const result = await withMinorGuardianStatus(client, profile, TODAY);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('legal_minor_has_guardian_path');
    expect(result).toEqual({ ...profile, minor_guardian_ok: expected });
    // 渡した profile は書き換えない
    expect(profile).not.toHaveProperty('minor_guardian_ok');
  });
});
