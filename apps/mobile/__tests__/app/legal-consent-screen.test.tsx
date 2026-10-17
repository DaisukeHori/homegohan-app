/**
 * legal-consent-screen.test.tsx — apps/mobile/app/legal-consent.tsx (#1442 設計書 cross/13b §6.6.11。T-SC1〜T-SC3)
 *
 * 同意画面の route = Web の /legal-consent を WebViewScreen で開く画面。
 *   awaiting-consent   取り除く操作を usePreventRemove で全部止める (同意のゲートの畳み直しは同意画面の route を key ごと再利用するので、取り除かれない)。
 *                      凍結中 (#1861) は止めない (凍結のゲートの畳み直しは同意画面の route を取り除く。実物の止めの層に通すのは legal-consent-frozen-collapse.test.tsx)
 *   signed-out-notice  ログアウトの後。Web の案内を残し、上に「閉じる」を出す。取り除く操作は全部止める
 *   free               何も止めない。未ログインのまま開かれたら自分で閉じる
 */
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => false);
/** usePreventRemove に渡された (prevent, callback) の記録。描画のたびに積む */
const mockPreventCalls: Array<{ prevent: boolean; callback: (...args: unknown[]) => unknown }> = [];
/** usePreventRemove が返す disablePrevention */
const mockDisablePrevention = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockReplace(...args),
    back: (...args: unknown[]) => mockBack(...args),
    canGoBack: () => mockCanGoBack(),
  },
  usePreventRemove: (prevent: boolean, callback: (...args: unknown[]) => unknown) => {
    mockPreventCalls.push({ prevent, callback });
    return mockDisablePrevention;
  },
}));

const mockGetSession = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

type AuthState = { session: { user: { id: string } } | null; isLoading: boolean };
let mockAuth: AuthState;
jest.mock('../../src/providers/AuthProvider', () => ({ useAuth: () => mockAuth }));

let mockLegalState: 'loading' | 'clear' | 'required' | 'unknown' = 'required';
jest.mock('../../src/providers/LegalConsentProvider', () => ({
  useLegalConsent: () => ({ state: mockLegalState, status: null, refresh: jest.fn() }),
}));

let mockFrozenState: 'loading' | 'clear' | 'frozen' | 'unknown' = 'clear';
jest.mock('../../src/providers/AccountFrozenProvider', () => ({
  useAccountFrozen: () => ({ state: mockFrozenState, refresh: jest.fn() }),
}));

// WebViewScreen は受けた props を記録し、header だけを描く
const mockWebViewProps: Array<Record<string, unknown>> = [];
jest.mock('../../src/components/web/WebViewScreen', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    WebViewScreen: (props: { testID?: string; header?: React.ReactNode } & Record<string, unknown>) => {
      mockWebViewProps.push(props);
      return ReactActual.createElement(View, { testID: props.testID }, props.header);
    },
  };
});

import LegalConsentScreen from '../../app/legal-consent';

const SIGNED_IN: AuthState = { session: { user: { id: 'user-1' } }, isLoading: false };
const SIGNED_OUT: AuthState = { session: null, isLoading: false };

/** 直近の描画で usePreventRemove の第 1 引数に渡された値 (true = 取り除く操作を全部止める) */
function preventsRemoval(): boolean | undefined {
  return mockPreventCalls[mockPreventCalls.length - 1]?.prevent;
}

function latestProps(): Record<string, unknown> {
  return mockWebViewProps[mockWebViewProps.length - 1] ?? {};
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPreventCalls.length = 0;
  mockWebViewProps.length = 0;
  mockAuth = SIGNED_IN;
  mockLegalState = 'required';
  mockFrozenState = 'clear';
  mockCanGoBack.mockReturnValue(false);
  mockGetSession.mockResolvedValue({ data: { session: null } });
});

describe('同意画面の route — 描くもの (T-SC1)', () => {
  it("WebViewScreen を path='/legal-consent'・testID='webview-legal-consent' で描く", () => {
    const { getByTestId } = render(<LegalConsentScreen />);

    expect(getByTestId('webview-legal-consent')).toBeTruthy();
    expect(latestProps().path).toBe('/legal-consent');
    expect(latestProps().testID).toBe('webview-legal-consent');
    expect(typeof latestProps().afterSignOut).toBe('function');
  });
});

describe('同意画面の route — 同意を待つ間 (T-SC2)', () => {
  it('サインイン中で required の間は、usePreventRemove に true を渡す (取り除く操作を全部止める)。止めた操作は捨てる (callback は何もしない)', () => {
    render(<LegalConsentScreen />);

    expect(preventsRemoval()).toBe(true);
    const last = mockPreventCalls[mockPreventCalls.length - 1];
    expect(last?.callback()).toBeUndefined();
  });

  it('「閉じる」(testID legal-consent-close) は出さず、router.replace も呼ばない', () => {
    const { queryByTestId } = render(<LegalConsentScreen />);

    expect(queryByTestId('legal-consent-close')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('clear になったら usePreventRemove に false を渡す (何も止めない)', () => {
    const view = render(<LegalConsentScreen />);
    expect(preventsRemoval()).toBe(true);

    mockLegalState = 'clear';
    view.rerender(<LegalConsentScreen />);

    expect(preventsRemoval()).toBe(false);
    expect(view.queryByTestId('legal-consent-close')).toBeNull();
  });

  it('サインイン中で required でも、凍結中 (frozen) は usePreventRemove に false を渡す (凍結のゲートの RESET を止めない。#1861)。自分では閉じない', () => {
    mockFrozenState = 'frozen';
    const view = render(<LegalConsentScreen />);

    expect(preventsRemoval()).toBe(false);
    // 凍結の画面へ移すのは凍結のゲート。同意画面は自分で閉じない (止めを解く操作も遷移も積まない)
    expect(mockDisablePrevention).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    expect(view.queryByTestId('legal-consent-close')).toBeNull();
  });

  it.each(['loading', 'clear', 'unknown'] as const)(
    '凍結の状態が %s なら、required の間は usePreventRemove に true を渡す (止めを解くのは frozen だけ)',
    (frozenState) => {
      mockFrozenState = frozenState;
      render(<LegalConsentScreen />);

      expect(preventsRemoval()).toBe(true);
    },
  );

  it('凍結中に false を渡した後、凍結が解ける (clear) と、required の間はまた true を渡す', () => {
    mockFrozenState = 'frozen';
    const view = render(<LegalConsentScreen />);
    expect(preventsRemoval()).toBe(false);

    mockFrozenState = 'clear';
    view.rerender(<LegalConsentScreen />);

    expect(preventsRemoval()).toBe(true);
  });

  it('描画の間に disablePrevention を呼ばない (押下・自分で閉じるときだけ)', () => {
    const view = render(<LegalConsentScreen />);
    view.rerender(<LegalConsentScreen />);
    expect(mockDisablePrevention).not.toHaveBeenCalled();
  });
});

describe('同意画面の route — ログアウトの後の案内 (T-SC3)', () => {
  it('required を見た後に session が無くなると header に「閉じる」(testID legal-consent-close) を出す', () => {
    const view = render(<LegalConsentScreen />);
    expect(view.queryByTestId('legal-consent-close')).toBeNull();

    mockAuth = SIGNED_OUT;
    mockLegalState = 'clear';
    view.rerender(<LegalConsentScreen />);

    expect(view.getByTestId('legal-consent-close')).toBeTruthy();
    expect(view.getByText('閉じる')).toBeTruthy();
  });

  it('その間は usePreventRemove に true を渡し、押すと disablePrevention を呼んでから router.replace("/") を 1 回呼ぶ (router.canGoBack が false のとき)', () => {
    const view = render(<LegalConsentScreen />);
    mockAuth = SIGNED_OUT;
    mockLegalState = 'clear';
    view.rerender(<LegalConsentScreen />);
    expect(preventsRemoval()).toBe(true);

    fireEvent.press(view.getByTestId('legal-consent-close'));

    expect(mockDisablePrevention).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockBack).not.toHaveBeenCalled();
    // 止めを解いてから遷移を積む (積む遷移が止められない)
    expect(mockDisablePrevention.mock.invocationCallOrder[0]).toBeLessThan(mockReplace.mock.invocationCallOrder[0] ?? 0);
    // 「閉じる」の後は止めない (次の描画の引数が false)
    expect(preventsRemoval()).toBe(false);
  });

  it('router.canGoBack が true なら disablePrevention を呼んでから router.back を 1 回呼ぶ', () => {
    mockCanGoBack.mockReturnValue(true);
    const view = render(<LegalConsentScreen />);
    mockAuth = SIGNED_OUT;
    mockLegalState = 'clear';
    view.rerender(<LegalConsentScreen />);

    fireEvent.press(view.getByTestId('legal-consent-close'));

    expect(mockDisablePrevention).toHaveBeenCalledTimes(1);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockDisablePrevention.mock.invocationCallOrder[0]).toBeLessThan(mockBack.mock.invocationCallOrder[0] ?? 0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('required を見ないまま session が無い (未ログインで開いた) ときは「閉じる」を出さず、何も止めず、auth の読み込みが済んでいれば router.replace("/") を 1 回呼ぶ', () => {
    mockAuth = SIGNED_OUT;
    mockLegalState = 'clear';
    const { queryByTestId } = render(<LegalConsentScreen />);

    expect(queryByTestId('legal-consent-close')).toBeNull();
    // 扱いは free なので何も止めない (自分で閉じる途中の描画も false)
    expect(preventsRemoval()).toBe(false);
    expect(mockDisablePrevention).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('未ログインで開いて canGoBack が true なら router.back を 1 回呼ぶ。auth の読み込み中は呼ばない', () => {
    mockCanGoBack.mockReturnValue(true);
    mockAuth = { session: null, isLoading: true };
    mockLegalState = 'clear';
    const view = render(<LegalConsentScreen />);
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();

    mockAuth = SIGNED_OUT;
    view.rerender(<LegalConsentScreen />);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('afterSignOut: getSession が null なら移らない (ウェルカムへの replace をしない)', async () => {
    render(<LegalConsentScreen />);
    const afterSignOut = latestProps().afterSignOut as () => void;

    mockGetSession.mockResolvedValue({ data: { session: null } });
    afterSignOut();
    await flush();

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('afterSignOut: session が残っていれば router.replace("/") を呼ぶ (サインアウトの途中の例外などで、端末にセッションが残ったとき)', async () => {
    render(<LegalConsentScreen />);
    const afterSignOut = latestProps().afterSignOut as () => void;

    mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });
    afterSignOut();
    await flush();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('afterSignOut: getSession が失敗したときも入口へ移す', async () => {
    render(<LegalConsentScreen />);
    const afterSignOut = latestProps().afterSignOut as () => void;

    mockGetSession.mockRejectedValue(new Error('storage failed'));
    afterSignOut();
    await flush();

    expect(mockReplace).toHaveBeenCalledWith('/');
  });
});
