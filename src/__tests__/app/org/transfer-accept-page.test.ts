// src/__tests__/app/org/transfer-accept-page.test.ts
// #1110 / #1306: 組織のオーナー譲渡の承諾ページ (/org/transfer-accept/[proposal_id]) が、
// ownership_transfer_proposals から存在しない列 reason を読んでいた。
// 存在しない列を select すると PostgREST は 42703 で失敗し、ページは error を見ずに data だけを見ていたため、
// どの提案を開いても「提案が見つかりません」になり、オーナー譲渡を承諾する画面に辿り着けなかった。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createPageClient } from '../transfer-accept-fake-client';

const ids = vi.hoisted(() => ({
  PROPOSAL_ID: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
  ORG_ID: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55',
  OLD_OWNER_ID: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  ME_ID: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
}));

const state = vi.hoisted(() => ({ client: null as unknown }));
const routerMock = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ proposal_id: ids.PROPOSAL_ID }),
  useRouter: () => routerMock,
}));

// ブラウザ側のクライアントはシングルトン (同じ参照を返す)
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => state.client,
}));

import TransferAcceptPage from '@/app/(org)/org/transfer-accept/[proposal_id]/page';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;
let client: ReturnType<typeof createPageClient>;

/** ほめゴハン株式会社のオーナー (社長) から、ログイン中の自分 (部長) への譲渡提案。期限内で pending */
function buildClient(overrides: { proposal?: Record<string, unknown> } = {}) {
  return createPageClient({
    userId: ids.ME_ID,
    tables: {
      ownership_transfer_proposals: [
        {
          id: ids.PROPOSAL_ID,
          scope: 'organization',
          scope_id: ids.ORG_ID,
          from_user_id: ids.OLD_OWNER_ID,
          to_user_id: ids.ME_ID,
          status: 'pending',
          proposed_at: '2026-10-01T00:00:00.000Z',
          expires_at: '2999-01-01T00:00:00.000Z',
          ...overrides.proposal,
        },
      ],
      organizations: [{ id: ids.ORG_ID, name: 'ほめゴハン株式会社' }],
      // 他人の user_profiles は RLS で読めない
      user_profiles: [],
    },
  });
}

beforeAll(() => {
  // React に「テスト中で、更新は act() の中で行う」と伝える (act の警告を出さないための設定)
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  routerMock.push.mockClear();
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
    root.render(h(TransferAcceptPage));
  });
  // 画面を開いたときの読み込み (ログイン確認 → 提案 → 組織 → 提案者) が終わるのを待つ
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const buttonLabels = () => Array.from(container.querySelectorAll('button')).map((button) => button.textContent);

describe('組織のオーナー譲渡の承諾ページ: 提案の読み取り (#1110 / #1306)', () => {
  it('提案は存在する列だけで読み、「提案が見つかりません」にならず、組織名と承諾・拒否の操作を表示する', async () => {
    client = buildClient();
    state.client = client;

    await renderPage();

    // 存在しない列 (ownership_transfer_proposals.reason) を select していない
    expect(client.invalidSelects).toEqual([]);
    expect(container.textContent).not.toContain('提案が見つかりません');
    expect(container.textContent).toContain('オーナー譲渡の提案');
    expect(container.textContent).toContain('ほめゴハン株式会社');
    expect(buttonLabels()).toEqual(expect.arrayContaining(['承諾', '拒否']));
  });

  it('提案者のニックネームを読めなくても (RLS)、「(不明)」と表示して承諾・拒否の操作はできる', async () => {
    client = buildClient();
    state.client = client;

    await renderPage();

    expect(container.textContent).toContain('(不明)');
    expect(container.textContent).not.toContain('@');
    expect(buttonLabels()).toEqual(expect.arrayContaining(['承諾', '拒否']));
  });

  it('自分宛てではない提案: 承諾・拒否の操作を出さず、案内を表示する', async () => {
    client = buildClient({ proposal: { to_user_id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33' } });
    state.client = client;

    await renderPage();

    expect(container.textContent).toContain('この提案はあなた宛てではありません');
    expect(buttonLabels()).not.toContain('承諾');
  });

  it('期限切れの提案: 承諾・拒否の操作を出さず、期限切れと表示する', async () => {
    client = buildClient({ proposal: { expires_at: '2000-01-01T00:00:00.000Z' } });
    state.client = client;

    await renderPage();

    expect(container.textContent).toContain('この提案は期限切れです');
    expect(buttonLabels()).not.toContain('承諾');
  });
});
