/**
 * appleSignIn.test.ts
 * apps/mobile/src/lib/appleSignIn.ts (docs/design/mobile/08-sign-in-with-apple.md §9.1・§11.5・§14.1)
 *
 * 本物の Apple・Supabase・API には繋がない (expo-apple-authentication・expo-crypto・supabase・getApi を差し替える)。
 */

import { Platform } from 'react-native';
import { APPLE_SIGN_IN_MESSAGES } from '@homegohan/shared';

// ---- Mocks (before any module imports) ----

const mockSignInAsync = jest.fn();
const mockIsAvailableAsync = jest.fn();
jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: (...args: any[]) => mockIsAvailableAsync(...args),
  signInAsync: (...args: any[]) => mockSignInAsync(...args),
  AppleAuthenticationButton: () => null,
  AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN', CONTINUE: 'CONTINUE', SIGN_UP: 'SIGN_UP' },
  AppleAuthenticationButtonStyle: { WHITE: 'WHITE', WHITE_OUTLINE: 'WHITE_OUTLINE', BLACK: 'BLACK' },
  AppleAuthenticationScope: { FULL_NAME: 'FULL_NAME', EMAIL: 'EMAIL' },
}));

const mockRandomUUID = jest.fn(() => 'raw-nonce');
const mockDigestStringAsync = jest.fn<(algorithm: string, value: string) => Promise<string>>();
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  digestStringAsync: (algorithm: string, value: string) => mockDigestStringAsync(algorithm, value),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

const mockSignInWithIdToken = jest.fn();
const mockUpdateUser = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithIdToken: (...args: any[]) => mockSignInWithIdToken(...args),
      updateUser: (...args: any[]) => mockUpdateUser(...args),
    },
  },
}));

const mockApiPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: (...args: any[]) => mockApiPost(...args) }),
}));

// ---- Module under test (after mocks) ----
import {
  APPLE_AUTHORIZATION_API_PATH,
  isAppleSignInAvailable,
  isAppleSignInEnabled,
  signInWithApple,
} from '../../src/lib/appleSignIn';

const originalFlag = process.env.EXPO_PUBLIC_APPLE_SIGN_IN;
let platformReplaced: jest.ReplaceProperty<typeof Platform.OS> | null = null;

function setPlatform(os: 'ios' | 'android') {
  platformReplaced?.restore();
  platformReplaced = jest.replaceProperty(Platform, 'OS', os);
}

/** Apple が返す認可の結果 (必要な列だけ上書きする) */
function credential(overrides: Record<string, unknown> = {}) {
  return {
    user: 'apple-user-1',
    identityToken: 'id-token-1',
    authorizationCode: 'auth-code-1',
    fullName: { givenName: '太郎', familyName: '山田' },
    email: 'relay@privaterelay.appleid.com',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  setPlatform('ios');
  process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
  mockRandomUUID.mockReturnValue('raw-nonce');
  mockDigestStringAsync.mockResolvedValue('hashed-nonce');
  mockIsAvailableAsync.mockResolvedValue(true);
  mockSignInAsync.mockResolvedValue(credential());
  mockSignInWithIdToken.mockResolvedValue({ data: { user: { user_metadata: {} } }, error: null });
  mockUpdateUser.mockResolvedValue({ error: null });
  mockApiPost.mockResolvedValue({ ok: true });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  platformReplaced?.restore();
  platformReplaced = null;
  if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_APPLE_SIGN_IN;
  else process.env.EXPO_PUBLIC_APPLE_SIGN_IN = originalFlag;
});

describe('isAppleSignInEnabled', () => {
  it.each(['on', 'ON', ' On ', '\ton\n'])('iOS で EXPO_PUBLIC_APPLE_SIGN_IN=%j なら true (大文字小文字と前後の空白は区別しない)', (value) => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = value;
    expect(isAppleSignInEnabled()).toBe(true);
  });

  it.each(['', '   ', 'off', 'true', '1', 'onn'])('iOS でも EXPO_PUBLIC_APPLE_SIGN_IN=%j なら false', (value) => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = value;
    expect(isAppleSignInEnabled()).toBe(false);
  });

  it('スイッチが未設定なら false', () => {
    delete process.env.EXPO_PUBLIC_APPLE_SIGN_IN;
    expect(isAppleSignInEnabled()).toBe(false);
  });

  it('スイッチが on でも Android は false', () => {
    setPlatform('android');
    expect(isAppleSignInEnabled()).toBe(false);
  });
});

describe('isAppleSignInAvailable', () => {
  it('有効で isAvailableAsync が true なら true', async () => {
    await expect(isAppleSignInAvailable()).resolves.toBe(true);
    expect(mockIsAvailableAsync).toHaveBeenCalledTimes(1);
  });

  it('有効でも isAvailableAsync が false なら false', async () => {
    mockIsAvailableAsync.mockResolvedValue(false);
    await expect(isAppleSignInAvailable()).resolves.toBe(false);
  });

  it('isAvailableAsync が投げたら false (投げ返さない)', async () => {
    mockIsAvailableAsync.mockRejectedValue(new Error('native module missing'));
    await expect(isAppleSignInAvailable()).resolves.toBe(false);
  });

  it('スイッチが off なら isAvailableAsync を呼ばずに false', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'off';
    await expect(isAppleSignInAvailable()).resolves.toBe(false);
    expect(mockIsAvailableAsync).not.toHaveBeenCalled();
  });

  it('Android は isAvailableAsync を呼ばずに false', async () => {
    setPlatform('android');
    await expect(isAppleSignInAvailable()).resolves.toBe(false);
    expect(mockIsAvailableAsync).not.toHaveBeenCalled();
  });
});

describe('signInWithApple', () => {
  it('nonce は randomUUID を SHA-256 にして Apple へ、raw を Supabase へ渡す', async () => {
    const outcome = await signInWithApple();

    expect(outcome).toEqual({ status: 'signed_in' });
    expect(mockDigestStringAsync).toHaveBeenCalledWith('SHA-256', 'raw-nonce');
    expect(mockSignInAsync).toHaveBeenCalledWith(expect.objectContaining({ nonce: 'hashed-nonce' }));
    expect(mockSignInWithIdToken).toHaveBeenCalledWith({ provider: 'apple', token: 'id-token-1', nonce: 'raw-nonce' });
    // hash 済みの値を Supabase へ、raw の値を Apple へ渡していない
    expect(mockSignInAsync.mock.calls[0][0].nonce).not.toBe('raw-nonce');
    expect(mockSignInWithIdToken.mock.calls[0][0].nonce).not.toBe('hashed-nonce');
  });

  it('requestedScopes は FULL_NAME と EMAIL', async () => {
    await signInWithApple();
    expect(mockSignInAsync.mock.calls[0][0].requestedScopes).toEqual(['FULL_NAME', 'EMAIL']);
  });

  it('ERR_REQUEST_CANCELED は cancelled (Supabase も API も呼ばない・アラートの文を持たない)', async () => {
    mockSignInAsync.mockRejectedValue({ code: 'ERR_REQUEST_CANCELED' });

    const outcome = await signInWithApple();

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(outcome).not.toHaveProperty('message');
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it.each(['ERR_REQUEST_FAILED', 'ERR_REQUEST_NOT_HANDLED', 'ERR_INVALID_RESPONSE'])(
    'ほかの Apple の失敗 (%s) は failed (APPLE_SIGN_IN_MESSAGES.failed)・Supabase を呼ばない',
    async (code) => {
      mockSignInAsync.mockRejectedValue({ code });

      await expect(signInWithApple()).resolves.toEqual({ status: 'failed', message: APPLE_SIGN_IN_MESSAGES.failed });
      expect(mockSignInWithIdToken).not.toHaveBeenCalled();
    },
  );

  it('code の無い例外・null の例外も failed (投げ返さない)', async () => {
    mockSignInAsync.mockRejectedValue(null);
    await expect(signInWithApple()).resolves.toEqual({ status: 'failed', message: APPLE_SIGN_IN_MESSAGES.failed });
    mockSignInAsync.mockRejectedValue(new Error('boom'));
    await expect(signInWithApple()).resolves.toEqual({ status: 'failed', message: APPLE_SIGN_IN_MESSAGES.failed });
  });

  it('identityToken が無ければ failed (noIdentityToken)・Supabase を呼ばない', async () => {
    mockSignInAsync.mockResolvedValue(credential({ identityToken: null }));

    await expect(signInWithApple()).resolves.toEqual({ status: 'failed', message: APPLE_SIGN_IN_MESSAGES.noIdentityToken });
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('signInWithIdToken の error は failed (GoTrue の英文を出さず固定の文)・名前の保存も API も呼ばない', async () => {
    mockSignInWithIdToken.mockResolvedValue({ data: { user: null }, error: { name: 'AuthApiError', message: 'Provider (issuer "https://appleid.apple.com") is not enabled' } });

    const outcome = await signInWithApple();

    expect(outcome).toEqual({ status: 'failed', message: APPLE_SIGN_IN_MESSAGES.failed });
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('初回 (fullName あり・user_metadata.full_name 無し) は updateUser({ data: { full_name, given_name, family_name } })', async () => {
    await signInWithApple();

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledWith({ data: { full_name: '太郎 山田', given_name: '太郎', family_name: '山田' } });
  });

  it('姓だけ・名だけでも保存する (空の側は null・full_name は届いた側だけ)', async () => {
    mockSignInAsync.mockResolvedValue(credential({ fullName: { givenName: '  ', familyName: '山田' } }));
    await signInWithApple();
    expect(mockUpdateUser).toHaveBeenCalledWith({ data: { full_name: '山田', given_name: null, family_name: '山田' } });
  });

  it('full_name が既にあれば updateUser を呼ばない', async () => {
    mockSignInWithIdToken.mockResolvedValue({ data: { user: { user_metadata: { full_name: '登録済みの名前' } } }, error: null });

    await expect(signInWithApple()).resolves.toEqual({ status: 'signed_in' });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('full_name が空白だけなら保存する (空とみなす)', async () => {
    mockSignInWithIdToken.mockResolvedValue({ data: { user: { user_metadata: { full_name: '   ' } } }, error: null });

    await signInWithApple();
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['fullName が null', null],
    ['givenName・familyName とも null', { givenName: null, familyName: null }],
    ['givenName・familyName とも空白', { givenName: ' ', familyName: '' }],
  ])('%s なら updateUser を呼ばない', async (_label, fullName) => {
    mockSignInAsync.mockResolvedValue(credential({ fullName }));

    await expect(signInWithApple()).resolves.toEqual({ status: 'signed_in' });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('updateUser が error を返しても signed_in (console.warn だけ・投げない・認可コードの登録は続けて呼ぶ。S-31)', async () => {
    mockUpdateUser.mockResolvedValue({ error: { name: 'AuthApiError', message: 'secret detail' } });

    const outcome = await signInWithApple();

    expect(outcome).toEqual({ status: 'signed_in' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not save the name'), 'AuthApiError');
    // 利用者の情報になりうる message はログに出さない
    expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain('secret detail');
    expect(mockApiPost).toHaveBeenCalledTimes(1);
  });

  it('認可コードを POST /api/auth/apple/authorization に送る (Bearer は getApi が付ける)', async () => {
    await signInWithApple();

    expect(APPLE_AUTHORIZATION_API_PATH).toBe('/api/auth/apple/authorization');
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/api/auth/apple/authorization', { authorization_code: 'auth-code-1' });
  });

  it('登録の API が失敗しても signed_in (console.warn だけ・投げない)', async () => {
    mockApiPost.mockRejectedValue(new Error('network down: token=secret-token'));

    await expect(signInWithApple()).resolves.toEqual({ status: 'signed_in' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not register the authorization code'), 'Error');
    // 例外の message (URL・トークンになりうる) はログに出さない
    expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain('secret-token');
  });

  it('authorizationCode が null なら API を呼ばない', async () => {
    mockSignInAsync.mockResolvedValue(credential({ authorizationCode: null }));

    await expect(signInWithApple()).resolves.toEqual({ status: 'signed_in' });
    expect(mockApiPost).not.toHaveBeenCalled();
  });
});
