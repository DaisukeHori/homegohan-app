// T15 (#1154) 設定に「AI へのデータ提供の同意」の項目があり、案内の一文が指す先が実在すること
//
// 画面を開くと自動で作る AI のコメント・AI の分析を省いた画面・相談の要約を省いた画面は、
// 「設定の「AI へのデータ提供の同意」から同意できます」と案内する (supabase/functions/_shared/ai-consent.ts の文面)。
// その項目が Web の設定 (/settings) とアプリの設定タブに無いと、案内に従っても同意の画面へ行けない。
//   1. 案内の文面は、どれも設定の項目の名前 (AI_CONSENT_SETTINGS_ENTRY_TITLE) を「」で指す
//   2. Web の設定に、その名前の項目があり、押すと /settings/ai-consent へ移る
//   3. アプリの設定タブに、その名前の項目があり、同意画面 (/settings/ai-consent) へ移る
//      (押したときの動きは apps/mobile/__tests__/settings/ai-consent-entry.test.tsx が確かめる)
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (account-link.test.ts と同じ)。

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import {
  AI_CONSENT_AUTOMATIC_LOCKED_NOTE,
  AI_CONSENT_SETTINGS_ENTRY_TITLE,
  AI_CONSENT_SKIPPED_NOTE,
  AI_CONSENT_SUMMARY_SKIPPED_NOTE,
} from '../supabase/functions/_shared/ai-consent';

const ROOT = path.resolve(__dirname, '..');
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

describe('案内の文面は、設定の項目の名前を指す', () => {
  it.each([
    ['画面を開くと自動で作る AI のコメント', AI_CONSENT_AUTOMATIC_LOCKED_NOTE],
    ['AI の分析を省いた保存の画面', AI_CONSENT_SKIPPED_NOTE],
    ['要約を省いた AI 相談', AI_CONSENT_SUMMARY_SKIPPED_NOTE],
  ])('%s', (_label, note) => {
    expect(note).toContain(`設定の「${AI_CONSENT_SETTINGS_ENTRY_TITLE}」`);
  });
});

describe('Web の設定 (/settings): 「AI へのデータ提供の同意」の項目', () => {
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

  it('「データとプライバシー」にあり、押すと同意の確認・撤回のページ (/settings/ai-consent) へ移る', () => {
    const link = container.querySelector<HTMLButtonElement>('[data-testid="settings-ai-consent-link"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain(AI_CONSENT_SETTINGS_ENTRY_TITLE);

    // 「データとプライバシー」の見出しのある区画の中にある
    const section = Array.from(container.querySelectorAll('h2')).find((e) => e.textContent === 'データとプライバシー')?.parentElement;
    expect(section?.contains(link!)).toBe(true);

    act(() => {
      link!.click();
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith('/settings/ai-consent');
  });
});

describe('アプリの設定タブ: 「AI へのデータ提供の同意」の項目 (ソース)', () => {
  it('項目の名前は共用の定義を使い、同意画面へ移る', () => {
    const text = fs.readFileSync(path.join(ROOT, 'apps/mobile/app/(tabs)/settings.tsx'), 'utf8');
    expect(text).toMatch(/title=\{AI_CONSENT_SETTINGS_ENTRY_TITLE\}/);
    expect(text).toMatch(/router\.push\(AI_CONSENT_SCREEN_PATH\)/);
  });
});
