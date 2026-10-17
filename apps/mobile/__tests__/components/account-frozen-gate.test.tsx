/**
 * account-frozen-gate.test.tsx — src/components/AccountFrozenGate.tsx (#1861)
 *
 * 凍結中 (frozen) は、ルートの Stack を凍結の画面の route 1 つに畳む (navigationRef.reset)。同じ凍結で二重に畳まない。
 * 凍結が解けたら (clear / unknown) プロフィールを読み直して入口へ移る。前面は navigationRef.getCurrentRoute() で見る。
 */
import { render } from '@testing-library/react-native';
import React from 'react';

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => false);
let mockPathname = '/home';
let mockNavigationKey: string | undefined = 'root-key';
let mockCurrentRoute: { name: string } | undefined = { name: 'home' };
const mockReset = jest.fn();
const mockNavigationRef = {
  getCurrentRoute: () => mockCurrentRoute,
  reset: (...args: unknown[]) => mockReset(...args),
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

const SIGNED_IN: AuthState = { session: { user: { id: 'user-1' } } };
const FROZEN_RESET = { index: 0, routes: [{ name: 'frozen' }] };

function setFront(name: string | undefined) {
  mockCurrentRoute = name === undefined ? undefined : { name };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/home';
  mockNavigationKey = 'root-key';
  mockCurrentRoute = { name: 'home' };
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
    'session あり & frozen & 対象のパス %s で、前面が凍結の画面でなければ reset を 1 回呼ぶ (規約の同意画面より凍結が先)',
    (pathname) => {
      mockFrozenState = 'frozen';
      mockPathname = pathname;
      setFront(pathname === '/legal-consent' ? 'legal-consent' : 'home');

      render(<AccountFrozenGate />);

      expect(mockReset).toHaveBeenCalledTimes(1);
      expect(mockReset).toHaveBeenCalledWith(FROZEN_RESET);
      expect(mockReplace).not.toHaveBeenCalled();
    },
  );

  it('二重に移らない: 畳んだ後に前面が凍結の画面になった再描画 (pathname が前の値のまま・/frozen に変わった・session の値だけ替わった) では呼ばない', () => {
    mockFrozenState = 'frozen';
    mockPathname = '/home';
    setFront('home');
    const view = render(<AccountFrozenGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    setFront('frozen');
    view.rerender(<AccountFrozenGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    mockPathname = '/frozen';
    view.rerender(<AccountFrozenGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    mockAuth = { session: { user: { id: 'user-1' } } };
    view.rerender(<AccountFrozenGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('畳んだ凍結の画面の上に別の画面が積まれた (通知のタップなど) ら、もう一度畳む', () => {
    mockFrozenState = 'frozen';
    setFront('home');
    const view = render(<AccountFrozenGate />);
    setFront('frozen');
    mockPathname = '/frozen';
    view.rerender(<AccountFrozenGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    setFront('health/blood-tests');
    mockPathname = '/health/blood-tests';
    view.rerender(<AccountFrozenGate />);

    expect(mockReset).toHaveBeenCalledTimes(2);
    expect(mockReset).toHaveBeenLastCalledWith(FROZEN_RESET);
  });

  it('前面が凍結の画面でも、このゲートが畳んでいない (deep link で開いた) なら畳み直す', () => {
    mockFrozenState = 'frozen';
    mockPathname = '/frozen';
    setFront('frozen');

    render(<AccountFrozenGate />);

    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it.each(['/login', '/signup', '/auth/verify', '/about', '/privacy', '/terms'])(
    '対象外のパス %s (認証の途中・公開ページ) では、frozen でも reset を呼ばない',
    (pathname) => {
      mockFrozenState = 'frozen';
      mockPathname = pathname;
      setFront('(auth)');

      render(<AccountFrozenGate />);

      expect(mockReset).not.toHaveBeenCalled();
    },
  );

  it.each(['loading', 'unknown', 'clear'] as const)('%s で対象のパスにいても reset を呼ばない', (state) => {
    mockFrozenState = state;
    setFront('(tabs)');

    render(<AccountFrozenGate />);

    expect(mockReset).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('session が無ければ frozen でも何もしない (ログアウトの後)', () => {
    mockFrozenState = 'frozen';
    mockAuth = { session: null };

    render(<AccountFrozenGate />);

    expect(mockReset).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('ナビゲーターの準備 (useRootNavigationState の key) が済むまでは何もせず、済んだら畳む', () => {
    mockFrozenState = 'frozen';
    mockNavigationKey = undefined;
    const view = render(<AccountFrozenGate />);
    expect(mockReset).not.toHaveBeenCalled();

    mockNavigationKey = 'root-key';
    view.rerender(<AccountFrozenGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('reset が例外を投げてもアプリを落とさない', () => {
    mockFrozenState = 'frozen';
    mockReset.mockImplementationOnce(() => {
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
      expect(mockReset).toHaveBeenCalledTimes(1);
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
    expect(mockReset).toHaveBeenCalledTimes(1);

    mockFrozenState = 'frozen';
    view.rerender(<AccountFrozenGate />);

    expect(mockReset).toHaveBeenCalledTimes(2);
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
