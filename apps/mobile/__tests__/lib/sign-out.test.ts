/**
 * sign-out.test.ts
 * apps/mobile/src/lib/signOut.ts のテスト (#1038 F7-10)
 *
 * ログアウトの順番:
 *   1. この端末の push token を user_push_tokens から消す (RLS のため、サインアウトの「前」)
 *   2. ユーザー別の端末データを消す (AsyncStorage と、WebView の localStorage の掃除の依頼。#1037。WebView の Cookie。#1612 F7-16)
 *   3. サインアウト
 * push token の削除や端末データの掃除が失敗しても、ログアウトは止めない。
 *
 * 設定画面の通常のログアウト (signOutOnDevice。#1037):
 *   順番は同じ。サインアウトが失敗したら (エラーが返る・例外が投げられる)、保管庫のセッションを端末だけで消し、
 *   AuthProvider の clearSession() で画面の状態も消す。例外は投げない。
 *
 * 退会のあとのログアウト (signOutAfterAccountDeletion。#1037):
 *   push token は消さない (auth.users の削除で ON DELETE CASCADE)。端末データの削除 → サインアウトの順。
 *   サインアウトが失敗したら、signOutOnDevice と同じく、保管庫のセッションと画面の状態を端末だけで消す。
 */

const calls: string[] = [];

const mockUnregister = jest.fn();
const mockClearStorage = jest.fn();
const mockSignOut = jest.fn();

jest.mock('../../src/lib/pushNotifications', () => ({
  unregisterExpoPushToken: (...args: unknown[]) => mockUnregister(...args),
}));
jest.mock('../../src/lib/user-storage', () => ({
  clearUserScopedAsyncStorage: (...args: unknown[]) => mockClearStorage(...args),
}));
jest.mock('../../src/lib/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-test-auth-token',
  supabase: { auth: { signOut: (...args: unknown[]) => mockSignOut(...args) } },
}));
const mockRemoveStoredItem = jest.fn();
jest.mock('../../src/lib/secureSessionStorage', () => ({
  secureSessionStorage: { removeItem: (...args: unknown[]) => mockRemoveStoredItem(...args) },
}));
// WebView の localStorage の掃除の依頼 (中身は web-view-user-storage-cleanup.test.ts で確かめる)。ここでは順番だけを見る
const mockRequestWebViewClear = jest.fn();
// WebView の Cookie の掃除 (端末の Cookie の置き場を空にする。#1612 F7-16。中身は web-view-cookie-cleanup.test.ts)
const mockClearWebViewCookies = jest.fn();
jest.mock('../../src/lib/webViewUserStorageCleanup', () => ({
  requestWebViewUserScopedStorageClear: (...args: unknown[]) => mockRequestWebViewClear(...args),
  clearWebViewNativeCookies: (...args: unknown[]) => mockClearWebViewCookies(...args),
}));

import {
  clearStoredSessionLocally,
  signOutAfterAccountDeletion,
  signOutOnDevice,
  signOutWithCleanup,
} from '../../src/lib/signOut';

const mockClearSession = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockUnregister.mockImplementation(async () => {
    calls.push('unregister');
    return 'deleted';
  });
  mockClearStorage.mockImplementation(async () => {
    calls.push('clearStorage');
  });
  mockSignOut.mockImplementation(async () => {
    calls.push('signOut');
    return { error: null };
  });
  mockRemoveStoredItem.mockImplementation(async (key: string) => {
    calls.push(`removeStored:${key}`);
  });
  mockRequestWebViewClear.mockImplementation(async () => {
    calls.push('requestWebViewClear');
  });
  mockClearWebViewCookies.mockImplementation(async () => {
    calls.push('clearWebViewCookies');
    return 'cleared';
  });
  mockClearSession.mockImplementation(() => {
    calls.push('clearSession');
  });
});

describe('signOutWithCleanup', () => {
  it('push token の削除 → 端末データの削除 → サインアウトの順に実行する (削除はサインアウトより前でなければ RLS で拒否される)', async () => {
    const result = await signOutWithCleanup('user-1');

    expect(calls).toEqual(['unregister', 'clearStorage', 'requestWebViewClear', 'clearWebViewCookies', 'signOut']);
    // アクセストークンを渡さなければ、削除は現在のセッションで認可される (設定画面・マイページ)
    expect(mockUnregister).toHaveBeenCalledWith('user-1', { accessToken: undefined });
    expect(mockClearStorage).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({ error: null });
  });

  it('呼び出し側が控えたアクセストークンは、push token の削除にそのまま渡す (Web からの sign-out でセッションが先に失効しても、削除を認可できる)', async () => {
    await signOutWithCleanup('user-1', { accessToken: 'saved-access-token' });

    expect(mockUnregister).toHaveBeenCalledWith('user-1', { accessToken: 'saved-access-token' });
    expect(calls).toEqual(['unregister', 'clearStorage', 'requestWebViewClear', 'clearWebViewCookies', 'signOut']);
  });

  it('push token の削除が失敗 (failed / skipped) でも、ログアウトは最後まで行う', async () => {
    mockUnregister.mockResolvedValue('failed');
    await signOutWithCleanup('user-1');
    expect(calls).toContain('signOut');

    calls.length = 0;
    mockUnregister.mockResolvedValue('skipped');
    await signOutWithCleanup('user-1');
    expect(calls).toContain('signOut');
  });

  it('端末データの掃除で例外が出ても、サインアウトする', async () => {
    mockClearStorage.mockRejectedValue(new Error('storage busy'));

    await expect(signOutWithCleanup('user-1')).resolves.toEqual({ error: null });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    // AsyncStorage の掃除が失敗しても、WebView の掃除は頼む
    expect(mockRequestWebViewClear).toHaveBeenCalledTimes(1);
  });

  it('WebView の掃除の依頼で例外が出ても、サインアウトする', async () => {
    mockRequestWebViewClear.mockRejectedValue(new Error('unexpected'));

    await expect(signOutWithCleanup('user-1')).resolves.toEqual({ error: null });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('WebView の Cookie の掃除で例外が出ても、サインアウトする (#1612 F7-16)', async () => {
    mockClearWebViewCookies.mockRejectedValue(new Error('unexpected'));

    await expect(signOutWithCleanup('user-1')).resolves.toEqual({ error: null });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('WebView の掃除の依頼で例外が出ても、WebView の Cookie の掃除はする (#1612 F7-16)', async () => {
    mockRequestWebViewClear.mockRejectedValue(new Error('unexpected'));

    await signOutWithCleanup('user-1');

    expect(mockClearWebViewCookies).toHaveBeenCalledTimes(1);
  });

  it('ユーザー ID が分からなくても (null) 実行できる。端末データの掃除は null で行う', async () => {
    await signOutWithCleanup(null);

    expect(mockUnregister).toHaveBeenCalledWith(null, { accessToken: undefined });
    expect(mockClearStorage).toHaveBeenCalledWith(null);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('サインアウトが返したエラーは呼び出し元に返す (例外にはしない)。端末側の後始末はしない (signOutOnDevice と違う)', async () => {
    const failure = new Error('network');
    mockSignOut.mockResolvedValue({ error: failure });

    await expect(signOutWithCleanup('user-1')).resolves.toEqual({ error: failure });
    expect(mockRemoveStoredItem).not.toHaveBeenCalled();
  });
});

describe('signOutOnDevice (設定画面の通常のログアウト。#1037)', () => {
  it('push token の削除 → 端末データの削除 → サインアウトの順。成功したら保管庫は直接消さず、画面の状態も消さない (SIGNED_OUT で消える)', async () => {
    const result = await signOutOnDevice('user-1', { clearSession: mockClearSession });

    expect(calls).toEqual(['unregister', 'clearStorage', 'requestWebViewClear', 'clearWebViewCookies', 'signOut']);
    expect(mockUnregister).toHaveBeenCalledWith('user-1', { accessToken: undefined });
    expect(mockClearStorage).toHaveBeenCalledWith('user-1');
    expect(mockRemoveStoredItem).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(result).toEqual({ error: null });
  });

  it('サインアウトがエラーを返したら (オフラインなど。supabase-js は保管庫を消さない)、保管庫のセッションと code-verifier を消し、画面の状態も消して、エラーを返す', async () => {
    const failure = new Error('network');
    mockSignOut.mockImplementation(async () => {
      calls.push('signOut');
      return { error: failure };
    });

    const result = await signOutOnDevice('user-1', { clearSession: mockClearSession });

    expect(calls).toEqual([
      'unregister',
      'clearStorage',
      'requestWebViewClear',
      'clearWebViewCookies',
      'signOut',
      'removeStored:sb-test-auth-token',
      'removeStored:sb-test-auth-token-code-verifier',
      'clearSession',
    ]);
    expect(result).toEqual({ error: failure });
  });

  it('サインアウトが例外を投げても、保管庫と画面の状態を消してエラーとして返す (例外にはしない)', async () => {
    const failure = new Error('unexpected');
    mockSignOut.mockRejectedValue(failure);

    await expect(signOutOnDevice('user-1', { clearSession: mockClearSession })).resolves.toEqual({ error: failure });
    expect(mockRemoveStoredItem).toHaveBeenCalledWith('sb-test-auth-token');
    expect(mockRemoveStoredItem).toHaveBeenCalledWith('sb-test-auth-token-code-verifier');
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  it('例外の値が null でも、失敗として扱って端末のセッションを消す', async () => {
    mockSignOut.mockRejectedValue(null);

    const result = await signOutOnDevice('user-1', { clearSession: mockClearSession });

    expect(result.error).toBeInstanceOf(Error);
    expect(mockRemoveStoredItem).toHaveBeenCalledWith('sb-test-auth-token');
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  it('push token の削除が例外を投げても、ログアウトは最後まで行う', async () => {
    mockUnregister.mockRejectedValue(new Error('boom'));

    await expect(signOutOnDevice('user-1', { clearSession: mockClearSession })).resolves.toEqual({ error: null });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('端末データの掃除が失敗しても、サインアウトする', async () => {
    mockClearStorage.mockRejectedValue(new Error('storage busy'));
    mockRequestWebViewClear.mockRejectedValue(new Error('storage busy'));

    await expect(signOutOnDevice('user-1', { clearSession: mockClearSession })).resolves.toEqual({ error: null });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('signOutAfterAccountDeletion (退会のあと。#1037)', () => {
  it('端末データの削除 → サインアウトの順。push token は消さない (auth.users の削除で消える)。成功したら保管庫は直接消さない', async () => {
    const result = await signOutAfterAccountDeletion('user-1', { clearSession: mockClearSession });

    expect(calls).toEqual(['clearStorage', 'requestWebViewClear', 'clearWebViewCookies', 'signOut']);
    expect(mockClearStorage).toHaveBeenCalledWith('user-1');
    expect(mockUnregister).not.toHaveBeenCalled();
    expect(mockRemoveStoredItem).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(result).toEqual({ error: null });
  });

  it('サインアウトがエラーを返したら (サーバーへのログアウトの失敗。supabase-js は保管庫を消さない)、保管庫のセッションと code-verifier を端末だけで消し、画面の状態も消して、エラーを返す', async () => {
    const failure = new Error('network');
    mockSignOut.mockImplementation(async () => {
      calls.push('signOut');
      return { error: failure };
    });

    const result = await signOutAfterAccountDeletion('user-1', { clearSession: mockClearSession });

    expect(calls).toEqual([
      'clearStorage',
      'requestWebViewClear',
      'clearWebViewCookies',
      'signOut',
      'removeStored:sb-test-auth-token',
      'removeStored:sb-test-auth-token-code-verifier',
      'clearSession',
    ]);
    expect(result).toEqual({ error: failure });
  });

  it('サインアウトが例外を投げても、保管庫を消してエラーとして返す (例外にはしない)', async () => {
    const failure = new Error('unexpected');
    mockSignOut.mockRejectedValue(failure);

    await expect(signOutAfterAccountDeletion('user-1', { clearSession: mockClearSession })).resolves.toEqual({
      error: failure,
    });
    expect(mockRemoveStoredItem).toHaveBeenCalledWith('sb-test-auth-token');
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  it('端末データの掃除で例外が出ても、サインアウトする', async () => {
    mockClearStorage.mockRejectedValue(new Error('storage busy'));

    await expect(signOutAfterAccountDeletion('user-1', { clearSession: mockClearSession })).resolves.toEqual({
      error: null,
    });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('clearStoredSessionLocally', () => {
  it('保管庫の削除が失敗しても例外を投げず、残りのキーも消しに行く', async () => {
    mockRemoveStoredItem.mockRejectedValueOnce(new Error('keychain'));

    await expect(clearStoredSessionLocally()).resolves.toBeUndefined();
    expect(mockRemoveStoredItem).toHaveBeenCalledWith('sb-test-auth-token');
    expect(mockRemoveStoredItem).toHaveBeenCalledWith('sb-test-auth-token-code-verifier');
  });
});
