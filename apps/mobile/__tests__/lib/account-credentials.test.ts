/**
 * account-credentials.test.ts
 * apps/mobile/src/lib/account-credentials.ts のテスト (#1187・#1720 段 C)
 *
 * ログイン中のパスワード変更・メールアドレス変更。Web (src/app/(main)/settings/account/page.tsx) と同じ流れであること:
 *   パスワード: POST /api/auth/password/change を 1 回呼ぶ (Bearer だけ。cross/16 §16)。再認証 (signInWithPassword)・updateUser・signOut は呼ばない
 *   メール    : updateUser({ email }, { emailRedirectTo: アプリのメール確認の画面 })
 *
 * メールの変更のエラーの形 (name / status / code / message) は、Web のテスト (src/lib/auth/__tests__/account-errors.test.ts) と同じく、
 * ローカルの Supabase Auth (GoTrue v2.183.0) が実際に返した値。パスワードの変更の失敗は API の応答の本文 (cross/16 §19 の固定の文)。
 */

import { HttpNetworkError } from '@homegohan/core';
import { PASSWORD_MAX_BYTES, PASSWORD_TOO_LONG_MESSAGE } from '@homegohan/shared';

const mockSignInWithPassword = jest.fn();
const mockUpdateUser = jest.fn();
const mockSignOut = jest.fn();
const mockApiPost = jest.fn();
// 呼ばれた順番
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

// getApi().post の偽物。本物の HTTP の失敗は `HTTP <status> <statusText>: <本文の JSON>` の Error (@homegohan/core の createHttpClient)
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    post: (...args: unknown[]) => {
      mockCallOrder.push('api.post');
      return mockApiPost(...args);
    },
  }),
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

const emailExists = {
  name: 'AuthApiError',
  status: 422,
  code: 'email_exists',
  message: 'A user with this email address has already been registered',
};

/** createHttpClient が投げる HTTP の失敗の Error (本文は route の flat の形 { error, code }) */
function httpError(status: number, statusText: string, code: string, error: string): Error {
  return new Error(`HTTP ${status} ${statusText}: ${JSON.stringify({ error, code })}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallOrder = [];
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockUpdateUser.mockResolvedValue({ data: { user: {} }, error: null });
  mockApiPost.mockResolvedValue({ ok: true });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('changePassword — 成功', () => {
  it('POST /api/auth/password/change を 1 回呼び、Supabase の signInWithPassword / updateUser / signOut を呼ばない', async () => {
    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: true });
    expect(mockCallOrder).toEqual(['api.post']);
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/api/auth/password/change', {
      current_password: 'oldPass123',
      new_password: 'newPass456',
    });
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('成功は { ok: true } だけ (othersSignedOut を持たない)', async () => {
    const result = await changePassword(EMAIL, VALID_INPUT);
    expect(Object.keys(result)).toEqual(['ok']);
  });
});

describe('changePassword — API の失敗', () => {
  it('400 AUTH_CURRENT_PASSWORD_MISMATCH: 本文の「現在のパスワードが正しくありません。」を返す', async () => {
    mockApiPost.mockRejectedValue(
      httpError(400, 'Bad Request', 'AUTH_CURRENT_PASSWORD_MISMATCH', '現在のパスワードが正しくありません。'),
    );

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: false, message: '現在のパスワードが正しくありません。' });
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('422 VALID_PASSWORD_HISTORY: 本文の「最近使ったパスワードは使えません」を返す', async () => {
    mockApiPost.mockRejectedValue(
      httpError(422, 'Unprocessable Entity', 'VALID_PASSWORD_HISTORY', '最近使ったパスワードは使えません。別のパスワードにしてください。'),
    );

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: false, message: '最近使ったパスワードは使えません。別のパスワードにしてください。' });
  });

  it('403 AUTH_REAUTHENTICATION_REQUIRED: 本文の「もう一度ログインしてから」を返す', async () => {
    mockApiPost.mockRejectedValue(
      httpError(403, 'Forbidden', 'AUTH_REAUTHENTICATION_REQUIRED', '安全のため、もう一度ログインしてから変更してください。'),
    );

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: false, message: '安全のため、もう一度ログインしてから変更してください。' });
  });

  it('圏外 (HttpNetworkError): 通信の文言を返す', async () => {
    mockApiPost.mockRejectedValue(new HttpNetworkError('offline', 'raw offline'));

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      message: '通信できません。インターネットへの接続を確認して、もう一度お試しください。',
    });
  });

  it('失敗の中身を取り出せない (message も本文も無い): 共通の失敗の文言を返す', async () => {
    mockApiPost.mockRejectedValue({});

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: false, message: 'パスワードを変更できませんでした。時間をおいて、もう一度お試しください。' });
  });

  it('HTTP のエラーでない例外の英文 (Supabase Auth の文など) は出さず、共通の失敗の文言を返す (#1917 の続き)', async () => {
    mockApiPost.mockRejectedValue(new Error('Auth session missing!'));

    const result = await changePassword(EMAIL, VALID_INPUT);

    expect(result).toEqual({ ok: false, message: 'パスワードを変更できませんでした。時間をおいて、もう一度お試しください。' });
  });

  it('失敗のログにパスワード・本文を出さない (エラーの名前だけ)', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockApiPost.mockRejectedValue(
      httpError(400, 'Bad Request', 'AUTH_CURRENT_PASSWORD_MISMATCH', '現在のパスワードが正しくありません。'),
    );

    await changePassword(EMAIL, VALID_INPUT);

    const logged = JSON.stringify(consoleError.mock.calls);
    expect(consoleError).toHaveBeenCalled();
    expect(logged).not.toContain('oldPass123');
    expect(logged).not.toContain('newPass456');
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
    // #1864: GoTrue (bcrypt) が断る 72 バイト超。日本語は 1 文字 3 バイトなので 26 文字で超える
    [{ ...VALID_INPUT, newPassword: `a1${'x'.repeat(PASSWORD_MAX_BYTES - 1)}`, confirmPassword: `a1${'x'.repeat(PASSWORD_MAX_BYTES - 1)}` }, PASSWORD_TOO_LONG_MESSAGE],
    [{ ...VALID_INPUT, newPassword: `a1${'あ'.repeat(24)}`, confirmPassword: `a1${'あ'.repeat(24)}` }, PASSWORD_TOO_LONG_MESSAGE],
  ])('%j → %s', async (input, message) => {
    const result = await changePassword(EMAIL, input);

    expect(result).toEqual({ ok: false, message });
    expect(mockCallOrder).toEqual([]);
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('#1864 現在のパスワードが 72 バイトを超えていても止めず、そのまま API に送る (既存の利用者を締め出さない)', async () => {
    const longCurrent = `oldPass1${'y'.repeat(PASSWORD_MAX_BYTES)}`;
    const result = await changePassword(EMAIL, { ...VALID_INPUT, currentPassword: longCurrent });

    expect(result).toEqual({ ok: true });
    expect(mockApiPost).toHaveBeenCalledWith('/api/auth/password/change', {
      current_password: longCurrent,
      new_password: VALID_INPUT.newPassword,
    });
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
