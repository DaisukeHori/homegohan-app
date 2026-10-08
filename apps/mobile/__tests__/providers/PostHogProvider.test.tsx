/**
 * PostHogProvider.test.tsx
 * PostHog のユーザー識別 (identify) の追従を確かめるテスト (#1049 F7-23)
 *
 * 以前はアプリ起動時に 1 回だけ「今ログインしているユーザー」を取って identify していた。
 * そのため
 *   - 未ログインで起動し、あとからログインした利用者は identify されなかった
 *   - サインアウトして別のユーザーでログインし直しても identify されなかった
 *   - platform が 'ios' 固定で、Android の利用者も ios として計上された
 * 認証状態の変化 (SIGNED_IN / SIGNED_OUT) に追従して identify / reset する。
 */

import React from 'react';
import { Platform, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

// ── PostHog クライアントのモック ─────────────────────────────────────────────
const mockIdentify = jest.fn();
const mockReset = jest.fn();
const mockClient = {
  identify: (...args: unknown[]) => mockIdentify(...args),
  reset: (...args: unknown[]) => mockReset(...args),
};

const mockInitPostHogMobile = jest.fn();
const mockCaptureEvent = jest.fn();
let mockActiveClient: typeof mockClient | null = null;

jest.mock('../../src/lib/posthog', () => ({
  initPostHogMobile: () => mockInitPostHogMobile(),
  getPostHogClient: () => mockActiveClient,
  captureEvent: (...args: unknown[]) => mockCaptureEvent(...args),
}));

const mockSetAnalyticsAdapter = jest.fn();
jest.mock('@homegohan/handson-tour-shared', () => ({
  setAnalyticsAdapter: (...args: unknown[]) => mockSetAnalyticsAdapter(...args),
}));

// ── Supabase のモック (現在のセッションを 1 か所で持ち、getSession / getUser の両方がそれを返す) ──
type Session = { user: { id: string } } | null;
type AuthListener = (event: string, session: Session) => void;

let mockSession: Session = null;
let mockAuthListener: AuthListener | null = null;
const mockUnsubscribe = jest.fn();
const mockProfileFor = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: mockSession } }),
      getUser: () => Promise.resolve({ data: { user: mockSession?.user ?? null } }),
      onAuthStateChange: (listener: AuthListener) => {
        mockAuthListener = listener;
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
      },
    },
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => ({
          single: () => mockProfileFor(table, columns, column, value),
        }),
      }),
    }),
  },
}));

import { PostHogProvider } from '../../src/providers/PostHogProvider';

const PROFILE_U1 = { created_at: '2026-01-01T00:00:00Z', plan_key_cached: 'free' };
const PROFILE_U2 = { created_at: '2026-02-02T00:00:00Z', plan_key_cached: 'premium' };

/** モックの Promise が全部流れきるまで待つ (全て即時に解決する Promise なので 1 マクロタスクで足りる) */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderProvider() {
  const view = render(
    <PostHogProvider>
      <Text>child</Text>
    </PostHogProvider>,
  );
  await flush();
  return view;
}

/** Supabase の認証イベントが届いたことにする */
async function emitAuth(event: string, session: Session) {
  mockSession = session;
  await act(async () => {
    mockAuthListener?.(event, session);
  });
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSession = null;
  mockAuthListener = null;
  mockActiveClient = mockClient;
  mockInitPostHogMobile.mockImplementation(async () => mockClient);
  mockProfileFor.mockImplementation(async (_table: string, _columns: string, _column: string, userId: string) => ({
    data: userId === 'u2' ? PROFILE_U2 : PROFILE_U1,
    error: null,
  }));
});

describe('PostHogProvider — 起動時にログイン済みの場合', () => {
  it('ユーザーを identify する (非 PII の属性だけを送る)', async () => {
    mockSession = { user: { id: 'u1' } };

    await renderProvider();

    expect(mockIdentify).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenCalledWith('u1', {
      signup_at: '2026-01-01T00:00:00Z',
      platform: Platform.OS,
      plan_key_cached: 'free',
    });
    // 属性の取得も自分のプロフィールだけを対象にしている
    expect(mockProfileFor).toHaveBeenCalledWith('user_profiles', 'created_at, plan_key_cached', 'id', 'u1');
  });

  it('起動時の SIGNED_IN / INITIAL_SESSION が同じユーザーで重ねて届いても identify は 1 回', async () => {
    mockSession = { user: { id: 'u1' } };
    await renderProvider();

    await emitAuth('INITIAL_SESSION', { user: { id: 'u1' } });
    await emitAuth('SIGNED_IN', { user: { id: 'u1' } });
    await emitAuth('SIGNED_IN', { user: { id: 'u1' } });

    expect(mockIdentify).toHaveBeenCalledTimes(1);
  });

  it('トークンの更新やユーザー情報の更新では identify し直さない', async () => {
    mockSession = { user: { id: 'u1' } };
    await renderProvider();

    await emitAuth('TOKEN_REFRESHED', { user: { id: 'u1' } });
    await emitAuth('USER_UPDATED', { user: { id: 'u1' } });

    expect(mockIdentify).toHaveBeenCalledTimes(1);
    expect(mockReset).not.toHaveBeenCalled();
  });
});

describe('PostHogProvider — 認証状態の変化への追従', () => {
  it('未ログインで起動し、あとからログインしたユーザーも identify する', async () => {
    await renderProvider();
    expect(mockIdentify).not.toHaveBeenCalled();

    await emitAuth('SIGNED_IN', { user: { id: 'u2' } });

    expect(mockIdentify).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenCalledWith('u2', {
      signup_at: '2026-02-02T00:00:00Z',
      platform: Platform.OS,
      plan_key_cached: 'premium',
    });
  });

  it('サインアウトで reset し、別のユーザーでログインし直したらそのユーザーを identify する', async () => {
    mockSession = { user: { id: 'u1' } };
    await renderProvider();
    expect(mockIdentify).toHaveBeenLastCalledWith('u1', expect.anything());

    await emitAuth('SIGNED_OUT', null);
    expect(mockReset).toHaveBeenCalledTimes(1);

    await emitAuth('SIGNED_IN', { user: { id: 'u2' } });

    expect(mockIdentify).toHaveBeenCalledTimes(2);
    expect(mockIdentify).toHaveBeenLastCalledWith('u2', expect.objectContaining({ plan_key_cached: 'premium' }));
  });

  it('サインアウトのあと、同じユーザーでログインし直しても identify する', async () => {
    mockSession = { user: { id: 'u1' } };
    await renderProvider();

    await emitAuth('SIGNED_OUT', null);
    await emitAuth('SIGNED_IN', { user: { id: 'u1' } });

    expect(mockIdentify).toHaveBeenCalledTimes(2);
    expect(mockIdentify).toHaveBeenLastCalledWith('u1', expect.anything());
  });

  it('サインアウトを挟まずに別のユーザーへ切り替わったら、reset してから identify する', async () => {
    mockSession = { user: { id: 'u1' } };
    await renderProvider();

    await emitAuth('SIGNED_IN', { user: { id: 'u2' } });

    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenCalledTimes(2);
    expect(mockIdentify).toHaveBeenLastCalledWith('u2', expect.anything());
    // reset は 2 人目の identify より前
    expect(mockReset.mock.invocationCallOrder[0]).toBeLessThan(mockIdentify.mock.invocationCallOrder[1]);
  });

  it('PostHog の初期化が終わる前に届いたログインは、初期化のあとで identify する', async () => {
    let finishInit: (client: typeof mockClient) => void = () => {};
    mockInitPostHogMobile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInit = resolve;
        }),
    );
    await renderProvider();

    // 初期化中にログインした
    await emitAuth('SIGNED_IN', { user: { id: 'u1' } });
    expect(mockIdentify).not.toHaveBeenCalled();

    await act(async () => {
      finishInit(mockClient);
    });
    await flush();

    expect(mockIdentify).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenCalledWith('u1', expect.anything());
  });

  it('属性の取得中にサインアウトしたら、前のユーザーを identify しない', async () => {
    let finishProfile: (value: { data: typeof PROFILE_U1; error: null }) => void = () => {};
    mockProfileFor.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishProfile = resolve;
        }),
    );
    await renderProvider();

    await emitAuth('SIGNED_IN', { user: { id: 'u1' } });
    await emitAuth('SIGNED_OUT', null);
    expect(mockReset).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishProfile({ data: PROFILE_U1, error: null });
    });
    await flush();

    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it('属性の取得に失敗しても identify する (属性は null)', async () => {
    mockProfileFor.mockImplementation(async () => {
      throw new Error('network');
    });
    mockSession = { user: { id: 'u1' } };

    await renderProvider();

    expect(mockIdentify).toHaveBeenCalledWith('u1', {
      signup_at: null,
      platform: Platform.OS,
      plan_key_cached: null,
    });
  });

  it('identify が例外を投げても、アプリを落とさず次のログインも処理する', async () => {
    mockIdentify.mockImplementationOnce(() => {
      throw new Error('sdk error');
    });
    mockSession = { user: { id: 'u1' } };
    await renderProvider();

    await emitAuth('SIGNED_OUT', null);
    await emitAuth('SIGNED_IN', { user: { id: 'u2' } });

    expect(mockIdentify).toHaveBeenCalledTimes(2);
    expect(mockIdentify).toHaveBeenLastCalledWith('u2', expect.anything());
  });
});

describe('PostHogProvider — platform', () => {
  it('実行中の OS を platform として送る (iOS 固定にしない)', async () => {
    const replaced = jest.replaceProperty(Platform as unknown as { OS: string }, 'OS', 'android');
    try {
      mockSession = { user: { id: 'u1' } };

      await renderProvider();

      expect(mockIdentify).toHaveBeenCalledWith('u1', expect.objectContaining({ platform: 'android' }));
    } finally {
      replaced.restore();
    }
  });
});

describe('PostHogProvider — 初期化と後始末', () => {
  it('PostHog が無効 (キー未設定などで初期化できない) なら、何も識別せず、イベント送信の注入もしない', async () => {
    mockInitPostHogMobile.mockImplementation(async () => null);
    mockActiveClient = null;
    mockSession = { user: { id: 'u1' } };

    await renderProvider();
    await emitAuth('SIGNED_IN', { user: { id: 'u1' } });
    await emitAuth('SIGNED_OUT', null);

    expect(mockIdentify).not.toHaveBeenCalled();
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockSetAnalyticsAdapter).not.toHaveBeenCalled();
  });

  it('初期化できたら、イベント送信 (AnalyticsAdapter) を共通 package に注入する', async () => {
    await renderProvider();

    expect(mockSetAnalyticsAdapter).toHaveBeenCalledTimes(1);
    const adapter = mockSetAnalyticsAdapter.mock.calls[0][0] as {
      capture: (eventName: string, payload: Record<string, unknown>) => void;
    };
    adapter.capture('tour_started', { step: 1 });
    expect(mockCaptureEvent).toHaveBeenCalledWith('tour_started', { step: 1 });
  });

  it('子要素をそのまま描画する', async () => {
    const view = await renderProvider();

    expect(view.getByText('child')).toBeTruthy();
  });

  it('アンマウントすると認証イベントの購読を解除し、以降のログインでは identify しない', async () => {
    const view = await renderProvider();

    view.unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

    // 解除後に (取りこぼしで) イベントが届いても何もしない
    await emitAuth('SIGNED_IN', { user: { id: 'u1' } });
    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it('初期化の途中でアンマウントされたら、あとから注入も identify もしない', async () => {
    let finishInit: (client: typeof mockClient) => void = () => {};
    mockInitPostHogMobile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInit = resolve;
        }),
    );
    mockSession = { user: { id: 'u1' } };
    const view = await renderProvider();

    view.unmount();
    await act(async () => {
      finishInit(mockClient);
    });
    await flush();

    expect(mockSetAnalyticsAdapter).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
  });
});
