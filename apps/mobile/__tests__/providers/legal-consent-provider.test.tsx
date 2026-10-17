/**
 * legal-consent-provider.test.tsx — src/providers/LegalConsentProvider.tsx (#1442 設計書 cross/13b §6.6.9。T-P1〜T-P8)
 *
 * 同意の状態 (loading / clear / required / unknown) を、GET /api/legal/status と
 * 合図 (403 → required / Web の同意画面 → accepted) と利用者の替わりから決めることを確かめる。
 */
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { AppState } from 'react-native';

import {
  LEGAL_CONSENT_STATUS_API_PATH,
  resolveLegalConsentStatus,
  type LegalConsentStatus,
} from '@homegohan/shared';

const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({ getApi: () => ({ get: (...args: unknown[]) => mockGet(...args) }) }));

type AuthState = { user: { id: string } | null };
let mockAuth: AuthState;
jest.mock('../../src/providers/AuthProvider', () => ({ useAuth: () => mockAuth }));

import {
  notifyLegalConsentAccepted,
  notifyLegalConsentRequired,
  resetLegalConsentListenersForTests,
} from '../../src/lib/legal-consent';
import {
  LegalConsentProvider,
  useLegalConsent,
  type LegalConsentState,
} from '../../src/providers/LegalConsentProvider';

/**
 * isLegalConsentStatus を通る本物の status (packages/shared の resolveLegalConsentStatus が作る)。
 * required: true = 強制中で未同意 / required: false = 強制していない (accepted でなくても required にならない)
 */
function statusOf(required: boolean): LegalConsentStatus {
  return resolveLegalConsentStatus({ accepted: null, enforced: required, today: '2026-10-17' });
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 描画ごとの state を記録する子 */
let renders: LegalConsentState[] = [];
let latest: ReturnType<typeof useLegalConsent> | null = null;
function Probe() {
  const value = useLegalConsent();
  renders.push(value.state);
  latest = value;
  return null;
}

function mount() {
  return render(
    <LegalConsentProvider>
      <Probe />
    </LegalConsentProvider>,
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
  resetLegalConsentListenersForTests();
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
  resetLegalConsentListenersForTests();
});

describe('LegalConsentProvider — status の取得 (T-P1 / T-P2)', () => {
  it('T-P1: user が居れば GET /api/legal/status を取り、required に応じて required になる (status も持つ)', async () => {
    mockGet.mockResolvedValue(statusOf(true));
    mount();
    expect(latest?.state).toBe('loading');
    await flush();

    expect(mockGet).toHaveBeenCalledWith(LEGAL_CONSENT_STATUS_API_PATH);
    expect(latest?.state).toBe('required');
    expect(latest?.status).toEqual(statusOf(true));
    expect(latest?.status?.required).toBe(true);
  });

  it('T-P1: required: false なら clear になる', async () => {
    mockGet.mockResolvedValue(statusOf(false));
    mount();
    await flush();

    expect(latest?.state).toBe('clear');
    expect(latest?.status).toEqual(statusOf(false));
  });

  it.each([
    ['通信の失敗', () => Promise.reject(new Error('通信できません。'))],
    ['500', () => Promise.reject(new Error('HTTP 500 Internal Server Error: {}'))],
    ['形の違い', () => Promise.resolve({ foo: 'bar' })],
  ])('T-P2: status の取得に失敗 (%s) したら unknown (止めない)', async (_label, make) => {
    mockGet.mockImplementation(make);
    mount();
    await flush();

    expect(latest?.state).toBe('unknown');
    expect(latest?.status).toBeNull();
  });

  it('T-P2: clear / required のときの取り直しの失敗は前の状態を保つ', async () => {
    mockGet.mockResolvedValueOnce(statusOf(true));
    mount();
    await flush();
    expect(latest?.state).toBe('required');

    mockGet.mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      await latest?.refresh();
    });
    expect(latest?.state).toBe('required');

    mockGet.mockResolvedValueOnce(statusOf(false));
    await act(async () => {
      await latest?.refresh();
    });
    expect(latest?.state).toBe('clear');

    mockGet.mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      await latest?.refresh();
    });
    expect(latest?.state).toBe('clear');
  });
});

describe('LegalConsentProvider — 合図 (T-P3 / T-P4 / T-P8)', () => {
  it('T-P3: required の合図を受けたら即 required にし、status を取り直す。取り直しに失敗しても required を保つ', async () => {
    mockGet.mockResolvedValueOnce(statusOf(false));
    mount();
    await flush();
    expect(latest?.state).toBe('clear');
    expect(mockGet).toHaveBeenCalledTimes(1);

    mockGet.mockRejectedValueOnce(new Error('network'));
    act(() => {
      notifyLegalConsentRequired();
    });
    expect(latest?.state).toBe('required');
    await flush();

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(latest?.state).toBe('required');
  });

  it('T-P4: accepted の合図を受けたら即 clear にし、status を取り直す', async () => {
    mockGet.mockResolvedValueOnce(statusOf(true));
    mount();
    await flush();
    expect(latest?.state).toBe('required');

    mockGet.mockResolvedValueOnce(statusOf(false));
    act(() => {
      notifyLegalConsentAccepted();
    });
    expect(latest?.state).toBe('clear');
    await flush();

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(latest?.state).toBe('clear');
  });

  it('T-P4: 取り直しが required: true なら required に戻る', async () => {
    mockGet.mockResolvedValueOnce(statusOf(true));
    mount();
    await flush();

    mockGet.mockResolvedValueOnce(statusOf(true));
    act(() => {
      notifyLegalConsentAccepted();
    });
    expect(latest?.state).toBe('clear');
    await flush();

    expect(latest?.state).toBe('required');
  });

  it('T-P8: loading の間に required の合図を受けたら即 required にし、保留していた最初の応答 (required: false) が後から返っても捨てる', async () => {
    const first = deferred<unknown>();
    mockGet.mockReturnValueOnce(first.promise);
    mockGet.mockResolvedValueOnce(statusOf(true));
    mount();
    expect(latest?.state).toBe('loading');

    act(() => {
      notifyLegalConsentRequired();
    });
    expect(latest?.state).toBe('required');

    await act(async () => {
      first.resolve(statusOf(false));
      await Promise.resolve();
    });
    await flush();
    expect(latest?.state).toBe('required');
  });

  it('T-P8: loading の間に accepted の合図を受けたら即 clear にし、最初の応答は捨てる (取り直しの応答で決まる)', async () => {
    const first = deferred<unknown>();
    mockGet.mockReturnValueOnce(first.promise);
    mockGet.mockResolvedValueOnce(statusOf(false));
    mount();

    act(() => {
      notifyLegalConsentAccepted();
    });
    expect(latest?.state).toBe('clear');

    await act(async () => {
      first.resolve(statusOf(true));
      await Promise.resolve();
    });
    await flush();
    expect(latest?.state).toBe('clear');
  });
});

describe('LegalConsentProvider — 利用者の替わり (T-P5 / T-P7)', () => {
  it('T-P5: user が null なら clear で、status を取らない', async () => {
    mockAuth = { user: null };
    mount();
    await flush();

    expect(latest?.state).toBe('clear');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('T-P5: user が替わったら loading から取り直し、古い応答は捨てる', async () => {
    const firstUserResponse = deferred<unknown>();
    mockGet.mockReturnValueOnce(firstUserResponse.promise);
    const view = mount();
    expect(latest?.state).toBe('loading');

    mockAuth = { user: { id: 'user-2' } };
    mockGet.mockResolvedValueOnce(statusOf(false));
    view.rerender(
      <LegalConsentProvider>
        <Probe />
      </LegalConsentProvider>,
    );
    await flush();
    expect(latest?.state).toBe('clear');

    // 前の利用者の応答が後から返る (required: true)。今の利用者の記録を上書きしない
    await act(async () => {
      firstUserResponse.resolve(statusOf(true));
      await Promise.resolve();
    });
    await flush();
    expect(latest?.state).toBe('clear');
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('T-P5: 別の利用者に替わった描画は、前の利用者の記録を使わず loading になる', async () => {
    mockGet.mockResolvedValueOnce(statusOf(true));
    const view = mount();
    await flush();
    expect(latest?.state).toBe('required');

    renders = [];
    mockAuth = { user: { id: 'user-2' } };
    mockGet.mockResolvedValueOnce(statusOf(false));
    view.rerender(
      <LegalConsentProvider>
        <Probe />
      </LegalConsentProvider>,
    );
    expect(renders[0]).toBe('loading');
    expect(renders).not.toContain('required');
    await flush();
    expect(latest?.state).toBe('clear');
  });

  it('T-P7: user が入った最初の描画から loading (clear の描画を挟まない)。同じ user がログアウトしてログインし直したら、前の記録を使わず loading から取り直す', async () => {
    mockAuth = { user: null };
    mockGet.mockResolvedValue(statusOf(true));
    const view = mount();
    await flush();
    expect(renders).toEqual(['clear']);

    renders = [];
    mockAuth = { user: { id: 'user-1' } };
    view.rerender(
      <LegalConsentProvider>
        <Probe />
      </LegalConsentProvider>,
    );
    // user が入った描画は loading (effect を待たない)
    expect(renders[0]).toBe('loading');
    expect(renders).not.toContain('clear');
    await flush();
    expect(latest?.state).toBe('required');

    // ログアウト → clear、記録は捨てる
    mockAuth = { user: null };
    view.rerender(
      <LegalConsentProvider>
        <Probe />
      </LegalConsentProvider>,
    );
    await flush();
    expect(latest?.state).toBe('clear');

    // 同じ user がログインし直す: 前の記録 (required) を使わず loading から
    renders = [];
    mockGet.mockResolvedValue(statusOf(false));
    mockAuth = { user: { id: 'user-1' } };
    view.rerender(
      <LegalConsentProvider>
        <Probe />
      </LegalConsentProvider>,
    );
    expect(renders[0]).toBe('loading');
    expect(renders).not.toContain('required');
    await flush();
    expect(latest?.state).toBe('clear');
  });
});

describe('LegalConsentProvider — アプリが前面に戻ったとき (T-P6)', () => {
  it('required のままアプリが前面に戻ったら (AppState active) status を取り直す', async () => {
    mockGet.mockResolvedValueOnce(statusOf(true));
    mount();
    await flush();
    expect(mockGet).toHaveBeenCalledTimes(1);

    mockGet.mockResolvedValueOnce(statusOf(false));
    await act(async () => {
      for (const handler of appStateHandlers) handler('active');
    });
    await flush();

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(latest?.state).toBe('clear');
  });

  it('active 以外では取り直さない', async () => {
    mockGet.mockResolvedValueOnce(statusOf(true));
    mount();
    await flush();

    await act(async () => {
      for (const handler of appStateHandlers) handler('background');
    });
    await flush();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['clear', () => Promise.resolve(statusOf(false))],
    ['unknown', () => Promise.reject(new Error('network'))],
  ])('%s のときは取り直さない', async (_label, make) => {
    mockGet.mockImplementationOnce(make);
    mount();
    await flush();
    mockGet.mockClear();

    await act(async () => {
      for (const handler of appStateHandlers) handler('active');
    });
    await flush();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('loading のときは取り直さない (取得中)', async () => {
    const pending = deferred<unknown>();
    mockGet.mockReturnValueOnce(pending.promise);
    mount();
    expect(latest?.state).toBe('loading');

    await act(async () => {
      for (const handler of appStateHandlers) handler('active');
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe('useLegalConsent', () => {
  it('Provider の外で呼ぶと例外', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow('useLegalConsent must be used within <LegalConsentProvider>');
    spy.mockRestore();
  });
});
