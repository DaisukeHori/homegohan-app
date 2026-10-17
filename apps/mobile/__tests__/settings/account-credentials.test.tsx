/**
 * account-credentials.test.tsx
 * 設定 → アカウント管理 の「パスワードを変更」「メールアドレスを変更」(apps/mobile/src/components/settings/AccountCredentialsSection.tsx) の RNTL テスト (#1187・#1720 段 C)
 *
 *  1. メールアドレスとパスワードでログインしている人には、2 つのフォームを出す
 *  2. Google でログインしている人にはフォームを出さず、案内だけを出す
 *  3. パスワード変更: パスワードの変更の API を 1 回呼び、成功を表示して入力を消す (再認証・updateUser・signOut は呼ばない)
 *  4. パスワード変更: 現在のパスワードが違えば (400)、理由を表示して入力は残す
 *  5. メール変更: 確認メールを送り、送り先と「両方の確認」の案内を表示する
 *  6. ログイン情報を読み込めないときは、もう一度読み込める
 *
 * 変更の処理 (src/lib/account-credentials.ts) は実物を通し、その先の supabase と API (getApi) をモックにする。
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockGetUser = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockUpdateUser = jest.fn();
const mockSignOut = jest.fn();
const mockApiPost = jest.fn();
let mockCallOrder: string[] = [];

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
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

jest.mock('../../src/lib/siteConfig', () => ({
  getSupportMailtoUrl: () => 'mailto:support@example.com',
}));

import { AccountCredentialsSection } from '../../src/components/settings/AccountCredentialsSection';

const EMAIL = 'user@example.com';

function emailUser() {
  return { data: { user: { id: 'u1', email: EMAIL, app_metadata: { provider: 'email' } } }, error: null };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallOrder = [];
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockGetUser.mockResolvedValue(emailUser());
  mockSignInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  mockUpdateUser.mockResolvedValue({ data: { user: {} }, error: null });
  mockSignOut.mockResolvedValue({ error: null });
  mockApiPost.mockResolvedValue({ ok: true });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function fillPasswordForm(current: string, next: string, confirm: string) {
  fireEvent.changeText(screen.getByTestId('account-current-password'), current);
  fireEvent.changeText(screen.getByTestId('account-new-password'), next);
  fireEvent.changeText(screen.getByTestId('account-confirm-password'), confirm);
}

describe('AccountCredentialsSection — 表示の出し分け', () => {
  it('1. メールアドレスとパスワードでログインしている人には、ログイン情報と 2 つのフォームを出す', async () => {
    render(<AccountCredentialsSection />);

    expect(await screen.findByTestId('account-password-section')).toBeTruthy();
    expect(screen.getByTestId('account-email-section')).toBeTruthy();
    expect(screen.getByTestId('account-current-email').props.children).toBe(EMAIL);
    expect(screen.queryByTestId('account-external-provider-guidance')).toBeNull();
    // 入力欄はパスワードを伏せて表示する
    expect(screen.getByTestId('account-current-password').props.secureTextEntry).toBe(true);
  });

  it('2. Google でログインしている人には、フォームを出さず案内だけを出す', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'g@example.com', app_metadata: { provider: 'google' } } },
      error: null,
    });

    render(<AccountCredentialsSection />);

    expect(await screen.findByTestId('account-external-provider-guidance')).toBeTruthy();
    expect(screen.getByText('Googleアカウントでログインしています')).toBeTruthy();
    expect(screen.queryByTestId('account-password-section')).toBeNull();
    expect(screen.queryByTestId('account-email-section')).toBeNull();
  });

  it('6. ログイン情報を読み込めないときは、エラーを出し、「もう一度読み込む」で読み込み直す', async () => {
    mockGetUser.mockRejectedValueOnce(new TypeError('Network request failed'));

    render(<AccountCredentialsSection />);

    expect(await screen.findByTestId('account-load-error')).toBeTruthy();
    fireEvent.press(screen.getByTestId('account-load-retry'));
    expect(await screen.findByTestId('account-password-section')).toBeTruthy();
    expect(mockGetUser).toHaveBeenCalledTimes(2);
  });

  it('ログインの有効期限が切れているときは、フォームを出さずにログインし直しを案内する', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' },
    });

    render(<AccountCredentialsSection />);

    expect(await screen.findByTestId('account-signed-out')).toBeTruthy();
    expect(screen.queryByTestId('account-password-section')).toBeNull();
  });
});

describe('AccountCredentialsSection — パスワードの変更', () => {
  it('3. パスワードの変更の API を 1 回呼び、成功を表示して入力を消す', async () => {
    render(<AccountCredentialsSection />);
    await screen.findByTestId('account-password-section');

    fillPasswordForm('oldPass123', 'newPass456', 'newPass456');
    fireEvent.press(screen.getByTestId('account-password-submit'));

    expect(await screen.findByTestId('password-change-success')).toBeTruthy();
    expect(mockCallOrder).toEqual(['api.post']);
    expect(mockApiPost).toHaveBeenCalledWith('/api/auth/password/change', {
      current_password: 'oldPass123',
      new_password: 'newPass456',
    });
    // 再認証・updateUser・signOut は使わない (他の端末の失効は GoTrue が更新と同じトランザクションで行う)
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    // 成功の帯は常に「この端末以外のログインはすべて解除しました」(確認できなかった枝は無い)
    expect(
      screen.getByText(
        'セキュリティのため、この端末以外のログインはすべて解除しました。他の端末では、新しいパスワードでログインし直してください。',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/確認できませんでした/)).toBeNull();
    expect(screen.getByTestId('account-current-password').props.value).toBe('');
    expect(screen.getByTestId('account-new-password').props.value).toBe('');
    expect(screen.getByTestId('account-confirm-password').props.value).toBe('');
  });

  it('4. 現在のパスワードが違えば (400)、理由を表示し、入力は残す', async () => {
    mockApiPost.mockRejectedValue(
      new Error(
        `HTTP 400 Bad Request: ${JSON.stringify({
          error: '現在のパスワードが正しくありません。',
          code: 'AUTH_CURRENT_PASSWORD_MISMATCH',
        })}`,
      ),
    );
    render(<AccountCredentialsSection />);
    await screen.findByTestId('account-password-section');

    fillPasswordForm('wrongPass1', 'newPass456', 'newPass456');
    fireEvent.press(screen.getByTestId('account-password-submit'));

    expect(await screen.findByText('現在のパスワードが正しくありません。')).toBeTruthy();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(screen.queryByTestId('password-change-success')).toBeNull();
    expect(screen.getByTestId('account-new-password').props.value).toBe('newPass456');
  });

  it('連打しても、API は 1 回しか呼ばない', async () => {
    let resolveApi: (value: unknown) => void = () => {};
    mockApiPost.mockReturnValue(new Promise((resolve) => { resolveApi = resolve; }));
    render(<AccountCredentialsSection />);
    await screen.findByTestId('account-password-section');

    fillPasswordForm('oldPass123', 'newPass456', 'newPass456');
    fireEvent.press(screen.getByTestId('account-password-submit'));
    fireEvent.press(screen.getByTestId('account-password-submit'));
    resolveApi({ ok: true });

    expect(await screen.findByTestId('password-change-success')).toBeTruthy();
    expect(mockApiPost).toHaveBeenCalledTimes(1);
  });

  it('「パスワードを表示する」で、伏せた入力を見えるようにする', async () => {
    render(<AccountCredentialsSection />);
    await screen.findByTestId('account-password-section');

    fireEvent.press(screen.getByTestId('account-toggle-password-visibility'));

    expect(screen.getByTestId('account-current-password').props.secureTextEntry).toBe(false);
    expect(screen.getByText('パスワードを隠す')).toBeTruthy();
  });
});

describe('AccountCredentialsSection — メールアドレスの変更', () => {
  it('5. 確認メールを送り、送り先と「両方の確認」の案内を表示する', async () => {
    render(<AccountCredentialsSection />);
    await screen.findByTestId('account-email-section');

    fireEvent.changeText(screen.getByTestId('account-new-email'), 'New@Example.com');
    fireEvent.press(screen.getByTestId('account-email-submit'));

    expect(await screen.findByTestId('email-change-sent')).toBeTruthy();
    expect(mockUpdateUser).toHaveBeenCalledWith(
      { email: 'new@example.com' },
      { emailRedirectTo: 'homegohan://auth/verify' },
    );
    expect(screen.getByText(/new@example\.com に届いたメールのリンクを開いてください/)).toBeTruthy();
    expect(screen.getByText(/現在のメールアドレス（user@example\.com）にも確認メールが届いた場合は/)).toBeTruthy();
    expect(screen.getByTestId('account-new-email').props.value).toBe('');
    // メール変更では、再認証も他の端末のログアウトもしない
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('今と同じアドレスは、送らずに理由を表示する', async () => {
    render(<AccountCredentialsSection />);
    await screen.findByTestId('account-email-section');

    fireEvent.changeText(screen.getByTestId('account-new-email'), 'USER@example.com');
    fireEvent.press(screen.getByTestId('account-email-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('email-change-error')).toBeTruthy(),
    );
    expect(screen.getByText('現在のメールアドレスと同じです。別のメールアドレスを入力してください')).toBeTruthy();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(screen.queryByTestId('email-change-sent')).toBeNull();
  });
});
