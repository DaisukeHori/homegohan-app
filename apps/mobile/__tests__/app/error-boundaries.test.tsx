/**
 * error-boundaries.test.tsx
 * apps/mobile/app 配下の _layout.tsx が expo-router の ErrorBoundary を持つことのテスト (#1207)
 *
 * 従来の問題:
 *   apps/mobile/app の 10 本の _layout.tsx に ErrorBoundary のエクスポートが 1 つも無く、画面の描画中に
 *   例外が起きると誰にも受けられず、アプリ全体がクラッシュ (白い画面) していた。
 *   expo-router は、ルートのファイル (_layout.tsx を含む) が `export function ErrorBoundary` を持つ場合だけ、
 *   その中で起きた描画の例外を受ける (持たない場合の既定の受け皿は無い)。
 *
 * 修正後:
 *   ルートと各グループの _layout.tsx が ErrorFallback を返す ErrorBoundary をエクスポートする。
 *   再試行を出し、例外の文面は出さず、記録する。
 *
 * ここでは次を確かめる。
 *   1. app 配下のすべての _layout.tsx が ErrorBoundary をエクスポートしている (新しい layout を足したときの取りこぼし防止)
 *   2. 各 layout の ErrorBoundary が、再試行と (グループ専用の) ホームへ戻る手段を出す
 *   3. expo-router 本物の Try (ErrorBoundary を呼び出す側) と組み合わせて、再試行で画面が復帰する
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

// ── expo-router モック (layout を読み込むのに必要な最小限。Try は deep import で本物を使う) ──
const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  const { View } = require('react-native');
  function Tabs() {
    return React.createElement(View, { testID: 'tabs' });
  }
  Tabs.Screen = function TabsScreen() {
    return null;
  };
  function Stack() {
    return React.createElement(View, { testID: 'stack' });
  }
  Stack.Screen = function StackScreen() {
    return null;
  };
  return {
    Stack,
    Tabs,
    Redirect: () => null,
    router: { replace: (...args: unknown[]) => mockReplace(...args), push: jest.fn() },
    useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
    useSegments: () => [],
    useLocalSearchParams: () => ({}),
  };
});

// ── 記録のモック (記録そのものは lib/error-report.test.ts で確かめる) ────────────
const mockReport = jest.fn();
jest.mock('../../src/lib/error-report', () => ({
  reportBoundaryError: (...args: unknown[]) => mockReport(...args),
}));

// ── layout が import する周辺モジュールのモック ─────────────────────────────
jest.mock('../../src/providers/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ session: null, user: null, isLoading: false }),
}));
jest.mock('../../src/providers/ProfileProvider', () => ({
  ProfileProvider: ({ children }: { children: React.ReactNode }) => children,
  useProfile: () => ({ isLoading: false, profile: null, roles: [], hasRole: () => false }),
}));
jest.mock('../../src/providers/PostHogProvider', () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));
// _layout.tsx は読み込み時に setupNotificationHandler() を呼ぶ (#1049 F7-11)
jest.mock('../../src/lib/pushNotifications', () => ({
  registerAndSaveExpoPushToken: jest.fn(),
  setupNotificationHandler: jest.fn(),
}));
jest.mock('../../src/lib/api', () => ({ getApi: () => ({ get: jest.fn(), post: jest.fn() }) }));
jest.mock('../../src/contexts/TourContext', () => ({
  TourProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../src/components/ai/AIFloatingFab', () => ({ AIFloatingFab: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@expo-google-fonts/noto-sans-jp', () => ({
  NotoSansJP_400Regular: 1,
  NotoSansJP_500Medium: 2,
  NotoSansJP_700Bold: 3,
  useFonts: () => [true],
}));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(),
  hideAsync: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// expo-router の Try が画面を隠すために呼ぶスプラッシュ制御 (ネイティブモジュールは Jest に無い)
jest.mock('expo-router/build/utils/splash', () => ({ hideAsync: jest.fn() }));

const APP_DIR = path.resolve(__dirname, '../../app');

interface LayoutSpec {
  /** apps/mobile/app からの相対パス */
  file: string;
  boundary: string;
  /** グループ専用の「戻る」手段。ルートの境界には無い */
  home?: { href: string; label: string };
}

// 移動先は、その境界がある区画の「外」でなければならない (区画の中への移動は、その区画のナビゲーターが
// 壊れている間は効かないため)。(tabs) の「ホーム」は区画の中なので、入口の "/" (→ ホーム) へ移る。
const HOME = { href: '/(tabs)/home', label: 'ホームへ戻る' };
const ENTRY_AS_HOME = { href: '/', label: 'ホームへ戻る' };
const FIRST = { href: '/', label: '最初の画面へ戻る' };

const LAYOUTS: LayoutSpec[] = [
  { file: '_layout.tsx', boundary: 'root' },
  { file: '(auth)/_layout.tsx', boundary: 'auth', home: FIRST },
  { file: '(org)/_layout.tsx', boundary: 'org', home: HOME },
  { file: '(public)/_layout.tsx', boundary: 'public', home: FIRST },
  { file: '(super-admin)/_layout.tsx', boundary: 'super-admin', home: HOME },
  { file: '(support)/_layout.tsx', boundary: 'support', home: HOME },
  { file: '(tabs)/_layout.tsx', boundary: 'tabs', home: ENTRY_AS_HOME },
  { file: 'handson-tour/_layout.tsx', boundary: 'handson-tour', home: HOME },
  { file: 'onboarding/_layout.tsx', boundary: 'onboarding', home: FIRST },
];

const SECRET_MESSAGE = 'relation "user_profiles" does not exist; password=hunter2';

function makeError() {
  const error = new Error(SECRET_MESSAGE);
  error.name = 'TypeError';
  return error;
}

function findLayouts(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findLayouts(full, found);
    else if (entry.name === '_layout.tsx') found.push(path.relative(APP_DIR, full).split(path.sep).join('/'));
  }
  return found;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('app 配下の _layout.tsx の配置', () => {
  it('このテストの対象に、すべての _layout.tsx が入っている', () => {
    expect(findLayouts(APP_DIR).sort()).toEqual(LAYOUTS.map((l) => l.file).sort());
  });

  it.each(LAYOUTS)('$file は `export function ErrorBoundary` を持ち、ErrorFallback を使う', ({ file }) => {
    const source = fs.readFileSync(path.join(APP_DIR, file), 'utf8');

    // expo-router は、この名前の export がある layout の中の例外だけを受ける
    expect(source).toMatch(/export function ErrorBoundary\(/);
    expect(source).toMatch(/<ErrorFallback\b/);
  });
});

describe.each(LAYOUTS)('$file の ErrorBoundary', ({ file, boundary, home }) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loadLayout = () => require(path.join(APP_DIR, file));

  it('エクスポートされていて、再試行を出し、押すと retry を呼ぶ', () => {
    const { ErrorBoundary } = loadLayout();
    expect(typeof ErrorBoundary).toBe('function');
    const retry = jest.fn().mockResolvedValue(undefined);

    const { getByTestId, getByText } = render(<ErrorBoundary error={makeError()} retry={retry} />);

    expect(getByText('エラーが発生しました')).toBeTruthy();
    fireEvent.press(getByTestId('error-fallback-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('例外の文面は画面に出さない', () => {
    const { ErrorBoundary } = loadLayout();

    const { toJSON } = render(<ErrorBoundary error={makeError()} retry={jest.fn()} />);

    const rendered = JSON.stringify(toJSON());
    expect(rendered).not.toContain('user_profiles');
    expect(rendered).not.toContain('hunter2');
  });

  it(`境界名 (${boundary}) つきで記録する`, () => {
    const { ErrorBoundary } = loadLayout();
    const error = makeError();

    render(<ErrorBoundary error={error} retry={jest.fn()} />);

    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(boundary, error);
  });

  if (home) {
    it(`「${home.label}」を出し、押すと区画の外 (${home.href}) へ移動する`, () => {
      const { ErrorBoundary } = loadLayout();
      const retry = jest.fn().mockResolvedValue(undefined);

      const { getByTestId, getByText } = render(<ErrorBoundary error={makeError()} retry={retry} />);

      expect(getByText(home.label)).toBeTruthy();
      fireEvent.press(getByTestId('error-fallback-home'));
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith(home.href);
      // 移動すれば境界ごと外れる。作り直すと同じ画面がまた例外を投げて重複して記録される
      expect(retry).not.toHaveBeenCalled();
    });

    it('移動先は、その境界がある区画の外にある', () => {
      // (group) の区画の中を指す移動先 (例: (tabs) の境界から /(tabs)/home) は、その区画のナビゲーターが
      // 壊れている間は効かない
      const group = file.match(/^\(([^)]+)\)\//)?.[1];
      if (group) {
        expect(home.href).not.toContain(`(${group})`);
      }
      const dir = file.match(/^([^/(][^/]*)\//)?.[1];
      if (dir) {
        expect(home.href).not.toMatch(new RegExp(`^/${dir}(/|$)`));
      }
    });
  } else {
    it('ルートの境界はナビゲーションが残っていないので、再試行だけを出す', () => {
      const { ErrorBoundary } = loadLayout();

      const { queryByTestId } = render(<ErrorBoundary error={makeError()} retry={jest.fn()} />);

      expect(queryByTestId('error-fallback-home')).toBeNull();
    });
  }
});

describe('expo-router 本物の Try と組み合わせた動き', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Try } = require('expo-router/build/views/Try');

  /** shouldThrow が true の間は描画で例外を投げる画面 */
  function makeScreen(state: { shouldThrow: boolean }) {
    return function Screen() {
      if (state.shouldThrow) throw new Error(SECRET_MESSAGE);
      return <Text>画面は正常です</Text>;
    };
  }

  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    // React が捕まえた例外を console.error に出すのを抑える
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it.each(LAYOUTS)('$file: 画面が例外を投げるとエラー画面になり、再試行で画面が復帰する', async ({ file }) => {
    const { ErrorBoundary } = jest.requireActual(path.join(APP_DIR, file));
    const state = { shouldThrow: true };
    const Screen = makeScreen(state);

    const { getByText, getByTestId, queryByText } = render(
      <Try catch={ErrorBoundary}>
        <Screen />
      </Try>,
    );

    // 例外はエラー画面で受けられ、アプリ全体は落ちない。例外の文面は出ない
    expect(getByText('エラーが発生しました')).toBeTruthy();
    expect(queryByText(/hunter2/)).toBeNull();
    expect(mockReport).toHaveBeenCalledTimes(1);

    // 原因が解消してから「再試行」を押すと、元の画面が描画される
    state.shouldThrow = false;
    await act(async () => {
      fireEvent.press(getByTestId('error-fallback-retry'));
    });

    expect(getByText('画面は正常です')).toBeTruthy();
    expect(queryByText('エラーが発生しました')).toBeNull();
  });

  it('原因が解消していなければ、再試行してもエラー画面に戻る (クラッシュしない)', async () => {
    const { ErrorBoundary } = jest.requireActual(path.join(APP_DIR, '(tabs)/_layout.tsx'));
    const Screen = makeScreen({ shouldThrow: true });

    const { getByText, getByTestId } = render(
      <Try catch={ErrorBoundary}>
        <Screen />
      </Try>,
    );
    await act(async () => {
      fireEvent.press(getByTestId('error-fallback-retry'));
    });

    expect(getByText('エラーが発生しました')).toBeTruthy();
    // 再試行のたびに記録される
    expect(mockReport).toHaveBeenCalledTimes(2);
  });
});
