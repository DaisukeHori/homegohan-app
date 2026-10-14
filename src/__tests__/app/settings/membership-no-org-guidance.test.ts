// src/__tests__/app/settings/membership-no-org-guidance.test.ts
// #1143 / #1123: メンバシップ設定の「所属組織」が空の人に出していた「組織を作成・参加」ボタンは、
// /org (組織の管理者専用) へ送るだけの行き止まりだった。組織をユーザー自身で作る機能も、
// 自分から参加を申し込む機能も無く、参加は招待メールのリンクからだけである。
// ボタンをやめ、その案内を表示するようにしたことを、実際にレンダリングして確かめる。

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const pushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, back: vi.fn() }),
}));

// 所属組織も所属家族も無い人のプロフィールを返す Supabase クライアント
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const query: Record<string, unknown> = {};
    query.select = () => query;
    query.eq = () => query;
    query.single = async () => ({
      data: { family_id: null, organization_id: null, org_role: null, nickname: 'テスト' },
    });
    return {
      auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
      from: () => query,
    };
  },
}));

import MembershipSettingsPage from '@/app/(main)/settings/membership/page';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React に「テスト中で、更新は act() の中で行う」と伝える (act の警告を出さないための設定)
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  pushMock.mockClear();
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
});

async function renderPage() {
  await act(async () => {
    root.render(h(MembershipSettingsPage));
  });
  // 画面を開いたときの読み込み (ログイン確認 → プロフィール取得) が終わるのを待つ
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function findSection(heading: string): HTMLElement {
  const section = Array.from(container.querySelectorAll('section')).find((s) =>
    s.textContent?.includes(heading),
  );
  if (!section) throw new Error(`「${heading}」のセクションが見つかりません`);
  return section;
}

describe('メンバシップ設定: 組織に未所属の人への案内 (#1143 / #1123)', () => {
  it('読み込みが終わり、所属組織のセクションが表示される (前提条件)', async () => {
    await renderPage();
    expect(findSection('所属組織').textContent).toContain('所属していません');
  });

  it('招待メールのリンクから参加できる、という案内を出す', async () => {
    await renderPage();
    expect(findSection('所属組織').textContent).toContain('招待メールのリンク');
  });

  it('「組織を作成・参加」ボタンは無い', async () => {
    await renderPage();
    expect(container.textContent).not.toContain('組織を作成');
    expect(findSection('所属組織').querySelectorAll('button')).toHaveLength(0);
  });

  it('画面のどのボタンを押しても /org (行き止まりだった画面) へは遷移しない', async () => {
    await renderPage();
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      act(() => {
        button.click();
      });
    }
    expect(pushMock).not.toHaveBeenCalledWith('/org');
  });

  it('家族グループの「作成・参加」ボタンは従来どおり /family/setup へ遷移する', async () => {
    await renderPage();
    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('家族グループを作成・参加'),
    );
    expect(button).toBeDefined();
    act(() => {
      button!.click();
    });
    expect(pushMock).toHaveBeenCalledWith('/family/setup');
  });
});
