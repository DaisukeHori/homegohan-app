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
 * Issue #1037 round-4 レビュー指摘 (Sonnet Warning) の回帰防止:
 *
 *  4. サーバー削除は成功したが signOut() がネットワークエラー等で失敗した場合、
 *     AsyncStorage の認証トークンを直接クリア + AuthProvider の in-memory session も
 *     クリアしてからログイン画面へ確実に遷移する (削除済みアカウントがホームへ
 *     戻るフラッシュを防ぐ)
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
  supabase: {
    auth: {
      getUser: (...args: any[]) => mockGetUser(...args),
      signOut: (...args: any[]) => mockSignOut(...args),
    },
  },
}));

const mockClearUserScopedAsyncStorage = jest.fn();
const mockClearSupabaseAuthStorage = jest.fn();
jest.mock('../../src/lib/user-storage', () => ({
  clearUserScopedAsyncStorage: (...args: any[]) => mockClearUserScopedAsyncStorage(...args),
  clearSupabaseAuthStorage: (...args: any[]) => mockClearSupabaseAuthStorage(...args),
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
  });
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
  });

  it('2. 削除 API が失敗した場合、ローカルセッションは破棄されずログイン状態を維持する', async () => {
    mockPost.mockRejectedValueOnce(new Error('サーバーエラー'));

    render(<AccountSettingsPage />);

    fireEvent.press(screen.getByTestId('account-delete-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('削除失敗', expect.stringContaining('サーバーエラー'));
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

  it('4. サーバー削除後 signOut が失敗(戻り値の error のみ・例外は投げない)しても、AsyncStorage の認証トークンと in-memory session を直接クリアしてログイン画面へ遷移する', async () => {
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
    // 場合でも、ネットワークに依存しないフェイルセーフで AsyncStorage の認証トークンを
    // 直接クリアし、AuthProvider の in-memory session も破棄していること。
    expect(mockClearSupabaseAuthStorage).toHaveBeenCalledTimes(1);
    expect(mockClearSession).toHaveBeenCalledTimes(1);

    // 「削除失敗」ではなく「削除は完了した」旨の文言でアラートを出す
    // (再試行してもサーバー側にアカウントが無いため削除 API は失敗するだけになる)
    expect(alertSpy).toHaveBeenCalledWith(
      'アカウントを削除しました',
      expect.stringContaining('端末側のログアウト処理に失敗'),
    );
    expect(alertSpy).not.toHaveBeenCalledWith('削除失敗', expect.anything());
  });
});
