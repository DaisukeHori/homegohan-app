/**
 * account-credentials.test.ts
 * apps/mobile/src/lib/account-credentials.ts のテスト (#1187)
 *
 * ログイン中のパスワード変更・メールアドレス変更。Web (src/app/(main)/settings/account/page.tsx) と同じ流れであること:
 *   パスワード: 現在のパスワードで再認証 → updateUser({ password }) → signOut({ scope: 'others' })
 *   メール    : updateUser({ email }, { emailRedirectTo: アプリのメール確認の画面 })
 *
 * エラーの形 (name / status / code / message) は、Web のテスト (src/lib/auth/__tests__/account-errors.test.ts) と同じく、
 * ローカルの Supabase Auth (GoTrue v2.183.0) が実際に返した値。
 */

import { CAPTCHA_FAILED_MESSAGE } from '@homegohan/shared';

const mockSignInWithPassword = jest.fn();
const mockUpdateUser = jest.fn();
const mockSignOut = jest.fn();
// 呼ばれた順番 (再認証 → 更新 → 他の端末のログアウト)
let mockCallOrder: string[] = [];

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => {
        mockCallOrder.push('signInWithPassword');
        return mockSignInWithPassword(...args);
      },
      updateUser: (...args: unknown[]) => {
        mockCallOrder.push('updateUser');
        return mockUpdateUser(...args);
      },
      signOut: (...args: unknown[]) => {
        mockCallOrder.push('signOut');
        return mockSignOut(...args);
      },
    },
  },
}));

jest.mock('expo-linking', () => ({
  createURL: (path: string) => `homegohan://${path.replace(/^\//, '')}`,
}));

import {
  EMAIL_CHANGE_REDIRECT_PATH,
  changePassword,
  requestEmailChange,
} from '../../src/lib/account-credentials';

const EMAIL = 'user@example.com';
const VALID_INPUT = { currentPassword: 'oldPass123', newPassword: 'newPass456', confirmPassword: 'newPass456' };

const invalidCredentials = { name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' };
const weakPassword = { name: 'AuthWeakPasswordError', status: 422, code: 'weak_password', message: 'weak', reasons: ['pwned'] };
const emailExists = {
  name: 'AuthApiError',
  status: 422,
  code: 'email_exists',
  message: 'A user with this email address has already been registered',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCallOrder = [];
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockSignInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  mockUpdateUser.mockResolvedValue({ data: { user: {} }, error: null });
  mockSignOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('changePassword — 成功', () => {
  it('現在のパスワードで再認証 → 新しいパスワードへ更新 → この端末以外をログアウト、の順に呼ぶ', async () => {
    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: true, othersSignedOut: true });
    expect(mockCallOrder).toEqual(['signInWithPassword', 'updateUser', 'signOut']);
    expect(mockSignInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: 'oldPass123' });
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'newPass456' });
    // 'others': 操作中の端末のセッションは残す (全端末の 'global' や、この端末だけの 'local' ではない)
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'others' });
  });

  it('他の端末のログアウトがエラーを返しても、パスワードは変わっているので成功にし、確認できなかったことを返す', async () => {
    mockSignOut.mockResolvedValue({ error: { name: 'AuthRetryableFetchError', status: 0, message: 'Network request failed' } });

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: true, othersSignedOut: false });
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it('他の端末のログアウトが例外を投げても、成功にし、確認できなかったことを返す', async () => {
    mockSignOut.mockRejectedValue(new TypeError('Network request failed'));

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: true, othersSignedOut: false });
  });
});

describe('changePassword — 再認証の失敗', () => {
  it('現在のパスワードが違う: 「現在のパスワードが正しくありません。」を返し、更新もログアウトも呼ばない', async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { session: null }, error: invalidCredentials });

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: false, message: '現在のパスワードが正しくありません。' });
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('CAPTCHA に断られた: パスワード違いと取り違えず、ボットの確認の文言を返す', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { name: 'AuthApiError', status: 400, code: 'captcha_failed', message: 'captcha verification process failed' },
    });

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: false, message: CAPTCHA_FAILED_MESSAGE });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('再認証で通信が例外になった: 通信の失敗の文言を返し、更新しない', async () => {
    mockSignInWithPassword.mockRejectedValue(new TypeError('Network request failed'));

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      message: '通信に失敗しました。ネットワークの状態を確認して、もう一度お試しください。',
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

describe('changePassword — 更新の失敗', () => {
  it('流出したことのあるパスワード: 理由を返し、他の端末のログアウトは呼ばない', async () => {
    mockUpdateUser.mockResolvedValue({ data: { user: null }, error: weakPassword });

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      message: 'このパスワードは過去に流出したことが確認されています。別のパスワードにしてください。',
    });
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('更新で例外になった: 更新の段の文言で返す (再認証の文言にしない)', async () => {
    mockUpdateUser.mockRejectedValue({ name: 'AuthApiError', status: 500, message: 'boom' });

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: false, message: 'パスワードを変更できませんでした。時間をおいて、もう一度お試しください。' });
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

describe('changePassword — 入力の検証 (API を呼ばずに止める。規則は Web と共通)', () => {
  it.each([
    [{ ...VALID_INPUT, currentPassword: '' }, '現在のパスワードを入力してください'],
    [{ ...VALID_INPUT, newPassword: '', confirmPassword: '' }, '新しいパスワードを入力してください'],
    [{ ...VALID_INPUT, confirmPassword: 'different789' }, '新しいパスワードと確認用のパスワードが一致しません'],
    [{ ...VALID_INPUT, newPassword: 'short1', confirmPassword: 'short1' }, 'パスワードは8文字以上で入力してください'],
    [{ ...VALID_INPUT, newPassword: 'onlyletters', confirmPassword: 'onlyletters' }, 'パスワードには数字を含めてください'],
    [{ ...VALID_INPUT, newPassword: 'oldPass123', confirmPassword: 'oldPass123' }, '新しいパスワードは、現在のパスワードと違うものにしてください'],
  ])('%j → %s', async (input, message) => {
    const result = await changePassword(EMAIL, input);

    expect(result).toEqual({ ok: false, message });
    expect(mockCallOrder).toEqual([]);
  });
});

describe('requestEmailChange', () => {
  it('小文字にそろえた新しいアドレスで updateUser を呼び、確認メールの戻り先をアプリのメール確認の画面にする', async () => {
    const result = await requestEmailChange('  New.Address@Example.COM ', EMAIL);

    expect(result).toEqual({ ok: true, sentTo: 'new.address@example.com' });
    expect(EMAIL_CHANGE_REDIRECT_PATH).toBe('/auth/verify');
    expect(mockUpdateUser).toHaveBeenCalledWith(
      { email: 'new.address@example.com' },
      { emailRedirectTo: 'homegohan://auth/verify' },
    );
    // メール変更では、ログアウトや再認証はしない
    expect(mockCallOrder).toEqual(['updateUser']);
  });

  it('使われているメールアドレス: 理由を日本語で返す', async () => {
    mockUpdateUser.mockResolvedValue({ data: { user: null }, error: emailExists });

    const result = await requestEmailChange('taken@example.com', EMAIL);

    expect(result).toEqual({
      ok: false,
      message: 'このメールアドレスは、すでに別のアカウントで使われています。別のメールアドレスを入力してください。',
    });
  });

  it('通信が例外になった: 通信の失敗の文言を返す', async () => {
    mockUpdateUser.mockRejectedValue(new TypeError('Network request failed'));

    const result = await requestEmailChange('new@example.com', EMAIL);

    expect(result).toEqual({
      ok: false,
      message: '通信に失敗しました。ネットワークの状態を確認して、もう一度お試しください。',
    });
  });

  it.each([
    ['   ', '新しいメールアドレスを入力してください'],
    ['not-an-email', 'メールアドレスの形式が正しくありません'],
    // Supabase は同じアドレスでもエラーにせず何もしないので、確認メールが届かないまま「送りました」と言わないよう止める
    [' USER@example.com ', '現在のメールアドレスと同じです。別のメールアドレスを入力してください'],
  ])('入力 %j は API を呼ばずに止める: %s', async (newEmail, message) => {
    const result = await requestEmailChange(newEmail, EMAIL);

    expect(result).toEqual({ ok: false, message });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});
