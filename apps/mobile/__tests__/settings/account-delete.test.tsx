/**
 * account-delete.test.tsx
 * apps/mobile/app/settings/account.tsx の RNTL 単体テスト
 * Issue #1037 round-2 レビュー指摘 #3 の回帰防止:
 *
 *  1. 削除成功時: サーバー削除 API → ローカル AsyncStorage クリア → signOut の順で呼ばれる
 *     (ローカルクリアが削除 API 呼び出しより先に走らないこと)
 *  2. 削除 API が失敗した場合: ローカルセッション (AsyncStorage / signOut) は破棄されず、
 *     ログイン状態を維持したまま再試行できる
 *  3. 連打しても削除 API は 1 回しか呼ばれない (多重実行防止ガード)
 *
 *  4. サーバー削除は成功したが signOut() がネットワークエラー等で失敗した場合、
 *     保管庫 (secureSessionStorage) のセッションを端末だけで消し、AuthProvider の
 *     in-memory session もクリアしてからログイン画面へ遷移する (削除済みアカウントが
 *     ホームへ戻るのを防ぐ)。セッションは #1038 F7-06 から AsyncStorage ではなく保管庫にある。
 *
 * signOut.ts (signOutAfterAccountDeletion) は実物を通し、その先の supabase・保管庫・AsyncStorage の掃除をモックにする。
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ---- 呼び出し順を記録する共有配列 ----
let callOrder: string[] = [];

// ---- Mocks ----
const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    post: (...args: any[]) => mockPost(...args),
  }),
}));

const mockGetUser = jest.fn();
const mockSignOut = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-test-auth-token',
  supabase: {
    auth: {
      getUser: (...args: any[]) => mockGetUser(...args),
      signOut: (...args: any[]) => mockSignOut(...args),
    },
  },
}));

const mockClearUserScopedAsyncStorage = jest.fn();
jest.mock('../../src/lib/user-storage', () => ({
  clearUserScopedAsyncStorage: (...args: any[]) => mockClearUserScopedAsyncStorage(...args),
}));

const mockRemoveStoredItem = jest.fn();
jest.mock('../../src/lib/secureSessionStorage', () => ({
  secureSessionStorage: { removeItem: (...args: any[]) => mockRemoveStoredItem(...args) },
}));

// 退会では push token を消さない (auth.users の削除で ON DELETE CASCADE)。呼ばれないことを確かめる
const mockUnregisterExpoPushToken = jest.fn();
jest.mock('../../src/lib/pushNotifications', () => ({
  unregisterExpoPushToken: (...args: any[]) => mockUnregisterExpoPushToken(...args),
}));

const mockClearSession = jest.fn();
jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ clearSession: (...args: any[]) => mockClearSession(...args) }),
}));

const mockReplace = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...args: any[]) => mockReplace(...args), push: (...args: unknown[]) => mockPush(...args) },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('../../src/theme', () => ({
  colors: { bg: '#fff', error: '#dc2626', textLight: '#555' },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, '4xl': 64 },
}));

jest.mock('../../src/theme/typography', () => ({
  typography: { body: {} },
}));

jest.mock('../../src/components/ui', () => {
  const React = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    Card: ({ children }: any) => <View>{children}</View>,
    SectionHeader: ({ title }: any) => <Text>{title}</Text>,
    PageHeader: ({ title }: any) => <Text>{title}</Text>,
    Button: ({ children, onPress, disabled, testID }: any) => (
      <Pressable testID={testID} onPress={onPress} disabled={disabled}>
        {children}
      </Pressable>
    ),
  };
});

// パスワード・メールアドレスの変更の部品 (#1187) は別のテスト (account-credentials.test.tsx) で確かめる。
// ここでは退会だけを見るので、何も描かない部品に差し替える (部品が読み込み時に呼ぶ getUser を、退会の呼び出しと混ぜないため)
jest.mock('../../src/components/settings/AccountCredentialsSection', () => ({
  AccountCredentialsSection: () => null,
}));

import AccountSettingsPage from '../../app/settings/account';
import { HttpNetworkError } from '@homegohan/core';
import {
  ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE,
  ACCOUNT_DELETE_FAILED_MESSAGE,
  ACCOUNT_DELETE_SESSION_EXPIRED_MESSAGE,
} from '../../src/lib/account-deletion-error';
import { NETWORK_ERROR_MESSAGES } from '../../src/lib/api-error';
import { ServiceUnavailableError } from '../../src/lib/service-unavailable';
import { MEMBERSHIP_SETTINGS_SCREEN_ROUTE } from '../../src/lib/membership-settings';
import {
  readPendingWebViewUserScopedStorageClear,
  resetWebViewUserStorageCleanupForTests,
} from '../../src/lib/webViewUserStorageCleanup';
import * as SecureStore from 'expo-secure-store';
import { PUSH_TOKEN_RELEASE_API_PATH } from '@homegohan/shared';
import { PUSH_INSTALL_SECRET_STORE_KEY } from '../../src/lib/pushInstallSecret';
import {
  PUSH_TOKEN_RELEASE_PENDING_KEY,
  PUSH_TOKEN_VALUE_KEY_PREFIX,
  releasePushTokenAfterSignedOut,
} from '../../src/lib/pushTokenRelease';

// Alert.alert をモックし、確認ダイアログでは "削除" ボタンを自動タップしたことにする
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((title, _message, buttons) => {
  if (title === 'アカウント削除') {
    const confirmButton = buttons?.find((b) => b.text === '削除');
    confirmButton?.onPress?.();
  }
  // "削除失敗" 等その他のアラートは記録のみで何もしない
});

beforeEach(async () => {
  jest.clearAllMocks();
  resetWebViewUserStorageCleanupForTests();
  await AsyncStorage.clear();
  alertSpy.mockClear();
  callOrder = [];
  mockGetUser.mockImplementation(async () => {
    callOrder.push('getUser');
    return { data: { user: { id: 'uid-1' } } };
  });
  mockPost.mockImplementation(async () => {
    callOrder.push('apiDelete');
    return {};
  });
  mockClearUserScopedAsyncStorage.mockImplementation(async () => {
    callOrder.push('clearLocal');
  });
  mockSignOut.mockImplementation(async () => {
    callOrder.push('signOut');
    return { error: null };
  });
  mockRemoveStoredItem.mockResolvedValue(undefined);
});

describe('AccountSettingsPage — アカウント削除', () => {
  it('1. 削除成功時: サーバー削除 API → ローカルクリア → signOut の順で呼ばれる', async () => {
    render(<AccountSettingsPage />);

    fireEvent.press(screen.getByTestId('account-delete-button'));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });

    // サーバー削除 (apiDelete) がローカルクリア (clearLocal) より先に呼ばれていること。
    // 旧実装はこの順序が逆で、削除失敗時にローカルだけ消える不整合があった。
    const apiIndex = callOrder.indexOf('apiDelete');
    const clearIndex = callOrder.indexOf('clearLocal');
    const signOutIndex = callOrder.indexOf('signOut');
    expect(apiIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(apiIndex);
    expect(signOutIndex).toBeGreaterThan(clearIndex);

    expect(mockPost).toHaveBeenCalledWith('/api/account/delete', { confirm: true });
    expect(mockClearUserScopedAsyncStorage).toHaveBeenCalledWith('uid-1');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    // サインアウトが成功したときは、保管庫を直接消さない (supabase-js が消す)・画面の状態も SIGNED_OUT で消える
    expect(mockRemoveStoredItem).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockUnregisterExpoPushToken).not.toHaveBeenCalled();
    // 次に開く WebView に、利用者別の localStorage を消させる (#1037。中身は web-view-user-storage-cleanup.test.ts)
    expect(await readPendingWebViewUserScopedStorageClear()).toEqual(expect.any(String));
  });

  it('2. 削除 API が失敗した場合、ローカルセッションは破棄されずログイン状態を維持する', async () => {
    mockPost.mockRejectedValueOnce(new Error('HTTP 500 Internal Server Error: {"error":"処理中にエラーが発生しました","code":"INTERNAL_ERROR"}'));

    render(<AccountSettingsPage />);

    fireEvent.press(screen.getByTestId('account-delete-button'));

    // 生の例外の文 (HTTP のステータスや JSON) は出さず、汎用の文を出す (#1447)
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('削除失敗', ACCOUNT_DELETE_FAILED_MESSAGE);
    });

    // 削除 API が失敗した場合、ローカルクリア・signOut・遷移は一切実行されない
    expect(mockClearUserScopedAsyncStorage).not.toHaveBeenCalled();
    expect(await readPendingWebViewUserScopedStorageClear()).toBeNull();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();

    // 再試行できる状態に戻っていること (ボタンが disable されたまま固まらない)。
    // 2 回目は成功させ、削除 API が再度呼べることを確認する。
    mockPost.mockResolvedValueOnce({});
    fireEvent.press(screen.getByTestId('account-delete-button'));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('3. ボタンを連打しても削除 API は 1 回しか呼ばれない', async () => {
    // apiDelete の完了を意図的に遅延させ、連打のタイミングを作る
    let resolvePost: (() => void) | undefined;
    mockPost.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePost = () => {
            callOrder.push('apiDelete');
            resolve();
          };
        }),
    );

    render(<AccountSettingsPage />);

    const button = screen.getByTestId('account-delete-button');
    // 同一 tick 内で連打 (onPress は同期的に発火するため、2・3 回目は
    // deletingRef による同期ガードで deleteAccount() 本体に到達しないはず)
    fireEvent.press(button);
    fireEvent.press(button);
    fireEvent.press(button);

    // 非同期チェーン (Alert.alert の確認 → api.post 呼び出し) が進むのを待つ
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    resolvePost?.();
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });

    // 完了後も 1 回のまま増えていないこと
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('4. サーバー削除後 signOut が失敗(戻り値の error のみ・例外は投げない)しても、保管庫のセッションと in-memory session を直接クリアしてログイン画面へ遷移する', async () => {
    // auth-js の signOut() は throwOnError が既定 false のため、ネットワークエラー等の
    // 失敗時も例外を投げず `{ error }` を返すだけのことがある (Round-4 レビュー指摘)。
    mockSignOut.mockImplementation(async () => {
      callOrder.push('signOut');
      return { error: new Error('network error') };
    });

    render(<AccountSettingsPage />);

    fireEvent.press(screen.getByTestId('account-delete-button'));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });

    // サーバー削除自体は成功済みなので削除 API は 1 回だけ呼ばれる (再試行はしない)
    expect(mockPost).toHaveBeenCalledTimes(1);

    // signOut がエラーを返した (= auth-js が内部で _removeSession() をスキップした)
    // 場合でも、ネットワークに依存せずに保管庫のセッション (と PKCE の code-verifier) を
    // 直接消し、AuthProvider の in-memory session も破棄していること。
    expect(mockRemoveStoredItem).toHaveBeenCalledWith('sb-test-auth-token');
    expect(mockRemoveStoredItem).toHaveBeenCalledWith('sb-test-auth-token-code-verifier');
    expect(mockClearSession).toHaveBeenCalledTimes(1);

    // 端末だけでセッションを忘れるのは、サーバーでの削除 (auth.users と一緒にサーバーのセッションも消える) が済んだあとだけ。
    // push token の行も消しに行かない (ON DELETE CASCADE で消えている)。AuthProvider.tsx の先頭の表の通信の失敗の行 (#1636)
    expect(callOrder.indexOf('apiDelete')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('signOut')).toBeGreaterThan(callOrder.indexOf('apiDelete'));
    expect(mockUnregisterExpoPushToken).not.toHaveBeenCalled();

    // 「削除失敗」ではなく「削除は完了した」旨の文言でアラートを出す
    // (再試行してもサーバー側にアカウントが無いため削除 API は失敗するだけになる)
    expect(alertSpy).toHaveBeenCalledWith(
      'アカウントを削除しました',
      expect.stringContaining('端末側のログアウト処理に失敗'),
    );
    expect(alertSpy).not.toHaveBeenCalledWith('削除失敗', expect.anything());
  });

  it('5. サーバー削除後 signOut が例外を投げても、保管庫と in-memory session を消してログイン画面へ遷移する', async () => {
    mockSignOut.mockImplementation(async () => {
      callOrder.push('signOut');
      throw new Error('unexpected');
    });

    render(<AccountSettingsPage />);

    fireEvent.press(screen.getByTestId('account-delete-button'));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });
    expect(mockRemoveStoredItem).toHaveBeenCalledWith('sb-test-auth-token');
    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith('アカウントを削除しました', expect.any(String));
  });
});

describe('AccountSettingsPage — 退会できない・失敗したときの文 (#1447)', () => {
  /** サーバー (src/lib/account-deletion.ts の findBlocker) が 409 の本文に入れる文 */
  const ORG_OWNER_MESSAGE = '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。';
  const FAMILY_REPRESENTATIVE_MESSAGE = '家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。';

  /** 削除を押して、出た Alert (確認のダイアログ以外) の見出しと本文を返す */
  async function pressDeleteAndGetFailureAlert() {
    render(<AccountSettingsPage />);
    fireEvent.press(screen.getByTestId('account-delete-button'));
    await waitFor(() => {
      expect(alertSpy.mock.calls.some(([title]) => title !== 'アカウント削除')).toBe(true);
    });
    const failures = alertSpy.mock.calls.filter(([title]) => title !== 'アカウント削除');
    expect(failures).toHaveLength(1);
    // 退会はしていない: 端末のログアウト・遷移はしない
    expect(mockClearUserScopedAsyncStorage).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    return { title: failures[0][0], message: failures[0][1] };
  }

  /** 削除を押して、出た Alert (確認のダイアログ以外) のボタンを返す (ボタンが無ければ undefined) */
  async function pressDeleteAndGetFailureButtons() {
    render(<AccountSettingsPage />);
    fireEvent.press(screen.getByTestId('account-delete-button'));
    await waitFor(() => {
      expect(alertSpy.mock.calls.some(([title]) => title !== 'アカウント削除')).toBe(true);
    });
    const failures = alertSpy.mock.calls.filter(([title]) => title !== 'アカウント削除');
    expect(failures).toHaveLength(1);
    return failures[0][2];
  }

  it.each([
    ['組織のオーナー', 'HTTP 409 Conflict', 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER', ORG_OWNER_MESSAGE],
    // HTTP/2 では statusText が空になる
    ['家族グループの代表者 (statusText が空)', 'HTTP 409 ', 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE', FAMILY_REPRESENTATIVE_MESSAGE],
  ])('409 (%s): 生の文字列ではなく、譲渡や解散が先だというサーバーの文を出す', async (_label, prefix, code, message) => {
    mockPost.mockRejectedValueOnce(
      new Error(`${prefix}: ${JSON.stringify({ error: code, message, organization: { id: 'org-1', name: '組織 A' } })}`),
    );
    const alert = await pressDeleteAndGetFailureAlert();
    expect(alert).toEqual({ title: '退会できません', message });
  });

  it('409: Alert に「閉じる」と「メンバーシップ設定を開く」があり、押すと MEMBERSHIP_SETTINGS_SCREEN_ROUTE へ router.push する (#1917)', async () => {
    mockPost.mockRejectedValueOnce(
      new Error(`HTTP 409 Conflict: ${JSON.stringify({ error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE', message: FAMILY_REPRESENTATIVE_MESSAGE })}`),
    );
    const buttons = await pressDeleteAndGetFailureButtons();
    expect(buttons?.map((b) => b.text)).toEqual(['閉じる', 'メンバーシップ設定を開く']);
    expect(buttons?.[0].style).toBe('cancel');
    expect(mockPush).not.toHaveBeenCalled();
    buttons?.[1].onPress?.();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(MEMBERSHIP_SETTINGS_SCREEN_ROUTE);
    expect(MEMBERSHIP_SETTINGS_SCREEN_ROUTE).toBe('/settings/membership');
  });

  it.each([
    ['500', new Error('HTTP 500 Internal Server Error: {}')],
    ['通信の失敗', new HttpNetworkError('offline', 'raw offline')],
  ])('%s の Alert にはボタンが無い (文だけ)', async (_label, error) => {
    mockPost.mockRejectedValueOnce(error);
    const buttons = await pressDeleteAndGetFailureButtons();
    expect(buttons).toBeUndefined();
  });

  it('409 で本文に文が無いときは、定型の案内の文を出す', async () => {
    mockPost.mockRejectedValueOnce(new Error('HTTP 409 Conflict: {"error":"ACCOUNT_DELETE_BLOCKED_ORG_OWNER"}'));
    const alert = await pressDeleteAndGetFailureAlert();
    expect(alert).toEqual({ title: '退会できません', message: ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE });
  });

  it('409 以外の HTTP のエラーは、本文に message があっても汎用の文を出す', async () => {
    mockPost.mockRejectedValueOnce(new Error('HTTP 400 Bad Request: {"error":"confirm is required","message":"内部の文"}'));
    const alert = await pressDeleteAndGetFailureAlert();
    expect(alert).toEqual({ title: '削除失敗', message: ACCOUNT_DELETE_FAILED_MESSAGE });
  });

  it('通信できなかったときは「通信できません」の文を出す', async () => {
    mockPost.mockRejectedValueOnce(new HttpNetworkError('offline', 'raw offline'));
    const alert = await pressDeleteAndGetFailureAlert();
    expect(alert).toEqual({ title: '削除失敗', message: NETWORK_ERROR_MESSAGES.offline });
  });

  it('メンテナンス中など (getApi() が置き換えた ServiceUnavailableError) は、その固定の文を出す', async () => {
    mockPost.mockRejectedValueOnce(new ServiceUnavailableError('ただいまメンテナンス中です。'));
    const alert = await pressDeleteAndGetFailureAlert();
    expect(alert).toEqual({ title: '削除失敗', message: 'ただいまメンテナンス中です。' });
  });

  it('Error ではない値 (文字列) の 409 で本文が JSON でないときも、定型の案内の文を出す', async () => {
    mockPost.mockRejectedValueOnce('HTTP 409 Conflict: not json');
    const alert = await pressDeleteAndGetFailureAlert();
    expect(alert).toEqual({ title: '退会できません', message: ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE });
  });

  it('Error でも文字列でもない値で失敗したときは、汎用の文を出す', async () => {
    mockPost.mockRejectedValueOnce({ status: 409 });
    const alert = await pressDeleteAndGetFailureAlert();
    expect(alert).toEqual({ title: '削除失敗', message: ACCOUNT_DELETE_FAILED_MESSAGE });
  });
});

describe('AccountSettingsPage — ログインが切れていて退会できなかったとき (#1562)', () => {
  it('401: 汎用の「削除に失敗しました」ではなく、もう一度ログインするよう伝え、端末のセッションを消して入口へ戻す', async () => {
    mockPost.mockRejectedValueOnce(new Error('HTTP 401 Unauthorized: {"error":"Unauthorized"}'));
    render(<AccountSettingsPage />);
    fireEvent.press(screen.getByTestId('account-delete-button'));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });
    const failures = alertSpy.mock.calls.filter(([title]) => title !== 'アカウント削除');
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toBe('ログインが必要です');
    expect(failures[0][1]).toBe(ACCOUNT_DELETE_SESSION_EXPIRED_MESSAGE);
    expect(failures[0][1]).not.toBe(ACCOUNT_DELETE_FAILED_MESSAGE);
    // #1917: 401 の Alert にはボタンが無い (メンバーシップ設定へのボタンは 409 だけ)
    expect(failures[0][2]).toBeUndefined();
    // アカウントは消えていないので、通常のログアウト (push token の削除 → 端末のデータの削除 → サインアウト)
    expect(mockUnregisterExpoPushToken).toHaveBeenCalledWith('uid-1', expect.anything());
    expect(mockClearUserScopedAsyncStorage).toHaveBeenCalledWith('uid-1');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it.each(['no_rows', 'failed'])(
    '401 のログアウトで push token の行の削除が %s でも、掃除の前に release の宛先を控え、続く SIGNED_OUT の release が行を消す (#1706)',
    async (unregisterResult) => {
      // 端末の秘密の値と、登録のときに控えた push token の値 (セッションが失効していて、本人のセッションでは行を消せない)
      const deviceSecret = 'shared-device-secret-aaaaaaaaaaaaaaaaaaaaaa'; // gitleaks:allow
      const token = 'ExponentPushToken[device]';
      const valueKey = `${PUSH_TOKEN_VALUE_KEY_PREFIX}:uid-1`;
      (SecureStore as unknown as { __reset: () => void }).__reset();
      await SecureStore.setItemAsync(PUSH_INSTALL_SECRET_STORE_KEY, deviceSecret);
      await AsyncStorage.setItem(valueKey, token);
      mockUnregisterExpoPushToken.mockResolvedValueOnce(unregisterResult);
      // 本物の掃除と同じく、ログアウトの掃除はこの値を消す (user-storage.ts の USER_ID_KEY_PREFIXES)
      mockClearUserScopedAsyncStorage.mockImplementation(async (userId: string) => {
        callOrder.push('clearLocal');
        await AsyncStorage.removeItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:${userId}`);
      });
      mockPost.mockRejectedValueOnce(new Error('HTTP 401 Unauthorized: {"error":"Unauthorized"}'));

      render(<AccountSettingsPage />);
      fireEvent.press(screen.getByTestId('account-delete-button'));
      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith('/');
      });

      expect(await AsyncStorage.getItem(valueKey)).toBeNull();
      expect(JSON.parse((await AsyncStorage.getItem(PUSH_TOKEN_RELEASE_PENDING_KEY)) ?? 'null')).toEqual([
        { userId: 'uid-1', token },
      ]);

      // サインアウトのあとに届く SIGNED_OUT の release (AuthProvider)。値はもう無いが、控えた宛先で行を消しに行く
      await releasePushTokenAfterSignedOut('uid-1');

      const releaseCalls = mockPost.mock.calls.filter(([path]) => path === PUSH_TOKEN_RELEASE_API_PATH);
      expect(releaseCalls.map(([, body]) => body)).toEqual([
        { expo_push_token: token, install_secret: deviceSecret, user_id: 'uid-1' },
      ]);
      expect(await AsyncStorage.getItem(PUSH_TOKEN_RELEASE_PENDING_KEY)).toBeNull();
    },
  );

  it('401 でも statusText が空 (HTTP/2) なら同じ扱い', async () => {
    mockPost.mockRejectedValueOnce(new Error('HTTP 401 : {"error":"Unauthorized"}'));
    render(<AccountSettingsPage />);
    fireEvent.press(screen.getByTestId('account-delete-button'));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });
    const failures = alertSpy.mock.calls.filter(([title]) => title !== 'アカウント削除');
    expect(failures.map(([title, message]) => [title, message])).toEqual([['ログインが必要です', ACCOUNT_DELETE_SESSION_EXPIRED_MESSAGE]]);
  });
});

describe('AccountSettingsPage — 退会の確認とストアの購読 (billing/03 §10.4・S35)', () => {
  it('the アカウント削除 confirmation shows the irreversible text followed by STORE_SUBSCRIPTION_DELETION_NOTICE with キャンセル / 定期購読の管理を開く / 削除, and 定期購読の管理を開く opens STORE_SUBSCRIPTION_MANAGEMENT_URL for the platform (play_store on android, app_store otherwise) without calling the delete API', async () => {
    const { Linking, Platform } = require('react-native');
    const { STORE_SUBSCRIPTION_DELETION_NOTICE, STORE_SUBSCRIPTION_MANAGEMENT_URL } = require('@homegohan/shared');
    const openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    // この it の中だけ、確認のダイアログで「定期購読の管理を開く」を押す
    alertSpy.mockImplementation((title, _message, buttons) => {
      if (title === 'アカウント削除') {
        buttons?.find((b) => b.text === '定期購読の管理を開く')?.onPress?.();
      }
    });
    try {
      render(<AccountSettingsPage />);
      fireEvent.press(screen.getByTestId('account-delete-button'));

      await waitFor(() => {
        expect(openURLSpy).toHaveBeenCalledTimes(1);
      });
      const confirmCalls = alertSpy.mock.calls.filter(([title]) => title === 'アカウント削除');
      expect(confirmCalls).toHaveLength(1);
      const [, message, buttons] = confirmCalls[0];
      expect(message).toBe(`アカウントとデータを削除します。取り消しできません。\n\n${STORE_SUBSCRIPTION_DELETION_NOTICE}`);
      expect((buttons ?? []).map((b) => b.text)).toEqual(['キャンセル', '定期購読の管理を開く', '削除']);

      const expectedStore = Platform.OS === 'android' ? 'play_store' : 'app_store';
      expect(openURLSpy).toHaveBeenCalledWith(STORE_SUBSCRIPTION_MANAGEMENT_URL[expectedStore]);
      // 退会はしない (削除の API を呼ばず、ログアウトもしない)。ボタンは押せる状態に戻る
      expect(mockPost).not.toHaveBeenCalledWith('/api/account/delete', expect.anything());
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
      // 多重実行のガードが戻っているので、もう一度押すと確認のダイアログがまた出る
      fireEvent.press(screen.getByTestId('account-delete-button'));
      await waitFor(() => {
        expect(openURLSpy).toHaveBeenCalledTimes(2);
      });
      expect(alertSpy.mock.calls.filter(([title]) => title === 'アカウント削除')).toHaveLength(2);
      expect(mockPost).not.toHaveBeenCalledWith('/api/account/delete', expect.anything());
    } finally {
      openURLSpy.mockRestore();
      alertSpy.mockImplementation((title, _message, buttons) => {
        if (title === 'アカウント削除') {
          buttons?.find((b) => b.text === '削除')?.onPress?.();
        }
      });
    }
  });
});
