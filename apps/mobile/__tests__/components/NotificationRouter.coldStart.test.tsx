/**
 * NotificationRouter.coldStart.test.tsx
 * 通知のタップでアプリが起動した場合 (cold start) の遷移を、本物の AuthProvider / ProfileProvider で確かめる (#1049 F7-11)
 *
 * NotificationRouter.test.tsx は useAuth / useProfile をモックしていて、「読み込み中」から「読み込み済み」へ
 * 直接切り替わる。本物の Provider には、その間に一瞬だけ次の状態がある。
 *   - ProfileProvider は、最初の読み込み (まだ user が null) で isLoading=false・profile=null にする
 *   - ログイン状態 (INITIAL_SESSION) が届くと、同じ描画で authLoading=false・session あり・profileLoading=false・profile=null になる
 *     (ProfileProvider が新しいユーザーの読み込みを始めるのは、その描画の effect。子の NotificationRouter の effect が先に走る)
 * この状態を「初期設定が終わっていない」と取り違えると、通知の行き先を捨ててしまい、cold start の遷移が黙って消える。
 * 起動の順は、getLastNotificationResponseAsync (native 呼び出し。数 ms) が、INITIAL_SESSION (AsyncStorage の読み込みや
 * token の更新が要る) より先に返るのが普通。
 */

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

// ── expo-notifications モック ─────────────────────────────────────────────────
type Response = {
  actionIdentifier: string;
  notification: { request: { identifier: string; content: { data?: Record<string, unknown> } } };
};

const mockGetLast = jest.fn();
const mockClearLast = jest.fn();

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  getLastNotificationResponseAsync: () => mockGetLast(),
  clearLastNotificationResponseAsync: () => mockClearLast(),
  addNotificationResponseReceivedListener: () => ({ remove: jest.fn() }),
}));

// ── expo-router モック (実物と同じく、安定した参照を返す) ──────────────────────
const mockPush = jest.fn();
const mockRouter = { push: (...args: unknown[]) => mockPush(...args) };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

// ── supabase モック: 認証イベントとプロフィールの返りを、テストから好きな順に流す ──────
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

import { NotificationRouter } from '../../src/components/NotificationRouter';
import { AuthProvider } from '../../src/providers/AuthProvider';
import { ProfileProvider } from '../../src/providers/ProfileProvider';

const SESSION = { access_token: 'token', user: { id: 'u1' } };

function tap(deepLink: string, id = 'cold-start'): Response {
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: { request: { identifier: id, content: { data: { deep_link: deepLink } } } },
  };
}

const onboardedRow = { id: 'u1', roles: [], onboarding_completed_at: '2026-10-01T00:00:00Z', week_start_day: 'monday' };
const notOnboardedRow = { id: 'u1', roles: [], onboarding_completed_at: null, week_start_day: 'monday' };

/** アプリを起動する (本物の Provider。NotificationRouter は実際の _layout.tsx と同じく ProfileProvider の中) */
async function launchApp() {
  const view = render(
    <AuthProvider>
      <ProfileProvider>
        <NotificationRouter />
      </ProfileProvider>
    </AuthProvider>,
  );
  // 起動直後: native 呼び出しの getLastNotificationResponseAsync が先に返る
  await act(async () => {});
  return view;
}

/** ログイン状態 (INITIAL_SESSION) が届く。getSession も同じタイミングで返る */
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
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthListener = null;
  mockGetSessionResult = deferred();
  mockProfileQuery = deferred();
  mockClearLast.mockResolvedValue(undefined);
  mockGetLast.mockResolvedValue(null);
});

describe('NotificationRouter — 本物の Provider での cold start', () => {
  it('getLast が INITIAL_SESSION より先に返っても、プロフィールが届いてから行き先へ遷移する', async () => {
    mockGetLast.mockResolvedValue(tap('homegohan://pantry'));
    await launchApp();
    expect(mockPush).not.toHaveBeenCalled();

    // ログイン状態が届いた直後 (authLoading=false・session あり・profileLoading=false・profile=null の一瞬)
    await deliverInitialSession(SESSION);
    await settle();
    expect(mockPush).not.toHaveBeenCalled();

    // プロフィールが届いた (初期設定は完了済み)
    await resolveProfile({ data: onboardedRow, error: null });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/pantry');
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockClearLast).toHaveBeenCalled();
  });

  it('WebView のタブへの行き先 (ページ指定つき) も、同じ順で失われない', async () => {
    mockGetLast.mockResolvedValue(tap('homegohan://menus/weekly?date=2026-10-08'));
    await launchApp();

    await deliverInitialSession(SESSION);
    await resolveProfile({ data: onboardedRow, error: null });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/(tabs)/menus',
        params: { initialPath: '/menus/weekly?date=2026-10-08' },
      });
    });
  });

  it('対照: getLast がプロフィールの読み込みのあとに返る場合も遷移する', async () => {
    const lastResponse = deferred<Response | null>();
    mockGetLast.mockReturnValue(lastResponse.promise);
    await launchApp();

    await deliverInitialSession(SESSION);
    await resolveProfile({ data: onboardedRow, error: null });
    await settle();
    expect(mockPush).not.toHaveBeenCalled();

    await act(async () => {
      lastResponse.resolve(tap('homegohan://pantry'));
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/pantry');
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('初期設定が終わっていないユーザーは、プロフィールが届いたあとでも遷移しない (初期設定の流れに任せる)', async () => {
    mockGetLast.mockResolvedValue(tap('homegohan://pantry'));
    await launchApp();

    await deliverInitialSession(SESSION);
    await resolveProfile({ data: notOnboardedRow, error: null });
    await settle();

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('未ログインで起動した場合は遷移しない', async () => {
    mockGetLast.mockResolvedValue(tap('homegohan://pantry'));
    await launchApp();

    await deliverInitialSession(null);
    await settle();

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('プロフィールの取得に失敗しても (初期設定の完了済みとして扱う)、行き先へ遷移する', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetLast.mockResolvedValue(tap('homegohan://pantry'));
    await launchApp();

    await deliverInitialSession(SESSION);
    await resolveProfile({ data: null, error: { message: 'network error' } });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/pantry');
    });
    consoleError.mockRestore();
  });
});
