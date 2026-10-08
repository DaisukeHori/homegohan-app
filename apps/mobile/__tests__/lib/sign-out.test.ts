/**
 * sign-out.test.ts
 * apps/mobile/src/lib/signOut.ts のテスト (#1038 F7-10)
 *
 * ログアウトの順番:
 *   1. この端末の push token を user_push_tokens から消す (RLS のため、サインアウトの「前」)
 *   2. ユーザー別の端末データを消す
 *   3. サインアウト
 * push token の削除や端末データの掃除が失敗しても、ログアウトは止めない。
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
  supabase: { auth: { signOut: (...args: unknown[]) => mockSignOut(...args) } },
}));

import { signOutWithCleanup } from '../../src/lib/signOut';

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
});

describe('signOutWithCleanup', () => {
  it('push token の削除 → 端末データの削除 → サインアウトの順に実行する (削除はサインアウトより前でなければ RLS で拒否される)', async () => {
    const result = await signOutWithCleanup('user-1');

    expect(calls).toEqual(['unregister', 'clearStorage', 'signOut']);
    expect(mockUnregister).toHaveBeenCalledWith('user-1');
    expect(mockClearStorage).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({ error: null });
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

    expect(mockUnregister).toHaveBeenCalledWith(null);
    expect(mockClearStorage).toHaveBeenCalledWith(null);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('サインアウトが返したエラーは呼び出し元に返す (例外にはしない)', async () => {
    const failure = new Error('network');
    mockSignOut.mockResolvedValue({ error: failure });

    await expect(signOutWithCleanup('user-1')).resolves.toEqual({ error: failure });
  });
});
