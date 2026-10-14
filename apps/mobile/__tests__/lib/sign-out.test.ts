/**
 * sign-out.test.ts
 * apps/mobile/src/lib/signOut.ts のテスト (#1038 F7-10)
 *
 * ログアウトの順番:
 *   1. この端末の push token を user_push_tokens から消す (RLS のため、サインアウトの「前」)
 *   2. ユーザー別の端末データを消す
 *   3. サインアウト
 * push token の削除や端末データの掃除が失敗しても、ログアウトは止めない。
 *
 * 退会のあとのログアウト (signOutAfterAccountDeletion。#1037):
 *   push token は消さない (auth.users の削除で ON DELETE CASCADE)。端末データの削除 → サインアウトの順。
 *   サインアウトが失敗したら、保管庫のセッションを端末だけで消す。
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

import { clearStoredSessionLocally, signOutAfterAccountDeletion, signOutWithCleanup } from '../../src/lib/signOut';

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
});

describe('signOutWithCleanup', () => {
  it('push token の削除 → 端末データの削除 → サインアウトの順に実行する (削除はサインアウトより前でなければ RLS で拒否される)', async () => {
    const result = await signOutWithCleanup('user-1');

    expect(calls).toEqual(['unregister', 'clearStorage', 'signOut']);
    // アクセストークンを渡さなければ、削除は現在のセッションで認可される (設定画面・マイページ)
    expect(mockUnregister).toHaveBeenCalledWith('user-1', { accessToken: undefined });
    expect(mockClearStorage).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({ error: null });
  });

  it('呼び出し側が控えたアクセストークンは、push token の削除にそのまま渡す (Web からの sign-out でセッションが先に失効しても、削除を認可できる)', async () => {
    await signOutWithCleanup('user-1', { accessToken: 'saved-access-token' });

    expect(mockUnregister).toHaveBeenCalledWith('user-1', { accessToken: 'saved-access-token' });
    expect(calls).toEqual(['unregister', 'clearStorage', 'signOut']);
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
  });

  it('ユーザー ID が分からなくても (null) 実行できる。端末データの掃除は null で行う', async () => {
    await signOutWithCleanup(null);

    expect(mockUnregister).toHaveBeenCalledWith(null, { accessToken: undefined });
    expect(mockClearStorage).toHaveBeenCalledWith(null);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('サインアウトが返したエラーは呼び出し元に返す (例外にはしない)', async () => {
    const failure = new Error('network');
    mockSignOut.mockResolvedValue({ error: failure });

    await expect(signOutWithCleanup('user-1')).resolves.toEqual({ error: failure });
  });
});

describe('signOutAfterAccountDeletion (退会のあと。#1037)', () => {
  it('端末データの削除 → サインアウトの順。push token は消さない (auth.users の削除で消える)。成功したら保管庫は直接消さない', async () => {
    const result = await signOutAfterAccountDeletion('user-1');

    expect(calls).toEqual(['clearStorage', 'signOut']);
    expect(mockClearStorage).toHaveBeenCalledWith('user-1');
    expect(mockUnregister).not.toHaveBeenCalled();
    expect(mockRemoveStoredItem).not.toHaveBeenCalled();
    expect(result).toEqual({ error: null });
  });

  it('サインアウトがエラーを返したら (サーバーへのログアウトの失敗。supabase-js は保管庫を消さない)、保管庫のセッションと code-verifier を端末だけで消し、エラーを返す', async () => {
    const failure = new Error('network');
    mockSignOut.mockImplementation(async () => {
      calls.push('signOut');
      return { error: failure };
    });

    const result = await signOutAfterAccountDeletion('user-1');

    expect(calls).toEqual([
      'clearStorage',
      'signOut',
      'removeStored:sb-test-auth-token',
      'removeStored:sb-test-auth-token-code-verifier',
    ]);
    expect(result).toEqual({ error: failure });
  });

  it('サインアウトが例外を投げても、保管庫を消してエラーとして返す (例外にはしない)', async () => {
    const failure = new Error('unexpected');
    mockSignOut.mockRejectedValue(failure);

    await expect(signOutAfterAccountDeletion('user-1')).resolves.toEqual({ error: failure });
    expect(mockRemoveStoredItem).toHaveBeenCalledWith('sb-test-auth-token');
  });

  it('端末データの掃除で例外が出ても、サインアウトする', async () => {
    mockClearStorage.mockRejectedValue(new Error('storage busy'));

    await expect(signOutAfterAccountDeletion('user-1')).resolves.toEqual({ error: null });
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
