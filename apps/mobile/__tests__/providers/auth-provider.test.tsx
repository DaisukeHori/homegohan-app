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

// セッションの無いときの user_push_tokens の行の後片付け (#1636)。中身は push-token-release.test.ts と
// auth-provider-sign-out-cleanup.test.tsx (本物) で確かめる。ここでは呼ばれることと順番を見る
const mockReleaseAfterSignedOut = jest.fn();
const mockFlushPendingReleases = jest.fn();
const mockRecordRelease = jest.fn();
const mockRecordStoredReleases = jest.fn();
jest.mock('../../src/lib/pushTokenRelease', () => ({
  releasePushTokenAfterSignedOut: (...args: unknown[]) => mockReleaseAfterSignedOut(...args),
  flushPendingPushTokenReleases: (...args: unknown[]) => mockFlushPendingReleases(...args),
  recordPushTokenRelease: (...args: unknown[]) => mockRecordRelease(...args),
  recordPushTokenReleasesForStoredValues: (...args: unknown[]) => mockRecordStoredReleases(...args),
}));

// この端末のログインへの端末名の登録 (#1189。cross/16 §16)。中身は device-name.test.ts で確かめる。ここでは渡す access token を見る
const mockRegisterDeviceName = jest.fn();
jest.mock('../../src/lib/device-name', () => ({
  registerDeviceName: (...args: unknown[]) => mockRegisterDeviceName(...args),
}));

// ストアの購入 (RevenueCat) の利用者の結び付けと外し (billing/03 §8.10・#1912)。中身は purchases.test.ts で確かめる。
// ここでは、signOut.ts を通らない SIGNED_OUT でも外しが呼ばれることと、次の利用者の結び付けとの順番を見る
const mockIdentifyPurchases = jest.fn();
const mockResetPurchasesOnSignOut = jest.fn();
jest.mock('../../src/lib/purchases', () => ({
  identifyPurchases: (...args: unknown[]) => mockIdentifyPurchases(...args),
  resetPurchasesOnSignOut: (...args: unknown[]) => mockResetPurchasesOnSignOut(...args),
}));

import { AuthProvider, useAuth } from '../../src/providers/AuthProvider';

/**
 * 起動時に未ログインと決まったときの掃除は、端末の Cookie の置き場の掃除の完了を待たない (#1647)。
 * 起動時にサーバーが失効と明言したとき (このあとにサインアウトする) は待つ (オプションを渡さない = 既定の "wait")
 */
const STARTUP_SIGNED_OUT_CLEAR_OPTIONS = { webViewNativeCookies: 'background' };

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
  mockReleaseAfterSignedOut.mockResolvedValue(undefined);
  mockFlushPendingReleases.mockResolvedValue(undefined);
  mockRecordRelease.mockResolvedValue(undefined);
  mockRecordStoredReleases.mockResolvedValue(undefined);
  mockGetStoredSession.mockResolvedValue(null);
  mockRegisterDeviceName.mockResolvedValue(undefined);
  mockIdentifyPurchases.mockResolvedValue(undefined);
  mockResetPurchasesOnSignOut.mockResolvedValue(undefined);
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
        // このあとにサインアウトするので、端末の Cookie の置き場の掃除も待つ (オプション無し = 既定の "wait"。#1647)
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

    it('その場合、サーバーでの検証 (getUser()) は省く: getUser() も同じ更新を試みて同じ理由で失敗し (2.117 は控えた失敗をすぐ受け取る)、読み込み中の表示を延ばすだけ', async () => {
      const stored = makeSession('user-1', 'stored-access');
      mockGetSession.mockResolvedValue({ data: { session: null }, error: retryableFetchError() });
      mockGetStoredSession.mockResolvedValue(stored);
      // 呼ばれたら、実機では読み込み中の表示が延びる (2.105 のビルドでは約 50 秒)。呼ばれないことが大事なので、呼ばれたら解決しない Promise にして、画面が止まることで検出する
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

      it('ストアの購入 (RevenueCat) の利用者を外す (signOut.ts を通らない SIGNED_OUT でも。#1912)。次の利用者の結び付けはそのあと', async () => {
        const api = await renderSignedIn('user-1');
        expect(mockIdentifyPurchases).toHaveBeenCalledWith('user-1');
        expect(mockResetPurchasesOnSignOut).not.toHaveBeenCalled();

        act(() => authListener('SIGNED_OUT', null));

        expect(text(api, 'session')).toBe('none');
        expect(mockResetPurchasesOnSignOut).toHaveBeenCalledTimes(1);

        act(() => authListener('SIGNED_IN', makeSession('user-2', 'access-2')));
        expect(mockIdentifyPurchases).toHaveBeenLastCalledWith('user-2');
        // 外しは次の利用者の結び付けより先に呼ばれている (purchases.ts の列で、この順に流れる)
        const resetOrder = mockResetPurchasesOnSignOut.mock.invocationCallOrder[0];
        const identifyOrders = mockIdentifyPurchases.mock.invocationCallOrder;
        expect(resetOrder).toBeLessThan(identifyOrders[identifyOrders.length - 1]);
      });

      it('外しが失敗 (拒否) しても、未ログインにし、掃除を続ける', async () => {
        mockResetPurchasesOnSignOut.mockRejectedValueOnce(new Error('reset failed'));
        const api = await renderSignedIn('user-1');

        act(() => authListener('SIGNED_OUT', null));

        expect(text(api, 'session')).toBe('none');
        await waitFor(() => expect(mockClearAfterSignedOut).toHaveBeenCalledWith('user-1'));
        expect(mockResetPurchasesOnSignOut).toHaveBeenCalledTimes(1);
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
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null, STARTUP_SIGNED_OUT_CLEAR_OPTIONS);
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
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null, STARTUP_SIGNED_OUT_CLEAR_OPTIONS);
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
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null, STARTUP_SIGNED_OUT_CLEAR_OPTIONS);
      });

      it('通信の失敗で getSession() が null を返し、保存済みのセッションも無いときも掃除する', async () => {
        mockGetSession.mockResolvedValue({ data: { session: null }, error: retryableFetchError() });
        mockGetStoredSession.mockResolvedValue(null);

        const api = renderProvider();

        await waitFor(() => expect(text(api, 'loading')).toBe('false'));
        expect(text(api, 'session')).toBe('none');
        expect(mockClearUserScopedLocalData).toHaveBeenCalledTimes(1);
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null, STARTUP_SIGNED_OUT_CLEAR_OPTIONS);
      });

      it('getSession() が例外を投げたときも掃除する', async () => {
        mockGetSession.mockRejectedValue(new Error('boom'));

        const api = renderProvider();

        await waitFor(() => expect(text(api, 'loading')).toBe('false'));
        expect(text(api, 'session')).toBe('none');
        expect(mockClearUserScopedLocalData).toHaveBeenCalledTimes(1);
        expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null, STARTUP_SIGNED_OUT_CLEAR_OPTIONS);
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

// ─────────────────────────────────────────────────────────────────────────────
// #1636: signOut.ts を通らずにセッションが終わったときの、user_push_tokens の行の後片付け (セッション無しの release)
// ─────────────────────────────────────────────────────────────────────────────
describe('AuthProvider — user_push_tokens の行の後片付け (#1636)', () => {
  function makeSignedIn(id = 'user-1') {
    const session = makeSession(id);
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: session.user }, error: null });
  }

  it('SIGNED_OUT: 掃除 (push token の値を残す版) のあとに、同じ利用者で release を呼ぶ', async () => {
    const calls: string[] = [];
    mockClearAfterSignedOut.mockImplementation(async (userId: unknown) => {
      calls.push(`clear:${String(userId)}`);
    });
    mockReleaseAfterSignedOut.mockImplementation(async (userId: unknown) => {
      calls.push(`release:${String(userId)}`);
    });
    makeSignedIn('user-1');
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'session')).toBe('access-1'));

    act(() => authListener('SIGNED_OUT', null));

    expect(text(api, 'session')).toBe('none');
    await waitFor(() => expect(calls).toEqual(['clear:user-1', 'release:user-1']));
  });

  it('SIGNED_OUT: 掃除が例外を投げても release は呼ぶ。release が例外を投げても外へ出さない', async () => {
    mockClearAfterSignedOut.mockRejectedValue(new Error('cleanup failed'));
    mockReleaseAfterSignedOut.mockRejectedValue(new Error('release failed'));
    makeSignedIn('user-1');
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'session')).toBe('access-1'));

    expect(() => act(() => authListener('SIGNED_OUT', null))).not.toThrow();

    await waitFor(() => expect(mockReleaseAfterSignedOut).toHaveBeenCalledWith('user-1'));
    expect(text(api, 'session')).toBe('none');
  });

  it('画面は release を待たずに未ログインになる', async () => {
    mockReleaseAfterSignedOut.mockImplementation(() => new Promise<void>(() => {}));
    makeSignedIn('user-1');
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'session')).toBe('access-1'));

    act(() => authListener('SIGNED_OUT', null));

    expect(text(api, 'session')).toBe('none');
    expect(text(api, 'loading')).toBe('false');
  });

  it('起動時に未ログインと決まったとき: 前に消せなかった release をやり直す (完了を待たずに未ログインの画面を出す)', async () => {
    mockFlushPendingReleases.mockImplementation(() => new Promise<void>(() => {}));

    const api = renderProvider();

    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(text(api, 'session')).toBe('none');
    expect(mockFlushPendingReleases).toHaveBeenCalledTimes(1);
    expect(mockRecordRelease).not.toHaveBeenCalled();
  });

  // 起動時に未ログインと決まる 4 つの経路 (どれも settleSignedOutAtStartup を通る)。アプリが閉じている間に refresh_token が失効すると、
  // supabase-js の初期化がセッションを消し、ここに来る。サインアウトした利用者は分からない
  it.each([
    ['getSession() が null (保存済みのセッションが無い)', () => mockGetSession.mockResolvedValue({ data: { session: null }, error: null })],
    [
      'refresh_token の失効で getSession() が null とエラーを返した',
      () =>
        mockGetSession.mockResolvedValue({
          data: { session: null },
          error: authError('AuthApiError', 400, 'Invalid Refresh Token', 'refresh_token_not_found'),
        }),
    ],
    [
      '通信の失敗で getSession() が null を返し、保存済みのセッションも無い',
      () => {
        mockGetSession.mockResolvedValue({ data: { session: null }, error: retryableFetchError() });
        mockGetStoredSession.mockResolvedValue(null);
      },
    ],
    ['getSession() が例外を投げた', () => mockGetSession.mockRejectedValue(new Error('storage exploded'))],
  ])(
    '起動時に未ログインと決まったとき (%s): 掃除が値を消す前に残っている値を全部控え、掃除のあとに release を始める (#1636)',
    async (_label, arrange) => {
      const calls: string[] = [];
      mockRecordStoredReleases.mockImplementation(async () => {
        calls.push('recordStored');
      });
      mockClearUserScopedLocalData.mockImplementation(async (userId: unknown) => {
        calls.push(`clear:${String(userId)}`);
      });
      mockFlushPendingReleases.mockImplementation(async () => {
        calls.push('flush');
      });
      arrange();

      const api = renderProvider();

      await waitFor(() => expect(text(api, 'loading')).toBe('false'));
      expect(text(api, 'session')).toBe('none');
      expect(calls).toEqual(['recordStored', 'clear:null', 'flush']);
      expect(mockRecordRelease).not.toHaveBeenCalled();
    },
  );

  it('起動時に未ログインと決まったとき: 控えが例外を投げても、掃除・やり直し・未ログインは続ける (#1636)', async () => {
    mockRecordStoredReleases.mockRejectedValue(new Error('record failed'));

    const api = renderProvider();

    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(text(api, 'session')).toBe('none');
    expect(mockClearUserScopedLocalData).toHaveBeenCalledWith(null, STARTUP_SIGNED_OUT_CLEAR_OPTIONS);
    expect(mockFlushPendingReleases).toHaveBeenCalledTimes(1);
  });

  it('SIGNED_OUT: サインアウトした利用者が分からない (起動の直後に supabase-js の初期化が届けた) ときも、null で release を呼ぶ (#1636)', async () => {
    // 起動時の復元が終わる前 (lastKnownUserIdRef が null) に、supabase-js の初期化が失効したセッションを消して SIGNED_OUT を届ける
    mockGetSession.mockImplementation(() => new Promise(() => {}));
    renderProvider();

    act(() => authListener('SIGNED_OUT', null));

    await waitFor(() => expect(mockReleaseAfterSignedOut).toHaveBeenCalledWith(null));
  });

  it('起動時にサーバーが失効と明言したとき: 掃除で値が消える前に宛先を控え、そのあと掃除 → サインアウト', async () => {
    const calls: string[] = [];
    mockRecordRelease.mockImplementation(async (userId: unknown) => {
      calls.push(`record:${String(userId)}`);
    });
    mockClearUserScopedLocalData.mockImplementation(async () => {
      calls.push('clearUserScopedLocalData');
    });
    mockSignOut.mockImplementation(async () => {
      calls.push('signOut');
      return { error: null };
    });
    const session = makeSession('user-revoked');
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: authError('AuthApiError', 403, 'Session not found', 'session_not_found'),
    });

    const api = renderProvider();

    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(calls).toEqual(['record:user-revoked', 'clearUserScopedLocalData', 'signOut']);
    // 失効の明言では利用者が分かるので、その利用者の値だけを控える (残っている値の全部ではない)
    expect(mockRecordStoredReleases).not.toHaveBeenCalled();
  });

  it('起動時にサーバーが失効と明言したとき: 控えが例外を投げても、掃除とサインアウトは続ける', async () => {
    mockRecordRelease.mockRejectedValue(new Error('record failed'));
    const session = makeSession('user-revoked');
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: authError('AuthApiError', 403, 'Session not found', 'session_not_found'),
    });

    const api = renderProvider();

    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(text(api, 'session')).toBe('none');
    expect(mockClearUserScopedLocalData).toHaveBeenCalledWith('user-revoked');
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('ログイン済みで起動したとき・通信の失敗で保存済みのセッションを使うときは、release も控えもやり直しもしない', async () => {
    makeSignedIn('user-1');
    const signedIn = renderProvider();
    await waitFor(() => expect(text(signedIn, 'session')).toBe('access-1'));
    signedIn.unmount();

    const session = makeSession('user-2', 'access-2');
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: retryableFetchError() });
    const offline = renderProvider();
    await waitFor(() => expect(text(offline, 'session')).toBe('access-2'));

    expect(mockReleaseAfterSignedOut).not.toHaveBeenCalled();
    expect(mockFlushPendingReleases).not.toHaveBeenCalled();
    expect(mockRecordRelease).not.toHaveBeenCalled();
    expect(mockRecordStoredReleases).not.toHaveBeenCalled();
  });
});

describe('AuthProvider — 端末名の登録 (#1189。cross/16 §16・§20.4)', () => {
  it('SIGNED_IN でセッションの access token を registerDeviceName に渡す', async () => {
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(mockRegisterDeviceName).not.toHaveBeenCalled();

    act(() => authListener('SIGNED_IN', makeSession('user-1', 'access-signed-in')));

    expect(mockRegisterDeviceName).toHaveBeenCalledTimes(1);
    expect(mockRegisterDeviceName).toHaveBeenCalledWith('access-signed-in');
  });

  it('INITIAL_SESSION でセッションがあれば、その access token で registerDeviceName を呼ぶ', async () => {
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    act(() => authListener('INITIAL_SESSION', makeSession('user-1', 'access-initial')));

    expect(mockRegisterDeviceName).toHaveBeenCalledTimes(1);
    expect(mockRegisterDeviceName).toHaveBeenCalledWith('access-initial');
  });

  it('SIGNED_OUT のあとに別のセッションで SIGNED_IN すると、新しい access token でもう一度呼ぶ', async () => {
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    act(() => authListener('SIGNED_IN', makeSession('user-1', 'access-first')));
    act(() => authListener('SIGNED_OUT', null));
    act(() => authListener('SIGNED_IN', makeSession('user-1', 'access-second')));

    expect(mockRegisterDeviceName.mock.calls).toEqual([['access-first'], ['access-second']]);
  });

  it('セッションが無い (未ログインで起動・SIGNED_OUT) ときは呼ばない', async () => {
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    act(() => authListener('INITIAL_SESSION', null));
    act(() => authListener('SIGNED_OUT', null));

    expect(mockRegisterDeviceName).not.toHaveBeenCalled();
  });

  it('registerDeviceName が reject しても、セッションの状態と掃除の表 (既存の it) は変わらない', async () => {
    mockRegisterDeviceName.mockRejectedValue(new Error('register failed'));
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    act(() => authListener('SIGNED_IN', makeSession('user-9', 'access-9')));
    await waitFor(() => expect(text(api, 'session')).toBe('access-9'));
    expect(text(api, 'user')).toBe('user-9');

    act(() => authListener('SIGNED_OUT', null));
    await waitFor(() => expect(mockClearAfterSignedOut).toHaveBeenCalledWith('user-9'));
    expect(text(api, 'session')).toBe('none');
  });
});
