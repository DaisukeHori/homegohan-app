/**
 * legal-consent-screen.test.tsx — apps/mobile/app/legal-consent.tsx (#1442 設計書 cross/13b §6.6.11。T-SC1〜T-SC3)
 *
 * 同意画面の route = Web の /legal-consent を WebViewScreen で開く画面。
 *   awaiting-consent   ゲートの畳み直し (RESET) のほかの取り除く操作を beforeRemove で止める
 *   signed-out-notice  ログアウトの後。Web の案内を残し、上に「閉じる」を出す。取り除く操作は全部止める
 *   free               何も止めない。未ログインのまま開かれたら自分で閉じる
 */
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => false);
type BeforeRemoveHandler = (event: { data: { action: { type: string } }; preventDefault: () => void }) => void;
const mockBeforeRemoveHandlers: BeforeRemoveHandler[] = [];
const mockUnsubscribeBeforeRemove = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockReplace(...args),
    back: (...args: unknown[]) => mockBack(...args),
    canGoBack: () => mockCanGoBack(),
  },
  useNavigation: () => ({
    addListener: (name: string, handler: BeforeRemoveHandler) => {
      if (name === 'beforeRemove') mockBeforeRemoveHandlers.push(handler);
      return mockUnsubscribeBeforeRemove;
    },
  }),
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

/** 取り除く操作を流し、止められたか (preventDefault が呼ばれたか) を返す。受け手が複数あれば 1 つでも止めたら止まる */
function removeAttempt(type: string): boolean {
  let prevented = false;
  const event = {
    data: { action: { type } },
    preventDefault: () => {
      prevented = true;
    },
  };
  for (const handler of mockBeforeRemoveHandlers) handler(event);
  return prevented;
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
  mockBeforeRemoveHandlers.length = 0;
  mockWebViewProps.length = 0;
  mockAuth = SIGNED_IN;
  mockLegalState = 'required';
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
  it('サインイン中で required の間は、beforeRemove の GO_BACK・POP・POP_TO_TOP・REPLACE・NAVIGATE を止め、RESET は止めない', () => {
    render(<LegalConsentScreen />);

    for (const type of ['GO_BACK', 'POP', 'POP_TO_TOP', 'REPLACE', 'NAVIGATE']) {
      expect(removeAttempt(type)).toBe(true);
    }
    expect(removeAttempt('RESET')).toBe(false);
  });

  it('「閉じる」(testID legal-consent-close) は出さず、router.replace も呼ばない', () => {
    const { queryByTestId } = render(<LegalConsentScreen />);

    expect(queryByTestId('legal-consent-close')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('clear になったら何も止めない', () => {
    const view = render(<LegalConsentScreen />);
    expect(removeAttempt('REPLACE')).toBe(true);

    mockLegalState = 'clear';
    view.rerender(<LegalConsentScreen />);

    for (const type of ['GO_BACK', 'POP', 'POP_TO_TOP', 'REPLACE', 'NAVIGATE', 'RESET']) {
      expect(removeAttempt(type)).toBe(false);
    }
    expect(view.queryByTestId('legal-consent-close')).toBeNull();
  });

  it('beforeRemove の受け手は外れるときに解除する', () => {
    const view = render(<LegalConsentScreen />);
    view.unmount();
    expect(mockUnsubscribeBeforeRemove).toHaveBeenCalled();
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

  it('その間の beforeRemove は RESET を含めて全部止め、押すと router.replace("/") を 1 回呼ぶ (router.canGoBack が false のとき)', () => {
    const view = render(<LegalConsentScreen />);
    mockAuth = SIGNED_OUT;
    mockLegalState = 'clear';
    view.rerender(<LegalConsentScreen />);

    for (const type of ['RESET', 'GO_BACK', 'POP', 'POP_TO_TOP', 'REPLACE', 'NAVIGATE']) {
      expect(removeAttempt(type)).toBe(true);
    }

    fireEvent.press(view.getByTestId('legal-consent-close'));

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockBack).not.toHaveBeenCalled();
    // 「閉じる」の後は止めない
    expect(removeAttempt('REPLACE')).toBe(false);
    expect(removeAttempt('RESET')).toBe(false);
  });

  it('router.canGoBack が true なら router.back を 1 回呼ぶ', () => {
    mockCanGoBack.mockReturnValue(true);
    const view = render(<LegalConsentScreen />);
    mockAuth = SIGNED_OUT;
    mockLegalState = 'clear';
    view.rerender(<LegalConsentScreen />);

    fireEvent.press(view.getByTestId('legal-consent-close'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('required を見ないまま session が無い (未ログインで開いた) ときは「閉じる」を出さず、何も止めず、auth の読み込みが済んでいれば router.replace("/") を 1 回呼ぶ', () => {
    mockAuth = SIGNED_OUT;
    mockLegalState = 'clear';
    const { queryByTestId } = render(<LegalConsentScreen />);

    expect(queryByTestId('legal-consent-close')).toBeNull();
    expect(removeAttempt('REPLACE')).toBe(false);
    expect(removeAttempt('GO_BACK')).toBe(false);
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

  it('afterSignOut: session が残っていれば router.replace("/") を呼ぶ (ネイティブのログアウトが通信の失敗で済まなかったとき)', async () => {
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
