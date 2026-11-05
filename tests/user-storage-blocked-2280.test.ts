// #2280 U1 Web のログアウト: 利用者別の localStorage の片付け (src/lib/user-storage.ts の clearUserScopedLocalStorage) が
// 保存の禁止された環境で投げても、サインアウトまで進む。
//
// 以前は、localStorage への参照・removeItem・length・key(i) を try/catch 無しで呼んでいたので、それらが SecurityError で
// 投げる環境 (サイトのデータの保存を禁止したブラウザなど) では、関数が投げ、設定画面のログアウト (settings/page.tsx の
// handleLogout) は、そのあとの notifyNativeSignOut・supabase.auth.signOut()・broadcastSignOut・ログイン画面への移動に進まなかった
// (ボタンを押しても何も起きない)。ここでは次を確かめる。
//   1. 使える環境では、消すキーとその順はこれまでと同じ (決まったキーを一覧の順に、次に接頭辞のキーを localStorage の並びの順に)。警告は出さない
//   2. localStorage への参照・removeItem・length・key(i) が投げても、関数は投げず、消せるキーは消し続け、
//      USER_SCOPED_STORAGE_CLEARED_EVENT を 1 回出し、警告 (console.warn) を出す
//   3. 設定画面のログアウトは、localStorage が投げる環境でも signOut まで進み、ログイン画面へ移る
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (account-deletion-blocked-message.test.ts と同じ)。

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  FAMILY_VIEW_STATE_KEY_PREFIX,
  USER_SCOPED_LOCAL_STORAGE_KEYS,
  USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES,
  USER_SCOPED_STORAGE_CLEARED_EVENT,
} from '@homegohan/shared';

import { clearUserScopedLocalStorage } from '@/lib/user-storage';

const h = React.createElement;

/** 保存が禁止された環境の例外 */
const SECURITY_ERROR = new DOMException('The operation is insecure.', 'SecurityError');

const mocks = vi.hoisted(() => ({
  /** サインアウトの経路で呼ばれた順 */
  calls: [] as string[],
  push: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => false }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      signOut: mocks.signOut,
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }),
      update: () => ({ eq: async () => ({}) }),
    }),
  }),
}));
vi.mock('framer-motion', async () => {
  const react = await import('react');
  const motion = new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, className, onClick, role }: Record<string, unknown>) =>
          react.createElement(tag, { className, onClick, role }, children as React.ReactNode),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => react.createElement(react.Fragment, null, children),
  };
});

import SettingsPage from '@/app/(main)/settings/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let restoreStorage: (() => void) | null = null;

/** localStorage への参照そのものを投げる形にする (後片付けは afterEach) */
function makeLocalStorageReferenceThrow(): void {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => {
      throw SECURITY_ERROR;
    },
  });
  restoreStorage = () => {
    if (own) Object.defineProperty(globalThis, 'localStorage', own);
  };
}

/** 決まったキーと、接頭辞のキー (家族の表示の切り替えの 3 つと、ほかの接頭辞の 1 つずつ) と、消さないキーを置く */
function seedUserScopedKeys(): string[] {
  for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) localStorage.setItem(key, 'previous-user');
  const prefixed = ['family-a', 'family-b', 'family-c'].map((id) => `${FAMILY_VIEW_STATE_KEY_PREFIX}${id}`);
  for (const prefix of USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES) prefixed.push(`${prefix}other`);
  for (const key of prefixed) localStorage.setItem(key, 'previous-user');
  localStorage.setItem('unrelated-key', 'keep');
  return prefixed;
}

/** いま localStorage にあるキー (並べ替えて返す) */
function remainingKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    .filter((key): key is string => key !== null)
    .sort();
}

let clearedEvents: number;
const onCleared = () => {
  clearedEvents += 1;
};

beforeEach(() => {
  localStorage.clear();
  clearedEvents = 0;
  window.addEventListener(USER_SCOPED_STORAGE_CLEARED_EVENT, onCleared);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
  window.removeEventListener(USER_SCOPED_STORAGE_CLEARED_EVENT, onCleared);
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('clearUserScopedLocalStorage: 使える環境では、消すキーとその順はこれまでと同じ (#2280)', () => {
  it('決まったキーを一覧の順に消し、次に接頭辞のキーを localStorage の並びの順に消す。ほかのキーは残し、警告は出さない', () => {
    const prefixed = seedUserScopedKeys();
    // 接頭辞のキーは、消す前の localStorage の並びの順に消す (先に集めてから消す)
    const prefixedInStorageOrder = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
      (key): key is string => key !== null && USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem');

    clearUserScopedLocalStorage();

    expect(removeSpy.mock.calls.map(([key]) => key)).toEqual([...USER_SCOPED_LOCAL_STORAGE_KEYS, ...prefixedInStorageOrder]);
    expect([...prefixedInStorageOrder].sort()).toEqual([...prefixed].sort());
    expect(remainingKeys()).toEqual(['unrelated-key']);
    expect(clearedEvents).toBe(1);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('clearUserScopedLocalStorage: 保存が禁止された環境でも投げない (#2280)', () => {
  it('localStorage への参照そのものが投げる: 投げずに、消したことのイベントを 1 回出し、警告を出す', () => {
    makeLocalStorageReferenceThrow();

    expect(() => clearUserScopedLocalStorage()).not.toThrow();

    expect(clearedEvents).toBe(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it('removeItem がどれも投げる: 投げずに、消したことのイベントを 1 回出し、キーごとに警告を出す', () => {
    const prefixed = seedUserScopedKeys();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw SECURITY_ERROR;
    });

    expect(() => clearUserScopedLocalStorage()).not.toThrow();

    expect(clearedEvents).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(USER_SCOPED_LOCAL_STORAGE_KEYS.length + prefixed.length);
  });

  it('removeItem が最初のキーだけで投げる: 残りの決まったキーと接頭辞のキーは消し続ける', () => {
    seedUserScopedKeys();
    const [firstKey] = USER_SCOPED_LOCAL_STORAGE_KEYS;
    const realRemoveItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (key === firstKey) throw SECURITY_ERROR;
      realRemoveItem.call(this, key);
    });

    expect(() => clearUserScopedLocalStorage()).not.toThrow();

    expect(remainingKeys()).toEqual([firstKey, 'unrelated-key'].sort());
    expect(clearedEvents).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('length が投げる: 決まったキーは消し、投げずに、消したことのイベントを 1 回出す', () => {
    const prefixed = seedUserScopedKeys();
    const lengthSpy = vi.spyOn(Storage.prototype, 'length', 'get').mockImplementation(() => {
      throw SECURITY_ERROR;
    });

    expect(() => clearUserScopedLocalStorage()).not.toThrow();

    lengthSpy.mockRestore();
    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.filter((key) => localStorage.getItem(key) !== null)).toEqual([]);
    // 接頭辞のキーは数えられないので残る (投げずに戻るのが目的)
    expect(prefixed.filter((key) => localStorage.getItem(key) === null)).toEqual([]);
    expect(clearedEvents).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('key(i) が投げる: 決まったキーは消し、投げずに、消したことのイベントを 1 回出す', () => {
    seedUserScopedKeys();
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw SECURITY_ERROR;
    });

    expect(() => clearUserScopedLocalStorage()).not.toThrow();

    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.filter((key) => localStorage.getItem(key) !== null)).toEqual([]);
    expect(clearedEvents).toBe(1);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('Web の設定 (/settings): localStorage が投げる環境でも、ログアウトは signOut まで進む (#2280)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    mocks.calls.length = 0;
    mocks.push.mockReset();
    mocks.push.mockImplementation((path: string) => {
      mocks.calls.push(`push:${path}`);
    });
    mocks.signOut.mockReset();
    mocks.signOut.mockImplementation(async () => {
      mocks.calls.push('signOut');
      return {};
    });
    // 起動時の通知設定などの取得は失敗扱い (この画面の関心事ではない)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
    });
    act(() => {
      root.render(h(SettingsPage));
    });
    await act(async () => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  /** 「ログアウト」を押して確認の画面を開き、確認の「ログアウト」を押す */
  async function logout() {
    const openButton = container.querySelector<HTMLButtonElement>('[data-testid="logout-button"]');
    expect(openButton, 'ログアウトのボタンが無い').not.toBeNull();
    act(() => {
      openButton!.click();
    });
    const confirmButton = container.querySelector<HTMLButtonElement>('[data-testid="logout-confirm-button"]');
    expect(confirmButton, '確認の「ログアウト」のボタンが無い').not.toBeNull();
    await act(async () => {
      confirmButton!.click();
    });
    await act(async () => {});
  }

  it('removeItem が投げる: signOut → ログイン画面への移動の順に進む', async () => {
    seedUserScopedKeys();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw SECURITY_ERROR;
    });

    await logout();

    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.calls).toEqual(['signOut', 'push:/login']);
    expect(clearedEvents).toBe(1);
  });

  it('localStorage への参照そのものが投げる: signOut まで進み、ログイン画面へ移る', async () => {
    makeLocalStorageReferenceThrow();

    await logout();

    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith('/login');
    expect(clearedEvents).toBe(1);
  });

  it('使える環境: 利用者別のキーを消してから、signOut → ログイン画面への移動に進む', async () => {
    seedUserScopedKeys();

    await logout();

    expect(remainingKeys()).toEqual(['unrelated-key']);
    expect(mocks.calls).toEqual(['signOut', 'push:/login']);
    expect(clearedEvents).toBe(1);
  });
});
