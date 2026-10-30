/**
 * #1728 プラン詳細画面 (/super-admin/plans/[id]) で「保存する」を押しても、バナー画像の URL (banner_url) が消えないことのテスト
 *
 * 以前の画面は、入力欄の無い banner_url をいつも空文字で始め、保存のたびに `banner_url: null` を送っていた。
 * PATCH の route は送られた項目をそのまま書くので、保存のたびに subscription_plans.banner_url が null で上書きされていた。
 * 画面は入力欄のある項目 (表示名・説明・表示順) のうち、変えた欄だけを送り (#1917)、route は送られなかった項目を書かない。
 *
 * ここでは画面の fetch を本物の route (GET / PATCH) へつなぎ、DB は 1 行を持つだけのフェイクにして、
 * 「保存の前後で DB の banner_url が変わらない」ことを画面から route まで通して確かめる。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/plan-detail-page-save-history-1724.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: PLAN_ID }),
  // プラン詳細は URL の tab を初めのタブにする (#2107 Y3)
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const mockRequireRole = vi.fn();
vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

// 失敗の記録 (app_logs) は書かない
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    withUser: () => ({ error: vi.fn() }),
  }),
  generateRequestId: () => 'req_test',
}));

// 監査ログは書いたことだけを数える (中身は tests/admin-mutation-audit-coverage-1571.test.ts が確かめる)
const mockRecordAdminAudit = vi.fn();
vi.mock('@/lib/admin/audit', () => ({
  recordAdminAudit: (...args: unknown[]) => mockRecordAdminAudit(...args),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeDb.client),
  // プランの更新 (subscription_plans) は service_role の client で書く (運営の直接の書き込みを塞いだ。#1917 の続き)。
  // 同じ代わりの DB に書く。廃止の操作 (契約者の数え上げ) はしないので、ほかの表には触れない
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'subscription_plans') throw new Error(`この試験では service_role で ${table} を使わない (廃止の操作をしない)`);
      return fakeDb.client.from(table);
    },
  }),
}));

// route は UUID の形でない id を DB に渡さず 404 にする (#1917) ので、id は UUID の形にする
const PLAN_ID = '88888888-8888-4888-8888-888888888887';
const BANNER_URL = 'https://cdn.example.com/plans/pro-banner.png';
const EDITED_DISPLAY_NAME = 'Pro (改定後)';

const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');
const { GET, PATCH } = await import('@/app/api/super-admin/plans/[id]/route');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PlanRow = Record<string, unknown> & { id: string; banner_url: string | null };

/** subscription_plans の 1 行 (banner_url が入っている) */
function planRow(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: PLAN_ID,
    plan_key: 'pro',
    display_name: 'Pro',
    plan_type: 'personal',
    description: 'プロ向けのプラン',
    banner_url: BANNER_URL,
    monthly_price_jpy: 1500,
    yearly_price_jpy: 15000,
    max_members: null,
    stripe_product_id: null,
    stripe_price_id: null,
    stripe_yearly_price_id: null,
    status: 'draft',
    display_order: 3,
    trial_days: 0,
    feature_packages: [],
    ends_at: null,
    ...overrides,
  };
}

/**
 * subscription_plans の 1 行だけを持つフェイクの DB。
 * select().eq().single() でいまの行を返し、update(values).eq().select().maybeSingle() で values を行に重ねる
 * (Supabase の update と同じく、渡されなかった列はそのまま残る)。route の PATCH は読んだ status を条件にした更新
 * (.eq('status', …)) だが、この画面のテストでは割り込みが無いので、条件はいつも合う (割り込みは tests/super-admin-plan-status-cas-route.test.ts)。
 */
function createPlanDb(initial: PlanRow) {
  const state = { row: { ...initial } as PlanRow, updates: [] as Record<string, unknown>[] };

  function plansBuilder() {
    let pendingUpdate: Record<string, unknown> | null = null;
    const builder = {
      select: () => builder,
      eq: () => builder,
      update: (values: Record<string, unknown>) => {
        pendingUpdate = values;
        return builder;
      },
      single: async () => terminal(),
      maybeSingle: async () => terminal(),
    };
    function terminal() {
      if (pendingUpdate) {
        state.updates.push(pendingUpdate);
        state.row = { ...state.row, ...pendingUpdate };
      }
      return { data: { ...state.row }, error: null };
    }
    return builder;
  }

  function priceHistoryBuilder() {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: async () => ({ data: [], error: null }),
    };
    return builder;
  }

  const client = {
    from: (table: string) => {
      if (table === 'subscription_plans') return plansBuilder();
      if (table === 'plan_price_history') return priceHistoryBuilder();
      throw new Error(`想定していないテーブル: ${table}`);
    },
  };
  return { state, client };
}

let fakeDb: ReturnType<typeof createPlanDb>;
let container: HTMLDivElement;
let root: Root;
const patchBodies: Record<string, unknown>[] = [];

/** 画面の fetch を本物の route の GET / PATCH へつなぐ */
function connectPageToRoute() {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const request = new Request(`http://localhost${url}`, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    }) as never;
    const context = { params: Promise.resolve({ id: PLAN_ID }) };
    if (init?.method === 'PATCH') {
      patchBodies.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
      return PATCH(request, context);
    }
    return GET(request, context);
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function renderPage() {
  await act(async () => {
    root.render(<PlanDetailPage />);
  });
  await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
}

/** React の制御された入力欄へ値を入れる (value の setter を通してから input イベントを出す) */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickSave() {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('保存する'));
  expect(button, '「保存する」ボタンが見つからない').toBeDefined();
  await act(async () => {
    button!.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  patchBodies.length = 0;
  mockRequireRole.mockResolvedValue({ id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null });
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

describe('プラン詳細画面: 保存しても banner_url が消えない (#1728)', () => {
  it.each([
    // 下書きは全項目を変えられる。公開中・非公開は route が変えてよい項目を絞る (operator/04-plan-management.md §3.1)
    ['draft' as const],
    ['public' as const],
    ['private' as const],
  ])('status = %s: 表示名を変えて保存しても、DB の banner_url は保存の前と同じ', async (status) => {
    fakeDb = createPlanDb(planRow({ status }));
    connectPageToRoute();
    await renderPage();

    await typeInto(container.querySelector('input[type="text"]') as HTMLInputElement, EDITED_DISPLAY_NAME);
    await clickSave();

    await vi.waitFor(() => expect(container.textContent).toContain('保存しました'));
    // 保存そのものは通っている (表示名は変わる)
    expect(fakeDb.state.row.display_name).toBe(EDITED_DISPLAY_NAME);
    // banner_url は保存の前と同じ (null で上書きされない)
    expect(fakeDb.state.row.banner_url).toBe(BANNER_URL);
    // 画面に入力欄の無い banner_url は送らない。入力欄のある 3 項目のうちでも、変えた表示名だけを送る (#1917)
    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0]).toEqual({ display_name: EDITED_DISPLAY_NAME });
    // route も、送られなかった banner_url を更新の値に入れない
    expect(fakeDb.state.updates).toHaveLength(1);
    expect(fakeDb.state.updates[0]).not.toHaveProperty('banner_url');
    expect(mockRecordAdminAudit).toHaveBeenCalledTimes(1);
  });

  it('何も変えずに保存しても、DB の行の中身 (banner_url・説明・表示順) は変わらない (変えた欄が無いので送らない。#1917)', async () => {
    const before = planRow();
    fakeDb = createPlanDb(before);
    connectPageToRoute();
    await renderPage();

    await clickSave();

    await vi.waitFor(() => expect(container.textContent).toContain('変更した項目がないので、保存していません'));
    expect(container.textContent).not.toContain('保存しました');
    expect(patchBodies).toHaveLength(0);
    expect(fakeDb.state.updates).toHaveLength(0);
    expect(fakeDb.state.row).toEqual(before);
    expect(mockRecordAdminAudit).not.toHaveBeenCalled();
  });
});
