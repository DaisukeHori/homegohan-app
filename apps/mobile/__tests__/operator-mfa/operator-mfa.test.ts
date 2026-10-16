/**
 * operator-mfa.test.ts
 * apps/mobile/src/lib/operator-mfa.ts のテスト (#1707 段 D。docs/design/cross/12-operator-mfa.md §16.2・§21.6)
 *
 * ネイティブのセッションの AAL を getAuthenticatorAssuranceLevel で読み、decideMobileOperatorGate で判定する。
 * 読めなければ OperatorMfaGateError。
 */
const mockGetAal = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: (...args: unknown[]) => mockGetAal(...args),
      },
    },
  },
}));

import { OperatorMfaGateError, resolveSessionMfaGate } from '../../src/lib/operator-mfa';

function aal(currentLevel: string | null, nextLevel: string | null) {
  return { data: { currentLevel, nextLevel, currentAuthenticationMethods: [] }, error: null };
}

beforeEach(() => {
  mockGetAal.mockReset();
});

describe('resolveSessionMfaGate', () => {
  it('getAuthenticatorAssuranceLevel の値で判定する: currentLevel aal2 → allow', async () => {
    mockGetAal.mockResolvedValue(aal('aal2', 'aal2'));
    await expect(resolveSessionMfaGate()).resolves.toBe('allow');
    expect(mockGetAal).toHaveBeenCalledTimes(1);
  });

  it('getAuthenticatorAssuranceLevel の値で判定する: nextLevel aal2 → verify', async () => {
    mockGetAal.mockResolvedValue(aal('aal1', 'aal2'));
    await expect(resolveSessionMfaGate()).resolves.toBe('verify');
  });

  it('getAuthenticatorAssuranceLevel の値で判定する: それ以外 → enroll_on_web', async () => {
    mockGetAal.mockResolvedValue(aal('aal1', 'aal1'));
    await expect(resolveSessionMfaGate()).resolves.toBe('enroll_on_web');
    mockGetAal.mockResolvedValue(aal(null, null));
    await expect(resolveSessionMfaGate()).resolves.toBe('enroll_on_web');
  });

  it('error か data が null なら OperatorMfaGateError', async () => {
    mockGetAal.mockResolvedValue({ data: null, error: new Error('network') });
    await expect(resolveSessionMfaGate()).rejects.toBeInstanceOf(OperatorMfaGateError);

    mockGetAal.mockResolvedValue({ data: null, error: null });
    await expect(resolveSessionMfaGate()).rejects.toBeInstanceOf(OperatorMfaGateError);

    // data があっても error があれば判定しない
    mockGetAal.mockResolvedValue({ data: aal('aal2', 'aal2').data, error: new Error('stale') });
    await expect(resolveSessionMfaGate()).rejects.toBeInstanceOf(OperatorMfaGateError);
  });

  it('呼び出しが例外を投げても OperatorMfaGateError にする', async () => {
    mockGetAal.mockRejectedValue(new TypeError('fetch failed'));
    const error = await resolveSessionMfaGate().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperatorMfaGateError);
    expect((error as Error).message).toBe('二段階認証の状態を確認できませんでした。');
    expect((error as Error).name).toBe('OperatorMfaGateError');
  });
});
