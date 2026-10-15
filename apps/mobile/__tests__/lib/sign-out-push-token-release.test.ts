/**
 * sign-out-push-token-release.test.ts
 * ログアウト (signOut.ts) で push token の行の削除が失敗・0 件だったとき、あとの release が行を消せること (#1706)
 *
 * 退会の API が 401 を返したときのログアウト (settings/account.tsx の signOutOnDevice) では、セッションが既に失効していて、
 * 本人のセッション (RLS) での行の削除が 0 件・失敗になりうる。そのあと signOut.ts の掃除が値 (push_token_value_v1:<利用者>) を
 * 消すので、続く SIGNED_OUT の release (AuthProvider の releasePushTokenAfterSignedOut) は値を読めず、行が残っていた。
 * signOut.ts は、掃除の前に release の宛先を控える (recordPushTokenRelease)。ここでは本物の signOut.ts・pushTokenRelease.ts・
 * 掃除 (userScopedLocalData.ts・user-storage.ts) を通し、値が掃除で消えたあとでも、release が控えた宛先で行を消しに行くことを確かめる。
 * 削除そのもの (unregisterExpoPushToken)・supabase・保管庫・WebView の掃除・API の通信はモックにする。
 */

const mockUnregister = jest.fn();
jest.mock('../../src/lib/pushNotifications', () => ({
  unregisterExpoPushToken: (...args: unknown[]) => mockUnregister(...args),
}));
const mockSignOut = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-test-auth-token',
  supabase: { auth: { signOut: (...args: unknown[]) => mockSignOut(...args) } },
}));
jest.mock('../../src/lib/secureSessionStorage', () => ({
  secureSessionStorage: { removeItem: jest.fn(async () => undefined) },
}));
jest.mock('../../src/lib/webViewUserStorageCleanup', () => ({
  requestWebViewUserScopedStorageClear: jest.fn(async () => undefined),
  clearWebViewNativeCookies: jest.fn(async () => 'cleared'),
}));
const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: (...args: unknown[]) => mockPost(...args) }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { PUSH_TOKEN_RELEASE_API_PATH } from '@homegohan/shared';
import { PUSH_INSTALL_SECRET_STORE_KEY } from '../../src/lib/pushInstallSecret';
import {
  PUSH_TOKEN_RELEASE_PENDING_KEY,
  PUSH_TOKEN_VALUE_KEY_PREFIX,
  flushPendingPushTokenReleases,
  releasePushTokenAfterSignedOut,
} from '../../src/lib/pushTokenRelease';
import { signOutOnDevice, signOutWithCleanup } from '../../src/lib/signOut';
import { clearUserScopedLocalDataAfterSignedOut } from '../../src/lib/userScopedLocalData';

/** この端末の秘密の値 (ダミー。43 文字の base64url) */
const DEVICE_SECRET = 'shared-device-secret-aaaaaaaaaaaaaaaaaaaaaa'; // gitleaks:allow
const TOKEN = 'ExponentPushToken[device]';
const USER_ID = 'user-a';
const VALUE_KEY = `${PUSH_TOKEN_VALUE_KEY_PREFIX}:${USER_ID}`;
const EXPECTED_RELEASE_BODY = { expo_push_token: TOKEN, install_secret: DEVICE_SECRET, user_id: USER_ID };

const mockClearSession = jest.fn();

async function pending(): Promise<unknown> {
  const raw = await AsyncStorage.getItem(PUSH_TOKEN_RELEASE_PENDING_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function releaseBodies(): unknown[] {
  return mockPost.mock.calls.filter(([path]) => path === PUSH_TOKEN_RELEASE_API_PATH).map(([, body]) => body);
}

/** AuthProvider の SIGNED_OUT と同じ順 (SIGNED_OUT の掃除 → release) で動かす */
async function deliverSignedOut(userId: string): Promise<void> {
  await clearUserScopedLocalDataAfterSignedOut(userId);
  await releasePushTokenAfterSignedOut(userId);
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset: () => void }).__reset();
  await SecureStore.setItemAsync(PUSH_INSTALL_SECRET_STORE_KEY, DEVICE_SECRET);
  // 登録のときに控えた、この端末の push token の値
  await AsyncStorage.setItem(VALUE_KEY, TOKEN);
  mockSignOut.mockResolvedValue({ error: null });
  mockPost.mockResolvedValue({ released: 1 });
});

describe.each([
  [
    'signOutOnDevice (退会の API が 401 を返したときのアカウントの画面・設定のログアウト)',
    () => signOutOnDevice(USER_ID, { clearSession: mockClearSession }),
  ],
  [
    'signOutWithCleanup (パスワード再設定のあと・Web からの sign-out / session-expired)',
    () => signOutWithCleanup(USER_ID, { accessToken: 'saved-access-token' }),
  ],
])('%s', (_name, signOut) => {
  it.each(['no_rows', 'failed'])(
    '行の削除が %s なら、値が掃除で消えても、続く SIGNED_OUT の release が控えた宛先で行を消す',
    async (result) => {
      mockUnregister.mockResolvedValue(result);

      await signOut();

      // 掃除は値を消している (次の利用者に前の利用者の値を残さない)。宛先は控えてある (通信はまだしない)
      expect(await AsyncStorage.getItem(VALUE_KEY)).toBeNull();
      expect(await pending()).toEqual([{ userId: USER_ID, token: TOKEN }]);
      expect(releaseBodies()).toEqual([]);

      await deliverSignedOut(USER_ID);

      expect(releaseBodies()).toEqual([EXPECTED_RELEASE_BODY]);
      expect(await pending()).toBeNull();
    },
  );

  it('行を消せたら控えず、続く SIGNED_OUT の release は通信しない', async () => {
    mockUnregister.mockResolvedValue('deleted');

    await signOut();

    expect(await AsyncStorage.getItem(VALUE_KEY)).toBeNull();
    expect(await pending()).toBeNull();

    await deliverSignedOut(USER_ID);

    expect(mockPost).not.toHaveBeenCalled();
  });
});

it('signOutOnDevice: サインアウトも失敗して SIGNED_OUT が届かないときは、起動時に未ログインと決まったときのやり直しが消す', async () => {
  mockUnregister.mockResolvedValue('failed');
  mockSignOut.mockResolvedValue({ error: new Error('network') });

  await signOutOnDevice(USER_ID, { clearSession: mockClearSession });

  expect(mockClearSession).toHaveBeenCalledTimes(1);
  expect(await AsyncStorage.getItem(VALUE_KEY)).toBeNull();
  expect(await pending()).toEqual([{ userId: USER_ID, token: TOKEN }]);

  // 次の起動で未ログインと決まった (AuthProvider の settleSignedOutAtStartup)
  await flushPendingPushTokenReleases();

  expect(releaseBodies()).toEqual([EXPECTED_RELEASE_BODY]);
  expect(await pending()).toBeNull();
});
