/**
 * account-frozen-flow.test.tsx — AccountFrozenProvider と AccountFrozenGate をつないだ流れ (#1861)
 *
 * 部品ごとのテスト (providers/account-frozen-provider.test.tsx・components/account-frozen-gate.test.tsx) は、相手をモックで差し込む。
 * ここでは本物の Provider と本物のゲートをつなぎ、画面の API の 403 AUTH_ACCOUNT_FROZEN (getApi の withFriendlyErrors が置き換える経路) から、
 *   - 凍結の画面へ移る (ルートの Stack を凍結の画面 1 つに畳む RESET の action の dispatch が 1 回)
 *   - 続けて 403 が届いても二重に移らない (dispatch は 1 回のまま)
 *   - 起動時 (セッションの復元の直後) に凍結なら、ホームを描かずに凍結の画面へ移る
 *   - 解除後 (判定の API が 403 でなくなった) に前面へ戻ると、プロフィールを読み直して入口へ戻る
 * ことを確かめる。expo-router と認証・プロフィールの Provider だけをモックにする。
 */
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { AppState } from 'react-native';

import { accountFrozenBody } from '@homegohan/shared';

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockDispatch = jest.fn();
let mockPathname = '/home';
let mockCurrentRoute: { name: string } | undefined = { name: 'home' };
/** ルートの Stack の state (expo-router 58 の NavigationState の形。ゲートが完全な state の RESET を作る元) */
const ROOT_ROUTE_NAMES = ['index', '(tabs)', 'frozen', 'legal-consent'];
const mockRootState = {
  key: 'navigator:root',
  routeKeySeq: 2,
  index: 1,
  type: 'stack',
  stale: false,
  routeNames: ROOT_ROUTE_NAMES,
  routes: [
    { key: 'index:0', name: 'index' },
    { key: '(tabs):1', name: '(tabs)' },
  ],
};
const mockNavigationRef = {
  getCurrentRoute: () => mockCurrentRoute,
  getRootState: () => mockRootState,
  dispatch: (...args: unknown[]) => mockDispatch(...args),
};
jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockReplace(...args),
    back: (...args: unknown[]) => mockBack(...args),
    canGoBack: () => false,
  },
  usePathname: () => mockPathname,
  useRootNavigationState: () => ({ key: 'root-key' }),
  useNavigationContainerRef: () => mockNavigationRef,
}));

const mockSignedIn = { session: { user: { id: 'user-1' } }, user: { id: 'user-1' } };
jest.mock('../../src/providers/AuthProvider', () => ({ useAuth: () => mockSignedIn }));

const mockRefreshProfile = jest.fn(() => Promise.resolve());
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({ refresh: mockRefreshProfile }),
}));

jest.mock('../../src/lib/supabase', () => ({ supabase: { auth: { getSession: jest.fn() } } }));

/** 判定の API (GET /api/legal/status) の応答。getApi の get だけを差し替え、403 の置き換え (withFriendlyErrors) は本物を通す */
const mockProbe = jest.fn();
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    getApi: () => ({ get: (...args: unknown[]) => actual.withFriendlyErrors(mockProbe(...args)) }),
  };
});

import { AccountFrozenGate } from '../../src/components/AccountFrozenGate';
import { FROZEN_PROBE_API_PATH, resetAccountFrozenListenersForTests } from '../../src/lib/account-frozen';
import { withFriendlyErrors } from '../../src/lib/api';
import { AccountFrozenProvider } from '../../src/providers/AccountFrozenProvider';

/** 凍結のゲートが dispatch する、完全な state の RESET の action (凍結の画面の route はまだ無い) */
const FROZEN_RESET_ACTION = {
  type: 'RESET',
  target: 'navigator:root',
  payload: {
    key: 'navigator:root',
    index: 0,
    routeKeySeq: 2,
    routeNames: ROOT_ROUTE_NAMES,
    type: 'stack',
    stale: false,
    routes: [{ name: 'frozen' }],
  },
};
/** サーバー (middleware) が凍結中の /api に返す 403 を、createHttpClient が投げる Error の形にしたもの */
const frozenHttpError = () => new Error(`HTTP 403 Forbidden: ${JSON.stringify(accountFrozenBody())}`);

const appStateHandlers: Array<(next: string) => void> = [];

function mount() {
  return render(
    <AccountFrozenProvider>
      <AccountFrozenGate />
    </AccountFrozenProvider>,
  );
}

function rerender(view: ReturnType<typeof render>) {
  view.rerender(
    <AccountFrozenProvider>
      <AccountFrozenGate />
    </AccountFrozenProvider>,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** ほかの画面が getApi で呼んだ API が 403 AUTH_ACCOUNT_FROZEN で返った (画面の catch は置き換えた例外を受ける) */
async function screenApiGetsFrozen403() {
  await act(async () => {
    await withFriendlyErrors(Promise.reject(frozenHttpError())).catch(() => undefined);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // 前のテストで使い切らなかった mockResolvedValueOnce などを残さない
  mockProbe.mockReset();
  resetAccountFrozenListenersForTests();
  mockPathname = '/home';
  mockCurrentRoute = { name: 'home' };
  appStateHandlers.length = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (next: string) => void) => {
    appStateHandlers.push(handler);
    return { remove: jest.fn() };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  jest.restoreAllMocks();
  resetAccountFrozenListenersForTests();
});

describe('凍結の流れ (Provider + ゲート)', () => {
  it('画面の API が 403 AUTH_ACCOUNT_FROZEN を受けたら凍結の画面へ 1 回移り、続けて 403 が届いても二重に移らない', async () => {
    mockProbe.mockResolvedValue({ required: false });
    const view = mount();
    await flush();
    expect(mockProbe).toHaveBeenCalledWith(FROZEN_PROBE_API_PATH);
    expect(mockDispatch).not.toHaveBeenCalled();

    await screenApiGetsFrozen403();

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(FROZEN_RESET_ACTION);

    // RESET が流れて前面が凍結の画面になった
    mockCurrentRoute = { name: 'frozen' };
    mockPathname = '/frozen';
    rerender(view);
    // 凍結の画面の WebView の外で、ほかの画面の API がまた 403 を受けた (知らせが繰り返し届く)
    await screenApiGetsFrozen403();
    await screenApiGetsFrozen403();
    rerender(view);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    // 403 の知らせで判定の API を呼び直さない (判定の API も凍結中は 403 のため)
    expect(mockProbe).toHaveBeenCalledTimes(1);
  });

  it('起動時 (セッションの復元の直後) に判定の API が 403 なら、判定が返るまで何もせず、返ったら凍結の画面へ移る (入口へは移さない)', async () => {
    let rejectProbe: (error: Error) => void = () => {};
    mockProbe.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectProbe = reject)));
    mount();
    await flush();
    // loading の間は畳まない・入口へも移さない
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();

    await act(async () => {
      rejectProbe(frozenHttpError());
    });
    await flush();

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(FROZEN_RESET_ACTION);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('解除後に前面へ戻ると、判定の API が 2xx (403 でなくなった) で clear に戻り、プロフィールを読み直して入口へ 1 回戻る', async () => {
    mockProbe.mockRejectedValueOnce(frozenHttpError());
    const view = mount();
    await flush();
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    mockCurrentRoute = { name: 'frozen' };
    mockPathname = '/frozen';
    rerender(view);

    // まだ凍結中: 前面に戻っても凍結の画面のまま
    mockProbe.mockRejectedValueOnce(frozenHttpError());
    act(() => {
      for (const handler of appStateHandlers) handler('active');
    });
    await flush();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockRefreshProfile).not.toHaveBeenCalled();

    // 解除された: 次に前面に戻ったときの判定が 2xx
    mockProbe.mockResolvedValueOnce({ required: false });
    act(() => {
      for (const handler of appStateHandlers) handler('active');
    });
    await flush();

    expect(mockProbe).toHaveBeenCalledTimes(3);
    expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    // 入口へ移った後は、もう何もしない (二重に戻らない)
    mockCurrentRoute = { name: 'index' };
    mockPathname = '/';
    rerender(view);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});
