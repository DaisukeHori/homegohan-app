// src/__tests__/app/settings/billing-link.test.ts
// billing/01 §10.3 (#1701 段 C): 設定画面 (/settings) に「プランとお支払い」の行があり、契約の管理の画面 (/account/billing) へ行ける。
// アプリの WebView の中では描かない (アプリ内に購入・解約の導線を出さない。billing/01 §10.4)。
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (support-link.test.ts と同じ)。

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const h = React.createElement;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  isNativeApp: false,
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: null } }),
      signOut: async () => ({}),
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }),
      update: () => ({ eq: async () => ({}) }),
    }),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => mocks.isNativeApp }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => mocks.supabase }));
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

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isNativeApp = false;
  // 起動時の通知設定の取得 (この画面の関心事ではない) は失敗扱いにする
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    const mounted = root;
    act(() => {
      mounted.unmount();
    });
    root = undefined;
  }
  container.remove();
  vi.unstubAllGlobals();
});

async function renderSettings(): Promise<void> {
  act(() => {
    root = createRoot(container);
  });
  act(() => {
    root!.render(h(SettingsPage));
  });
  await act(async () => {});
}

function billingLinks(): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll('a')).filter((a) => a.textContent?.includes('プランとお支払い'));
}

describe('billing/01 §10.3 設定画面: 「プランとお支払い」', () => {
  it('settings shows プランとお支払い linking to /account/billing on web and hides it in native app mode', async () => {
    await renderSettings();
    const links = billingLinks();
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/account/billing');

    act(() => {
      root!.unmount();
    });
    root = undefined;

    mocks.isNativeApp = true;
    await renderSettings();
    expect(billingLinks()).toEqual([]);
    expect(container.textContent).not.toContain('プランとお支払い');
    expect(container.querySelector('a[href="/account/billing"]')).toBeNull();
  });
});
