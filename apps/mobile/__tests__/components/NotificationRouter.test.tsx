/**
 * #1049 F7-11: 通知の受け取り口 (src/components/NotificationRouter.tsx。app/_layout.tsx が置く)
 *
 * 以前は setNotificationHandler も addNotificationResponseReceivedListener も無く、フォアグラウンドの通知は表示されず、
 * 通知をタップしても該当画面へ移らなかった。ここでは次を確かめる。
 *   1. 置かれたらフォアグラウンドの通知を表示する設定をし、外されたら設定とリスナーを解除する
 *   2. 通知のタップ (起動中・通知での起動の両方) で、data の行き先へ遷移する。同じ通知は 1 回だけ
 *   3. 未ログイン・初期設定の前は遷移しない。ログイン直後の一瞬 (プロフィール未読み込み) は捨てずに待つ
 *   4. 通知のボタンの操作・不正な行き先では遷移しない
 */

import { act, render } from '@testing-library/react-native';
import React from 'react';

type Listener = (response: unknown) => void;

const mockSetNotificationHandler = jest.fn();
const mockRemove = jest.fn();
const mockGetLast = jest.fn();
const mockClearLast = jest.fn();
const mockListeners: Listener[] = [];
jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationHandler: (...args: unknown[]) => mockSetNotificationHandler(...args),
  addNotificationResponseReceivedListener: (listener: Listener) => {
    mockListeners.push(listener);
    return { remove: () => mockRemove(listener) };
  },
  getLastNotificationResponseAsync: () => mockGetLast(),
  clearLastNotificationResponseAsync: () => mockClearLast(),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

type AuthState = { session: { user: { id: string } } | null; isLoading: boolean };
type ProfileState = { profile: { id: string; onboardingCompletedAt?: string | null } | null; isLoading: boolean };
let mockAuth: AuthState;
let mockProfile: ProfileState;
jest.mock('../../src/providers/AuthProvider', () => ({ useAuth: () => mockAuth }));
jest.mock('../../src/providers/ProfileProvider', () => ({ useProfile: () => mockProfile }));

import { NotificationRouter } from '../../src/components/NotificationRouter';

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';
const SIGNED_IN: AuthState = { session: { user: { id: 'user-1' } }, isLoading: false };
const ONBOARDED: ProfileState = { profile: { id: 'user-1', onboardingCompletedAt: '2026-10-01T00:00:00Z' }, isLoading: false };

function responseOf(id: string, data: Record<string, unknown>, actionIdentifier = DEFAULT_ACTION) {
  return { actionIdentifier, notification: { request: { identifier: id, content: { data } } } };
}

/** 起動中のタップを流す */
async function tap(response: unknown) {
  await act(async () => {
    for (const listener of mockListeners) listener(response);
  });
}

/** 起動時の非同期の取得 (getLastNotificationResponseAsync) を終わらせる */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.length = 0;
  mockGetLast.mockResolvedValue(null);
  mockClearLast.mockResolvedValue(undefined);
  mockAuth = SIGNED_IN;
  mockProfile = ONBOARDED;
});

describe('NotificationRouter — フォアグラウンドの通知の表示と解除 (#1049 F7-11)', () => {
  it('置かれたら、バナー・通知センター・音・バッジを出す設定をする', async () => {
    render(<NotificationRouter />);
    await flush();

    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
    const handler = mockSetNotificationHandler.mock.calls[0][0] as { handleNotification: () => Promise<unknown> };
    await expect(handler.handleNotification()).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    });
  });

  it('外されたら、表示の設定を解除し (null)、タップのリスナーを外す', async () => {
    const view = render(<NotificationRouter />);
    await flush();
    expect(mockListeners).toHaveLength(1);

    view.unmount();

    expect(mockSetNotificationHandler).toHaveBeenLastCalledWith(null);
    expect(mockRemove).toHaveBeenCalledWith(mockListeners[0]);
  });
});

describe('NotificationRouter — 通知のタップで遷移する (#1049 F7-11)', () => {
  it('起動中のタップで、data.deep_link の画面へ遷移する (画面が無い下位のパスは上位の画面)', async () => {
    render(<NotificationRouter />);
    await flush();

    await tap(responseOf('n-1', { type: 'family_meal_request', deep_link: 'homegohan://family/meal-requests' }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/family');
    expect(mockClearLast).toHaveBeenCalled();
  });

  it('通知のタップで起動したとき (getLastNotificationResponseAsync) も、data.path の画面へ遷移する', async () => {
    mockGetLast.mockResolvedValue(responseOf('n-2', { path: '/menus/weekly' }));

    render(<NotificationRouter />);
    await flush();

    expect(mockPush).toHaveBeenCalledWith('/menus/weekly');
    // 次の起動で同じタップをもう一度扱わないよう消す
    expect(mockClearLast).toHaveBeenCalled();
  });

  it('同じ通知が、起動時の取得とリスナーの両方に届いても、遷移は 1 回だけ', async () => {
    const response = responseOf('n-3', { path: '/pantry' });
    mockGetLast.mockResolvedValue(response);

    render(<NotificationRouter />);
    await flush();
    await tap(response);

    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('通知のボタンの操作 (既定の操作でない) では遷移しない', async () => {
    render(<NotificationRouter />);
    await flush();

    await tap(responseOf('n-4', { path: '/pantry' }, 'dismiss'));

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('許していない行き先 (ほかのスキーム・設定の画面) では遷移しない', async () => {
    render(<NotificationRouter />);
    await flush();

    await tap(responseOf('n-5', { deep_link: 'https://evil.example/family' }));
    await tap(responseOf('n-6', { path: '/settings/account' }));

    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('NotificationRouter — 遷移してよい状態になってから遷移する (#1049 F7-11)', () => {
  it('未ログインなら遷移せず、行き先を捨てる (後でログインしても、その通知では遷移しない)', async () => {
    mockAuth = { session: null, isLoading: false };
    mockProfile = { profile: null, isLoading: false };
    const view = render(<NotificationRouter />);
    await flush();

    await tap(responseOf('n-7', { path: '/pantry' }));
    expect(mockPush).not.toHaveBeenCalled();

    mockAuth = SIGNED_IN;
    mockProfile = ONBOARDED;
    view.rerender(<NotificationRouter />);
    await flush();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('ログインの確認中・プロフィールの読み込み中・ログイン直後の一瞬 (profile=null) は待ち、読めたら遷移する', async () => {
    mockAuth = { session: null, isLoading: true };
    mockProfile = { profile: null, isLoading: true };
    mockGetLast.mockResolvedValue(responseOf('n-8', { path: '/health/streaks' }));
    const view = render(<NotificationRouter />);
    await flush();
    expect(mockPush).not.toHaveBeenCalled();

    // ログインが分かった直後の一瞬: プロフィールはまだ読まれていない (isLoading=false・profile=null)
    mockAuth = SIGNED_IN;
    mockProfile = { profile: null, isLoading: false };
    view.rerender(<NotificationRouter />);
    await flush();
    expect(mockPush).not.toHaveBeenCalled();

    // 前のユーザーのプロフィールが残っている間も待つ
    mockProfile = { profile: { id: 'user-old', onboardingCompletedAt: '2026-01-01T00:00:00Z' }, isLoading: false };
    view.rerender(<NotificationRouter />);
    await flush();
    expect(mockPush).not.toHaveBeenCalled();

    mockProfile = ONBOARDED;
    view.rerender(<NotificationRouter />);
    await flush();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/health/streaks');
  });

  it('初期設定が済んでいない利用者は遷移しない (初期設定の流れに任せる)', async () => {
    mockProfile = { profile: { id: 'user-1', onboardingCompletedAt: null }, isLoading: false };
    render(<NotificationRouter />);
    await flush();

    await tap(responseOf('n-9', { path: '/pantry' }));

    expect(mockPush).not.toHaveBeenCalled();
  });
});
