// src/__tests__/app/settings/trainer-share-removed.test.ts
// #1144: 設定画面から「トレーナーと共有」を外したことの contract テスト。
//
// 「トレーナーと共有（準備中）」は、押すと「近日公開予定」と出るだけで、トレーナーなどに共有する機能は
// どこにも無かった (保存されるのは notification_preferences.data_share_enabled の true / false だけ)。
// 利用者に「共有できる / すでに共有している」と思わせる表示になっていたため、Web とアプリの設定画面から外した
// (オーナー判断 2026-10-08)。ここでは Web の設定画面を jsdom に描画して、次を確かめる。
//
//   - 「トレーナーと共有」の項目も、「記録ON / 記録OFF」の表示も出ない
//   - 保存済みの値が true のユーザー (旧画面で ON にしたまま) でも、同じ
//   - 隣の項目 (エクスポート・AI へのデータ提供の同意) は残っている (外しすぎていない。何も描画できていないときに空振りで通らない)
//   - 残った 2 つのスイッチ (通知・自動解析) は、それぞれ自分の項目だけを PATCH する
//
// モバイルの設定画面と、保存済みの値を「同意」として読むコードが増えていないことは
// tests/data-share-not-consent.test.ts (ソース走査) で確かめる。
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (account-link.test.ts と同じ)。

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

const fetchMock = vi.fn();

/**
 * 起動時の通知設定の取得 (GET /api/notification-preferences) に返す内容を決めて、設定画面を描画する。
 * stored が null のときは、取得に失敗した (500) 場合。
 */
async function renderSettings(stored: boolean | null) {
  fetchMock.mockImplementation(async (input: string) => {
    if (input === '/api/notification-preferences' && stored !== null) {
      return new Response(
        JSON.stringify({
          settings: { notifications_enabled: true, auto_analyze_enabled: true, data_share_enabled: stored },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 500 });
  });

  act(() => {
    root.render(h(SettingsPage));
  });
  // useEffect 内の fetch の完了と、その後の state 更新まで待つ
  await act(async () => {});
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

const buttonLabels = () => Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');

/** PATCH /api/notification-preferences に送った本文 (JSON) を、送った順に */
const patchBodies = () =>
  fetchMock.mock.calls
    .filter(([url, init]) => url === '/api/notification-preferences' && init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(init.body as string));

describe('#1144 設定画面 (Web): 「トレーナーと共有」は出ない', () => {
  it.each([
    ['保存済みの値が false', false],
    ['保存済みの値が true (旧画面で ON にしたまま)', true],
    ['保存済みの値を取得できない', null],
  ])('%s のとき: 項目も「記録ON / 記録OFF」の表示も無い', async (_label, stored) => {
    await renderSettings(stored);

    // 何も描画できていないときに「無い」ことの確認が空振りで通らないよう、隣の項目の存在を先に確かめる
    expect(buttonLabels().some((text) => text.includes('データをエクスポート'))).toBe(true);
    expect(buttonLabels().some((text) => text.includes('献立をCSVエクスポート'))).toBe(true);

    const text = container.textContent ?? '';
    expect(text).not.toContain('トレーナー');
    expect(text).not.toContain('栄養士やジムと連携');
    expect(text).not.toContain('記録ON');
    expect(text).not.toContain('記録OFF');
    expect(buttonLabels().some((label) => label.includes('トレーナーと共有'))).toBe(false);
  });

  it('「データとプライバシー」は、データのエクスポート (JSON / CSV) と AI へのデータ提供の同意 (T15 / #1154) の 3 項目だけ', async () => {
    await renderSettings(true);

    const privacy = Array.from(container.querySelectorAll('h2')).find((e) => e.textContent === 'データとプライバシー');
    expect(privacy).toBeDefined();

    const card = privacy!.nextElementSibling;
    expect(card).not.toBeNull();
    const labels = Array.from(card!.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain('データをエクスポート');
    expect(labels[1]).toContain('献立をCSVエクスポート');
    // 外国の AI 事業者への提供の同意の確認・撤回 (共有の機能ではない。押すと /settings/ai-consent へ移る)
    expect(labels[2]).toContain('AI へのデータ提供の同意');
    expect(labels[2]).not.toMatch(/共有|トレーナー/);
  });

  it('共有に使うスイッチ (role="switch") も無い', async () => {
    await renderSettings(true);

    const labels = Array.from(container.querySelectorAll('[role="switch"]')).map((s) => s.getAttribute('aria-label') ?? '');
    // 通知と自動解析のスイッチは残っている (描画できていることの確認)
    expect(labels).toContain('通知を有効化');
    expect(labels).toContain('自動解析を有効化');
    expect(labels.filter((label) => /共有|トレーナー|share/i.test(label))).toEqual([]);
  });
});

describe('#1144 設定画面 (Web): 残ったスイッチは自分の項目だけを保存する', () => {
  it('通知スイッチ: PATCH で送るのは notifications_enabled だけ (data_share_enabled を書き換えない)', async () => {
    await renderSettings(true);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));

    const notifications = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="通知を有効化"]');
    expect(notifications).not.toBeNull();
    // 取得した値は ON なので、この操作は OFF にする (ブラウザの通知許可は ON にするときだけ求める)
    await act(async () => {
      notifications!.click();
    });

    expect(patchBodies()).toEqual([{ notifications_enabled: false }]);
  });

  it('自動解析スイッチ: PATCH で送るのは auto_analyze_enabled だけ', async () => {
    await renderSettings(true);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));

    const autoAnalyze = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自動解析を有効化"]');
    expect(autoAnalyze).not.toBeNull();
    await act(async () => {
      autoAnalyze!.click();
    });

    expect(patchBodies()).toEqual([{ auto_analyze_enabled: false }]);
  });
});
