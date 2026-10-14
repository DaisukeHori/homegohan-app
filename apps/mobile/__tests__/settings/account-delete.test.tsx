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
jest.mock('expo-router', () => ({
  router: { replace: (...args: any[]) => mockReplace(...args) },
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

import AccountSettingsPage from '../../app/settings/account';
import { HttpNetworkError } from '@homegohan/core';
import {
  ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE,
  ACCOUNT_DELETE_FAILED_MESSAGE,
} from '../../src/lib/account-deletion-error';
import { NETWORK_ERROR_MESSAGES } from '../../src/lib/api-error';
import { ServiceUnavailableError } from '../../src/lib/service-unavailable';

// Alert.alert をモックし、確認ダイアログでは "削除" ボタンを自動タップしたことにする
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((title, _message, buttons) => {
  if (title === 'アカウント削除') {
    const confirmButton = buttons?.find((b) => b.text === '削除');
    confirmButton?.onPress?.();
  }
  // "削除失敗" 等その他のアラートは記録のみで何もしない
});

beforeEach(() => {
  jest.clearAllMocks();
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
