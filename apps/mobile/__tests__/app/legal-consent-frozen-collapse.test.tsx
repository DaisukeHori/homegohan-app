/**
 * legal-consent-frozen-collapse.test.tsx — 同意画面 (app/legal-consent.tsx) の止めと、凍結のゲート (src/components/AccountFrozenGate.tsx) の
 * 畳み直しを、実物の expo-router 58 (expo-router/testing-library の renderRouter) に通す (#1591・#1861)。
 *
 * 同意待ち (awaiting-consent) の同意画面は usePreventRemove で取り除く操作を全部止める。expo-router 58 は、action で取り除かれる route の
 * 1 つでも止めていれば、その action を RESET でも捨てる (build/global-state/useNavigationTreeReducer.js の routesWithRemovalPrevented)。
 * 凍結のゲートの RESET ([frozen]) は同意画面の route を取り除くので、凍結中も同意画面が止めたままだと、凍結の画面へ畳めず同意画面に残る。
 * 部品ごとのテスト (legal-consent-screen.test.tsx・account-frozen-gate.test.tsx) は expo-router を mock にするので、この止めの層を通らない。
 * ここでは本物の同意画面・本物の凍結のゲート・本物の expo-router をつなぎ、認証・同意・凍結・プロフィールの Provider と WebView だけを mock にする。
 */
import { Stack, router } from 'expo-router';
import { act, renderRouter, type RenderRouterResult } from 'expo-router/testing-library';
import React from 'react';
import { Text } from 'react-native';

const mockSignedIn = { session: { user: { id: 'user-1' } }, user: { id: 'user-1' }, isLoading: false };
jest.mock('../../src/providers/AuthProvider', () => ({ useAuth: () => mockSignedIn }));

jest.mock('../../src/providers/LegalConsentProvider', () => ({
  useLegalConsent: () => ({ state: 'required', status: null, refresh: () => Promise.resolve() }),
}));

/** プロフィールの読み直し (ゲートの effect の依存に入るので、描画ごとに同じ関数を返す) */
const mockRefreshProfile = jest.fn(() => Promise.resolve());
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({ refresh: mockRefreshProfile }),
}));

/** 凍結の状態。本物の Provider と同じく、変わると読む側 (同意画面と凍結のゲート) が同じ描画で描き直す */
let mockFrozenState: 'loading' | 'clear' | 'frozen' | 'unknown' = 'clear';
const mockFrozenListeners = new Set<() => void>();
const mockRefreshFrozen = jest.fn(() => Promise.resolve());
jest.mock('../../src/providers/AccountFrozenProvider', () => {
  const ReactActual: typeof import('react') = require('react');
  return {
    useAccountFrozen: () => ({
      state: ReactActual.useSyncExternalStore(
        (listener: () => void) => {
          mockFrozenListeners.add(listener);
          return () => {
            mockFrozenListeners.delete(listener);
          };
        },
        () => mockFrozenState,
      ),
      refresh: mockRefreshFrozen,
    }),
  };
});

jest.mock('../../src/lib/supabase', () => ({ supabase: { auth: { getSession: jest.fn() } } }));

// WebView はネイティブのモジュールを要るので、testID だけを持つ View にする
jest.mock('../../src/components/web/WebViewScreen', () => {
  const ReactActual: typeof import('react') = require('react');
  const { View } = require('react-native');
  return {
    WebViewScreen: (props: { testID?: string; header?: React.ReactNode }) =>
      ReactActual.createElement(View, { testID: props.testID }, props.header),
  };
});

import LegalConsentScreen from '../../app/legal-consent';
import { AccountFrozenGate } from '../../src/components/AccountFrozenGate';
import { FROZEN_SCREEN_ROUTE_NAME } from '../../src/lib/account-frozen';
import {
  LEGAL_CONSENT_SCREEN_PATH,
  LEGAL_CONSENT_SCREEN_ROUTE_NAME,
  findNavigatorOwningRoute,
} from '../../src/lib/legal-consent';

/** 凍結の画面の path (app/frozen.tsx) */
const FROZEN_SCREEN_PATH = `/${FROZEN_SCREEN_ROUTE_NAME}`;

function setFrozenState(next: typeof mockFrozenState) {
  mockFrozenState = next;
  for (const listener of mockFrozenListeners) listener();
}

/** ルートの layout (app/_layout.tsx と同じ並び: Stack の後ろに凍結のゲート) */
function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name={LEGAL_CONSENT_SCREEN_ROUTE_NAME} options={{ gestureEnabled: false }} />
        <Stack.Screen name={FROZEN_SCREEN_ROUTE_NAME} options={{ gestureEnabled: false }} />
      </Stack>
      <AccountFrozenGate />
    </>
  );
}

function EntryScreen() {
  return <Text testID="entry-screen">entry</Text>;
}

function FrozenScreen() {
  return <Text testID="frozen-screen">frozen</Text>;
}

/**
 * ルートの Stack (app/_layout.tsx の Stack。凍結の画面の route の持ち主) の routes の名前の並び。
 * renderRouter の state の一番上は expo-router の __root の route で、layout の Stack はその下にある
 */
function rootStackRouteNames(view: RenderRouterResult): string[] {
  const owner = findNavigatorOwningRoute(view.getRouterState(), FROZEN_SCREEN_ROUTE_NAME);
  if (owner === null) throw new Error('ルートの Stack の state が見つからない');
  return owner.routes.map((route) => route.name);
}

async function renderAtLegalConsent(): Promise<RenderRouterResult> {
  const view = await renderRouter(
    {
      _layout: RootLayout,
      index: EntryScreen,
      [LEGAL_CONSENT_SCREEN_ROUTE_NAME]: LegalConsentScreen,
      [FROZEN_SCREEN_ROUTE_NAME]: FrozenScreen,
    },
    { initialUrl: LEGAL_CONSENT_SCREEN_PATH },
  );
  expect(view.getPathname()).toBe(LEGAL_CONSENT_SCREEN_PATH);
  expect(view.getByTestId('webview-legal-consent')).toBeTruthy();
  expect(rootStackRouteNames(view)).toContain(LEGAL_CONSENT_SCREEN_ROUTE_NAME);
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFrozenState = 'clear';
  mockFrozenListeners.clear();
});

afterEach(() => {
  // renderRouter が fake timers にする
  jest.useRealTimers();
});

describe('同意画面の止めと凍結のゲート — 実物の expo-router 58 に通す', () => {
  it('同意待ちの同意画面は、取り除く操作 (入口への replace) を実物の止めの層で止める (この番兵が止めの層を通っていることの確かめ)', async () => {
    const view = await renderAtLegalConsent();

    await act(async () => {
      router.replace('/');
    });

    expect(view.getPathname()).toBe(LEGAL_CONSENT_SCREEN_PATH);
    expect(rootStackRouteNames(view)).toContain(LEGAL_CONSENT_SCREEN_ROUTE_NAME);
    expect(view.queryByTestId('entry-screen')).toBeNull();
  });

  it('同意待ちの同意画面が前面のまま凍結 (frozen) になると、凍結のゲートの RESET が通り、ルートの Stack が凍結の画面 1 つに畳まれる', async () => {
    const view = await renderAtLegalConsent();

    await act(async () => {
      setFrozenState('frozen');
    });

    expect(view.getPathname()).toBe(FROZEN_SCREEN_PATH);
    expect(rootStackRouteNames(view)).toEqual([FROZEN_SCREEN_ROUTE_NAME]);
    expect(view.getByTestId('frozen-screen')).toBeTruthy();
    expect(view.queryByTestId('webview-legal-consent')).toBeNull();
  });

  it.each(['loading', 'unknown'] as const)(
    '凍結の状態が %s の間は、同意画面は止めたまま (入口への replace は捨てられる) で、凍結のゲートも畳まない',
    async (frozenState) => {
      const view = await renderAtLegalConsent();

      await act(async () => {
        setFrozenState(frozenState);
      });
      await act(async () => {
        router.replace('/');
      });

      expect(view.getPathname()).toBe(LEGAL_CONSENT_SCREEN_PATH);
      expect(rootStackRouteNames(view)).toContain(LEGAL_CONSENT_SCREEN_ROUTE_NAME);
      expect(rootStackRouteNames(view)).not.toContain(FROZEN_SCREEN_ROUTE_NAME);
    },
  );
});
