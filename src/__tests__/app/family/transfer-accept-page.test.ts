// src/__tests__/app/family/transfer-accept-page.test.ts
// #1110 / #1306: 家族の代表者譲渡の承諾ページ (/family/transfer-accept/[proposal_id]) が、
// 提案者の user_profiles から存在しない列 email を読んでいた。
// user_profiles に email 列は無く (メールアドレスは auth.users にしか無い)、読み取りは常に失敗していた。
// 他人のメールアドレスをブラウザへ出さないためにも、読むのは nickname だけにする。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createPageClient } from '../transfer-accept-fake-client';

const ids = vi.hoisted(() => ({
  PROPOSAL_ID: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
  FAMILY_ID: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
  OLD_REP_ID: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
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

import FamilyTransferAcceptPage from '@/app/(main)/family/transfer-accept/[proposal_id]/page';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;
let client: ReturnType<typeof createPageClient>;

/** 山田家の代表者 (花子) から、ログイン中の自分 (太郎) への譲渡提案。期限内で pending */
function buildClient(options: { proposerProfileReadable: boolean }) {
  return createPageClient({
    userId: ids.ME_ID,
    tables: {
      ownership_transfer_proposals: [
        {
          id: ids.PROPOSAL_ID,
          scope: 'family',
          scope_id: ids.FAMILY_ID,
          from_user_id: ids.OLD_REP_ID,
          to_user_id: ids.ME_ID,
          status: 'pending',
          proposed_at: '2026-10-01T00:00:00.000Z',
          expires_at: '2999-01-01T00:00:00.000Z',
        },
      ],
      family_groups: [{ id: ids.FAMILY_ID, name: '山田家' }],
      // 他人の user_profiles は RLS で読めないことが多い。読める場合 (将来のポリシー変更など) と読めない場合の両方を確かめる
      user_profiles: options.proposerProfileReadable ? [{ id: ids.OLD_REP_ID, nickname: '花子' }] : [],
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
    root.render(h(FamilyTransferAcceptPage));
  });
  // 画面を開いたときの読み込み (ログイン確認 → 提案 → 提案者 → 家族名) が終わるのを待つ
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('家族の代表者譲渡の承諾ページ: 提案者の読み取り (#1110 / #1306)', () => {
  it('提案者のプロフィールは存在する列だけで読み、読めたニックネームを提案者として表示する', async () => {
    client = buildClient({ proposerProfileReadable: true });
    state.client = client;

    await renderPage();

    // 存在しない列 (user_profiles.email) を select していない
    expect(client.invalidSelects).toEqual([]);
    expect(container.textContent).toContain('花子');
    expect(container.textContent).toContain('山田家');
    // 他人のメールアドレスは読みも表示もしない
    expect(container.textContent).not.toContain('@');
  });

  it('提案者のニックネームを読めなくても (RLS)、「代表者」と表示して承諾・拒否の操作はできる', async () => {
    client = buildClient({ proposerProfileReadable: false });
    state.client = client;

    await renderPage();

    expect(client.invalidSelects).toEqual([]);
    expect(container.textContent).toContain('代表者 様から');
    expect(container.textContent).toContain('山田家');
    const labels = Array.from(container.querySelectorAll('button')).map((button) => button.textContent);
    expect(labels).toEqual(expect.arrayContaining(['承諾する (代表者になる)', '拒否する']));
  });
});
