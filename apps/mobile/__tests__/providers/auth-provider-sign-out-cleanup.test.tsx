/**
 * auth-provider-sign-out-cleanup.test.tsx
 * AuthProvider が未ログインになるどの経路でも、端末に残る利用者別のデータが消えることを、
 * 本物の掃除 (userScopedLocalData.ts → user-storage.ts・webViewUserStorageCleanup.ts) で確かめる (#1615)。
 *
 * auth-provider.test.tsx は掃除を差し替えて「呼ばれること・順番」を見る。ここでは差し替えずに、
 * AsyncStorage の利用者別のキーが消え、次に開く WebView に localStorage の掃除が頼まれていることまで見る。
 * 端末の Cookie の置き場の掃除 (React Native の Networking.clearCookies。#1612 / #1049 F7-16) も、どの経路でも呼ばれることを見る。
 * 起動時に未ログインと決まったときと SIGNED_OUT は、その完了を待たずに未ログインの画面を出し、起動時の失効の明言は
 * 完了を待ってからサインアウトする (#1647。userScopedLocalData.ts の WebViewNativeCookieClearWait)
 */

import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Networking } from 'react-native';

const mockGetSession = jest.fn();
const mockGetUser = jest.fn();
const mockSignOut = jest.fn();
const mockOnAuthStateChange = jest.fn();
const mockGetStoredSession = jest.fn();

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

import { PERSISTENCE_KEYS } from '../../src/lib/persistence';
import {
  readPendingWebViewUserScopedStorageClear,
  resetWebViewUserStorageCleanupForTests,
} from '../../src/lib/webViewUserStorageCleanup';
import { AuthProvider, useAuth } from '../../src/providers/AuthProvider';

type AuthListener = (event: string, session: unknown) => void;
let authListener: AuthListener;

/** 前の利用者 (user-1) が端末に残した値 */
const PREVIOUS_USER_ID = 'user-1';
const PUSH_TOKEN_VALUE_KEY = `push_token_value_v1:${PREVIOUS_USER_ID}`;
const RANGE_DAYS_KEY = PERSISTENCE_KEYS.v4_range_days.key;

function makeSession(id = PREVIOUS_USER_ID, accessToken = 'access-1') {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-1',
    expires_at: 1_900_000_000,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id, email: `${id}@example.com` },
  };
}

function authError(name: string, status: number | undefined, message: string, code?: string) {
  return Object.assign(new Error(message), { name, status, code });
}

function Probe() {
  const { isLoading, session } = useAuth();
  return (
    <>
      <Text testID="loading">{String(isLoading)}</Text>
      <Text testID="session">{session ? session.access_token : 'none'}</Text>
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

async function seedPreviousUserData() {
  await AsyncStorage.multiSet([
    [RANGE_DAYS_KEY, JSON.stringify({ data: 7 })],
    [PUSH_TOKEN_VALUE_KEY, 'ExponentPushToken[previous]'],
    ['unrelated', 'keep'],
  ]);
}

/**
 * 前の利用者の値が消えていること。
 * pushTokenValue: 'kept' は SIGNED_OUT の掃除。この端末の push token の値だけは残す (このあとに signOut.ts が読んで
 * user_push_tokens の行を消すことがある。#1615。AuthProvider.tsx の先頭の表)
 */
async function expectPreviousUserDataCleared({ pushTokenValue }: { pushTokenValue: 'cleared' | 'kept' } = { pushTokenValue: 'cleared' }) {
  expect(await AsyncStorage.getItem(RANGE_DAYS_KEY)).toBeNull();
  if (pushTokenValue === 'cleared') {
    expect(await AsyncStorage.getItem(PUSH_TOKEN_VALUE_KEY)).toBeNull();
  } else {
    expect(await AsyncStorage.getItem(PUSH_TOKEN_VALUE_KEY)).toBe('ExponentPushToken[previous]');
  }
  // 利用者別でないキーは消さない
  expect(await AsyncStorage.getItem('unrelated')).toBe('keep');
  // 次に開く WebView に、利用者別の localStorage の掃除が頼まれている
  expect(await readPendingWebViewUserScopedStorageClear()).toEqual(expect.any(String));
}

/**
 * Networking.clearCookies の差し替え。テストの環境のネイティブには clearCookies が無いので、ここで置く。
 * respond: 'immediately' はすぐに消し終わったと知らせる。'manually' は知らせを止めておき、release() で知らせる
 * (知らせが来ない端末を真似る。上限の時計を片付けるため、テストの最後に release() する)
 */
type ClearCookiesCallback = (result: boolean) => void;
let pendingCookieCallbacks: ClearCookiesCallback[] = [];
const mockClearCookies = jest.fn();
const networking = Networking as { clearCookies?: (callback: ClearCookiesCallback) => void } | undefined;
const originalClearCookies = networking?.clearCookies;

function respondToClearCookies(respond: 'immediately' | 'manually') {
  mockClearCookies.mockImplementation((callback: ClearCookiesCallback) => {
    if (respond === 'immediately') callback(true);
    else pendingCookieCallbacks.push(callback);
  });
}

function releaseClearCookies() {
  const callbacks = pendingCookieCallbacks;
  pendingCookieCallbacks = [];
  for (const callback of callbacks) callback(true);
}

afterEach(() => {
  releaseClearCookies();
});

afterAll(() => {
  if (networking) networking.clearCookies = originalClearCookies;
});

beforeEach(async () => {
  jest.clearAllMocks();
  pendingCookieCallbacks = [];
  if (networking) networking.clearCookies = (callback: ClearCookiesCallback) => mockClearCookies(callback);
  respondToClearCookies('immediately');
  resetWebViewUserStorageCleanupForTests();
  await AsyncStorage.clear();
  await seedPreviousUserData();
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
  mockSignOut.mockResolvedValue({ error: null });
  mockGetStoredSession.mockResolvedValue(null);
  mockOnAuthStateChange.mockImplementation((listener: AuthListener) => {
    authListener = listener;
    return { data: { subscription: { unsubscribe: jest.fn() } } };
  });
});

describe('AuthProvider — 未ログインになるどの経路でも、端末の利用者別のデータが消える (#1615)', () => {
  it('前提: ログイン済みで起動したときは消さず、掃除も頼まない', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: session.user }, error: null });

    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    expect(text(api, 'session')).toBe('access-1');
    expect(await AsyncStorage.getItem(RANGE_DAYS_KEY)).not.toBeNull();
    expect(await AsyncStorage.getItem(PUSH_TOKEN_VALUE_KEY)).toBe('ExponentPushToken[previous]');
    expect(await readPendingWebViewUserScopedStorageClear()).toBeNull();
  });

  it('SIGNED_OUT (自動更新で refresh_token が失効と答えた・Web のログアウトで全端末が失効したなど)', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: session.user }, error: null });
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'session')).toBe('access-1'));

    act(() => authListener('SIGNED_OUT', null));

    expect(text(api, 'session')).toBe('none');
    // SIGNED_OUT の掃除が WebView の掃除を頼むまで待つ (AsyncStorage の掃除のあとに頼む)
    await waitFor(async () => expect(await readPendingWebViewUserScopedStorageClear()).toEqual(expect.any(String)));
    await expectPreviousUserDataCleared({ pushTokenValue: 'kept' });
  });

  it('一度もセッションが無いまま SIGNED_OUT が届いても (ID なしの掃除)、push token の値は残す', async () => {
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    // 起動時の掃除 (ID なし) が消したので、前の利用者の値を置き直す
    await seedPreviousUserData();
    const requestBefore = await readPendingWebViewUserScopedStorageClear();

    act(() => authListener('SIGNED_OUT', null));

    // SIGNED_OUT の掃除が WebView の掃除を頼み直すまで待つ (AsyncStorage の掃除のあとに頼む)
    await waitFor(async () => expect(await readPendingWebViewUserScopedStorageClear()).not.toBe(requestBefore));
    await expectPreviousUserDataCleared({ pushTokenValue: 'kept' });
  });

  it('起動時に保存済みのセッションが無い (getSession() が null)', async () => {
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    expect(text(api, 'session')).toBe('none');
    await expectPreviousUserDataCleared();
  });

  it('起動時に refresh_token の失効で getSession() が null を返した', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: authError('AuthApiError', 400, 'Invalid Refresh Token', 'refresh_token_not_found'),
    });

    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    expect(text(api, 'session')).toBe('none');
    await expectPreviousUserDataCleared();
  });

  it('起動時にサーバーが失効と明言した (getUser() が session_not_found)', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: authError('AuthApiError', 403, 'Session not found', 'session_not_found'),
    });

    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    expect(text(api, 'session')).toBe('none');
    await expectPreviousUserDataCleared();
  });

  it('二重に掃除しても (失効の明言の掃除 → signOut の SIGNED_OUT の掃除) 例外にならず、2 回目のあとに次の利用者が書いた値は消さない', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: authError('AuthApiError', 403, 'Session not found', 'session_not_found'),
    });
    let signedOutCleanupRequested = false;
    mockSignOut.mockImplementation(async () => {
      authListener('SIGNED_OUT', null);
      signedOutCleanupRequested = true;
      return { error: null };
    });

    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(signedOutCleanupRequested).toBe(true);
    // 2 回目の掃除 (SIGNED_OUT) が済むのを待つ: 掃除の ID が書き換わるまで
    const firstRequest = await readPendingWebViewUserScopedStorageClear();
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    await expectPreviousUserDataCleared();
    const settledRequest = await readPendingWebViewUserScopedStorageClear();
    expect(firstRequest).toEqual(expect.any(String));
    expect(settledRequest).toEqual(expect.any(String));

    // 次の利用者がログインして値を書く。それ以後、掃除は走らない
    act(() => authListener('SIGNED_IN', makeSession('user-2', 'access-2')));
    await AsyncStorage.setItem(RANGE_DAYS_KEY, JSON.stringify({ data: 3 }));
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect(text(api, 'session')).toBe('access-2');
    expect(await AsyncStorage.getItem(RANGE_DAYS_KEY)).toBe(JSON.stringify({ data: 3 }));
    expect(await readPendingWebViewUserScopedStorageClear()).toBe(settledRequest);
  });

  it('clearSession のあと (サインアウトの失敗で端末だけ忘れた) に別の利用者がログインしてから SIGNED_OUT が届くと、掃除するのは次の利用者のキー (#1636)', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: session.user }, error: null });
    let clearSession: (() => void) | null = null;
    function ClearSessionProbe() {
      clearSession = useAuth().clearSession;
      return null;
    }
    const api = render(
      <AuthProvider>
        <Probe />
        <ClearSessionProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(text(api, 'session')).toBe('access-1'));

    // signOut.ts の signOutOrForgetLocally と同じ: SIGNED_OUT は届かず、画面の状態だけを消す
    act(() => clearSession?.());
    expect(text(api, 'session')).toBe('none');

    // 次の利用者がログインし、利用者の ID 付きのキーを書く
    const NEXT_USER_ID = 'user-2';
    const nextUserKey = `push_token_registered_v2:${NEXT_USER_ID}`;
    act(() => authListener('SIGNED_IN', makeSession(NEXT_USER_ID, 'access-2')));
    await AsyncStorage.setItem(nextUserKey, 'true');
    expect(text(api, 'session')).toBe('access-2');

    const requestBefore = await readPendingWebViewUserScopedStorageClear();
    act(() => authListener('SIGNED_OUT', null));

    await waitFor(async () => expect(await readPendingWebViewUserScopedStorageClear()).not.toBe(requestBefore));
    // 前の利用者の ID で掃除すると、次の利用者のキーが残る
    expect(await AsyncStorage.getItem(nextUserKey)).toBeNull();
    expect(await AsyncStorage.getItem('unrelated')).toBe('keep');
  });
});

describe('AuthProvider — 端末の Cookie の置き場の掃除 (Networking.clearCookies。#1612 / #1647)', () => {
  it('前提: テストの環境で Networking を差し替えられる (差し替えられないと、下のテストは何も確かめない)', () => {
    expect(networking).toBeDefined();
  });

  it('ログイン済みで起動したときは呼ばない', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: session.user }, error: null });

    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    expect(text(api, 'session')).toBe('access-1');
    expect(mockClearCookies).not.toHaveBeenCalled();
  });

  it('起動時に未ログインと決まったとき (getSession() が null) に呼ぶ', async () => {
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    expect(text(api, 'session')).toBe('none');
    expect(mockClearCookies).toHaveBeenCalledTimes(1);
  });

  it('起動時に未ログインと決まったときは、知らせが来なくても、その完了を待たずに未ログインの画面を出す', async () => {
    respondToClearCookies('manually');

    const api = renderProvider();
    await waitFor(() => expect(text(api, 'loading')).toBe('false'));

    // まだ知らせが来ていない (掃除は終わっていない) のに、読み込み中が終わっている
    expect(mockClearCookies).toHaveBeenCalledTimes(1);
    expect(pendingCookieCallbacks).toHaveLength(1);
    expect(text(api, 'session')).toBe('none');
    // AsyncStorage と localStorage の掃除の依頼は待っている (未ログインの画面を出す前に済んでいる)
    await expectPreviousUserDataCleared();
  });

  it('SIGNED_OUT のときに呼ぶ', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: session.user }, error: null });
    const api = renderProvider();
    await waitFor(() => expect(text(api, 'session')).toBe('access-1'));
    expect(mockClearCookies).not.toHaveBeenCalled();

    act(() => authListener('SIGNED_OUT', null));

    expect(text(api, 'session')).toBe('none');
    await waitFor(() => expect(mockClearCookies).toHaveBeenCalledTimes(1));
  });

  it('起動時にサーバーが失効と明言したときは、掃除の完了を待ってからサインアウトする (サインアウトの前に消す順を保つ)', async () => {
    respondToClearCookies('manually');
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session }, error: null });
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: authError('AuthApiError', 403, 'Session not found', 'session_not_found'),
    });

    const api = renderProvider();
    await waitFor(() => expect(mockClearCookies).toHaveBeenCalledTimes(1));
    // 知らせが来るまで、サインアウトせず読み込み中のまま
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(text(api, 'loading')).toBe('true');

    act(() => releaseClearCookies());

    await waitFor(() => expect(text(api, 'loading')).toBe('false'));
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(text(api, 'session')).toBe('none');
  });
});
