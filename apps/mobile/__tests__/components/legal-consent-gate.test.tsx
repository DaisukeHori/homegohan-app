/**
 * legal-consent-gate.test.tsx — src/components/legal/LegalConsentGate.tsx (#1442 設計書 cross/13b §6.6.10。T-G1〜T-G8)
 *
 * 同意が要る間 (required) は、ルートの Stack を同意画面の route 1 つに畳む (navigationRef.dispatch。expo-router 58 が受け付ける完全な state の RESET)。
 * 同意が済んだら (clear / unknown) プロフィールを読み直して入口へ移る。前面は pathname でなく
 * navigationRef.getCurrentRoute() で見る。
 */
import { render } from '@testing-library/react-native';
import React from 'react';

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => false);
let mockPathname = '/home';
let mockNavigationKey: string | undefined = 'root-key';
let mockCurrentRoute: { name: string } | undefined = { name: 'home' };
const mockDispatch = jest.fn();
const ROOT_ROUTE_NAMES = ['index', '(public)', '(auth)', '(tabs)', 'legal-consent', 'settings/account'];
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

let mockLegalState: 'loading' | 'clear' | 'required' | 'unknown' = 'clear';
// #1861: 凍結の状態 (既定 clear。凍結のテストで変える)
let mockFrozenState: 'loading' | 'clear' | 'frozen' | 'unknown' = 'clear';
jest.mock('../../src/providers/AccountFrozenProvider', () => ({
  useAccountFrozen: () => ({ state: mockFrozenState, refresh: jest.fn() }),
}));
beforeEach(() => {
  mockFrozenState = 'clear';
});
jest.mock('../../src/providers/LegalConsentProvider', () => ({
  useLegalConsent: () => ({ state: mockLegalState, status: null, refresh: jest.fn() }),
}));

const mockRefreshProfile = jest.fn(() => Promise.resolve());
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({ refresh: mockRefreshProfile }),
}));

import { LegalConsentGate } from '../../src/components/legal/LegalConsentGate';

const SIGNED_IN: AuthState = { session: { user: { id: 'user-1' } } };
/** 既定のルートの Stack の state (同意画面の route はまだ無い) */
function defaultRootState(): Record<string, unknown> {
  return {
    key: 'navigator:root',
    routeKeySeq: 3,
    index: 1,
    type: 'stack',
    stale: false,
    routeNames: [...ROOT_ROUTE_NAMES],
    routes: [
      { key: 'index:0', name: 'index' },
      { key: '(tabs):1', name: '(tabs)' },
    ],
  };
}
/** 同意のゲートが dispatch する、完全な state の RESET の action (同意画面の route はまだ無い) */
const CONSENT_RESET_ACTION = {
  type: 'RESET',
  target: 'navigator:root',
  payload: {
    key: 'navigator:root',
    index: 0,
    routeKeySeq: 3,
    routeNames: ROOT_ROUTE_NAMES,
    type: 'stack',
    stale: false,
    routes: [{ name: 'legal-consent' }],
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
  mockRootState = defaultRootState();
  mockLegalState = 'clear';
  mockAuth = SIGNED_IN;
  mockCanGoBack.mockReturnValue(false);
  mockRefreshProfile.mockImplementation(() => Promise.resolve());
});

describe('LegalConsentGate — 畳む (T-G1 / T-G2 / T-G5 / T-G6)', () => {
  it.each(['/', '/home', '/onboarding/welcome', '/health/blood-tests', '/handson-tour/photo', '/settings'])(
    'T-G1: session あり & required & 対象のパス %s で、前面が同意画面でなければ RESET の action を 1 回 dispatch する',
    (pathname) => {
      mockLegalState = 'required';
      mockPathname = pathname;
      setFront('home');

      render(<LegalConsentGate />);

      expect(mockDispatch).toHaveBeenCalledTimes(1);
      expect(mockDispatch).toHaveBeenCalledWith(CONSENT_RESET_ACTION);
      expect(mockReplace).not.toHaveBeenCalled();
    },
  );

  it('T-G1: そのあと前面を legal-consent にした再描画 (pathname が前の値のまま・/legal-consent に変えた・session の値だけ替えた) では呼ばない', () => {
    mockLegalState = 'required';
    mockPathname = '/health/blood-tests';
    setFront('health/blood-tests');
    const view = render(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    setFront('legal-consent');
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    mockPathname = '/legal-consent';
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    mockAuth = { session: { user: { id: 'user-1' } } };
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['/login', '/signup', '/auth/reset-password', '/about', '/privacy', '/terms'])(
    'T-G2: 対象外のパス %s では、required でも前面が同意画面でなければ dispatch しない',
    (pathname) => {
      mockLegalState = 'required';
      mockPathname = pathname;
      setFront('(auth)');

      render(<LegalConsentGate />);

      expect(mockDispatch).not.toHaveBeenCalled();
    },
  );

  it.each(['loading', 'unknown', 'clear'] as const)('T-G5: %s で対象のパスにいても dispatch しない', (state) => {
    mockLegalState = state;
    mockPathname = '/home';
    setFront('(tabs)');

    render(<LegalConsentGate />);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('T-G6: ナビゲーターの準備 (useRootNavigationState の key) が済むまでは何もせず、済んだら判定する', () => {
    mockLegalState = 'required';
    mockNavigationKey = undefined;
    const view = render(<LegalConsentGate />);
    expect(mockDispatch).not.toHaveBeenCalled();

    mockNavigationKey = 'root-key';
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('T-G6: dispatch / replace が例外を投げても落ちない (端末のログに警告を残す)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockLegalState = 'required';
      mockDispatch.mockImplementationOnce(() => {
        throw new Error('dispatch failed');
      });
      expect(() => render(<LegalConsentGate />)).not.toThrow();
      expect(warn).toHaveBeenCalled();

      mockLegalState = 'clear';
      setFront('legal-consent');
      mockReplace.mockImplementationOnce(() => {
        throw new Error('replace failed');
      });
      expect(() => render(<LegalConsentGate />)).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('LegalConsentGate — 同意の後に入口へ移る (T-G3)', () => {
  it('前面が同意画面で clear になったら、プロフィールの refresh と router.replace("/") を 1 回ずつ呼ぶ', () => {
    mockLegalState = 'clear';
    setFront('legal-consent');
    mockPathname = '/legal-consent';

    render(<LegalConsentGate />);

    expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('unknown でも同じ', () => {
    mockLegalState = 'unknown';
    setFront('legal-consent');

    render(<LegalConsentGate />);

    expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('router.canGoBack が true なら replace の代わりに router.back を 1 回呼ぶ (ゲートが畳んでいない同意画面)', () => {
    mockLegalState = 'clear';
    setFront('legal-consent');
    mockCanGoBack.mockReturnValue(true);

    render(<LegalConsentGate />);

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
  });

  it('前面が同意画面のまま再描画しても重ねて呼ばない。前面が入口に変わった後に、また前面が同意画面で clear になれば呼ぶ', () => {
    mockLegalState = 'clear';
    setFront('legal-consent');
    const view = render(<LegalConsentGate />);
    expect(mockReplace).toHaveBeenCalledTimes(1);

    mockPathname = '/legal-consent';
    view.rerender(<LegalConsentGate />);
    mockAuth = { session: { user: { id: 'user-1' } } };
    view.rerender(<LegalConsentGate />);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockRefreshProfile).toHaveBeenCalledTimes(1);

    // 入口へ移った
    setFront('index');
    mockPathname = '/';
    view.rerender(<LegalConsentGate />);
    expect(mockReplace).toHaveBeenCalledTimes(1);

    // また同意画面が前面になって clear
    setFront('legal-consent');
    mockPathname = '/legal-consent';
    view.rerender(<LegalConsentGate />);
    expect(mockReplace).toHaveBeenCalledTimes(2);
    expect(mockRefreshProfile).toHaveBeenCalledTimes(2);
  });

  it('loading では呼ばない', () => {
    mockLegalState = 'loading';
    setFront('legal-consent');

    render(<LegalConsentGate />);

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockRefreshProfile).not.toHaveBeenCalled();
  });

  it('refresh が reject しても落ちない (警告を残して、入口へは移る)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockRefreshProfile.mockImplementation(() => Promise.reject(new Error('profile failed')));
      mockLegalState = 'clear';
      setFront('legal-consent');

      expect(() => render(<LegalConsentGate />)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockReplace).toHaveBeenCalledWith('/');
      expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringContaining('profile refresh failed'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('前面が同意画面でなければ (clear)、何も呼ばない', () => {
    mockLegalState = 'clear';
    setFront('home');
    render(<LegalConsentGate />);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockRefreshProfile).not.toHaveBeenCalled();
  });
});

describe('LegalConsentGate — session が無いとき (T-G4)', () => {
  it('前面が同意画面でもそうでなくても dispatch も replace も呼ばない', () => {
    mockAuth = { session: null };
    for (const state of ['loading', 'clear', 'required', 'unknown'] as const) {
      mockLegalState = state;
      setFront('legal-consent');
      render(<LegalConsentGate />).unmount();
      setFront('home');
      render(<LegalConsentGate />).unmount();
    }
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('RESET で畳んだ後にログアウトし、前面が入口に変わってからログインし直して required になると、また RESET の action を 1 回 dispatch する', () => {
    mockLegalState = 'required';
    setFront('home');
    const view = render(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    // 畳んだ同意画面が前面。ログアウト (state は clear に戻る)
    setFront('legal-consent');
    mockAuth = { session: null };
    mockLegalState = 'clear';
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();

    // 「閉じる」で入口へ。session 無しで前面が入口なので openedRef を外す
    setFront('index');
    mockPathname = '/';
    view.rerender(<LegalConsentGate />);

    // ログインし直して required
    mockAuth = SIGNED_IN;
    mockLegalState = 'required';
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });
});

describe('LegalConsentGate — 畳み直し (T-G7 / T-G8)', () => {
  it('T-G7: required で前面が同意画面だがゲートが畳んでいない (deep link で開いた) なら、同意画面の route の key を再利用した RESET の action を 1 回 dispatch する', () => {
    mockLegalState = 'required';
    setFront('legal-consent');
    mockPathname = '/legal-consent';
    mockRootState = {
      ...defaultRootState(),
      index: 2,
      routes: [
        { key: 'index:0', name: 'index' },
        { key: '(tabs):1', name: '(tabs)' },
        { key: 'legal-consent:2', name: 'legal-consent' },
      ],
    };

    render(<LegalConsentGate />);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith({
      ...CONSENT_RESET_ACTION,
      payload: { ...CONSENT_RESET_ACTION.payload, routes: [{ name: 'legal-consent', key: 'legal-consent:2' }] },
    });
  });

  it('T-G7: ゲートが畳んだ後に、前面が対象の別の画面 (health/blood-tests) になったらもう 1 回 dispatch し、対象外の画面 (auth/reset-password) なら呼ばない。対象外の画面から前面が同意画面に戻っても呼ばない', () => {
    mockLegalState = 'required';
    setFront('home');
    mockPathname = '/home';
    const view = render(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    // 畳んだ同意画面が前面
    setFront('legal-consent');
    mockPathname = '/legal-consent';
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    // 同意画面の上に対象の画面が積まれた
    setFront('health/blood-tests');
    mockPathname = '/health/blood-tests';
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(2);

    // 畳み直した
    setFront('legal-consent');
    mockPathname = '/legal-consent';
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(2);

    // 対象外の画面が積まれた: 畳まない
    setFront('auth/reset-password');
    mockPathname = '/auth/reset-password';
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(2);

    // 対象外の画面を閉じて同意画面に戻った: 畳み直さない (openedRef が保たれている)
    setFront('legal-consent');
    mockPathname = '/legal-consent';
    view.rerender(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('T-G8: タブの区画が外れる形: required・pathname /settings・前面 (tabs) で RESET の action を 1 回 dispatch した後、前面を legal-consent にして pathname を /home に変えた描画でも dispatch しない (合計 1 回)', () => {
    mockLegalState = 'required';
    mockPathname = '/settings';
    setFront('(tabs)');
    const view = render(<LegalConsentGate />);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    setFront('legal-consent');
    mockPathname = '/home';
    view.rerender(<LegalConsentGate />);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('LegalConsentGate — 畳む action の中身 (T-G9 / T-G10)', () => {
  it('T-G9: 前面が対象の画面で、同意画面の route が Stack の下に残っている (ログアウトの前から) なら、その key を再利用した RESET の action を dispatch する', () => {
    mockLegalState = 'required';
    mockPathname = '/health/blood-tests';
    setFront('health/blood-tests');
    mockRootState = {
      ...defaultRootState(),
      index: 2,
      routes: [
        { key: 'index:0', name: 'index' },
        { key: 'legal-consent:2', name: 'legal-consent' },
        { key: 'health/blood-tests:4', name: 'health/blood-tests' },
      ],
    };

    render(<LegalConsentGate />);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith({
      ...CONSENT_RESET_ACTION,
      payload: { ...CONSENT_RESET_ACTION.payload, routes: [{ name: 'legal-consent', key: 'legal-consent:2' }] },
    });
  });

  it('T-G10: ルートの Stack の state がそろっていない (routeNames に legal-consent が無い・routeKeySeq が無い) なら dispatch せず警告を残し、次の描画でそろっていれば 1 回 dispatch する', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockLegalState = 'required';
      mockRootState = { ...defaultRootState(), routeNames: ['index', '(tabs)'], routeKeySeq: undefined };
      const view = render(<LegalConsentGate />);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringContaining('root stack is not ready'),
      );

      // 準備が済んだ (openedRef を立てていないので、次の描画で試す)
      mockRootState = defaultRootState();
      mockPathname = '/health';
      view.rerender(<LegalConsentGate />);

      expect(mockDispatch).toHaveBeenCalledTimes(1);
      expect(mockDispatch).toHaveBeenCalledWith(CONSENT_RESET_ACTION);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('LegalConsentGate — 凍結中は畳まない (#1861。凍結が先)', () => {
  it('required でも、凍結中 (frozen) なら dispatch も replace もしない。凍結が解けたら (clear) 同意画面へ畳む', () => {
    mockLegalState = 'required';
    mockFrozenState = 'frozen';
    mockPathname = '/frozen';
    setFront('frozen');
    const view = render(<LegalConsentGate />);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();

    mockFrozenState = 'clear';
    view.rerender(<LegalConsentGate />);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(CONSENT_RESET_ACTION);
  });

  it('前面が同意画面で clear でも、凍結中なら閉じない (凍結のゲートが凍結の画面へ畳む)', () => {
    mockLegalState = 'clear';
    mockFrozenState = 'frozen';
    setFront('legal-consent');

    render(<LegalConsentGate />);

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockRefreshProfile).not.toHaveBeenCalled();
  });
});
