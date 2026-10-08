/**
 * auth-provider.test.tsx
 * apps/mobile/src/providers/AuthProvider.tsx のテスト (#1038 F7-07)
 *
 * 起動時、保存済みのセッションをサーバーで検証する。
 *   - サーバーが「失効」と明言したとき (401/403・session_not_found など) だけセッションを捨てる
 *   - 機内モード・電波が悪い・サーバーの一時障害・レート制限では、ログイン済みのまま起動する
 *     (以前はどんなエラーでも signOut しており、オフライン起動でウェルカム画面に落ちていた)
 */

import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';

// ── supabase モック ───────────────────────────────────────────────────────────
const mockGetSession = jest.fn();
const mockGetUser = jest.fn();
const mockSignOut = jest.fn();
const mockOnAuthStateChange = jest.fn();
const mockGetStoredSession = jest.fn();
const mockUnsubscribe = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getUser: (...args: unknown[]) => mockGetUser(...args),
      signOut: (...args: unknown[]) => mockSignOut(...args),
      onAuthStateChange: (...args: unknown[]) => mockOnAuthStateChange(...args),
    },
  },
  getStoredSession: (...args: unknown[]) => mockGetStoredSession(...args),
}));

import { AuthProvider, useAuth } from '../../src/providers/AuthProvider';

// ── ヘルパー ──────────────────────────────────────────────────────────────────
type AuthListener = (event: string, session: unknown) => void;
let authListener: AuthListener;

function makeSession(id = 'user-1', accessToken = 'access-1') {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-1',
    expires_at: 1_900_000_000,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id, email: `${id}@example.com` },
  };
}

/** supabase-js が返すエラーに合わせた形 */
function authError(name: string, status: number | undefined, message: string, code?: string) {
  return Object.assign(new Error(message), { name, status, code });
}
const retryableFetchError = () => authError('AuthRetryableFetchError', 0, 'Network request failed');

function Probe() {
  const { isLoading, session, user } = useAuth();
  return (
    <>
      <Text testID="loading">{String(isLoading)}</Text>
      <Text testID="session">{session ? session.access_token : 'none'}</Text>
      <Text testID="user">{user ? user.id : 'none'}</Text>
    </>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

const text = (api: ReturnType<typeof renderProvider>, id: string) => api.getByTestId(id).props.children;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
  mockSignOut.mockResolvedValue({ error: null });
  mockGetStoredSession.mockResolvedValue(null);
  mockOnAuthStateChange.mockImplementation((listener: AuthListener) => {
    authListener = listener;
    return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
  });
});

describe('AuthProvider — 起動時のセッション復元', () => {
  it('保存済みのセッションがサーバーで検証できれば、ログイン済みで起動する', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: session.user }, error: null });

    const api = renderProvider();

    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(text(api, 'session')).toBe('access-1');
    expect(text(api, 'user')).toBe('user-1');
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('保存済みのセッションが無ければ未ログイン (signOut もしない)', async () => {
    const api = renderProvider();

    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(text(api, 'session')).toBe('none');
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  describe('通信できない・サーバーが不調なときは、セッションを捨てない (#1038 F7-07)', () => {
    const transientErrors: Array<[string, () => Error]> = [
      ['機内モード (AuthRetryableFetchError / status 0)', retryableFetchError],
      ['ゲートウェイ障害 503 (AuthRetryableFetchError)', () => authError('AuthRetryableFetchError', 503, 'Service Unavailable')],
      ['サーバーエラー 500 (AuthApiError)', () => authError('AuthApiError', 500, 'Internal Server Error')],
      ['レート制限 429', () => authError('AuthApiError', 429, 'Too many requests', 'over_request_rate_limit')],
      ['fetch の例外 (status が無い TypeError)', () => new TypeError('Network request failed')],
    ];

    it.each(transientErrors)('%s: キャッシュしているセッションのまま起動し、signOut しない', async (_label, makeError) => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockGetUser.mockResolvedValue({ data: { user: null }, error: makeError() });

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('access-1');
      expect(text(api, 'user')).toBe('user-1');
      expect(mockSignOut).not.toHaveBeenCalled();
    });

    it('getUser() が例外を投げても (通信エラーの例外化)、保存済みのセッションを維持する', async () => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockGetUser.mockRejectedValue(new TypeError('Network request failed'));

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('access-1');
      expect(mockSignOut).not.toHaveBeenCalled();
    });

    it('素性の分からないエラーでも、失効が確認できていないので捨てない', async () => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockGetUser.mockResolvedValue({ data: { user: null }, error: authError('AuthApiError', 400, 'Something odd') });

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('access-1');
      expect(mockSignOut).not.toHaveBeenCalled();
    });
  });

  describe('サーバーが失効と明言したときだけ、セッションを捨てる', () => {
    const invalidErrors: Array<[string, () => Error]> = [
      ['401', () => authError('AuthApiError', 401, 'invalid JWT')],
      ['403 session_not_found', () => authError('AuthApiError', 403, 'Session from session_id claim in JWT does not exist', 'session_not_found')],
      ['403 user_not_found', () => authError('AuthApiError', 403, 'User from sub claim in JWT does not exist', 'user_not_found')],
      ['400 refresh_token_not_found', () => authError('AuthApiError', 400, 'Invalid Refresh Token: Refresh Token Not Found', 'refresh_token_not_found')],
      ['AuthSessionMissingError', () => authError('AuthSessionMissingError', 400, 'Auth session missing!')],
    ];

    it.each(invalidErrors)('%s: signOut して未ログインにする', async (_label, makeError) => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockGetUser.mockResolvedValue({ data: { user: null }, error: makeError() });

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('none');
      // 既に失効しているので、他の端末のセッションまで巻き込まない端末側だけの signOut
      expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('エラーが無いのにユーザーも返らない異常な応答は、検証できなかったものとして捨てる', async () => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('none');
      expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('端末側の signOut が失敗しても、失効したセッションは使わない', async () => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockGetUser.mockResolvedValue({ data: { user: null }, error: authError('AuthApiError', 403, 'gone', 'session_not_found') });
      mockSignOut.mockRejectedValue(new Error('storage unavailable'));

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('none');
    });
  });

  describe('access_token が期限切れのままオフラインで起動した場合 (#1038 F7-07)', () => {
    it('getSession() が更新に失敗して session: null を返しても、保存済みのセッションでログイン済みのまま起動する', async () => {
      const stored = makeSession('user-1', 'stored-access');
      mockGetSession.mockResolvedValue({ data: { session: null }, error: retryableFetchError() });
      mockGetStoredSession.mockResolvedValue(stored);
      mockGetUser.mockResolvedValue({ data: { user: null }, error: retryableFetchError() });

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('stored-access');
      expect(text(api, 'user')).toBe('user-1');
      expect(mockSignOut).not.toHaveBeenCalled();
    });

    it('その場合、サーバーでの検証 (getUser()) は省く: getUser() も同じ更新をやり直して同じ理由で失敗し、読み込み中の表示を約 50 秒延ばすだけ', async () => {
      const stored = makeSession('user-1', 'stored-access');
      mockGetSession.mockResolvedValue({ data: { session: null }, error: retryableFetchError() });
      mockGetStoredSession.mockResolvedValue(stored);
      // 呼ばれたら、実機では約 50 秒かかる。呼ばれないことが大事なので、呼ばれたら解決しない Promise にして、画面が止まることで検出する
      mockGetUser.mockReturnValue(new Promise(() => {}));

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('stored-access');
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('保存済みのセッションが無ければ、通信エラーでも未ログイン', async () => {
      mockGetSession.mockResolvedValue({ data: { session: null }, error: retryableFetchError() });
      mockGetStoredSession.mockResolvedValue(null);

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('none');
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('失効を示すエラー (refresh_token_not_found) で session: null のときは、保存済みを読み直さず未ログイン', async () => {
      mockGetSession.mockResolvedValue({
        data: { session: null },
        error: authError('AuthApiError', 400, 'Invalid Refresh Token', 'refresh_token_not_found'),
      });
      mockGetStoredSession.mockResolvedValue(makeSession());

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('none');
      expect(mockGetStoredSession).not.toHaveBeenCalled();
    });

    it('通信が戻って TOKEN_REFRESHED が来たら、新しいセッションに差し替わる', async () => {
      const stored = makeSession('user-1', 'stored-access');
      mockGetSession.mockResolvedValue({ data: { session: null }, error: retryableFetchError() });
      mockGetStoredSession.mockResolvedValue(stored);
      mockGetUser.mockResolvedValue({ data: { user: null }, error: retryableFetchError() });
      const api = renderProvider();
      await waitFor(() => expect(text(api, 'session')).toBe('stored-access'));

      act(() => authListener('TOKEN_REFRESHED', makeSession('user-1', 'fresh-access')));

      expect(text(api, 'session')).toBe('fresh-access');
    });
  });

  describe('onAuthStateChange', () => {
    it('起動時の INITIAL_SESSION(null) で、復元したセッションを上書きしない (通信失敗で復元できなかっただけの可能性があるため)', async () => {
      const stored = makeSession('user-1', 'stored-access');
      mockGetSession.mockResolvedValue({ data: { session: null }, error: retryableFetchError() });
      mockGetStoredSession.mockResolvedValue(stored);
      mockGetUser.mockResolvedValue({ data: { user: null }, error: retryableFetchError() });
      const api = renderProvider();
      await waitFor(() => expect(text(api, 'session')).toBe('stored-access'));

      act(() => authListener('INITIAL_SESSION', null));

      expect(text(api, 'session')).toBe('stored-access');
    });

    it('INITIAL_SESSION に値があれば、検証の完了を待たずに画面を出す', async () => {
      // サーバー検証が終わらない状況でも、キャッシュ済みのセッションですぐ表示できる
      mockGetSession.mockReturnValue(new Promise(() => {}));
      const api = renderProvider();
      expect(text(api, 'loading')).toBe('true');

      act(() => authListener('INITIAL_SESSION', makeSession('user-1', 'cached-access')));

      expect(text(api, 'loading')).toBe('false');
      expect(text(api, 'session')).toBe('cached-access');
    });

    it('SIGNED_OUT でログアウト状態になり、SIGNED_IN でログイン状態になる', async () => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockGetUser.mockResolvedValue({ data: { user: session.user }, error: null });
      const api = renderProvider();
      await waitFor(() => expect(text(api, 'session')).toBe('access-1'));

      act(() => authListener('SIGNED_OUT', null));
      expect(text(api, 'session')).toBe('none');

      act(() => authListener('SIGNED_IN', makeSession('user-2', 'access-2')));
      expect(text(api, 'user')).toBe('user-2');
    });

    it('アンマウントで購読を解除する', async () => {
      const api = renderProvider();
      await waitFor(() => expect(text(api, 'loading')).toBe('false'));

      api.unmount();

      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  it('getSession() 自体が例外を投げても、読み込み中のまま固まらず未ログインになる', async () => {
    mockGetSession.mockRejectedValue(new Error('boom'));

    const api = renderProvider();

    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(text(api, 'session')).toBe('none');
  });
});
