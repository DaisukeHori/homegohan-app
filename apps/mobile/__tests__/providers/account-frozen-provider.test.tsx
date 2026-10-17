/**
 * account-frozen-provider.test.tsx — src/providers/AccountFrozenProvider.tsx (#1861)
 *
 * 凍結の状態 (loading / clear / frozen / unknown) を、起動時・利用者の替わりの判定の API (GET /api/legal/status) と、
 * ほかの API の 403 AUTH_ACCOUNT_FROZEN の知らせと、前面に戻ったときの確かめ直し (凍結が解けたら clear) から決めることを確かめる。
 */
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { AppState } from 'react-native';

import { accountFrozenBody } from '@homegohan/shared';

const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({ getApi: () => ({ get: (...args: unknown[]) => mockGet(...args) }) }));

type AuthState = { user: { id: string } | null };
let mockAuth: AuthState;
jest.mock('../../src/providers/AuthProvider', () => ({ useAuth: () => mockAuth }));

import {
  AccountFrozenError,
  FROZEN_PROBE_API_PATH,
  accountFrozenErrorOf,
  notifyAccountFrozen,
  resetAccountFrozenListenersForTests,
} from '../../src/lib/account-frozen';
import {
  AccountFrozenProvider,
  useAccountFrozen,
  type AccountFrozenState,
} from '../../src/providers/AccountFrozenProvider';

/** getApi が凍結の 403 で投げる例外 (withFriendlyErrors が置き換えた後の形) */
function frozenRejection(): Promise<never> {
  return Promise.reject(new AccountFrozenError());
}

let renders: AccountFrozenState[] = [];
let latest: ReturnType<typeof useAccountFrozen> | null = null;
function Probe() {
  const value = useAccountFrozen();
  renders.push(value.state);
  latest = value;
  return null;
}

function mount() {
  return render(
    <AccountFrozenProvider>
      <Probe />
    </AccountFrozenProvider>,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const appStateHandlers: Array<(next: string) => void> = [];

beforeEach(() => {
  jest.clearAllMocks();
  resetAccountFrozenListenersForTests();
  renders = [];
  latest = null;
  appStateHandlers.length = 0;
  mockAuth = { user: { id: 'user-1' } };
  mockGet.mockReset();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (next: string) => void) => {
    appStateHandlers.push(handler);
    return { remove: jest.fn() };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  jest.restoreAllMocks();
  resetAccountFrozenListenersForTests();
});

function goForeground() {
  act(() => {
    for (const handler of appStateHandlers) handler('active');
  });
}

describe('AccountFrozenProvider — 起動時・利用者の替わりの判定', () => {
  it('user が居れば判定の API (GET /api/legal/status) を呼び、2xx なら clear。最初の描画から loading (clear を挟まない)', async () => {
    mockGet.mockResolvedValue({ required: false });
    mount();
    expect(renders[0]).toBe('loading');
    await flush();

    expect(mockGet).toHaveBeenCalledWith(FROZEN_PROBE_API_PATH);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(latest?.state).toBe('clear');
    expect(renders.indexOf('clear')).toBeGreaterThan(renders.indexOf('loading'));
  });

  it('判定の API が 403 AUTH_ACCOUNT_FROZEN なら frozen (起動時のセッションの復元の直後でも、ホームより先に凍結と分かる)', async () => {
    mockGet.mockImplementation(frozenRejection);
    mount();
    await flush();

    expect(latest?.state).toBe('frozen');
    // 凍結の 403 で確かめ直しを繰り返さない (判定の API も凍結中は 403 のため)
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('生の HTTP の文の 403 AUTH_ACCOUNT_FROZEN (置き換え前) でも frozen', async () => {
    mockGet.mockRejectedValue(new Error(`HTTP 403 Forbidden: ${JSON.stringify(accountFrozenBody())}`));
    mount();
    await flush();

    expect(latest?.state).toBe('frozen');
  });

  it.each([
    ['通信の失敗', () => Promise.reject(new Error('通信できません。'))],
    ['500', () => Promise.reject(new Error('HTTP 500 Internal Server Error: {}'))],
    ['ほかの 403', () => Promise.reject(new Error('HTTP 403 Forbidden: {"error":"forbidden"}'))],
  ])('判定に失敗 (%s) したら unknown (止めない)', async (_label, make) => {
    mockGet.mockImplementation(make);
    mount();
    await flush();

    expect(latest?.state).toBe('unknown');
  });

  it('未ログインなら clear で、判定の API を呼ばない', async () => {
    mockAuth = { user: null };
    mount();
    await flush();

    expect(latest?.state).toBe('clear');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('利用者が替わったら、その描画から loading にして確かめ直す (前の利用者の frozen を使わない)', async () => {
    mockGet.mockImplementationOnce(frozenRejection);
    const view = mount();
    await flush();
    expect(latest?.state).toBe('frozen');

    mockAuth = { user: { id: 'user-2' } };
    mockGet.mockResolvedValueOnce({ required: false });
    renders = [];
    view.rerender(
      <AccountFrozenProvider>
        <Probe />
      </AccountFrozenProvider>,
    );
    expect(renders[0]).toBe('loading');
    await flush();

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(latest?.state).toBe('clear');
  });

  it('利用者が替わる前に出した判定の古い応答は捨てる', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    mockGet.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    const view = mount();

    mockAuth = { user: { id: 'user-2' } };
    mockGet.mockImplementationOnce(frozenRejection);
    view.rerender(
      <AccountFrozenProvider>
        <Probe />
      </AccountFrozenProvider>,
    );
    await flush();
    expect(latest?.state).toBe('frozen');

    await act(async () => {
      resolveFirst({ required: false });
      await Promise.resolve();
    });
    expect(latest?.state).toBe('frozen');
  });
});

describe('AccountFrozenProvider — ほかの API の 403 の知らせ', () => {
  it('clear の後に、ほかの API の 403 AUTH_ACCOUNT_FROZEN の知らせを受けたら即 frozen。確かめ直しの API は呼ばない', async () => {
    mockGet.mockResolvedValue({ required: false });
    mount();
    await flush();
    expect(latest?.state).toBe('clear');
    expect(mockGet).toHaveBeenCalledTimes(1);

    act(() => {
      accountFrozenErrorOf(new Error(`HTTP 403: ${JSON.stringify(accountFrozenBody())}`));
    });

    expect(latest?.state).toBe('frozen');
    await flush();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('知らせが何度届いても frozen のまま (二重に状態を変えない)', async () => {
    mockGet.mockResolvedValue({ required: false });
    mount();
    await flush();

    act(() => {
      notifyAccountFrozen();
      notifyAccountFrozen();
    });
    const frozenRenders = renders.filter((state) => state === 'frozen').length;
    act(() => {
      notifyAccountFrozen();
    });

    expect(latest?.state).toBe('frozen');
    expect(renders.filter((state) => state === 'frozen').length).toBe(frozenRenders);
  });

  it('未ログインの間の知らせは無視する', async () => {
    mockAuth = { user: null };
    mount();
    await flush();

    act(() => {
      notifyAccountFrozen();
    });

    expect(latest?.state).toBe('clear');
  });
});

describe('AccountFrozenProvider — 凍結が解けたら通常へ戻る', () => {
  it('frozen のまま前面に戻ったら確かめ直し、2xx (403 でなくなった) なら clear に戻る', async () => {
    mockGet.mockImplementationOnce(frozenRejection);
    mount();
    await flush();
    expect(latest?.state).toBe('frozen');

    mockGet.mockResolvedValueOnce({ required: false });
    goForeground();
    await flush();

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(latest?.state).toBe('clear');
  });

  it('前面に戻ったときの確かめ直しが、まだ 403 なら frozen のまま。通信の失敗でも frozen を保つ', async () => {
    mockGet.mockImplementationOnce(frozenRejection);
    mount();
    await flush();

    mockGet.mockImplementationOnce(frozenRejection);
    goForeground();
    await flush();
    expect(latest?.state).toBe('frozen');

    mockGet.mockRejectedValueOnce(new Error('通信できません。'));
    goForeground();
    await flush();
    expect(latest?.state).toBe('frozen');
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('clear の間は前面に戻っても確かめ直さない', async () => {
    mockGet.mockResolvedValue({ required: false });
    mount();
    await flush();

    goForeground();
    await flush();

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('refresh() でも確かめ直せる (2xx なら clear)', async () => {
    mockGet.mockImplementationOnce(frozenRejection);
    mount();
    await flush();

    mockGet.mockResolvedValueOnce({ required: false });
    await act(async () => {
      await latest?.refresh();
    });

    expect(latest?.state).toBe('clear');
  });
});

describe('useAccountFrozen', () => {
  it('Provider の外で使うと例外', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow('useAccountFrozen must be used within <AccountFrozenProvider>');
    spy.mockRestore();
  });
});
