/**
 * user-storage.test.ts
 * apps/mobile/src/lib/user-storage.ts のテスト (#1038 F7-10)
 *
 * ログアウト時に、ユーザー別の AsyncStorage キーを消す。
 * push token の「この端末のトークンの値」と、旧ビルドが付けた「登録済み」の印 (v2・v1。今は読まず書かない: #1599) が対象。
 */

jest.mock('../../src/lib/supabase', () => ({ supabase: {} }));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-device', () => ({ __esModule: true, isDevice: true }));
jest.mock('expo-constants', () => ({ default: {} }));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { PUSH_TOKEN_VALUE_KEY_PREFIX } from '../../src/lib/pushNotifications';
import { PERSISTENCE_KEYS } from '../../src/lib/persistence';
import { clearUserScopedAsyncStorage } from '../../src/lib/user-storage';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('clearUserScopedAsyncStorage', () => {
  it('ユーザー ID を指定すると、そのユーザーの push token の値と旧ビルドの登録済みの印を消す (他のユーザー・他のキーは残す)', async () => {
    await AsyncStorage.multiSet([
      ['push_token_registered_v1:user-1', '1'],
      [`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-1`, 'ExponentPushToken[abc]'],
      ['push_token_registered_v1:user-2', '1'],
      [`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-2`, 'ExponentPushToken[def]'],
      ['auth_last_fail_ts', '123'],
    ]);

    await clearUserScopedAsyncStorage('user-1');

    expect(await AsyncStorage.getItem('push_token_registered_v1:user-1')).toBeNull();
    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-1`)).toBeNull();
    expect(await AsyncStorage.getItem('push_token_registered_v1:user-2')).toBe('1');
    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-2`)).toBe('ExponentPushToken[def]');
    expect(await AsyncStorage.getItem('auth_last_fail_ts')).toBe('123');
  });

  it('ユーザー ID が分からないとき (null) は、全キーを調べて、該当するキーをすべて消す', async () => {
    await AsyncStorage.multiSet([
      ['push_token_registered_v1:user-1', '1'],
      [`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-1`, 'ExponentPushToken[abc]'],
      [`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-2`, 'ExponentPushToken[def]'],
      ['auth_last_fail_ts', '123'],
    ]);

    await clearUserScopedAsyncStorage(null);

    expect([...(await AsyncStorage.getAllKeys())].sort()).toEqual(['auth_last_fail_ts']);
  });

  it('旧ビルドが付けた登録済みの印 (v1・v2。#1599 から読まず書かない) を消す (文字列そのもので確かめる)', async () => {
    await AsyncStorage.multiSet([
      ['push_token_registered_v1:user-1', '1'],
      ['push_token_registered_v2:user-1', '1'],
      ['push_token_registered_v2:user-2', '1'],
    ]);

    await clearUserScopedAsyncStorage('user-1');

    expect(await AsyncStorage.getItem('push_token_registered_v1:user-1')).toBeNull();
    expect(await AsyncStorage.getItem('push_token_registered_v2:user-1')).toBeNull();
    expect(await AsyncStorage.getItem('push_token_registered_v2:user-2')).toBe('1');
  });

  it('pushNotifications.ts が使うキーの接頭辞と、ここで消す接頭辞が一致している (食い違うとログアウト後に値が残る)', async () => {
    await AsyncStorage.multiSet([
      [`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-9`, 'ExponentPushToken[zzz]'],
      ['push_token_registered_v2:user-9', '1'],
    ]);

    await clearUserScopedAsyncStorage('user-9');

    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-9`)).toBeNull();
    // 旧ビルドが付けた v2 の印 (#1599 から読まず書かない) も消す
    expect(await AsyncStorage.getItem('push_token_registered_v2:user-9')).toBeNull();
  });
});

describe('clearUserScopedAsyncStorage — 旧ビルドが書いた V4 献立の生成中の状態 (#1049 F7-20)', () => {
  // 今のビルドは書かないが (読む処理が無かった)、旧ビルドから更新した端末には前のユーザーの値が残っている
  it.each([['user-1'], [null]])('ログアウト (userId=%p) で "v4MenuGenerating" を消す (他のキーは残す)', async (userId) => {
    await AsyncStorage.multiSet([
      ['v4MenuGenerating', JSON.stringify({ requestId: 'req-old', timestamp: 1, totalSlots: 7 })],
      ['auth_last_fail_ts', '123'],
    ]);

    await clearUserScopedAsyncStorage(userId);

    expect(await AsyncStorage.getItem('v4MenuGenerating')).toBeNull();
    expect(await AsyncStorage.getItem('auth_last_fail_ts')).toBe('123');
  });
});

describe('clearUserScopedAsyncStorage — アプリの永続化キー (#1599)', () => {
  // Web の利用者別の localStorage のキーと同じ中身を、アプリは AsyncStorage に持つ。共有端末で次にログインする
  // 別の利用者に、前の利用者の期間の設定・生成中の状態 (前の利用者の食事の ID) が残らないよう、ログアウトで消す
  const PREVIOUS_USER_VALUES: Array<[string, string]> = [
    // src/components/menu/V4GenerateModal.tsx が書く (キーの文字列そのもので確かめる)
    ['v4_range_days', JSON.stringify({ startDays: 0, endDays: 6 })],
    // src/components/menu/RegenerateMealModal.tsx が setItemWithTTL で書く
    ['singleMealGenerating', JSON.stringify({ data: { mealId: 'meal-of-previous-user' }, expiresAt: 1 })],
    ['weeklyMenuGenerating', JSON.stringify({ data: {}, expiresAt: 1 })],
    ['shoppingListRegenerating', JSON.stringify({ data: {}, expiresAt: 1 })],
  ];

  it.each([['user-1'], [null]])('ログアウト (userId=%p) で永続化キーをすべて消す (端末の設定・ログイン前の値は残す)', async (userId) => {
    await AsyncStorage.multiSet([
      ...PREVIOUS_USER_VALUES,
      // AI のボタンの位置 (端末の表示の設定。利用者別ではない)
      ['aiFabPosition', JSON.stringify({ x: 1, y: 2 })],
      ['auth_last_fail_ts', '123'],
    ]);

    await clearUserScopedAsyncStorage(userId);

    for (const [key] of PREVIOUS_USER_VALUES) {
      expect(await AsyncStorage.getItem(key)).toBeNull();
    }
    expect(await AsyncStorage.getItem('aiFabPosition')).toBe(JSON.stringify({ x: 1, y: 2 }));
    expect(await AsyncStorage.getItem('auth_last_fail_ts')).toBe('123');
  });

  it('persistence.ts の PERSISTENCE_KEYS のキーは、すべてログアウトで消す (足したキーも自動で消える)', async () => {
    const keys = Object.values(PERSISTENCE_KEYS).map(({ key }) => key);
    expect(keys.length).toBeGreaterThan(0);
    await AsyncStorage.multiSet(keys.map((key) => [key, 'previous-user'] as [string, string]));

    await clearUserScopedAsyncStorage('user-1');

    expect((await AsyncStorage.multiGet(keys)).filter(([, value]) => value !== null)).toEqual([]);
  });
});
