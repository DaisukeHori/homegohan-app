/**
 * auth-provider-sign-out-cleanup.test.tsx
 * AuthProvider が未ログインになるどの経路でも、端末に残る利用者別のデータが消えることを、
 * 本物の掃除 (userScopedLocalData.ts → user-storage.ts・webViewUserStorageCleanup.ts) で確かめる (#1615)。
 *
 * auth-provider.test.tsx は掃除を差し替えて「呼ばれること・順番」を見る。ここでは差し替えずに、
 * AsyncStorage の利用者別のキーが消え、次に開く WebView に localStorage の掃除が頼まれていることまで見る。
 */

import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

async function expectPreviousUserDataCleared() {
  expect(await AsyncStorage.getItem(RANGE_DAYS_KEY)).toBeNull();
  expect(await AsyncStorage.getItem(PUSH_TOKEN_VALUE_KEY)).toBeNull();
  // 利用者別でないキーは消さない
  expect(await AsyncStorage.getItem('unrelated')).toBe('keep');
  // 次に開く WebView に、利用者別の localStorage の掃除が頼まれている
  expect(await readPendingWebViewUserScopedStorageClear()).toEqual(expect.any(String));
}

beforeEach(async () => {
  jest.clearAllMocks();
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
    await waitFor(async () => expect(await AsyncStorage.getItem(PUSH_TOKEN_VALUE_KEY)).toBeNull());
    await expectPreviousUserDataCleared();
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
});
