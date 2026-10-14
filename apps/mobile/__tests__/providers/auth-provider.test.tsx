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

// 通常のログアウトと同じ掃除 (AsyncStorage の利用者別のキー・WebView の利用者別の localStorage)。
// 中身は user-storage.test.ts と web-view-user-storage-cleanup.test.ts で確かめる。ここでは呼ばれることと順番を見る (#1599)
// SIGNED_OUT のときは、push token の値を残す版 (clearUserScopedLocalDataAfterSignedOut) を使う (#1615)
const mockClearUserScopedLocalData = jest.fn();
const mockClearAfterSignedOut = jest.fn();
jest.mock('../../src/lib/userScopedLocalData', () => ({
  clearUserScopedLocalData: (...args: unknown[]) => mockClearUserScopedLocalData(...args),
  clearUserScopedLocalDataAfterSignedOut: (...args: unknown[]) => mockClearAfterSignedOut(...args),
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
  mockClearUserScopedLocalData.mockResolvedValue(undefined);
  mockClearAfterSignedOut.mockResolvedValue(undefined);
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

    it.each(invalidErrors)(
      '%s: 通常のログアウトと同じ掃除 (利用者別の AsyncStorage・WebView の localStorage) を、サインアウトの前に通す (#1599)',
      async (_label, makeError) => {
        const calls: string[] = [];
        mockClearUserScopedLocalData.mockImplementation(async () => {
          calls.push('clearUserScopedLocalData');
        });
        mockSignOut.mockImplementation(async () => {
          calls.push('signOut');
          return { error: null };
        });
        const session = makeSession('user-revoked');
        mockGetSession.mockResolvedValue({ data: { session }, error: null });
        mockGetUser.mockResolvedValue({ data: { user: null }, error: makeError() });

        const api = renderProvider();

        await waitFor(() => expect(text(api, 'loading')).toBe('false'));
        expect(text(api, 'session')).toBe('none');
        // 失効したセッションの利用者のキーを消す (userId が分かれば、その利用者のキーを狙って消す)
        expect(mockClearUserScopedLocalData).toHaveBeenCalledTimes(1);
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith('user-revoked');
        // CLAUDE.md: サインアウトの前に消す
        expect(calls).toEqual(['clearUserScopedLocalData', 'signOut']);
      },
    );

    it('失効でないとき (検証できた・通信の失敗) は、掃除しない (ログイン中の利用者の値を消さない)', async () => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockGetUser.mockResolvedValueOnce({ data: { user: session.user }, error: null });

      const verified = renderProvider();
      await waitFor(() => expect(text(verified, 'loading')).toBe('false'));
      verified.unmount();

      mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: retryableFetchError() });
      const offline = renderProvider();
      await waitFor(() => expect(text(offline, 'loading')).toBe('false'));
      expect(text(offline, 'session')).toBe('access-1');

      expect(mockClearUserScopedLocalData).not.toHaveBeenCalled();
      expect(mockClearAfterSignedOut).not.toHaveBeenCalled();
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

    it('掃除が例外を投げても、サインアウトして失効したセッションは使わない', async () => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockGetUser.mockResolvedValue({ data: { user: null }, error: authError('AuthApiError', 403, 'gone', 'session_not_found') });
      mockClearUserScopedLocalData.mockRejectedValue(new Error('storage unavailable'));

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

  describe('どの経路で未ログインになっても、通常のログアウトと同じ掃除を通す (#1615)', () => {
    /** 解決を外から決められる Promise */
    function deferred() {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    async function renderSignedIn(id = 'user-1', accessToken = 'access-1') {
      const session = makeSession(id, accessToken);
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockGetUser.mockResolvedValue({ data: { user: session.user }, error: null });
      const api = renderProvider();
      await waitFor(() => expect(text(api, 'session')).toBe(accessToken));
      return api;
    }

    describe('SIGNED_OUT (ログアウト・自動更新で refresh_token が失効・getUser() が失効を見つけて端末のセッションを消した)', () => {
      it('直前のセッションの利用者の ID で掃除し、未ログインにする', async () => {
        const api = await renderSignedIn('user-1');
        expect(mockClearAfterSignedOut).not.toHaveBeenCalled();

        act(() => authListener('SIGNED_OUT', null));

        expect(text(api, 'session')).toBe('none');
        await waitFor(() => expect(mockClearAfterSignedOut).toHaveBeenCalledTimes(1));
        expect(mockClearAfterSignedOut).toHaveBeenCalledWith('user-1');
        // push token の値まで消す版は使わない (このあとに signOut.ts が値を読んで user_push_tokens の行を消すことがある。#1615)
        expect(mockClearUserScopedLocalData).not.toHaveBeenCalled();
      });

      it('SIGNED_IN で利用者が入れ替わったあとは、入れ替わった先の利用者の ID で掃除する', async () => {
        const api = await renderSignedIn('user-1');

        act(() => authListener('SIGNED_IN', makeSession('user-2', 'access-2')));
        act(() => authListener('SIGNED_OUT', null));

        expect(text(api, 'session')).toBe('none');
        await waitFor(() => expect(mockClearAfterSignedOut).toHaveBeenCalledTimes(1));
        expect(mockClearAfterSignedOut).toHaveBeenCalledWith('user-2');
      });

      it('INITIAL_SESSION・TOKEN_REFRESHED で受け取ったセッションの利用者も覚えている', async () => {
        mockGetSession.mockReturnValue(new Promise(() => {}));
        renderProvider();

        act(() => authListener('INITIAL_SESSION', makeSession('user-initial', 'a-1')));
        act(() => authListener('SIGNED_OUT', null));
        await waitFor(() => expect(mockClearAfterSignedOut).toHaveBeenLastCalledWith('user-initial'));

        act(() => authListener('TOKEN_REFRESHED', makeSession('user-refreshed', 'a-2')));
        act(() => authListener('SIGNED_OUT', null));
        await waitFor(() => expect(mockClearAfterSignedOut).toHaveBeenLastCalledWith('user-refreshed'));
        expect(mockClearAfterSignedOut).toHaveBeenCalledTimes(2);
      });

      it('続けて届いた 2 回目の SIGNED_OUT は、ID なしで掃除する (覚えている ID は 1 回の掃除で忘れる)', async () => {
        await renderSignedIn('user-1');

        act(() => authListener('SIGNED_OUT', null));
        act(() => authListener('SIGNED_OUT', null));

        await waitFor(() => expect(mockClearAfterSignedOut).toHaveBeenCalledTimes(2));
        expect(mockClearAfterSignedOut.mock.calls).toEqual([['user-1'], [null]]);
      });

      it('一度もセッションが無いまま SIGNED_OUT が届いたら、ID なしで掃除する', async () => {
        const api = renderProvider();
        await waitFor(() => expect(text(api, 'loading')).toBe('false'));
        // 起動時に未ログインと決まった掃除は、push token の値まで消す版
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null);
        expect(mockClearAfterSignedOut).not.toHaveBeenCalled();

        act(() => authListener('SIGNED_OUT', null));

        await waitFor(() => expect(mockClearAfterSignedOut).toHaveBeenCalledTimes(1));
        expect(mockClearAfterSignedOut).toHaveBeenCalledWith(null);
      });

      it('画面は掃除の完了を待たずに未ログインになる (失効したセッションで画面を出し続けない)', async () => {
        const api = await renderSignedIn('user-1');
        mockClearAfterSignedOut.mockReturnValue(new Promise(() => {}));

        act(() => authListener('SIGNED_OUT', null));

        expect(text(api, 'session')).toBe('none');
        expect(text(api, 'loading')).toBe('false');
        await waitFor(() => expect(mockClearAfterSignedOut).toHaveBeenCalledWith('user-1'));
      });

      it.each([
        ['同期で例外を投げる', () => mockClearAfterSignedOut.mockImplementation(() => {
          throw new Error('storage unavailable');
        })],
        ['拒否された Promise を返す', () => mockClearAfterSignedOut.mockRejectedValue(new Error('storage unavailable'))],
      ])('掃除が%sときも、例外を外へ漏らさず未ログインになる', async (_label, arrange) => {
        const api = await renderSignedIn('user-1');
        arrange();

        expect(() => act(() => authListener('SIGNED_OUT', null))).not.toThrow();

        expect(text(api, 'session')).toBe('none');
        await waitFor(() => expect(mockClearAfterSignedOut).toHaveBeenCalledWith('user-1'));
      });

      it.each(['TOKEN_REFRESHED', 'USER_UPDATED', 'SIGNED_IN', 'PASSWORD_RECOVERY'])(
        '%s では掃除しない (ログイン中の利用者の値を消さない)',
        async (event) => {
          const api = await renderSignedIn('user-1');

          act(() => authListener(event, makeSession('user-1', 'access-next')));

          expect(text(api, 'session')).toBe('access-next');
          // 掃除は次の tick に回るので、それを待ってから確かめる
          await act(async () => {
            await Promise.resolve();
          });
          expect(mockClearAfterSignedOut).not.toHaveBeenCalled();
          expect(mockClearUserScopedLocalData).not.toHaveBeenCalled();
        },
      );
    });

    describe('起動時に未ログインと決まった', () => {
      it('保存済みのセッションが無い (getSession() が null): ID なしで掃除してから、未ログインの画面を出す', async () => {
        const gate = deferred();
        mockClearUserScopedLocalData.mockReturnValue(gate.promise);

        const api = renderProvider();

        await waitFor(() => expect(mockClearUserScopedLocalData).toHaveBeenCalledTimes(1));
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null);
        // 掃除が済むまでは読み込み中のまま (掃除の前に、次の利用者がログインできる画面を出さない)
        expect(text(api, 'loading')).toBe('true');

        await act(async () => {
          gate.resolve();
          await gate.promise;
        });

        await waitFor(() => expect(text(api, 'loading')).toBe('false'));
        expect(text(api, 'session')).toBe('none');
        expect(mockSignOut).not.toHaveBeenCalled();
      });

      it('refresh_token の失効 (getSession() が refresh_token_not_found で null) でも掃除する', async () => {
        mockGetSession.mockResolvedValue({
          data: { session: null },
          error: authError('AuthApiError', 400, 'Invalid Refresh Token', 'refresh_token_not_found'),
        });

        const api = renderProvider();

        await waitFor(() => expect(text(api, 'loading')).toBe('false'));
        expect(text(api, 'session')).toBe('none');
        expect(mockClearUserScopedLocalData).toHaveBeenCalledTimes(1);
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null);
      });

      it('通信の失敗で getSession() が null を返し、保存済みのセッションも無いときも掃除する', async () => {
        mockGetSession.mockResolvedValue({ data: { session: null }, error: retryableFetchError() });
        mockGetStoredSession.mockResolvedValue(null);

        const api = renderProvider();

        await waitFor(() => expect(text(api, 'loading')).toBe('false'));
        expect(text(api, 'session')).toBe('none');
        expect(mockClearUserScopedLocalData).toHaveBeenCalledTimes(1);
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null);
      });

      it('getSession() が例外を投げたときも掃除する', async () => {
        mockGetSession.mockRejectedValue(new Error('boom'));

        const api = renderProvider();

        await waitFor(() => expect(text(api, 'loading')).toBe('false'));
        expect(text(api, 'session')).toBe('none');
        expect(mockClearUserScopedLocalData).toHaveBeenCalledTimes(1);
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null);
      });

      it('起動時の掃除が例外を投げても、読み込み中のまま固まらず未ログインになる', async () => {
        mockClearUserScopedLocalData.mockRejectedValue(new Error('storage unavailable'));

        const api = renderProvider();

        await waitFor(() => expect(text(api, 'loading')).toBe('false'));
        expect(text(api, 'session')).toBe('none');
      });

      it('ログイン済みで起動したとき (検証できた・通信の失敗で保存済みを使う・getUser() の例外) は掃除しない', async () => {
        const session = makeSession();
        mockGetSession.mockResolvedValue({ data: { session }, error: null });
        mockGetUser.mockRejectedValueOnce(new TypeError('Network request failed'));
        const thrown = renderProvider();
        await waitFor(() => expect(text(thrown, 'loading')).toBe('false'));
        expect(text(thrown, 'session')).toBe('access-1');
        thrown.unmount();

        mockGetSession.mockResolvedValue({ data: { session: null }, error: retryableFetchError() });
        mockGetStoredSession.mockResolvedValue(makeSession('user-1', 'stored-access'));
        const stored = renderProvider();
        await waitFor(() => expect(text(stored, 'loading')).toBe('false'));
        expect(text(stored, 'session')).toBe('stored-access');

        expect(mockClearUserScopedLocalData).not.toHaveBeenCalled();
        expect(mockClearAfterSignedOut).not.toHaveBeenCalled();
      });

      it('失効の明言で掃除 → signOut({ scope: "local" }) のあとに SIGNED_OUT が届いても、もう一度掃除するだけで順は崩れない', async () => {
        const calls: string[] = [];
        mockClearUserScopedLocalData.mockImplementation(async (userId: unknown) => {
          calls.push(`clear:${String(userId)}`);
        });
        mockClearAfterSignedOut.mockImplementation(async (userId: unknown) => {
          calls.push(`clearAfterSignedOut:${String(userId)}`);
        });
        mockSignOut.mockImplementation(async () => {
          calls.push('signOut');
          // supabase-js は端末のセッションを消すと SIGNED_OUT を知らせる
          authListener('SIGNED_OUT', null);
          return { error: null };
        });
        const session = makeSession('user-revoked');
        mockGetSession.mockResolvedValue({ data: { session }, error: null });
        mockGetUser.mockResolvedValue({ data: { user: null }, error: authError('AuthApiError', 403, 'gone', 'session_not_found') });

        const api = renderProvider();

        await waitFor(() => expect(calls).toHaveLength(3));
        expect(text(api, 'session')).toBe('none');
        // 1 回目は失効したセッションの利用者を狙って、サインアウトの前に。2 回目 (SIGNED_OUT) は覚えている利用者が無いので ID なし
        expect(calls).toEqual(['clear:user-revoked', 'signOut', 'clearAfterSignedOut:null']);
      });
    });
  });

  it('getSession() 自体が例外を投げても、読み込み中のまま固まらず未ログインになる', async () => {
    mockGetSession.mockRejectedValue(new Error('boom'));

    const api = renderProvider();

    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(text(api, 'session')).toBe('none');
  });
});
