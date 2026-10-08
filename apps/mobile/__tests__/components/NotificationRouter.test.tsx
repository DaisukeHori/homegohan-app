/**
 * NotificationRouter.test.tsx
 * 通知タップで該当画面へ遷移する処理 (src/components/NotificationRouter.tsx) のテスト (#1049 F7-11)
 *
 * 以前は通知のタップを受け取る処理が無く、タップしてもアプリが開くだけで該当画面に遷移しなかった。
 * 受け取る経路は 2 つ:
 *   - アプリが起動中のタップ (addNotificationResponseReceivedListener)
 *   - アプリが終了していて通知のタップで起動した場合 (getLastNotificationResponseAsync)
 * 遷移はログイン状態・初期設定の完了が分かってから行う。
 */

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

// ── expo-notifications モック ─────────────────────────────────────────────────
type Response = {
  actionIdentifier: string;
  notification: { request: { identifier: string; content: { data?: Record<string, unknown> } } };
};

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

let mockListener: ((response: Response) => void) | null = null;
const mockRemove = jest.fn();
const mockGetLast = jest.fn();
const mockClearLast = jest.fn();

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  getLastNotificationResponseAsync: () => mockGetLast(),
  clearLastNotificationResponseAsync: () => mockClearLast(),
  addNotificationResponseReceivedListener: (listener: (response: Response) => void) => {
    mockListener = listener;
    return { remove: mockRemove };
  },
}));

// ── expo-router モック (useRouter は同じオブジェクトを返す。実物と同じく安定した参照) ──
const mockPush = jest.fn();
const mockRouter = { push: (...args: unknown[]) => mockPush(...args) };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

// ── 認証・プロフィールの状態 ───────────────────────────────────────────────────
type AuthState = { session: unknown; isLoading: boolean };
type ProfileState = { profile: { onboardingCompletedAt?: string | null } | null; isLoading: boolean };

let mockAuth: AuthState = { session: { user: { id: 'u1' } }, isLoading: false };
let mockProfile: ProfileState = { profile: { onboardingCompletedAt: '2026-10-01T00:00:00Z' }, isLoading: false };

jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => mockAuth,
}));
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => mockProfile,
}));

import { NotificationRouter } from '../../src/components/NotificationRouter';

function tap(deepLink: unknown, overrides: Partial<Response> & { id?: string } = {}): Response {
  return {
    actionIdentifier: overrides.actionIdentifier ?? DEFAULT_ACTION,
    notification: {
      request: {
        identifier: overrides.id ?? 'notification-1',
        content: { data: deepLink === undefined ? {} : { deep_link: deepLink } },
      },
    },
  };
}

/** 描画する。起動時の取得 (非同期) の結果が反映されるまで act の中で待つ */
async function renderRouter() {
  const view = render(<NotificationRouter />);
  await act(async () => {});
  return view;
}

/** 起動中にタップされたことにする */
async function receiveTap(response: Response) {
  await act(async () => {
    mockListener?.(response);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListener = null;
  mockGetLast.mockResolvedValue(null);
  mockClearLast.mockResolvedValue(undefined);
  mockAuth = { session: { user: { id: 'u1' } }, isLoading: false };
  mockProfile = { profile: { onboardingCompletedAt: '2026-10-01T00:00:00Z' }, isLoading: false };
});

describe('NotificationRouter — 起動中のタップ', () => {
  it('ネイティブ画面への deep_link をタップすると、その画面へ遷移する', async () => {
    await renderRouter();

    await receiveTap(tap('homegohan://family'));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/family');
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('WebView のタブへの deep_link は、そのタブへページ指定つきで遷移する', async () => {
    await renderRouter();

    await receiveTap(tap('homegohan://menus/weekly?date=2026-10-08'));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/(tabs)/menus',
        params: { initialPath: '/menus/weekly?date=2026-10-08' },
      });
    });
  });

  it('タブそのものへの deep_link は、ページ指定なしでタブを切り替える', async () => {
    await renderRouter();

    await receiveTap(tap('homegohan://home'));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/(tabs)/home');
    });
  });

  it('行き先が決められない通知 (deep_link なし・不正・許可外) では遷移しない', async () => {
    await renderRouter();

    await receiveTap(tap(undefined, { id: 'a' }));
    await receiveTap(tap('https://evil.example/', { id: 'b' }));
    await receiveTap(tap('homegohan://settings/account', { id: 'c' }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('通知本体のタップ以外 (アクションボタン、通知を消した操作) では遷移しない', async () => {
    await renderRouter();

    await receiveTap(tap('homegohan://family', { actionIdentifier: 'expo.modules.notifications.actions.DISMISS' }));
    await receiveTap(tap('homegohan://family', { actionIdentifier: 'APPROVE', id: 'x' }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('同じ通知のタップが 2 回届いても、遷移は 1 回', async () => {
    await renderRouter();

    await receiveTap(tap('homegohan://family', { id: 'same' }));
    await receiveTap(tap('homegohan://family', { id: 'same' }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
  });

  it('別の通知なら、それぞれ遷移する', async () => {
    await renderRouter();

    await receiveTap(tap('homegohan://family', { id: 'one' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    await receiveTap(tap('homegohan://pantry', { id: 'two' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(2));

    expect(mockPush).toHaveBeenLastCalledWith('/pantry');
  });
});

describe('NotificationRouter — 通知のタップでアプリが起動した場合', () => {
  it('起動時に取得したタップへ遷移し、次回の起動で同じタップを処理しないよう消す', async () => {
    mockGetLast.mockResolvedValue(tap('homegohan://pantry', { id: 'cold-start' }));

    await renderRouter();

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/pantry');
    });
    expect(mockClearLast).toHaveBeenCalled();
  });

  it('起動直後で認証の確認中なら、確認が終わってから遷移する', async () => {
    mockAuth = { session: null, isLoading: true };
    mockGetLast.mockResolvedValue(tap('homegohan://pantry', { id: 'cold-start' }));

    const view = await renderRouter();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPush).not.toHaveBeenCalled();

    // 認証の確認が終わった
    mockAuth = { session: { user: { id: 'u1' } }, isLoading: false };
    view.rerender(<NotificationRouter />);
    await act(async () => {});

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/pantry');
    });
  });

  it('プロフィール (初期設定の完了状況) の読み込み中も待つ', async () => {
    mockProfile = { profile: null, isLoading: true };
    mockGetLast.mockResolvedValue(tap('homegohan://pantry', { id: 'cold-start' }));

    const view = await renderRouter();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPush).not.toHaveBeenCalled();

    mockProfile = { profile: { onboardingCompletedAt: '2026-10-01T00:00:00Z' }, isLoading: false };
    view.rerender(<NotificationRouter />);
    await act(async () => {});

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/pantry');
    });
  });
});

describe('NotificationRouter — 遷移しない状態', () => {
  it('未ログインなら遷移しない (その後ログインしても、古いタップでは遷移しない)', async () => {
    mockAuth = { session: null, isLoading: false };
    const view = await renderRouter();

    await receiveTap(tap('homegohan://family'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPush).not.toHaveBeenCalled();

    mockAuth = { session: { user: { id: 'u1' } }, isLoading: false };
    view.rerender(<NotificationRouter />);
    await act(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('初期設定が終わっていないユーザーは遷移しない (初期設定の流れに任せる)', async () => {
    mockProfile = { profile: { onboardingCompletedAt: null }, isLoading: false };
    await renderRouter();

    await receiveTap(tap('homegohan://family'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('遷移が例外を投げても、アプリを落とさない', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPush.mockImplementation(() => {
      throw new Error('Attempted to navigate before mounting the Root Layout component');
    });
    await renderRouter();

    await receiveTap(tap('homegohan://family'));

    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    warn.mockRestore();
  });
});

describe('NotificationRouter — 後始末', () => {
  it('アンマウントするとリスナーを外す', async () => {
    const view = await renderRouter();

    view.unmount();

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('起動時の取得に失敗してもアプリを落とさない', async () => {
    mockGetLast.mockRejectedValue(new Error('unavailable'));

    await renderRouter();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockPush).not.toHaveBeenCalled();
  });
});
