/**
 * logout.test.tsx
 * RNTL tests for the logout flow of apps/mobile/app/(tabs)/settings.tsx (#1038 F7-10 / #1037)
 *
 * ログアウトは、各画面でバラバラに書かず共通処理 (signOut.ts の signOutOnDevice) を通す。
 * ここでは signOut.ts を実物のまま通し、その先の supabase・保管庫・push token の削除をモックにして、
 *   - push token の削除 → 端末データの削除 → サインアウトの順に行い、トップへ戻ること
 *   - サインアウトが失敗しても (オフラインで { error } が返る・例外が投げられる)、保管庫のセッションと
 *     AuthProvider の画面の状態 (clearSession) を消してからトップへ戻ること (#1037。消さないと入口がホームへ戻す)
 *   - WebView の利用者別の localStorage の掃除を頼んでいること (#1037)
 * を確かめる。
 */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { readPendingWebViewUserScopedStorageClear } from '../../src/lib/webViewUserStorageCleanup';

// ---- Mocks ----

// 呼ばれた順を記録する
let callOrder: string[] = [];

const mockUnregisterExpoPushToken = jest.fn();
jest.mock('../../src/lib/pushNotifications', () => ({
  unregisterExpoPushToken: (...args: unknown[]) => mockUnregisterExpoPushToken(...args),
}));

const mockRemoveStoredItem = jest.fn();
jest.mock('../../src/lib/secureSessionStorage', () => ({
  secureSessionStorage: { removeItem: (...args: unknown[]) => mockRemoveStoredItem(...args) },
}));

const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockRouterReplace(...args),
    push: (...args: unknown[]) => mockRouterPush(...args),
  },
}));

const mockClearSession = jest.fn();
jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'uid-settings' }, clearSession: (...args: unknown[]) => mockClearSession(...args) }),
}));

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: jest.fn().mockResolvedValue({
      settings: { notifications_enabled: true, auto_analyze_enabled: true, data_share_enabled: false },
    }),
    patch: jest.fn().mockResolvedValue({}),
  }),
  getApiBaseUrl: () => 'https://api.example.test',
}));

const mockSignOut = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-test-auth-token',
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      signOut: (...args: unknown[]) => mockSignOut(...args),
    },
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { week_start_day: 'monday' } }),
      update: jest.fn().mockReturnThis(),
    }),
  },
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
}));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/tmp/',
  writeAsStringAsync: jest.fn(),
  EncodingType: { UTF8: 'utf8' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

import SettingsTab from '../../app/(tabs)/settings';

beforeEach(() => {
  jest.clearAllMocks();
  callOrder = [];
  mockUnregisterExpoPushToken.mockImplementation(async () => {
    callOrder.push('unregister');
    return 'deleted';
  });
  mockSignOut.mockImplementation(async () => {
    callOrder.push('signOut');
    return { error: null };
  });
  mockRemoveStoredItem.mockImplementation(async (key: string) => {
    callOrder.push(`removeStored:${key}`);
  });
  mockClearSession.mockImplementation(() => {
    callOrder.push('clearSession');
  });
  mockRouterReplace.mockImplementation((href: string) => {
    callOrder.push(`replace:${href}`);
  });
});

/** 確認モーダルで「ログアウト」を押し、トップへ戻るまで待つ */
async function confirmLogout(api: ReturnType<typeof render>) {
  fireEvent.press(api.getByTestId('settings-logout-button'));
  fireEvent.press(await api.findByTestId('settings-logout-confirm-button'));
  await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/'));
}

/** 画面の初期読み込み (設定値の取得) が終わるまで待つ。終わる前にテストが進むと act の警告が出る */
async function renderSettings() {
  const api = render(<SettingsTab />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return api;
}

describe('設定タブ — ログアウト (#1038 F7-10)', () => {
  it('確認モーダルで「ログアウト」を押すと、push token の削除 → サインアウトの順に行い、トップへ戻る', async () => {
    const api = await renderSettings();

    await confirmLogout(api);

    // push token の削除はサインアウトの前に行う必要がある (RLS)。共通処理が順序を保証する
    expect(mockUnregisterExpoPushToken).toHaveBeenCalledWith('uid-settings', { accessToken: undefined });
    expect(callOrder).toEqual(['unregister', 'signOut', 'replace:/']);
    // サインアウトが成功したときは、保管庫を直接消さない (supabase-js が消す)・画面の状態も SIGNED_OUT で消える
    expect(mockRemoveStoredItem).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  it('ログアウトすると、WebView の利用者別の localStorage の掃除を頼む (次に開く WebView が消す。#1037)', async () => {
    const api = await renderSettings();
    const before = await readPendingWebViewUserScopedStorageClear();

    await confirmLogout(api);

    const after = await readPendingWebViewUserScopedStorageClear();
    expect(after).toEqual(expect.any(String));
    expect(after).not.toBe(before);
  });

  it('キャンセルしたときは何も実行しない', async () => {
    const api = await renderSettings();

    fireEvent.press(api.getByTestId('settings-logout-button'));
    fireEvent.press(await api.findByTestId('settings-logout-cancel-button'));

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockUnregisterExpoPushToken).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
});

describe('設定タブ — サインアウトが失敗したとき (オフラインなど。#1037)', () => {
  // supabase.auth.signOut() は、access token が失効していて更新もできないと (オフライン・5xx・失敗の控えの間)、
  // 保管庫のセッションを消さずに { error } を返し、SIGNED_OUT も出さない (このテストの偽物の signOut はこちらの形)。
  // access token が有効なうちなら、通信に失敗しても supabase-js が保管庫を消して SIGNED_OUT を出す。
  // そのまま "/" へ移ると、入口 (app/index.tsx) がホームへ戻し、「ログアウトしたのに戻された」ように見える

  it('signOut が { error } を返したら、保管庫のセッションと画面の状態を消してから、トップへ戻る', async () => {
    mockSignOut.mockImplementation(async () => {
      callOrder.push('signOut');
      return { error: new Error('Network request failed') };
    });
    const api = await renderSettings();

    await confirmLogout(api);

    expect(callOrder).toEqual([
      'unregister',
      'signOut',
      'removeStored:sb-test-auth-token',
      'removeStored:sb-test-auth-token-code-verifier',
      'clearSession',
      'replace:/',
    ]);
  });

  it('signOut が例外を投げても、保管庫のセッションと画面の状態を消してから、トップへ戻る', async () => {
    mockSignOut.mockImplementation(async () => {
      callOrder.push('signOut');
      throw new Error('boom');
    });
    const api = await renderSettings();

    await confirmLogout(api);

    expect(callOrder).toEqual([
      'unregister',
      'signOut',
      'removeStored:sb-test-auth-token',
      'removeStored:sb-test-auth-token-code-verifier',
      'clearSession',
      'replace:/',
    ]);
  });

  it('push token の削除が例外を投げても、ログアウトを最後まで行い、トップへ戻る (ログアウト操作が固まらない)', async () => {
    mockUnregisterExpoPushToken.mockRejectedValue(new Error('boom'));
    const api = await renderSettings();

    await confirmLogout(api);

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('設定タブ — マイページの歯車から開いたときに届く操作 (#1037)', () => {
  // マイページ (WebView) の歯車 (app/(tabs)/profile.tsx) はこの画面を開く。
  // アプリの中の Web の設定画面ではログアウトと退会を出さないので、ここから必ず届かなければならない (ストアの審査の要件)
  it('通知の設定・ログアウト・退会 (アカウント) の入口がある', async () => {
    const api = await renderSettings();

    expect(api.getByTestId('settings-notifications-toggle')).toBeTruthy();
    expect(api.getByTestId('settings-logout-button')).toBeTruthy();
    expect(api.getByTestId('settings-account-row')).toBeTruthy();
  });

  it('「アカウント」を押すと退会の画面 (/settings/account) を開く', async () => {
    const api = await renderSettings();

    fireEvent.press(api.getByTestId('settings-account-row'));

    expect(mockRouterPush).toHaveBeenCalledWith('/settings/account');
  });
});
