/**
 * legal-consent-gate.test.tsx — src/components/legal/LegalConsentGate.tsx (#1442 設計書 cross/13b §6.6.10。T-G1〜T-G8)
 *
 * 同意が要る間 (required) は、ルートの Stack を同意画面の route 1 つに畳む (navigationRef.reset)。
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
const CONSENT_RESET = { index: 0, routes: [{ name: 'legal-consent' }] };

function setFront(name: string | undefined) {
  mockCurrentRoute = name === undefined ? undefined : { name };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/home';
  mockNavigationKey = 'root-key';
  mockCurrentRoute = { name: 'home' };
  mockLegalState = 'clear';
  mockAuth = SIGNED_IN;
  mockCanGoBack.mockReturnValue(false);
  mockRefreshProfile.mockImplementation(() => Promise.resolve());
});

describe('LegalConsentGate — 畳む (T-G1 / T-G2 / T-G5 / T-G6)', () => {
  it.each(['/', '/home', '/onboarding/welcome', '/health/blood-tests', '/handson-tour/photo', '/settings'])(
    'T-G1: session あり & required & 対象のパス %s で、前面が同意画面でなければ reset を 1 回呼ぶ',
    (pathname) => {
      mockLegalState = 'required';
      mockPathname = pathname;
      setFront('home');

      render(<LegalConsentGate />);

      expect(mockReset).toHaveBeenCalledTimes(1);
      expect(mockReset).toHaveBeenCalledWith(CONSENT_RESET);
      expect(mockReplace).not.toHaveBeenCalled();
    },
  );

  it('T-G1: そのあと前面を legal-consent にした再描画 (pathname が前の値のまま・/legal-consent に変えた・session の値だけ替えた) では呼ばない', () => {
    mockLegalState = 'required';
    mockPathname = '/health/blood-tests';
    setFront('health/blood-tests');
    const view = render(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    setFront('legal-consent');
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    mockPathname = '/legal-consent';
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    mockAuth = { session: { user: { id: 'user-1' } } };
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it.each(['/login', '/signup', '/auth/reset-password', '/about', '/privacy', '/terms'])(
    'T-G2: 対象外のパス %s では、required でも前面が同意画面でなければ reset を呼ばない',
    (pathname) => {
      mockLegalState = 'required';
      mockPathname = pathname;
      setFront('(auth)');

      render(<LegalConsentGate />);

      expect(mockReset).not.toHaveBeenCalled();
    },
  );

  it.each(['loading', 'unknown', 'clear'] as const)('T-G5: %s で対象のパスにいても reset を呼ばない', (state) => {
    mockLegalState = state;
    mockPathname = '/home';
    setFront('(tabs)');

    render(<LegalConsentGate />);

    expect(mockReset).not.toHaveBeenCalled();
  });

  it('T-G6: ナビゲーターの準備 (useRootNavigationState の key) が済むまでは何もせず、済んだら判定する', () => {
    mockLegalState = 'required';
    mockNavigationKey = undefined;
    const view = render(<LegalConsentGate />);
    expect(mockReset).not.toHaveBeenCalled();

    mockNavigationKey = 'root-key';
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('T-G6: reset / replace が例外を投げても落ちない (端末のログに警告を残す)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockLegalState = 'required';
      mockReset.mockImplementationOnce(() => {
        throw new Error('reset failed');
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
    expect(mockReset).not.toHaveBeenCalled();
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
  it('前面が同意画面でもそうでなくても reset も replace も呼ばない', () => {
    mockAuth = { session: null };
    for (const state of ['loading', 'clear', 'required', 'unknown'] as const) {
      mockLegalState = state;
      setFront('legal-consent');
      render(<LegalConsentGate />).unmount();
      setFront('home');
      render(<LegalConsentGate />).unmount();
    }
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('reset で畳んだ後にログアウトし、前面が入口に変わってからログインし直して required になると、また reset を 1 回呼ぶ', () => {
    mockLegalState = 'required';
    setFront('home');
    const view = render(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    // 畳んだ同意画面が前面。ログアウト (state は clear に戻る)
    setFront('legal-consent');
    mockAuth = { session: null };
    mockLegalState = 'clear';
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();

    // 「閉じる」で入口へ。session 無しで前面が入口なので openedRef を外す
    setFront('index');
    mockPathname = '/';
    view.rerender(<LegalConsentGate />);

    // ログインし直して required
    mockAuth = SIGNED_IN;
    mockLegalState = 'required';
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(2);
  });
});

describe('LegalConsentGate — 畳み直し (T-G7 / T-G8)', () => {
  it('T-G7: required で前面が同意画面だがゲートが畳んでいない (deep link で開いた) なら reset を 1 回呼ぶ', () => {
    mockLegalState = 'required';
    setFront('legal-consent');
    mockPathname = '/legal-consent';

    render(<LegalConsentGate />);

    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledWith(CONSENT_RESET);
  });

  it('T-G7: ゲートが畳んだ後に、前面が対象の別の画面 (health/blood-tests) になったらもう 1 回呼び、対象外の画面 (auth/reset-password) なら呼ばない。対象外の画面から前面が同意画面に戻っても呼ばない', () => {
    mockLegalState = 'required';
    setFront('home');
    mockPathname = '/home';
    const view = render(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    // 畳んだ同意画面が前面
    setFront('legal-consent');
    mockPathname = '/legal-consent';
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    // 同意画面の上に対象の画面が積まれた
    setFront('health/blood-tests');
    mockPathname = '/health/blood-tests';
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(2);

    // 畳み直した
    setFront('legal-consent');
    mockPathname = '/legal-consent';
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(2);

    // 対象外の画面が積まれた: 畳まない
    setFront('auth/reset-password');
    mockPathname = '/auth/reset-password';
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(2);

    // 対象外の画面を閉じて同意画面に戻った: 畳み直さない (openedRef が保たれている)
    setFront('legal-consent');
    mockPathname = '/legal-consent';
    view.rerender(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(2);
  });

  it('T-G8: タブの区画が外れる形: required・pathname /settings・前面 (tabs) で reset を 1 回呼んだ後、前面を legal-consent にして pathname を /home に変えた描画でも reset を呼ばない (合計 1 回)', () => {
    mockLegalState = 'required';
    mockPathname = '/settings';
    setFront('(tabs)');
    const view = render(<LegalConsentGate />);
    expect(mockReset).toHaveBeenCalledTimes(1);

    setFront('legal-consent');
    mockPathname = '/home';
    view.rerender(<LegalConsentGate />);

    expect(mockReset).toHaveBeenCalledTimes(1);
  });
});

describe('LegalConsentGate — 凍結中は畳まない (#1861。凍結が先)', () => {
  it('required でも、凍結中 (frozen) なら reset も replace もしない。凍結が解けたら (clear) 同意画面へ畳む', () => {
    mockLegalState = 'required';
    mockFrozenState = 'frozen';
    mockPathname = '/frozen';
    setFront('frozen');
    const view = render(<LegalConsentGate />);

    expect(mockReset).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();

    mockFrozenState = 'clear';
    view.rerender(<LegalConsentGate />);

    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledWith(CONSENT_RESET);
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
