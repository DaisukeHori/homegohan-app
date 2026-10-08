/**
 * #1125 #1128: admin の画面で、まだ動いていない機能を「準備中」「未対応」と明示する
 *
 * 以前の画面は、動いていない機能を、動いていて問題が無いように見せていた。
 *   - 売上・経理: 課金 (Stripe の Webhook・収益の集計バッチ) はまだ動いておらず、請求書・収益推移の表は常に空。
 *     Stripe 整合チェックは一度も動いていないのに「不一致件数 0 / 整合OK」を緑で出していた。
 *     ダッシュボードは、元データが無いため MRR・ARR・解約率・LTV を 0 で出していた
 *   - モデレーション: AI コンテンツのバックエンドが無く、「AI コンテンツ」を選ぶと必ず
 *     「審査待ちのアイテムはありません」と出て、通報 0 件に見えた
 * ここでは、ページを実際に描画して、次を確かめる。
 *   - 請求書・収益推移・整合チェック: 「課金は未開始のため準備中」だけが出る。空の表・「整合OK」・通信が無い
 *   - ダッシュボード: MRR / ARR / Churn Rate / LTV と契約数は「準備中」。MAU は実データのまま出す
 *   - モデレーション: 「AIコンテンツ（未対応）」の選択肢は選べない。URL で ai_content を指定されても API を呼ばず案内を出す
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 * モデレーションの画面は async の Server Component なので、結果を react-dom/server で HTML にして確かめる。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireRole = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound,
  useParams: () => ({ id: 'evt_1' }),
}));

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { default: FinanceDashboardPage } = await import('@/app/admin/finance/page');
const { default: InvoicesPage } = await import('@/app/admin/finance/invoices/page');
const { default: ReconciliationPage } = await import('@/app/admin/finance/reconciliation/page');
const { default: RevenueListPage } = await import('@/app/admin/finance/revenue/page');
const { default: AdminModerationPage } = await import('@/app/admin/moderation/page');
const { default: AdminModerationDetailPage } = await import('@/app/admin/moderation/[type]/[id]/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BILLING_NOT_STARTED = '課金は未開始のため準備中';
const AI_CONTENT_OPTION = 'AIコンテンツ（未対応）';
const AI_CONTENT_NOTICE = 'AIコンテンツの審査は準備中（未対応）です';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ id: 'admin-1', roles: ['admin'], email: 'admin@example.com' });
  adminFetch.mockResolvedValue(jsonResponse({ data: [], meta: { total: 0, page: 1, per_page: 30 } }));

  fetchMock = vi.fn(async () => jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404));
  vi.stubGlobal('fetch', fetchMock);

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

const text = () => container.textContent ?? '';

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** async の Server Component を HTML にして、DOM として調べられるようにする */
async function renderServerPage(page: Promise<React.ReactElement>) {
  const holder = document.createElement('div');
  holder.innerHTML = renderToStaticMarkup(await page);
  return holder;
}

describe('/admin/finance の請求書・収益推移・Stripe 整合チェック', () => {
  const pages = [
    { name: '請求書一覧 (invoices)', Page: InvoicesPage },
    { name: 'Stripe 整合チェック (reconciliation)', Page: ReconciliationPage },
    { name: '収益推移 (revenue)', Page: RevenueListPage },
  ];

  it.each(pages)('$name: 「課金は未開始のため準備中」だけを出す。空の表・フィルタ・通信が無い', async ({ Page }) => {
    await render(<Page />);

    expect(text()).toContain(BILLING_NOT_STARTED);
    // 空の表 (「データがありません」の行を持つ表) と、検索のフィルタが無い
    expect(container.querySelector('table, form, input, select, button')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Stripe 整合チェック: チェックが動いていないのに「整合OK」「不一致は検出されていません」と出さない', async () => {
    await render(<ReconciliationPage />);

    expect(text()).not.toContain('整合OK');
    expect(text()).not.toContain('不一致は検出されていません');
    expect(text()).not.toContain('不一致件数');
  });
});

describe('/admin/finance (売上ダッシュボード)', () => {
  /** 元データが無くても API は 0 を返す。ここでは、画面が値を使っていないことを確かめるため、0 ではない値にしておく */
  const dashboard = {
    current_mrr_jpy: 1_234_567,
    current_arr_jpy: 14_814_804,
    churn_rate: 3.5,
    ltv_jpy: 90_000,
    new_mrr_jpy: 10_000,
    expansion_mrr_jpy: 20_000,
    contraction_mrr_jpy: 3_000,
    churned_mrr_jpy: 4_000,
    personal_active_users: 777,
    family_active_groups: 88,
    org_active_orgs: 9,
    mau: 4321,
  };

  /** admin / super_admin が書き出せる種別。nps があるので、クイックリンクに NPS / CSAT が出る (#1311) */
  const ADMIN_EXPORT_TYPES = ['revenue', 'invoices', 'subscriptions', 'nps'];

  beforeEach(() => {
    // 画面は URL の違う 2 つの API を呼ぶので、URL ごとに応答を分ける。
    // 全部に同じ応答を返すと、クイックリンクが書き出せる種別 (available_types) を読めず、NPS / CSAT のリンクが出ない。
    //   - /api/admin/finance/dashboard: 売上ダッシュボードの値
    //   - /api/admin/finance/exports: 呼んだ本人が書き出せる種別 (FinanceQuickLinks が NPS / CSAT の出し分けに使う)
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === '/api/admin/finance/dashboard') return jsonResponse({ data: dashboard });
      if (url === '/api/admin/finance/exports') return jsonResponse({ data: { available_types: ADMIN_EXPORT_TYPES } });
      return jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
    });
  });

  /** ラベルの文字を持つ要素を含むカード (ラベルの 2 つ上の要素) の文字 */
  function cardText(label: string) {
    const labelEl = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === label);
    expect(labelEl, `${label} のカードが無い`).toBeDefined();
    return labelEl!.parentElement!.parentElement!.textContent ?? '';
  }

  it('今月の MRR・ARR・Churn Rate・LTV は、値ではなく「準備中」を出す', async () => {
    await render(<FinanceDashboardPage />);

    for (const label of ['今月の MRR', 'ARR', 'Churn Rate', 'LTV']) {
      const card = cardText(label);
      expect(card, label).toContain('準備中');
      expect(card, label).toContain(BILLING_NOT_STARTED);
    }
    // 金額・解約率が一つも出ていない (API は 0 以外の値を返している)
    expect(text()).not.toContain('¥');
    expect(text()).not.toContain('3.5%');
  });

  it('MRR 内訳と契約数 (個人課金者・家族グループ・法人) も「準備中」。MAU は実データのまま出す', async () => {
    await render(<FinanceDashboardPage />);

    expect(text()).toContain('MRR 内訳');
    for (const label of ['個人課金者', '家族グループ', '法人']) {
      const labelEl = Array.from(container.querySelectorAll('div')).find((el) => el.textContent === label);
      expect(labelEl?.nextElementSibling?.textContent, label).toBe('準備中');
    }
    // 契約数の元の値 (777 など) が出ていない
    expect(text()).not.toContain('777');

    const mauLabel = Array.from(container.querySelectorAll('div')).find((el) => el.textContent === 'MAU');
    expect(mauLabel?.nextElementSibling?.textContent).toBe('4,321');
  });

  it('Stripe ダッシュボードへのリンクとクイックリンクは残る (NPS / CSAT は admin / super_admin に出る)', async () => {
    await render(<FinanceDashboardPage />);

    expect(container.querySelector('a[href="https://dashboard.stripe.com"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/finance/revenue"]')).not.toBeNull();
    // NPS / CSAT は、書き出せる種別に nps がある人 (admin / super_admin) にだけ出る。出し分けそのものは
    // tests/admin-finance-quick-links.test.tsx が確かめる。ここでは、準備中にした画面でもリンクが残ることを確かめる
    expect(container.querySelector('a[href="/admin/finance/nps"]')).not.toBeNull();
  });

  it('書き出せる種別に nps が無い人 (財務ロール) には、NPS / CSAT のリンクを出さない。ほかのリンクは残る', async () => {
    fetchMock.mockImplementation(async (input: unknown) =>
      String(input) === '/api/admin/finance/dashboard'
        ? jsonResponse({ data: dashboard })
        : jsonResponse({ data: { available_types: ['revenue', 'invoices', 'subscriptions'] } }),
    );

    await render(<FinanceDashboardPage />);

    expect(container.querySelector('a[href="/admin/finance/revenue"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/finance/nps"]')).toBeNull();
  });
});

describe('/admin/moderation (モデレーション一覧)', () => {
  it('「AIコンテンツ（未対応）」の選択肢は選べない。食事画像・レシピは選べる', async () => {
    const page = await renderServerPage(AdminModerationPage({ searchParams: {} }));

    const aiOption = page.querySelector<HTMLOptionElement>('select[name="type"] option[value="ai_content"]');
    expect(aiOption?.textContent?.trim()).toBe(AI_CONTENT_OPTION);
    expect(aiOption?.disabled).toBe(true);
    for (const value of ['', 'food', 'recipe']) {
      const option = page.querySelector<HTMLOptionElement>(`select[name="type"] option[value="${value}"]`);
      expect(option, `value=${value}`).not.toBeNull();
      expect(option?.disabled, `value=${value}`).toBe(false);
    }
  });

  it('一覧の上に、AI コンテンツは審査できないこと (一覧は食事画像とレシピだけ) を書く', async () => {
    const page = await renderServerPage(AdminModerationPage({ searchParams: {} }));

    expect(page.textContent).toContain('AIコンテンツの審査は準備中（未対応）です');
    expect(page.textContent).toContain('食事画像とレシピの通報だけ');
  });

  it('type 未指定の一覧は、従来どおり API からキューを取る (type は付けない)', async () => {
    adminFetch.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 'flag-0001-aaaa',
            type: 'food',
            content_url: null,
            reporter_count: 1,
            user_id: 'user-1',
            status: 'pending',
            created_at: '2026-10-01T00:00:00Z',
          },
        ],
        meta: { total: 1, page: 1, per_page: 30 },
      }),
    );

    const page = await renderServerPage(AdminModerationPage({ searchParams: {} }));

    expect(adminFetch).toHaveBeenCalledTimes(1);
    const url = String(adminFetch.mock.calls[0][0]);
    expect(url).toMatch(/^\/api\/admin\/moderation\/queue\?/);
    expect(url).not.toContain('type=');
    expect(page.querySelector('table')).not.toBeNull();
    expect(page.textContent).toContain('flag-000');
  });

  it('type=food は API に type=food を渡す', async () => {
    await renderServerPage(AdminModerationPage({ searchParams: { type: 'food' } }));

    expect(String(adminFetch.mock.calls[0][0])).toContain('type=food');
  });

  it('URL で type=ai_content を指定されても API を呼ばず、「審査待ちのアイテムはありません」ではなく案内を出す', async () => {
    const page = await renderServerPage(AdminModerationPage({ searchParams: { type: 'ai_content' } }));

    expect(adminFetch).not.toHaveBeenCalled();
    expect(page.textContent).toContain(AI_CONTENT_NOTICE);
    // 一覧の位置には案内の行が 1 つだけ (審査のリンクを持つ行は無い)
    expect(page.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(page.querySelector('tbody a')).toBeNull();
    expect(page.textContent).not.toContain('審査待ちのアイテムはありません');
    expect(page.textContent).not.toContain('アイテムが見つかりません');
    // 件数を 0 と出さない
    expect(page.textContent).not.toMatch(/件数:\s*0/);
  });
});

describe('/admin/moderation/[type]/[id] (個別審査)', () => {
  it('type=ai_content は API を呼ばず、「準備中（未対応）」を出す。404 にしない', async () => {
    const page = await renderServerPage(
      AdminModerationDetailPage({ params: { type: 'ai_content', id: '00000000-0000-4000-8000-000000000001' } }),
    );

    expect(adminFetch).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
    expect(page.textContent).toContain(AI_CONTENT_NOTICE);
    // 審査アクションのフォームを出さない
    expect(page.querySelector('form, select, textarea')).toBeNull();
    expect(page.querySelector('a[href="/admin/moderation"]')).not.toBeNull();
  });

  it('未知の type は従来どおり 404', async () => {
    await expect(
      AdminModerationDetailPage({ params: { type: 'unknown', id: 'x' } }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(adminFetch).not.toHaveBeenCalled();
  });
});
