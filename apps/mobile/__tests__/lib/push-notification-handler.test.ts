/**
 * push-notification-handler.test.ts
 * src/lib/pushNotifications.ts の setupNotificationHandler / setNotificationBadge のテスト (#1049 F7-11)
 *
 * フォアグラウンドの通知の扱いを設定していなかったため、アプリを開いている間に届いた通知は
 * OS のバナーも出ず、気付けなかった。設計書 (docs/design/mobile/03-push-notification.md §3.5) どおり、
 * 表示・通知音を有効にし、ペイロードの badge でアイコンのバッジも合わせる。
 */

const mockSetNotificationHandler = jest.fn();
const mockSetBadgeCountAsync = jest.fn();

jest.mock('expo-notifications', () => ({
  setNotificationHandler: (...args: unknown[]) => mockSetNotificationHandler(...args),
  setBadgeCountAsync: (...args: unknown[]) => mockSetBadgeCountAsync(...args),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
}));

jest.mock('expo-device', () => ({ __esModule: true, isDevice: true }));
jest.mock('expo-constants', () => ({ default: {} }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../../src/lib/supabase', () => ({ supabase: {} }));

import { setNotificationBadge, setupNotificationHandler } from '../../src/lib/pushNotifications';

type Behavior = {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
};
type Handler = { handleNotification: (notification: unknown) => Promise<Behavior> };

function installedHandler(): Handler {
  expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
  return mockSetNotificationHandler.mock.calls[0][0] as Handler;
}

function notification(content: Record<string, unknown>) {
  return { request: { identifier: 'n-1', content } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSetBadgeCountAsync.mockResolvedValue(undefined);
});

describe('setupNotificationHandler', () => {
  it('通知ハンドラーを 1 回登録する', () => {
    setupNotificationHandler();

    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
  });

  it('フォアグラウンドでもバナー・通知センター・通知音・バッジを有効にする', async () => {
    setupNotificationHandler();

    const behavior = await installedHandler().handleNotification(notification({ title: '献立が届きました', body: '…' }));

    expect(behavior).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    });
  });

  it('ペイロードに badge (数値) があれば、アイコンのバッジをその数にする', async () => {
    setupNotificationHandler();

    await installedHandler().handleNotification(notification({ title: 't', badge: 3 }));

    expect(mockSetBadgeCountAsync).toHaveBeenCalledWith(3);
  });

  it('badge が 0 ならバッジを消す', async () => {
    setupNotificationHandler();

    await installedHandler().handleNotification(notification({ title: 't', badge: 0 }));

    expect(mockSetBadgeCountAsync).toHaveBeenCalledWith(0);
  });

  it('badge が無い / 数値でないときはバッジに触らない', async () => {
    setupNotificationHandler();
    const { handleNotification } = installedHandler();

    await handleNotification(notification({ title: 't' }));
    await handleNotification(notification({ title: 't', badge: null }));
    await handleNotification(notification({ title: 't', badge: '3' }));

    expect(mockSetBadgeCountAsync).not.toHaveBeenCalled();
  });

  it('バッジの更新に失敗しても、通知の表示は止めない', async () => {
    mockSetBadgeCountAsync.mockRejectedValue(new Error('badge unavailable'));
    setupNotificationHandler();

    const behavior = await installedHandler().handleNotification(notification({ title: 't', badge: 2 }));

    expect(behavior.shouldShowBanner).toBe(true);
  });
});

describe('setNotificationBadge', () => {
  it('バッジ数を設定し、失敗しても例外を投げない', async () => {
    await expect(setNotificationBadge(5)).resolves.toBeUndefined();
    expect(mockSetBadgeCountAsync).toHaveBeenCalledWith(5);

    mockSetBadgeCountAsync.mockRejectedValueOnce(new Error('nope'));
    await expect(setNotificationBadge(1)).resolves.toBeUndefined();
  });
});
