/**
 * push-notifications.test.ts
 * apps/mobile/src/lib/pushNotifications.ts のテスト
 * - 権限拒否 → null 返却
 * - Supabase upsert 成功 → トークン保存確認
 * - Supabase upsert 失敗 → エラーをスローする
 * - Android チャンネル作成パス
 * - isDevice=false → null 返却
 * - #1038 F7-09: EAS project ID の解決 (展開されなかった "$VAR" を読み飛ばして app.json へ) / 失敗の観測
 * - #1038 F7-10: ログアウト時に「この端末の行だけ」を user_push_tokens から消す
 */

// --- モック設定 ---

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
    from: jest.fn(() => ({ upsert: jest.fn().mockResolvedValue({ error: null }) })),
  },
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
}));

jest.mock('../../src/lib/posthog', () => ({
  captureEvent: jest.fn(),
}));

jest.mock('expo-device', () => ({
  __esModule: true,
  isDevice: true,
}));

jest.mock('expo-constants', () => ({
  default: {},
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { captureEvent } from '../../src/lib/posthog';
import { supabase } from '../../src/lib/supabase';
import {
  PUSH_TOKEN_REGISTERED_KEY_PREFIX,
  PUSH_TOKEN_VALUE_KEY_PREFIX,
  ensurePushTokenRegistered,
  registerAndSaveExpoPushToken,
  resolveEasProjectId,
  unregisterExpoPushToken,
} from '../../src/lib/pushNotifications';

// 型キャスト用
const mockGetUser = supabase.auth.getUser as jest.Mock;
const mockFrom = supabase.from as jest.Mock;
const mockGetPermissionsAsync = Notifications.getPermissionsAsync as jest.Mock;
const mockRequestPermissionsAsync = Notifications.requestPermissionsAsync as jest.Mock;
const mockGetExpoPushTokenAsync = Notifications.getExpoPushTokenAsync as jest.Mock;
const mockSetNotificationChannelAsync = Notifications.setNotificationChannelAsync as jest.Mock;
const mockCaptureEvent = captureEvent as jest.Mock;

/** upsert モックを作り直して from に設定するヘルパー */
function setupUpsert(returnValue: { error: Error | null }) {
  const mockUpsert = jest.fn().mockResolvedValue(returnValue);
  mockFrom.mockReturnValue({ upsert: mockUpsert });
  return mockUpsert;
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();

  // project ID の出どころを毎回まっさらにする
  delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  const ConstantsMock = jest.requireMock('expo-constants');
  delete ConstantsMock.expoConfig;
  delete ConstantsMock.easConfig;

  // expo-device mock を物理端末状態にリセット
  const DeviceMock = jest.requireMock('expo-device');
  DeviceMock.isDevice = true;

  // react-native Platform を iOS にリセット
  const RNMock = jest.requireMock('react-native');
  RNMock.Platform.OS = 'ios';

  // デフォルト: 認証済みユーザー
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-123' } },
  });

  // デフォルト: 既に権限付与済み
  mockGetPermissionsAsync.mockResolvedValue({ status: 'granted' });

  // デフォルト: トークン取得成功
  mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[test-token]' });

  // デフォルト: upsert 成功
  setupUpsert({ error: null });
});

describe('registerAndSaveExpoPushToken — 権限拒否', () => {
  it('権限が拒否された場合、null を返す', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mockRequestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    const result = await registerAndSaveExpoPushToken();

    expect(result).toBeNull();
    // upsert は呼ばれない
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('初回権限未決定のとき requestPermissionsAsync を呼び、denied なら null を返す', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    mockRequestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    const result = await registerAndSaveExpoPushToken();

    expect(mockRequestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });
});

describe('registerAndSaveExpoPushToken — Supabase upsert 成功', () => {
  it('upsert が成功した場合、トークンを返す', async () => {
    const mockUpsert = setupUpsert({ error: null });

    const result = await registerAndSaveExpoPushToken();

    expect(result).toBe('ExponentPushToken[test-token]');
    expect(mockFrom).toHaveBeenCalledWith('user_push_tokens');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-123',
        expo_push_token: 'ExponentPushToken[test-token]',
      }),
      expect.objectContaining({ onConflict: 'user_id,expo_push_token' })
    );
  });

  it('getExpoPushTokenAsync が呼ばれてトークンが取得される', async () => {
    const result = await registerAndSaveExpoPushToken();

    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    expect(result).toBe('ExponentPushToken[test-token]');
  });
});

describe('registerAndSaveExpoPushToken — Supabase upsert 失敗', () => {
  it('upsert が失敗した場合、エラーをスローする', async () => {
    const upsertError = new Error('DB upsert failed');
    setupUpsert({ error: upsertError });

    await expect(registerAndSaveExpoPushToken()).rejects.toThrow('DB upsert failed');
  });
});

describe('registerAndSaveExpoPushToken — Android チャンネル作成', () => {
  it('Android の場合、setNotificationChannelAsync が呼ばれる', async () => {
    jest.requireMock('react-native').Platform.OS = 'android';

    await registerAndSaveExpoPushToken();

    expect(mockSetNotificationChannelAsync).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ name: 'default' })
    );
  });

  it('iOS の場合、setNotificationChannelAsync は呼ばれない', async () => {
    // beforeEach で 'ios' に設定済み

    await registerAndSaveExpoPushToken();

    expect(mockSetNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

describe('registerAndSaveExpoPushToken — 物理端末チェック', () => {
  it('isDevice が false のとき null を返す', async () => {
    jest.requireMock('expo-device').isDevice = false;

    const result = await registerAndSaveExpoPushToken();

    expect(result).toBeNull();
    expect(mockGetPermissionsAsync).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1038 F7-09: EAS project ID の解決
// ─────────────────────────────────────────────────────────────────────────────

const APP_JSON_PROJECT_ID = 'ce2a0961-4696-472c-8377-a3f83cecdff5';
const ENV_PROJECT_ID = '11111111-2222-4333-8444-555555555555';

/** expo-constants のモックに app.json 相当の設定を入れる (default import が mock 全体になるため直接書く) */
function setExpoConfig(extra: Record<string, unknown>) {
  jest.requireMock('expo-constants').expoConfig = { extra };
}

describe('resolveEasProjectId — #1038 F7-09', () => {
  it('環境変数が UUID なら最優先で使う', () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = ENV_PROJECT_ID;
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });

    expect(resolveEasProjectId()).toEqual({ projectId: ENV_PROJECT_ID, source: 'env', rejected: [] });
  });

  it('eas.json の "$VAR" が展開されずに文字列のまま入っていても、app.json の projectId に落ちる', () => {
    // eas.json に "EXPO_PUBLIC_EAS_PROJECT_ID": "$EXPO_PUBLIC_EAS_PROJECT_ID" と書いて展開されなかった場合の値
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '$EXPO_PUBLIC_EAS_PROJECT_ID';
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });

    expect(resolveEasProjectId()).toEqual({
      projectId: APP_JSON_PROJECT_ID,
      source: 'expoConfig',
      rejected: ['env'],
    });
  });

  it('プレースホルダー・空文字・UUID でない値は捨て、次の候補を使う', () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = 'PLEASE_SET_VIA_EAS_INIT';
    jest.requireMock('expo-constants').easConfig = { projectId: 'not-a-uuid' };
    setExpoConfig({ eas: { projectId: '' }, projectId: APP_JSON_PROJECT_ID });

    const resolved = resolveEasProjectId();
    expect(resolved.projectId).toBe(APP_JSON_PROJECT_ID);
    expect(resolved.source).toBe('extra');
    expect(resolved.rejected).toEqual(['env', 'easConfig']);
  });

  it('UUID は大文字でも受け付ける', () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = ENV_PROJECT_ID.toUpperCase();
    expect(resolveEasProjectId().projectId).toBe(ENV_PROJECT_ID.toUpperCase());
  });

  it('有効な候補が 1 つも無ければ projectId は undefined', () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '$EXPO_PUBLIC_EAS_PROJECT_ID';
    expect(resolveEasProjectId()).toEqual({ projectId: undefined, source: 'none', rejected: ['env'] });
  });
});

describe('registerAndSaveExpoPushToken — project ID の受け渡し (#1038 F7-09)', () => {
  it('展開されなかった "$VAR" ではなく app.json の projectId で getExpoPushTokenAsync を呼ぶ', async () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '$EXPO_PUBLIC_EAS_PROJECT_ID';
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });

    await registerAndSaveExpoPushToken();

    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: APP_JSON_PROJECT_ID });
  });

  it('有効な projectId が無いときは projectId 抜きで呼ぶ (SDK 側の既定の解決に任せる)', async () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = 'PLEASE_SET_VIA_EAS_INIT';

    await registerAndSaveExpoPushToken();

    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledWith({});
  });
});

describe('registerAndSaveExpoPushToken — 失敗の観測 (#1038 F7-09)', () => {
  it('getExpoPushTokenAsync が失敗したら、例外を再スローしつつ PostHog に送る (トークンやユーザー ID は載せない)', async () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '$EXPO_PUBLIC_EAS_PROJECT_ID';
    const failure = Object.assign(new Error('Invalid uuid for projectId'), { name: 'CodedError' });
    mockGetExpoPushTokenAsync.mockRejectedValue(failure);

    await expect(registerAndSaveExpoPushToken()).rejects.toThrow('Invalid uuid for projectId');

    expect(mockCaptureEvent).toHaveBeenCalledTimes(1);
    const [eventName, props] = mockCaptureEvent.mock.calls[0];
    expect(eventName).toBe('push_token_registration_failed');
    expect(props).toEqual({
      stage: 'get_token',
      platform: 'ios',
      error_name: 'CodedError',
      error_message: 'Invalid uuid for projectId',
      project_id_source: 'none',
      rejected_project_id_sources: 'env',
    });
    expect(JSON.stringify(props)).not.toContain('user-123');
  });

  it('DB への保存が失敗したときも PostHog に送って再スローする', async () => {
    setupUpsert({ error: Object.assign(new Error('permission denied'), { name: 'PostgrestError' }) });

    await expect(registerAndSaveExpoPushToken()).rejects.toThrow('permission denied');

    expect(mockCaptureEvent).toHaveBeenCalledWith(
      'push_token_registration_failed',
      expect.objectContaining({ stage: 'save_token', error_name: 'PostgrestError' }),
    );
    // 保存に失敗したトークンは控えない
    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`)).toBeNull();
  });

  it('成功したときは PostHog に何も送らず、登録した値をユーザー別に控える', async () => {
    await registerAndSaveExpoPushToken();

    expect(mockCaptureEvent).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`)).toBe('ExponentPushToken[test-token]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1038 F7-10: ログアウト時に push token を消す
// ─────────────────────────────────────────────────────────────────────────────

/** from('user_push_tokens').delete().eq(...).eq(...) のチェーンを作る */
function setupDelete(result: { error: unknown } | Promise<{ error: unknown }> = { error: null }) {
  const eqToken = jest.fn().mockReturnValue(Promise.resolve(result));
  const eqUser = jest.fn().mockReturnValue({ eq: eqToken });
  const del = jest.fn().mockReturnValue({ eq: eqUser });
  mockFrom.mockReturnValue({ delete: del });
  return { del, eqUser, eqToken };
}

describe('unregisterExpoPushToken — #1038 F7-10', () => {
  it('控えておいたトークンについて、user_id と expo_push_token の両方で絞って削除する', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
    const { del, eqUser, eqToken } = setupDelete();

    const result = await unregisterExpoPushToken('user-123');

    expect(result).toBe('deleted');
    expect(mockFrom).toHaveBeenCalledWith('user_push_tokens');
    expect(del).toHaveBeenCalledTimes(1);
    expect(eqUser).toHaveBeenCalledWith('user_id', 'user-123');
    // 同じユーザーの他の端末の行まで消さない (expo_push_token で必ず絞る)
    expect(eqToken).toHaveBeenCalledWith('expo_push_token', 'ExponentPushToken[this-device]');
    // 控えを使えたので、Expo に問い合わせ直さない
    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('userId が無ければ何もしない', async () => {
    expect(await unregisterExpoPushToken(null)).toBe('skipped');
    expect(await unregisterExpoPushToken(undefined)).toBe('skipped');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('控えが無い端末 (この変更より前のビルドで登録済み) は getExpoPushTokenAsync で取り直して削除する', async () => {
    setExpoConfig({ eas: { projectId: APP_JSON_PROJECT_ID } });
    mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[refetched]' });
    const { eqToken } = setupDelete();

    const result = await unregisterExpoPushToken('user-123');

    expect(result).toBe('deleted');
    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: APP_JSON_PROJECT_ID });
    expect(eqToken).toHaveBeenCalledWith('expo_push_token', 'ExponentPushToken[refetched]');
  });

  it('控えも無く取り直しにも失敗したら、DB には触らず skipped (ログアウトは止めない)', async () => {
    mockGetExpoPushTokenAsync.mockRejectedValue(new Error('offline'));

    expect(await unregisterExpoPushToken('user-123')).toBe('skipped');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('物理端末でない (トークンが無い) 場合も、控えが無ければ skipped', async () => {
    jest.requireMock('expo-device').isDevice = false;

    expect(await unregisterExpoPushToken('user-123')).toBe('skipped');
    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('DB の削除が失敗したら failed を返し、PostHog に送る (例外は投げない)', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
    setupDelete({ error: { name: 'PostgrestError', code: '42501', message: 'permission denied' } });

    await expect(unregisterExpoPushToken('user-123')).resolves.toBe('failed');

    expect(mockCaptureEvent).toHaveBeenCalledWith('push_token_unregister_failed', {
      platform: 'ios',
      error_name: 'PostgrestError',
      error_code: '42501',
    });
  });

  it('通信が返ってこなくても、待ち時間の上限で failed を返して先へ進める', async () => {
    jest.useFakeTimers();
    try {
      await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
      // 永遠に解決しない
      setupDelete(new Promise(() => {}));

      const pending = unregisterExpoPushToken('user-123', { timeoutMs: 3000 });
      await jest.advanceTimersByTimeAsync(3000);

      await expect(pending).resolves.toBe('failed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('途中で例外が起きても握りつぶして failed を返す', async () => {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:user-123`, 'ExponentPushToken[this-device]');
    mockFrom.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(unregisterExpoPushToken('user-123')).resolves.toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1038 F7-09: 起動時の登録 (「登録済み」の印を付けるタイミング)
// ─────────────────────────────────────────────────────────────────────────────

describe('ensurePushTokenRegistered — #1038 F7-09', () => {
  const FLAG_KEY = `${PUSH_TOKEN_REGISTERED_KEY_PREFIX}:user-123`;

  it('登録できたときだけ「登録済み」の印を付ける', async () => {
    await ensurePushTokenRegistered('user-123');

    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(FLAG_KEY)).toBe('1');
  });

  it('権限が拒否されて登録できなかったときは印を付けない (後から OS の設定で許可したとき、次の起動で登録できる)', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mockRequestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await ensurePushTokenRegistered('user-123');

    expect(await AsyncStorage.getItem(FLAG_KEY)).toBeNull();

    // 許可された後の起動では、登録される
    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted' });
    await ensurePushTokenRegistered('user-123');
    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(FLAG_KEY)).toBe('1');
  });

  it('実機でない (Expo Go のシミュレーターなど) 場合も印は付けない。毎回の確認は設定を読むだけで軽い', async () => {
    jest.requireMock('expo-device').isDevice = false;

    await ensurePushTokenRegistered('user-123');

    expect(await AsyncStorage.getItem(FLAG_KEY)).toBeNull();
    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('既に登録済みの印があれば、何もしない', async () => {
    await AsyncStorage.setItem(FLAG_KEY, '1');

    await ensurePushTokenRegistered('user-123');

    expect(mockGetPermissionsAsync).not.toHaveBeenCalled();
    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('登録に失敗したら例外を伝え (呼び出し側が握りつぶす)、印は付けない', async () => {
    mockGetExpoPushTokenAsync.mockRejectedValue(new Error('No "projectId" found'));

    await expect(ensurePushTokenRegistered('user-123')).rejects.toThrow('No "projectId" found');

    expect(await AsyncStorage.getItem(FLAG_KEY)).toBeNull();
  });
});
