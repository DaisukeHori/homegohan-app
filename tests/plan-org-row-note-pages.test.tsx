/**
 * #1912 組織のプランの行 (plan_type = 'org' の org_*) の廃止・価格変更の画面で、組織の件数を出さず注記を出すテスト
 *
 * org_* の行は組織の段階 (standard / premium / enterprise。organizations.plan) とは無関係で、組織の利用者の判定に使われない。
 * 廃止の安全弁が組織の件数を数えても常に 0 件になり「組織の契約者は 0 件」と読めてしまうので、数えずに注記を出す
 * (src/lib/super-admin/plan-subscribers.ts の ORG_SUBSCRIPTION_PLAN_ROW_NOTE)。
 *   - プランの詳細の画面 (/super-admin/plans/[id]): org_* の行だけ注記を出し、「廃止する」の確認の文にも添える
 *   - 価格変更の画面 (/super-admin/plans/[id]/price-change): org_* の行だけ注記を出す
 *   - 個人・家族のプランには出さない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/plan-detail-page-deprecate.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_SUBSCRIPTION_PLAN_ROW_NOTE } from '@/lib/super-admin/plan-subscribers';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'plan-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');
const { default: PriceChangePage } = await import('@/app/super-admin/plans/[id]/price-change/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENDS_AT_INPUT = '2027-01-01';
const NOTE_SELECTOR = '[data-testid="org-subscription-plan-row-note"]';

/** 公開中のプラン (「廃止する」「価格変更」が出る状態) */
function planOf(overrides: Record<string, unknown>) {
  return {
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
    status: 'public',
    display_order: 0,
    trial_days: 0,
    feature_packages: [],
    price_history: [],
    ...overrides,
  };
}

const ORG_ROW = planOf({ plan_key: 'org_standard', display_name: 'Org Standard', plan_type: 'org', monthly_price_jpy: 980 });
const PERSONAL = planOf({});
const FAMILY = planOf({ plan_key: 'family_basic', display_name: 'Family Basic', plan_type: 'family' });

let container: HTMLDivElement;
let root: Root;
let confirmSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** プランの取得 (GET) は引数のプランを返す (確認で「いいえ」を選ぶので、ほかの呼び出しは起きない) */
function stubPlan(plan: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(200, { data: plan })),
  );
}

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

function noteText(): string | null {
  return container.querySelector(NOTE_SELECTOR)?.textContent ?? null;
}

beforeEach(() => {
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'prompt').mockReturnValue(ENDS_AT_INPUT);
  // 確認では「いいえ」を選び、PATCH まで進まない (確認の文だけを見る)
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

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

describe('プランの詳細の画面: 組織のプランの行の注記 (#1912)', () => {
  it('org_* の行では、組織の件数の代わりに注記を出す', async () => {
    stubPlan(ORG_ROW);
    await render(<PlanDetailPage />);

    expect(noteText()).toBe(ORG_SUBSCRIPTION_PLAN_ROW_NOTE);
    expect(container.textContent).not.toMatch(/組織 \d+ 件/);
  });

  it('org_* の行の「廃止する」の確認の文に、注記を添える', async () => {
    stubPlan(ORG_ROW);
    await render(<PlanDetailPage />);

    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('廃止する'));
    expect(button, '「廃止する」ボタンが見つからない').toBeDefined();
    await act(async () => {
      button!.click();
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = String(confirmSpy.mock.calls[0]![0]);
    expect(message).toContain(`このプランを ${ENDS_AT_INPUT} 廃止予定で廃止しますか？`);
    expect(message).toContain(ORG_SUBSCRIPTION_PLAN_ROW_NOTE);
  });

  it.each([
    ['個人', PERSONAL],
    ['家族', FAMILY],
  ])('%sのプランには注記を出さず、「廃止する」の確認の文にも添えない', async (_label, plan) => {
    stubPlan(plan);
    await render(<PlanDetailPage />);

    expect(container.querySelector(NOTE_SELECTOR)).toBeNull();
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('廃止する'));
    await act(async () => {
      button!.click();
    });
    expect(String(confirmSpy.mock.calls[0]![0])).not.toContain(ORG_SUBSCRIPTION_PLAN_ROW_NOTE);
  });
});

describe('価格変更の画面: 組織のプランの行の注記 (#1912)', () => {
  it('org_* の行では、注記を出す', async () => {
    stubPlan(ORG_ROW);
    await render(<PriceChangePage />);

    expect(noteText()).toBe(ORG_SUBSCRIPTION_PLAN_ROW_NOTE);
  });

  it.each([
    ['個人', PERSONAL],
    ['家族', FAMILY],
  ])('%sのプランには注記を出さない', async (_label, plan) => {
    stubPlan(plan);
    await render(<PriceChangePage />);

    // 画面が描けている (読み込み中のままではない) ことを確かめてから、注記が無いことを見る
    expect(container.textContent).toContain('現在の価格');
    expect(container.querySelector(NOTE_SELECTOR)).toBeNull();
  });
});
