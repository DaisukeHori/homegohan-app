/**
 * user-storage.test.ts
 * apps/mobile/src/lib/user-storage.ts のテスト (#1038 F7-10)
 *
 * ログアウト時に、ユーザー別の AsyncStorage キーを消す。
 * push token の「登録済み」フラグと「この端末のトークンの値」の両方が対象。
 */

jest.mock('../../src/lib/supabase', () => ({ supabase: {} }));
jest.mock('../../src/lib/posthog', () => ({ captureEvent: jest.fn() }));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-device', () => ({ __esModule: true, isDevice: true }));
jest.mock('expo-constants', () => ({ default: {} }));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { PUSH_TOKEN_REGISTERED_KEY_PREFIX, PUSH_TOKEN_VALUE_KEY_PREFIX } from '../../src/lib/pushNotifications';
import { clearUserScopedAsyncStorage } from '../../src/lib/user-storage';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('clearUserScopedAsyncStorage', () => {
  it('ユーザー ID を指定すると、そのユーザーの push token の登録済みフラグと値を消す (他のユーザー・他のキーは残す)', async () => {
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

  it('旧ビルドが付けた登録済みの印 (v1) も、今のビルドの印 (v2) も消す (文字列そのもので確かめる)', async () => {
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
      [`${PUSH_TOKEN_REGISTERED_KEY_PREFIX}:user-9`, '1'],
    ]);

    await clearUserScopedAsyncStorage('user-9');

    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-9`)).toBeNull();
    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_REGISTERED_KEY_PREFIX}:user-9`)).toBeNull();
  });
});
