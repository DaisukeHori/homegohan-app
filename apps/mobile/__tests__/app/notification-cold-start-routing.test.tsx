/**
 * notification-cold-start-routing.test.tsx
 * 通知のタップでアプリが起動した場合 (cold start) の遷移を、本物の expo-router・本物の app/_layout.tsx ・
 * app/index.tsx ・ app/onboarding と、本物の AuthProvider / ProfileProvider / NotificationRouter で確かめる (#1049 F7-11)
 *
 * NotificationRouter.coldStart.test.tsx は router.push が呼ばれることまでを確かめる。ここでは、その push が
 * 起動時の画面の振り分け (app/index.tsx の <Redirect>、app/onboarding/index.tsx の <Redirect>) に上書きされず、
 * 通知の行き先がスタックの一番上に残ることを確かめる。
 *
 * 起動の順は実機と同じにしてある。
 *   1. getLastNotificationResponseAsync (native 呼び出し) が先に返る → 行き先が保留される
 *   2. INITIAL_SESSION が届く → 一瞬、「ログイン済み・読み込み済みに見えるが profile=null」になる (app/index.tsx は
 *      この状態で /onboarding への <Redirect> を描画する)。NotificationRouter は待つ
 *   3. プロフィールが届く → 同じ commit で、NotificationRouter が行き先へ push し、app/index.tsx は /(tabs)/home への
 *      <Redirect> を描画する
 *
 * 3 で push が <Redirect> の replace に上書きされないのは、expo-router 5.1 の次の性質による (probe で確かめた)。
 *   - router.push / router.replace は、すぐには実行されずキュー (routingQueue) に積まれ、描画のあとの effect でまとめて実行される
 *   - <Redirect> は useFocusEffect の中で replace を呼ぶ。useFocusEffect は、ナビゲーションの読み込みが済んだ次の描画から
 *     動くので、新しく描画された <Redirect> の最初の effect では何もしない。次の描画の effect までに、キューの push が
 *     実行され、app/index.tsx の画面は focus を失っている (focus されていない画面の <Redirect> は replace を呼ばない)
 * 実機では確かめられない部分なので、expo-router を上げたときに壊れたら、このテストで気づけるようにしてある。
 * (このテストが落ちたら、通知で起動したとき、行き先ではなくホームが開く)
 * 行き先の画面から戻る操作をしたときは、通常の起動と同じホームに戻る (スタックの一番下の app/index.tsx が、
 * 戻ってきたときにホームへの <Redirect> を呼ぶ) ことも、あわせて確かめる。
 */

import path from 'path';
import React from 'react';
import { act, render } from '@testing-library/react-native';

// expo-router/testing-library は読み込めない (expect/build/matchers が無い) ので、必要な部品だけを使う
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('expo-router/build/testing-library/mocks');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ExpoRoot } = require('expo-router/build/ExpoRoot');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getMockContext } = require('expo-router/build/testing-library/mock-config');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { store } = require('expo-router/build/global-state/router-store');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { router } = require('expo-router/build/imperative-api');

// ── 通知 ───────────────────────────────────────────────────────────────────
const mockGetLast = jest.fn();
jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  getLastNotificationResponseAsync: () => mockGetLast(),
  clearLastNotificationResponseAsync: () => Promise.resolve(),
  addNotificationResponseReceivedListener: () => ({ remove: jest.fn() }),
}));

// ── supabase: 認証イベントとプロフィールの返りを、テストから好きな順に流す ─────────────
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type ProfileQueryResult = { data: Record<string, unknown> | null; error: { message: string } | null };

let mockAuthListener: ((event: string, session: unknown) => void) | null = null;
let mockGetSessionResult: Deferred<{ data: { session: unknown } }>;
let mockProfileQuery: Deferred<ProfileQueryResult>;

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSessionResult.promise,
      getUser: () => Promise.resolve({ data: { user: { id: 'u1' } }, error: null }),
      signOut: () => Promise.resolve({ error: null }),
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        mockAuthListener = cb;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => mockProfileQuery.promise,
        }),
      }),
    }),
  },
}));

// ── _layout.tsx が読み込む周辺 (画面の中身に関係しないもの) ──────────────────────
jest.mock('../../src/lib/pushNotifications', () => ({
  registerAndSaveExpoPushToken: jest.fn(),
  setupNotificationHandler: jest.fn(),
}));
jest.mock('../../src/providers/PostHogProvider', () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));
// 認証の購読を 1 つに保つ (supabase モックの onAuthStateChange は 1 つのコールバックしか覚えない)
jest.mock('../../src/components/web/WebViewSessionCleaner', () => ({ WebViewSessionCleaner: () => null }));
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

// ── 行き先の画面 (中身は要らない) ───────────────────────────────────────────────
jest.mock('../../app/(tabs)/home', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text>HOME</Text> };
});
jest.mock('../../app/(tabs)/menus', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text>MENUS</Text> };
});
jest.mock('../../app/pantry/index', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text>PANTRY</Text> };
});
jest.mock('../../app/onboarding/welcome', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text>ONBOARDING-WELCOME</Text> };
});

// 最初のテストでは、本物の画面モジュール (_layout・index・onboarding など) の読み込みと変換が走る。
// CI の --coverage (全ファイルの計装) や混み合った環境では、既定の 5 秒を超えることがあるので、余裕を持たせる
jest.setTimeout(60_000);

const APP_DIR = path.resolve(__dirname, '../../app');
const SESSION = { access_token: 'token', user: { id: 'u1' } };
const onboardedRow = { id: 'u1', roles: [], onboarding_completed_at: '2026-10-01T00:00:00Z', week_start_day: 'monday' };
const notOnboardedRow = { id: 'u1', roles: [], onboarding_completed_at: null, week_start_day: 'monday' };

function tap(deepLink: string) {
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: { request: { identifier: 'cold-start', content: { data: { deep_link: deepLink } } } },
  };
}

/** 本物の app/ ディレクトリで、アプリを起動する (expo-router/testing-library の renderRouter と同じ作り) */
function launchApp() {
  jest.useFakeTimers();
  process.env.EXPO_ROUTER_IMPORT_MODE = 'sync';
  return render(<ExpoRoot context={getMockContext({ appDir: APP_DIR, overrides: {} })} location="/" />);
}

const pathname = (): string => store.getRouteInfo().pathname;
const params = (): Record<string, unknown> => store.getRouteInfo().params;
/** ルートのスタックに積まれている画面の名前 (下から順) */
const rootStack = (): string[] => {
  const root = store.state?.routes?.[0]?.state;
  return (root?.routes ?? []).map((route: { name: string }) => route.name);
};

async function deliverInitialSession(session: unknown) {
  await act(async () => {
    mockAuthListener?.('INITIAL_SESSION', session);
    mockGetSessionResult.resolve({ data: { session } });
  });
}

async function resolveProfile(result: ProfileQueryResult) {
  await act(async () => {
    mockProfileQuery.resolve(result);
  });
  // ナビゲーションのキューと、その後の描画を流しきる
  await act(async () => {});
  await act(async () => {});
}

beforeEach(() => {
  mockAuthListener = null;
  mockGetSessionResult = deferred();
  mockProfileQuery = deferred();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('通知のタップで起動したときの遷移 (本物の expo-router)', () => {
  it('ネイティブ画面への行き先は、起動時の振り分け (Redirect) に上書きされず、スタックの一番上に残る', async () => {
    mockGetLast.mockResolvedValue(tap('homegohan://pantry'));
    launchApp();
    await act(async () => {});
    expect(pathname()).toBe('/');

    await deliverInitialSession(SESSION);
    // ログイン状態が届いただけでは (プロフィールが読めるまで) 遷移しない
    expect(pathname()).toBe('/');

    await resolveProfile({ data: onboardedRow, error: null });

    expect(pathname()).toBe('/pantry');
    expect(rootStack()).toEqual(['index', 'pantry/index']);

    // 戻る操作で、通常の起動と同じホームに戻る (一番下の index が、ホームへの <Redirect> を持つ)
    await act(async () => {
      router.back();
    });
    await act(async () => {});
    await act(async () => {});
    expect(pathname()).toBe('/home');
  });

  it('WebView のタブへの行き先は、ページ指定 (initialPath) つきで開く', async () => {
    mockGetLast.mockResolvedValue(tap('homegohan://menus/weekly?date=2026-10-08'));
    launchApp();
    await act(async () => {});

    await deliverInitialSession(SESSION);
    await resolveProfile({ data: onboardedRow, error: null });

    expect(pathname()).toBe('/menus');
    expect(params()).toMatchObject({ initialPath: '/menus/weekly?date=2026-10-08' });
    expect(rootStack()).toEqual(['index', '(tabs)']);

    // 戻る操作で、通常の起動と同じホームに戻る
    await act(async () => {
      router.back();
    });
    await act(async () => {});
    await act(async () => {});
    expect(pathname()).toBe('/home');
  });

  it('通知のタップが無い通常の起動では、ホームが開く', async () => {
    mockGetLast.mockResolvedValue(null);
    launchApp();
    await act(async () => {});

    await deliverInitialSession(SESSION);
    await resolveProfile({ data: onboardedRow, error: null });

    expect(pathname()).toBe('/home');
  });

  it('初期設定が終わっていないユーザーは、通知の行き先へ行かず、初期設定の画面になる', async () => {
    mockGetLast.mockResolvedValue(tap('homegohan://pantry'));
    launchApp();
    await act(async () => {});

    await deliverInitialSession(SESSION);
    await resolveProfile({ data: notOnboardedRow, error: null });

    expect(pathname()).toBe('/onboarding/welcome');
    expect(rootStack()).not.toContain('pantry/index');
  });

  it('未ログインで起動した場合は、通知の行き先へ行かず、最初の画面のまま', async () => {
    mockGetLast.mockResolvedValue(tap('homegohan://pantry'));
    launchApp();
    await act(async () => {});

    await deliverInitialSession(null);
    await act(async () => {});

    expect(pathname()).toBe('/');
    expect(rootStack()).toEqual(['index']);
  });
});
