/**
 * account-frozen-gate.test.tsx — src/components/AccountFrozenGate.tsx (#1861)
 *
 * 凍結中 (frozen) は、ルートの Stack を凍結の画面の route 1 つに畳む (navigationRef.dispatch。expo-router 58 が受け付ける完全な state の RESET。
 * 規約の同意のゲートと同じ部品 (findNavigatorOwningRoute・collapseStackAction) を使う)。同じ凍結で二重に畳まない。
 * 凍結が解けたら (clear / unknown) プロフィールを読み直して入口へ移る。前面は navigationRef.getCurrentRoute() で見る。
 */
import { render } from '@testing-library/react-native';
import { StackRouter, isActionHandled } from 'expo-router/build/react-navigation/routers/index';
import React from 'react';

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => false);
let mockPathname = '/home';
let mockNavigationKey: string | undefined = 'root-key';
let mockCurrentRoute: { name: string } | undefined = { name: 'home' };
const mockDispatch = jest.fn();
/** ルートの Stack の state (expo-router 58 の NavigationState の形。畳む action の元になる) */
let mockRootState: Record<string, unknown> = {};
const mockNavigationRef = {
  getCurrentRoute: () => mockCurrentRoute,
  getRootState: () => mockRootState,
  dispatch: (...args: unknown[]) => mockDispatch(...args),
};
jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockReplace(...args),
    back: (...args: unknown[]) => mockBack(...args),
    canGoBack: () => mockCanGoBack(),
  },
  usePathname: () => mockPathname,
  useRootNavigationState: () => (mockNavigationKey === undefined ? undefined : { key: mockNavigationKey }),
  useNavigationContainerRef: () => mockNavigationRef,
}));

type AuthState = { session: { user: { id: string } } | null };
let mockAuth: AuthState;
jest.mock('../../src/providers/AuthProvider', () => ({ useAuth: () => mockAuth }));

let mockFrozenState: 'loading' | 'clear' | 'frozen' | 'unknown' = 'clear';
jest.mock('../../src/providers/AccountFrozenProvider', () => ({
  useAccountFrozen: () => ({ state: mockFrozenState, refresh: jest.fn() }),
}));

const mockRefreshProfile = jest.fn(() => Promise.resolve());
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({ refresh: mockRefreshProfile }),
}));

import { AccountFrozenGate } from '../../src/components/AccountFrozenGate';
import { FROZEN_SCREEN_ROUTE_NAME } from '../../src/lib/account-frozen';
import { collapseStackAction, findNavigatorOwningRoute, type NavigatorStateLike } from '../../src/lib/legal-consent';

const SIGNED_IN: AuthState = { session: { user: { id: 'user-1' } } };
const ROOT_STACK_KEY = 'navigator:root';
const ROOT_ROUTE_KEY_SEQ = 3;
const ROOT_ROUTE_NAMES = ['index', '(public)', '(auth)', '(tabs)', 'frozen', 'legal-consent', 'settings/account'];
const FROZEN_ROUTE_KEY = `frozen:${ROOT_ROUTE_KEY_SEQ}`;

/** 既定のルートの Stack の state (凍結の画面の route はまだ無い) */
function rootStackState(overrides: Partial<NavigatorStateLike> = {}): NavigatorStateLike {
  return {
    key: ROOT_STACK_KEY,
    routeKeySeq: ROOT_ROUTE_KEY_SEQ,
    index: 1,
    type: 'stack',
    stale: false,
    routeNames: [...ROOT_ROUTE_NAMES],
    routes: [
      { key: 'index:0', name: 'index' },
      { key: '(tabs):1', name: '(tabs)' },
    ],
    ...overrides,
  };
}

/** 凍結のゲートが dispatch する RESET の action (凍結の画面の route が無い state から) */
const FROZEN_RESET_ACTION = {
  type: 'RESET',
  target: ROOT_STACK_KEY,
  payload: {
    key: ROOT_STACK_KEY,
    index: 0,
    routeKeySeq: ROOT_ROUTE_KEY_SEQ,
    routeNames: ROOT_ROUTE_NAMES,
    type: 'stack',
    stale: false,
    routes: [{ name: 'frozen' }],
  },
};

function setFront(name: string | undefined) {
  mockCurrentRoute = name === undefined ? undefined : { name };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/home';
  mockNavigationKey = 'root-key';
  mockCurrentRoute = { name: 'home' };
  mockRootState = rootStackState();
  mockFrozenState = 'clear';
  mockAuth = SIGNED_IN;
  mockCanGoBack.mockReturnValue(false);
  mockRefreshProfile.mockImplementation(() => Promise.resolve());
});

describe('AccountFrozenGate — 凍結中は凍結の画面へ畳む', () => {
  it('route の名前は frozen (app/frozen.tsx)', () => {
    expect(FROZEN_SCREEN_ROUTE_NAME).toBe('frozen');
  });

  it.each(['/', '/home', '/onboarding/welcome', '/health/blood-tests', '/settings/account', '/legal-consent'])(
    'session あり & frozen & 対象のパス %s で、前面が凍結の画面でなければ RESET の action を 1 回 dispatch する (規約の同意画面より凍結が先)',
    (pathname) => {
      mockFrozenState = 'frozen';
      mockPathname = pathname;
      setFront(pathname === '/legal-consent' ? 'legal-consent' : 'home');

      render(<AccountFrozenGate />);

      expect(mockDispatch).toHaveBeenCalledTimes(1);
      expect(mockDispatch).toHaveBeenCalledWith(FROZEN_RESET_ACTION);
      expect(mockReplace).not.toHaveBeenCalled();
    },
  );

  it('二重に移らない: 畳んだ後に前面が凍結の画面になった再描画 (pathname が前の値のまま・/frozen に変わった・session の値だけ替わった) では呼ばない', () => {
    mockFrozenState = 'frozen';
    mockPathname = '/home';
    setFront('home');
    const view = render(<AccountFrozenGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    setFront('frozen');
    view.rerender(<AccountFrozenGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    mockPathname = '/frozen';
    view.rerender(<AccountFrozenGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    mockAuth = { session: { user: { id: 'user-1' } } };
    view.rerender(<AccountFrozenGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('畳んだ凍結の画面の上に別の画面が積まれた (通知のタップなど) ら、もう一度畳む', () => {
    mockFrozenState = 'frozen';
    setFront('home');
    const view = render(<AccountFrozenGate />);
    setFront('frozen');
    mockPathname = '/frozen';
    view.rerender(<AccountFrozenGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    setFront('health/blood-tests');
    mockPathname = '/health/blood-tests';
    view.rerender(<AccountFrozenGate />);

    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(mockDispatch).toHaveBeenLastCalledWith(FROZEN_RESET_ACTION);
  });

  it('前面が凍結の画面でも、このゲートが畳んでいない (deep link で開いた) なら畳み直す', () => {
    mockFrozenState = 'frozen';
    mockPathname = '/frozen';
    setFront('frozen');

    render(<AccountFrozenGate />);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['/login', '/signup', '/auth/verify', '/about', '/privacy', '/terms'])(
    '対象外のパス %s (認証の途中・公開ページ) では、frozen でも dispatch しない',
    (pathname) => {
      mockFrozenState = 'frozen';
      mockPathname = pathname;
      setFront('(auth)');

      render(<AccountFrozenGate />);

      expect(mockDispatch).not.toHaveBeenCalled();
    },
  );

  it.each(['loading', 'unknown', 'clear'] as const)('%s で対象のパスにいても dispatch しない', (state) => {
    mockFrozenState = state;
    setFront('(tabs)');

    render(<AccountFrozenGate />);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('session が無ければ frozen でも何もしない (ログアウトの後)', () => {
    mockFrozenState = 'frozen';
    mockAuth = { session: null };

    render(<AccountFrozenGate />);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('ナビゲーターの準備 (useRootNavigationState の key) が済むまでは何もせず、済んだら畳む', () => {
    mockFrozenState = 'frozen';
    mockNavigationKey = undefined;
    const view = render(<AccountFrozenGate />);
    expect(mockDispatch).not.toHaveBeenCalled();

    mockNavigationKey = 'root-key';
    view.rerender(<AccountFrozenGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('dispatch が例外を投げてもアプリを落とさない', () => {
    mockFrozenState = 'frozen';
    mockDispatch.mockImplementationOnce(() => {
      throw new Error('navigator not ready');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => render(<AccountFrozenGate />)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('AccountFrozenGate — 凍結が解けたら通常へ戻る', () => {
  it.each(['clear', 'unknown'] as const)(
    '前面が凍結の画面で %s になったら、プロフィールを読み直して入口へ 1 回 replace する (戻る先が無いとき)',
    (state) => {
      mockFrozenState = 'frozen';
      setFront('home');
      const view = render(<AccountFrozenGate />);
      setFront('frozen');
      mockPathname = '/frozen';
      view.rerender(<AccountFrozenGate />);

      mockFrozenState = state;
      view.rerender(<AccountFrozenGate />);

      expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/');
      expect(mockBack).not.toHaveBeenCalled();

      // replace が流れるまでの再描画で重ねて積まない
      view.rerender(<AccountFrozenGate />);
      expect(mockReplace).toHaveBeenCalledTimes(1);

      // 流れて前面が入口になったら、もう何もしない
      setFront('index');
      mockPathname = '/';
      view.rerender(<AccountFrozenGate />);
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('凍結の画面の下に画面がある (deep link で上に開いた) なら、その画面へ戻る (back)', () => {
    mockFrozenState = 'clear';
    mockCanGoBack.mockReturnValue(true);
    setFront('frozen');

    render(<AccountFrozenGate />);

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('解けた後にまた凍結されたら、もう一度畳む', () => {
    mockFrozenState = 'frozen';
    setFront('home');
    const view = render(<AccountFrozenGate />);
    setFront('frozen');
    view.rerender(<AccountFrozenGate />);
    mockFrozenState = 'clear';
    view.rerender(<AccountFrozenGate />);
    setFront('index');
    mockPathname = '/';
    view.rerender(<AccountFrozenGate />);
    setFront('(tabs)');
    mockPathname = '/home';
    view.rerender(<AccountFrozenGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    mockFrozenState = 'frozen';
    view.rerender(<AccountFrozenGate />);

    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('プロフィールの読み直しが失敗しても、入口へは移る (警告だけ)', async () => {
    mockFrozenState = 'clear';
    setFront('frozen');
    mockRefreshProfile.mockImplementationOnce(() => Promise.reject(new Error('network')));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    render(<AccountFrozenGate />);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('AccountFrozenGate — 畳む action の中身 (完全な state の RESET)', () => {
  it('凍結の画面の route が Stack の下に残っている (deep link で開いた・前の凍結から残った) なら、その key を再利用した RESET の action を dispatch する', () => {
    mockFrozenState = 'frozen';
    mockPathname = '/health/blood-tests';
    setFront('health/blood-tests');
    mockRootState = rootStackState({
      index: 2,
      routes: [
        { key: 'index:0', name: 'index' },
        { key: FROZEN_ROUTE_KEY, name: 'frozen' },
        { key: 'health/blood-tests:4', name: 'health/blood-tests' },
      ],
    });

    render(<AccountFrozenGate />);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith({
      ...FROZEN_RESET_ACTION,
      payload: { ...FROZEN_RESET_ACTION.payload, routes: [{ name: 'frozen', key: FROZEN_ROUTE_KEY }] },
    });
  });

  it('ルートの Stack の state がそろっていない (routeNames に frozen が無い・routeKeySeq が無い) なら dispatch せず警告を残し、次の描画でそろっていれば 1 回 dispatch する', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockFrozenState = 'frozen';
      mockRootState = rootStackState({ routeNames: ['index', '(tabs)'], routeKeySeq: undefined });
      const view = render(<AccountFrozenGate />);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringContaining('root stack is not ready'),
      );

      // 準備が済んだ (openedRef を立てていないので、次の描画で試す)
      mockRootState = rootStackState();
      mockPathname = '/health';
      view.rerender(<AccountFrozenGate />);

      expect(mockDispatch).toHaveBeenCalledTimes(1);
      expect(mockDispatch).toHaveBeenCalledWith(FROZEN_RESET_ACTION);
    } finally {
      warn.mockRestore();
    }
  });
});

// 実物の expo-router 58 の StackRouter に、ゲートが dispatch する action を通す (mock だけで緑になることを防ぐ)。
// 部分の state の RESET (index と routes だけ) は 58 の BaseRouter が捨て、凍結の画面へ畳めずスピナーのまま止まる
describe('AccountFrozenGate — expo-router 58 の StackRouter に通す', () => {
  const routerConfig = { routeNames: [...ROOT_ROUTE_NAMES], routeParamList: {}, routeGetIdList: {} };

  function stateAfterGate(root: NavigatorStateLike) {
    mockFrozenState = 'frozen';
    mockRootState = root;
    render(<AccountFrozenGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const action = mockDispatch.mock.calls[0]?.[0];
    return StackRouter({}).getStateForAction(root as never, action, routerConfig);
  }

  it('凍結の画面の route が無い state に、ゲートの action を通すと、受け付けて routes が [frozen] (key は router が付ける) になる', () => {
    const result = stateAfterGate(rootStackState());
    if (!isActionHandled(result)) throw new Error('RESET が受け付けられなかった');
    expect(result.state.routes.map((route) => route.name)).toEqual(['frozen']);
    expect(result.state.routes[0]?.key).toBe(FROZEN_ROUTE_KEY);
    expect(result.state.index).toBe(0);
    expect(result.state.routeKeySeq).toBe(ROOT_ROUTE_KEY_SEQ + 1);
  });

  it('凍結の画面の route がある state に、ゲートの action を通すと、その key のまま routes が [frozen] になる', () => {
    const result = stateAfterGate(
      rootStackState({
        index: 2,
        routes: [
          { key: 'index:0', name: 'index' },
          { key: '(tabs):1', name: '(tabs)' },
          { key: FROZEN_ROUTE_KEY, name: 'frozen' },
        ],
      }),
    );
    if (!isActionHandled(result)) throw new Error('RESET が受け付けられなかった');
    expect(result.state.routes.map((route) => ({ name: route.name, key: route.key }))).toEqual([
      { name: 'frozen', key: FROZEN_ROUTE_KEY },
    ]);
    expect(result.state.routeKeySeq).toBe(ROOT_ROUTE_KEY_SEQ);
  });

  it('いまの部分の state ({ index: 0, routes: [{ name: "frozen" }] }) の RESET は受け付けない (Unhandled。この番兵が実物の router の条件を見ていることの確かめ)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const root = rootStackState();
      const owner = findNavigatorOwningRoute(root, FROZEN_SCREEN_ROUTE_NAME);
      if (owner === null) throw new Error('持ち主が見つからない');
      expect(collapseStackAction(owner, FROZEN_SCREEN_ROUTE_NAME).payload.stale).toBe(false);

      const result = StackRouter({}).getStateForAction(
        root as never,
        { type: 'RESET', payload: { index: 0, routes: [{ name: 'frozen' }] } },
        routerConfig,
      );

      expect(isActionHandled(result)).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
