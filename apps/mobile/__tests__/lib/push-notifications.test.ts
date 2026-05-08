/**
 * push-notifications.test.ts
 * apps/mobile/src/lib/pushNotifications.ts のテスト
 * - 権限拒否 → null 返却
 * - Supabase upsert 成功 → トークン保存確認
 * - Supabase upsert 失敗 → エラーをスローする
 * - Android チャンネル作成パス
 * - isDevice=false → null 返却
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

import * as Notifications from 'expo-notifications';
import { supabase } from '../../src/lib/supabase';
import { registerAndSaveExpoPushToken } from '../../src/lib/pushNotifications';

// 型キャスト用
const mockGetUser = supabase.auth.getUser as jest.Mock;
const mockFrom = supabase.from as jest.Mock;
const mockGetPermissionsAsync = Notifications.getPermissionsAsync as jest.Mock;
const mockRequestPermissionsAsync = Notifications.requestPermissionsAsync as jest.Mock;
const mockGetExpoPushTokenAsync = Notifications.getExpoPushTokenAsync as jest.Mock;
const mockSetNotificationChannelAsync = Notifications.setNotificationChannelAsync as jest.Mock;

/** upsert モックを作り直して from に設定するヘルパー */
function setupUpsert(returnValue: { error: Error | null }) {
  const mockUpsert = jest.fn().mockResolvedValue(returnValue);
  mockFrom.mockReturnValue({ upsert: mockUpsert });
  return mockUpsert;
}

beforeEach(() => {
  jest.clearAllMocks();

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
