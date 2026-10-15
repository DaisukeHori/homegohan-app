// src/__tests__/app/settings/data-requests-link.test.ts
// #1178 / #1702: 設定画面 (/settings) の「データとプライバシー」に「開示・訂正・利用停止の請求」の項目があり、
// 押すと請求の画面 (/settings/data-requests) へ移ること (設計 docs/design/cross/15-data-subject-requests.md §9.1・§15)。
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (account-link.test.ts と同じ)。

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

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
import { DSR_SETTINGS_ENTRY_TITLE, DSR_SETTINGS_PATH } from '@/lib/data-subject-requests/core';

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

/** 「データとプライバシー」の見出し (h2) の直後のカードの中の、data-testid を持つ項目を上から順に */
function dataPrivacyItemTestIds(): string[] {
  const heading = Array.from(container.querySelectorAll('h2')).find((e) => e.textContent === 'データとプライバシー');
  const card = heading?.nextElementSibling;
  return Array.from(card?.querySelectorAll('[data-testid]') ?? []).map((e) => e.getAttribute('data-testid') ?? '');
}

describe('#1178 設定画面: 「開示・訂正・利用停止の請求」の項目', () => {
  it('「データとプライバシー」のカードの中にあり、AI へのデータ提供の同意の項目の次に並ぶ', () => {
    const ids = dataPrivacyItemTestIds();
    expect(ids).toContain('settings-data-requests-link');
    expect(ids.indexOf('settings-data-requests-link')).toBe(ids.indexOf('settings-ai-consent-link') + 1);
  });

  it('見出しは DSR_SETTINGS_ENTRY_TITLE と説明の文で、押すと DSR_SETTINGS_PATH (/settings/data-requests) へ移動する', () => {
    const link = container.querySelector<HTMLButtonElement>('[data-testid="settings-data-requests-link"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain(DSR_SETTINGS_ENTRY_TITLE);
    expect(link?.textContent).toContain('個人情報の開示・訂正・利用停止・消去を請求する');

    act(() => {
      link!.click();
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith(DSR_SETTINGS_PATH);
    expect(DSR_SETTINGS_PATH).toBe('/settings/data-requests');
  });
});
