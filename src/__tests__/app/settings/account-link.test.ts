// src/__tests__/app/settings/account-link.test.ts
// #1187: 設定画面 (/settings) に「アカウント」セクションがあり、パスワード・メールアドレスの変更画面
// (/settings/account) へ入れること。FAQ は「設定画面の『アカウント』→『パスワード・メールアドレス』」と案内していて、
// 「アカウントを削除する」は従来どおり一番下の「危険ゾーン」にある (FAQ の削除手順もそれに合わせている)。
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (data-export.test.ts と同じ)。

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

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
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  // 起動時の通知設定の取得 (この画面の関心事ではない) は失敗扱いにする
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

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

/** 設定画面のセクション見出し (h2) の文言を、画面の上から順に */
function sectionHeadings(): string[] {
  return Array.from(container.querySelectorAll('h2')).map((e) => e.textContent ?? '');
}

describe('#1187 設定画面: 「アカウント」セクション', () => {
  it('「アカウント」セクションがあり、「個人情報」の後・「データとプライバシー」の前に並ぶ', () => {
    const headings = sectionHeadings();
    expect(headings).toContain('アカウント');

    const account = headings.indexOf('アカウント');
    expect(account).toBeGreaterThan(headings.indexOf('個人情報'));
    expect(account).toBeLessThan(headings.indexOf('データとプライバシー'));
    // 「アカウント」の見出しは 1 つだけ (FAQ の案内先があいまいにならない)
    expect(headings.filter((t) => t === 'アカウント')).toHaveLength(1);
  });

  it('「パスワード・メールアドレス」の項目を押すと、/settings/account へ移動する', () => {
    const link = container.querySelector<HTMLButtonElement>('[data-testid="settings-account-link"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('パスワード・メールアドレス');

    act(() => {
      link!.click();
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith('/settings/account');
  });

  it('アカウントの削除は、従来どおり一番下の「危険ゾーン」にある (FAQ の削除手順)', () => {
    const headings = sectionHeadings();
    expect(headings[headings.length - 1]).toBe('危険ゾーン');

    const deleteButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'アカウントを削除する',
    );
    expect(deleteButton).toBeDefined();
  });
});
