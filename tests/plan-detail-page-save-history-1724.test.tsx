/**
 * #1724 プラン詳細画面 (/super-admin/plans/[id]) で「保存する」を押したあとも、価格変更の履歴の一覧が残ることのテスト
 *
 * PATCH /api/super-admin/plans/[id] の応答はプランの行だけで、price_history を含まない
 * (GET だけが price_history を付けて返す)。以前の画面は PATCH の応答で plan を丸ごと置き換えていたため、
 * 保存のあとに「価格変更履歴」タブの一覧が空になっていた (再読み込みで戻る)。
 * 画面は保存のあとに GET で取り直し、履歴も保存した内容もサーバーの最新の状態で表示する。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/plan-detail-page-deprecate.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'plan-1' }),
  // プラン詳細は URL の tab を初めのタブにする (#2107 Y3)
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HISTORY_REASON = '原材料費の値上がりに合わせた改定';
const SAVED_DISPLAY_NAME = 'Pro (改定後)';

/** GET が返す価格変更の履歴 (1 件) */
const PRICE_HISTORY = [
  {
    id: 'history-1',
    old_monthly_price_jpy: 1200,
    new_monthly_price_jpy: 1500,
    reason: HISTORY_REASON,
    applies_to: 'new_only',
    changed_by: 'admin-1',
    created_at: '2026-09-01T00:00:00.000Z',
  },
];

/** プランの行 (subscription_plans の 1 行。PATCH の応答はこの形で、price_history を含まない) */
const PLAN_ROW = {
  id: 'plan-1',
  plan_key: 'pro',
  display_name: 'Pro',
  plan_type: 'personal',
  description: null,
  monthly_price_jpy: 1500,
  yearly_price_jpy: 15000,
  max_members: null,
  stripe_product_id: null,
  stripe_price_id: null,
  stripe_yearly_price_id: null,
  status: 'draft',
  display_order: 0,
  trial_days: 0,
  feature_packages: [],
};

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/**
 * 実際の route と同じ形の応答を返す:
 *   GET   : プランの行 + price_history (保存のあとは保存した表示名)
 *   PATCH : 更新後のプランの行だけ (price_history なし)
 */
function stubApi(patchResponse: ReturnType<typeof jsonResponse>) {
  let saved = false;
  fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') {
      if (patchResponse.ok) saved = true;
      return patchResponse;
    }
    const row = saved ? { ...PLAN_ROW, display_name: SAVED_DISPLAY_NAME } : PLAN_ROW;
    return jsonResponse(200, { data: { ...row, price_history: PRICE_HISTORY } });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function planFetchCount() {
  return fetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === undefined).length;
}

function patchCalls() {
  return fetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH');
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

async function click(label: string) {
  const button = findButton(label);
  expect(button, `「${label}」ボタンが見つからない`).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

async function renderPage() {
  await act(async () => {
    root.render(<PlanDetailPage />);
  });
}

/**
 * 表示名の入力欄を変える (保存は変えた欄だけを送り、何も変えていなければ送らないため。#1917)。
 * React の制御された入力欄へ値を入れる (value の setter を通してから input イベントを出す)
 */
async function editDisplayName(value: string) {
  const input = container.querySelector('input[type="text"]') as HTMLInputElement;
  expect(input, '表示名の入力欄が見つからない').not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('プラン詳細画面: 保存のあとも価格変更の履歴が残る (#1724)', () => {
  it('保存に成功したら GET で取り直し、価格変更履歴タブに履歴が出る (空にならない)', async () => {
    stubApi(jsonResponse(200, { data: { ...PLAN_ROW, display_name: SAVED_DISPLAY_NAME } }));
    await renderPage();
    expect(planFetchCount()).toBe(1);

    await editDisplayName(SAVED_DISPLAY_NAME);
    await click('保存する');

    await vi.waitFor(() => expect(container.textContent).toContain('保存しました'));
    expect(patchCalls()).toHaveLength(1);
    // 保存のあと、画面の状態は GET で取り直す
    expect(planFetchCount()).toBe(2);
    // 保存した内容 (サーバーの最新の表示名) が出ている
    expect(container.textContent).toContain(SAVED_DISPLAY_NAME);

    await click('価格変更履歴');

    expect(container.textContent).toContain(HISTORY_REASON);
    expect(container.textContent).not.toContain('価格変更履歴がありません');
  });

  it('保存に失敗したときは取り直さず、表示中の履歴もそのまま残る', async () => {
    stubApi(jsonResponse(422, { error: { code: 'OP_PLAN_STATUS_LOCKED', message: '変更できない項目があります' } }));
    await renderPage();

    await editDisplayName(SAVED_DISPLAY_NAME);
    await click('保存する');

    await vi.waitFor(() => expect(container.textContent).toContain('変更できない項目があります'));
    expect(planFetchCount()).toBe(1);

    await click('価格変更履歴');

    expect(container.textContent).toContain(HISTORY_REASON);
    expect(container.textContent).not.toContain('価格変更履歴がありません');
  });
});
