/**
 * push-token-release.test.ts
 * apps/mobile/src/lib/pushTokenRelease.ts のテスト (#1636)
 *
 * ログアウト (signOut.ts) を通らずにセッションが終わったとき (自動更新の失効の SIGNED_OUT など) に、
 * セッション無しの release の API で、この端末の push token の、サインアウトした利用者の行を消す。
 *   - 残した値 (push_token_value_v1:<利用者>) と端末の秘密の値で release を呼ぶ (通信の設定: やり直さない・待つ上限)
 *   - 消せなかったら宛先を控え、やり直しで消す。400 (やり直しても通らない) は控えから捨てる
 *   - 端末の秘密の値が無いときは通信せず控えを捨てる。保管庫を読めないときは通信せず控えを残す
 *   - 控えは同じ宛先を重ねず、上限を超えたら古いものから捨てる。壊れた控えは空として扱う
 *   - claim の成功で、同じトークンの控えだけを捨てる (forgetPendingPushTokenReleases)
 */

const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: (...args: unknown[]) => mockPost(...args) }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { PUSH_TOKEN_RELEASE_API_PATH } from '@homegohan/shared';
import { PUSH_INSTALL_SECRET_STORE_KEY } from '../../src/lib/pushInstallSecret';
import {
  MAX_PENDING_PUSH_TOKEN_RELEASES,
  PUSH_TOKEN_RELEASE_PENDING_KEY,
  PUSH_TOKEN_RELEASE_TIMEOUT_MS,
  PUSH_TOKEN_VALUE_KEY_PREFIX,
  flushPendingPushTokenReleases,
  forgetPendingPushTokenReleases,
  recordPushTokenRelease,
  releasePushTokenAfterSignedOut,
} from '../../src/lib/pushTokenRelease';

/** この端末の秘密の値 (ダミー。43 文字の base64url) */
const DEVICE_SECRET = 'shared-device-secret-aaaaaaaaaaaaaaaaaaaaaa'; // gitleaks:allow
const TOKEN = 'ExponentPushToken[device]';

async function pending(): Promise<unknown> {
  const raw = await AsyncStorage.getItem(PUSH_TOKEN_RELEASE_PENDING_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function releaseCalls(): unknown[][] {
  return mockPost.mock.calls.filter(([path]) => path === PUSH_TOKEN_RELEASE_API_PATH);
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset: () => void }).__reset();
  await SecureStore.setItemAsync(PUSH_INSTALL_SECRET_STORE_KEY, DEVICE_SECRET);
  mockPost.mockResolvedValue({ released: 1 });
});

describe('releasePushTokenAfterSignedOut (#1636)', () => {
  it('登録の値のキーの接頭辞 (pushNotifications.ts はこれを再び公開して使う) と release の API のパス', () => {
    expect(PUSH_TOKEN_VALUE_KEY_PREFIX).toBe('push_token_value_v1');
    expect(PUSH_TOKEN_RELEASE_API_PATH).toBe('/api/push-tokens/release');
  });

  it('残した値と端末の秘密の値で release を呼び、消せたら控えを残さない', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-a`, TOKEN);

    await releasePushTokenAfterSignedOut('user-a');

    expect(releaseCalls()).toEqual([
      [
        PUSH_TOKEN_RELEASE_API_PATH,
        { expo_push_token: TOKEN, install_secret: DEVICE_SECRET, user_id: 'user-a' },
        { retry: false, timeoutMs: PUSH_TOKEN_RELEASE_TIMEOUT_MS },
      ],
    ]);
    expect(await pending()).toBeNull();
    // 値は消さない (signOut.ts が読むことがある。起動時の ID なしの掃除で消える)
    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-a`)).toBe(TOKEN);
  });

  it('値が無い (signOut.ts が行と値を先に消した) ときは、控えが無ければ通信しない', async () => {
    await releasePushTokenAfterSignedOut('user-a');
    await releasePushTokenAfterSignedOut(null);

    expect(mockPost).not.toHaveBeenCalled();
    expect(await pending()).toBeNull();
  });

  it.each([
    ['通信の失敗', new TypeError('Network request failed')],
    ['メンテナンス中の 503 (getApi() が固定の文の例外に置き換えたもの)', new Error('ただいまメンテナンス中です。')],
    ['サーバーのエラー', new Error('HTTP 500 Internal Server Error: {}')],
  ])('%s: 宛先を控え、やり直し (flushPendingPushTokenReleases) で消す', async (_label, error) => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-a`, TOKEN);
    mockPost.mockRejectedValueOnce(error);

    await releasePushTokenAfterSignedOut('user-a');
    expect(await pending()).toEqual([{ userId: 'user-a', token: TOKEN }]);

    // 起動時の掃除 (ID なし) で値が消えても、控えから消し直せる
    await AsyncStorage.removeItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-a`);
    await flushPendingPushTokenReleases();

    expect(releaseCalls()).toHaveLength(2);
    expect(releaseCalls()[1][1]).toEqual({ expo_push_token: TOKEN, install_secret: DEVICE_SECRET, user_id: 'user-a' });
    expect(await pending()).toBeNull();
  });

  it('400 (本文の形が違う) は、やり直しても通らないので控えから捨てる', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-a`, TOKEN);
    mockPost.mockRejectedValueOnce(new Error('HTTP 400 Bad Request: {"error":{"code":"INVALID_PUSH_TOKEN_REQUEST"}}'));

    await releasePushTokenAfterSignedOut('user-a');

    expect(await pending()).toBeNull();
  });

  it('端末の秘密の値が無い (古い版のアプリで登録した端末) ときは通信せず、控えを捨てる (release では消せない)', async () => {
    await SecureStore.deleteItemAsync(PUSH_INSTALL_SECRET_STORE_KEY);
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-a`, TOKEN);

    await releasePushTokenAfterSignedOut('user-a');

    expect(mockPost).not.toHaveBeenCalled();
    expect(await pending()).toBeNull();
  });

  it('保管庫を読めないときは通信せず、控えを残す (次の起動でやり直す)', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-a`, TOKEN);
    const getSpy = jest.spyOn(SecureStore, 'getItemAsync').mockRejectedValue(new Error('User interaction is not allowed'));
    try {
      await releasePushTokenAfterSignedOut('user-a');
    } finally {
      getSpy.mockRestore();
    }

    expect(mockPost).not.toHaveBeenCalled();
    expect(await pending()).toEqual([{ userId: 'user-a', token: TOKEN }]);
  });

  it('複数の利用者の宛先を控え、消せたものだけを外す。同じ宛先は重ねない', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-a`, TOKEN);
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-b`, TOKEN);
    mockPost.mockRejectedValue(new TypeError('Network request failed'));

    await releasePushTokenAfterSignedOut('user-a');
    await releasePushTokenAfterSignedOut('user-a');
    await releasePushTokenAfterSignedOut('user-b');
    expect(await pending()).toEqual([
      { userId: 'user-a', token: TOKEN },
      { userId: 'user-b', token: TOKEN },
    ]);

    mockPost.mockImplementation(async (_path: string, body: { user_id: string }) => {
      if (body.user_id === 'user-a') return { released: 1 };
      throw new TypeError('Network request failed');
    });
    await flushPendingPushTokenReleases();

    expect(await pending()).toEqual([{ userId: 'user-b', token: TOKEN }]);
  });

  it(`控えは上限 (${MAX_PENDING_PUSH_TOKEN_RELEASES} 件) を超えたら古いものから捨てる`, async () => {
    mockPost.mockRejectedValue(new TypeError('Network request failed'));
    const extra = 3;
    for (let i = 0; i < MAX_PENDING_PUSH_TOKEN_RELEASES + extra; i += 1) {
      await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-${i}`, TOKEN);
      await releasePushTokenAfterSignedOut(`user-${i}`);
    }

    const kept = (await pending()) as Array<{ userId: string }>;
    expect(kept).toHaveLength(MAX_PENDING_PUSH_TOKEN_RELEASES);
    expect(kept[0].userId).toBe(`user-${extra}`);
    expect(kept[kept.length - 1].userId).toBe(`user-${MAX_PENDING_PUSH_TOKEN_RELEASES + extra - 1}`);
  });

  it('壊れた控え (JSON でない・形の違う要素) は空・読み飛ばしとして扱う', async () => {
    await AsyncStorage.setItem(PUSH_TOKEN_RELEASE_PENDING_KEY, 'not-json');
    await flushPendingPushTokenReleases();
    expect(mockPost).not.toHaveBeenCalled();

    await AsyncStorage.setItem(
      PUSH_TOKEN_RELEASE_PENDING_KEY,
      JSON.stringify([{ userId: 'user-a', token: TOKEN }, { userId: '', token: TOKEN }, { token: TOKEN }, 'x', null]),
    );
    await flushPendingPushTokenReleases();
    expect(releaseCalls()).toHaveLength(1);
    expect(await pending()).toBeNull();
  });

  it('同時に呼ばれても、控えの読み書きが混ざらない (1 つずつ順に動く)', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-a`, TOKEN);
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-b`, TOKEN);
    mockPost.mockRejectedValue(new TypeError('Network request failed'));

    await Promise.all([releasePushTokenAfterSignedOut('user-a'), releasePushTokenAfterSignedOut('user-b')]);

    expect(await pending()).toEqual([
      { userId: 'user-a', token: TOKEN },
      { userId: 'user-b', token: TOKEN },
    ]);
  });

  it('例外を投げない (AsyncStorage が壊れていても)', async () => {
    const getSpy = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('storage broken'));
    try {
      await expect(releasePushTokenAfterSignedOut('user-a')).resolves.toBeUndefined();
      await expect(flushPendingPushTokenReleases()).resolves.toBeUndefined();
      await expect(recordPushTokenRelease('user-a')).resolves.toBeUndefined();
      await expect(forgetPendingPushTokenReleases(TOKEN)).resolves.toBeUndefined();
    } finally {
      getSpy.mockRestore();
    }
  });
});

describe('recordPushTokenRelease (#1636)', () => {
  it('宛先を控えるだけで、通信しない', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-a`, TOKEN);

    await recordPushTokenRelease('user-a');
    await recordPushTokenRelease(null);

    expect(mockPost).not.toHaveBeenCalled();
    expect(await pending()).toEqual([{ userId: 'user-a', token: TOKEN }]);
  });
});

describe('forgetPendingPushTokenReleases (#1636)', () => {
  it('同じトークンの宛先だけを捨てる', async () => {
    await AsyncStorage.setItem(
      PUSH_TOKEN_RELEASE_PENDING_KEY,
      JSON.stringify([
        { userId: 'user-a', token: TOKEN },
        { userId: 'user-b', token: TOKEN },
        { userId: 'user-a', token: 'ExponentPushToken[old]' },
      ]),
    );

    await forgetPendingPushTokenReleases(TOKEN);

    expect(await pending()).toEqual([{ userId: 'user-a', token: 'ExponentPushToken[old]' }]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('最後の宛先を捨てたら、控えのキーも消す', async () => {
    await AsyncStorage.setItem(PUSH_TOKEN_RELEASE_PENDING_KEY, JSON.stringify([{ userId: 'user-a', token: TOKEN }]));

    await forgetPendingPushTokenReleases(TOKEN);

    expect(await AsyncStorage.getItem(PUSH_TOKEN_RELEASE_PENDING_KEY)).toBeNull();
  });
});
