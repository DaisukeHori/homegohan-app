/**
 * #2107 Y3: プラン詳細 (/super-admin/plans/[id]) は URL の tab (basic / price / history) を初めのタブにする
 *
 * 以前: 価格の変更の画面は、済んだあと・「済んだか分からない」の案内で `/super-admin/plans/{id}?tab=history` へ送っていたが、
 *   プラン詳細は useState('basic') で URL の tab を読まなかったので、履歴ではなく基本情報のタブが開いた
 *   (画面のテストは router をモックしていたので気づけなかった)。
 * 直したあと (不変条件):
 *   - ?tab=history で開くと価格変更履歴のタブ、?tab=price で開くと価格設定のタブが選ばれている
 *   - tab が無い・知らない値なら基本情報のタブ
 *   - 価格の変更の画面が送る先 (planDetailHref(id, 'history')) は ?tab=history で、詳細の画面はそれを履歴のタブとして読む
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_DETAIL_TAB_QUERY_KEY, planDetailHref, planDetailTabOf } from '@/lib/super-admin/plan-detail-tab';

const PLAN_ID = '21072107-2107-4107-8107-210721072108';
const search = vi.hoisted(() => ({ query: '' }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '21072107-2107-4107-8107-210721072108' }),
  useSearchParams: () => new URLSearchParams(search.query),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HISTORY_REASON = '販売開始の Price の登録';
const PLAN_ROW = {
  id: PLAN_ID,
  plan_key: 'pro',
  display_name: '個人 Pro',
  plan_type: 'personal',
  description: null,
  monthly_price_jpy: 580,
  yearly_price_jpy: 5800,
  max_members: null,
  stripe_product_id: 'prod_pro',
  stripe_price_id: 'price_m',
  stripe_yearly_price_id: 'price_y',
  status: 'public',
  display_order: 0,
  trial_days: 0,
  feature_packages: [],
  price_history: [
    {
      id: 'history-1',
      old_monthly_price_jpy: 580,
      new_monthly_price_jpy: 580,
      reason: HISTORY_REASON,
      applies_to: 'new_only',
      changed_by: 'admin-1',
      created_at: '2026-10-30T00:00:00.000Z',
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

async function renderPage(query: string) {
  search.query = query;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: PLAN_ROW }), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
  await act(async () => {
    root.render(createElement(PlanDetailPage));
  });
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const text = () => container.textContent ?? '';
/** 選ばれているタブのボタン (aria-selected="true") の文 */
const selectedTabs = () => Array.from(container.querySelectorAll('[role="tab"][aria-selected="true"]')).map((el) => el.textContent);

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
});

describe('プラン詳細は URL の tab を初めのタブにする (#2107 Y3)', () => {
  it('?tab=history で開くと価格変更履歴のタブが選ばれ、履歴の行が見える', async () => {
    await renderPage('tab=history');
    expect(selectedTabs()).toEqual(['価格変更履歴']);
    expect(text()).toContain(HISTORY_REASON);
  });

  it('?tab=price で開くと価格設定のタブが選ばれている', async () => {
    await renderPage('tab=price');
    expect(selectedTabs()).toEqual(['価格設定']);
    expect(text()).not.toContain(HISTORY_REASON);
  });

  it.each([
    ['tab が無い', ''],
    ['知らない値', 'tab=unknown'],
    ['大文字の違う値', 'tab=History'],
  ])('%s なら基本情報のタブ', async (_label, query) => {
    await renderPage(query);
    expect(selectedTabs()).toEqual(['基本情報']);
    expect(text()).not.toContain(HISTORY_REASON);
  });

  it('価格の変更の画面が送る先は ?tab=history で、詳細の画面はそれを履歴のタブとして読む', () => {
    const href = planDetailHref(PLAN_ID, 'history');
    expect(href).toBe(`/super-admin/plans/${PLAN_ID}?tab=history`);
    const query = new URL(href, 'http://localhost').searchParams;
    expect(planDetailTabOf(query.get(PLAN_DETAIL_TAB_QUERY_KEY))).toBe('history');
    expect(planDetailTabOf(null)).toBe('basic');
    expect(planDetailTabOf('')).toBe('basic');
  });
});
