// src/__tests__/app/settings/support-link.test.ts
// #1194: 設定画面 (/settings) の「お問い合わせ」は、問い合わせ先を直接書かず src/lib/site-config.ts の getSupportEmail() から作る。
// 以前は mailto:support@homegohan.jp と書かれていて、メールの文面・お問い合わせ画面・招待画面 (どれも getSupportEmail())
// とは別のドメインを指していた。
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (account-link.test.ts と同じ)。

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { DEFAULT_SUPPORT_EMAIL } from '@/lib/site-config';

const h = React.createElement;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
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
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => false }));
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
  vi.unstubAllEnvs();
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

/** 「お問い合わせ」の項目 (a 要素) */
function supportLink(): HTMLAnchorElement {
  const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent?.includes('お問い合わせ'));
  expect(link, '「お問い合わせ」の項目が無い').toBeDefined();
  return link!;
}

describe('#1194 設定画面: 「お問い合わせ」の宛先は site-config の getSupportEmail()', () => {
  it('環境変数が無いときは、問い合わせ先の既定値 (DEFAULT_SUPPORT_EMAIL) へのメールを開く', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '');
    await renderSettings();
    expect(supportLink().getAttribute('href')).toBe(`mailto:${DEFAULT_SUPPORT_EMAIL}`);
  });

  it('NEXT_PUBLIC_SUPPORT_EMAIL を設定すると、その宛先へのメールを開く (ドメインの切り替えは環境変数だけで済む)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', 'help@example.test');
    await renderSettings();
    expect(supportLink().getAttribute('href')).toBe('mailto:help@example.test');
  });
});
