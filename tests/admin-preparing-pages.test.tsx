/**
 * #1125 #1128 #1911: admin の画面に、まだ動いていない機能を出さない
 *
 * 以前の画面は、動いていない機能を、動いていて問題が無いように見せていた (#1125 #1128)。
 * その後「準備中」「未対応」と明示する形にしたが、#1911 で、未完成の機能は「準備中」とも出さず、画面から出さないことにした。
 *   - 売上・経理: 課金 (Stripe の Webhook・収益の集計バッチ) は動いておらず、請求書・収益推移・整合チェックには元のデータが無い。
 *     ダッシュボードは、元データが無いため MRR・ARR・解約率・LTV・契約数を API が 0 で返す
 *   - モデレーション: AI コンテンツのバックエンドが無く、API は 501 を返す
 * ここでは、ページを実際に描画して、次を確かめる。
 *   - 請求書・収益推移・整合チェック: 404 (notFound)。通信が無い。ダッシュボードのクイックリンクにも並ばない
 *   - ダッシュボード: MRR / ARR / Churn Rate / LTV と契約数のカードを出さない (値も「準備中」も)。MAU は実データのまま出す
 *   - モデレーション: AI コンテンツの選択肢を出さない。URL で ai_content を指定されたら、種類を絞らない一覧として扱う。
 *     個別審査の ai_content は API を呼ばずに 404
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

/** 未完成を示す語。どの画面にも出さない (#1911) */
const PENDING_WORDS = ['準備中', '未対応', '課金は未開始'];

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

  it.each(pages)('$name: 未完成の機能なので「準備中」とも出さず、404 にする。通信が無い', ({ Page }) => {
    expect(() => Page()).toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('今月の MRR・ARR・Churn Rate・LTV・MRR 内訳・契約数のカードを出さない。値も「準備中」も出さない', async () => {
    await render(<FinanceDashboardPage />);

    for (const label of ['今月の MRR', 'ARR', 'Churn Rate', 'LTV', 'MRR 内訳', 'アクティブ契約数', '個人課金者', '家族グループ', '法人']) {
      expect(text(), label).not.toContain(label);
    }
    for (const word of PENDING_WORDS) expect(text(), word).not.toContain(word);
    // 金額・解約率・契約数が一つも出ていない (API は 0 以外の値を返している)
    expect(text()).not.toContain('¥');
    expect(text()).not.toContain('3.5%');
    expect(text()).not.toContain('777');
  });

  it('MAU は実データのまま出す', async () => {
    await render(<FinanceDashboardPage />);

    const mauLabel = Array.from(container.querySelectorAll('div')).find((el) => el.textContent === 'MAU');
    expect(mauLabel?.nextElementSibling?.textContent).toBe('4,321');
  });

  it('Stripe ダッシュボードへのリンクと、使えるクイックリンクは残る。収益推移・請求書一覧・整合チェックへのリンクは出さない', async () => {
    await render(<FinanceDashboardPage />);

    expect(container.querySelector('a[href="https://dashboard.stripe.com"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/finance/exports"]')).not.toBeNull();
    // NPS / CSAT は、書き出せる種別に nps がある人 (admin / super_admin) にだけ出る。出し分けそのものは
    // tests/admin-finance-quick-links.test.tsx が確かめる
    expect(container.querySelector('a[href="/admin/finance/nps"]')).not.toBeNull();
    for (const href of ['/admin/finance/revenue', '/admin/finance/invoices', '/admin/finance/reconciliation']) {
      expect(container.querySelector(`a[href="${href}"]`), href).toBeNull();
    }
  });

  it('書き出せる種別に nps が無い人 (財務ロール) には、NPS / CSAT のリンクを出さない。ほかのリンクは残る', async () => {
    fetchMock.mockImplementation(async (input: unknown) =>
      String(input) === '/api/admin/finance/dashboard'
        ? jsonResponse({ data: dashboard })
        : jsonResponse({ data: { available_types: ['revenue', 'invoices', 'subscriptions'] } }),
    );

    await render(<FinanceDashboardPage />);

    expect(container.querySelector('a[href="/admin/finance/exports"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/finance/nps"]')).toBeNull();
  });
});

describe('/admin/moderation (モデレーション一覧)', () => {
  it('種類の選択肢は、審査できる食事画像・レシピ (と全タイプ) だけ。AI コンテンツの選択肢を出さない', async () => {
    const page = await renderServerPage(AdminModerationPage({ searchParams: {} }));

    const values = Array.from(page.querySelectorAll<HTMLOptionElement>('select[name="type"] option')).map((o) => o.value);
    expect(values).toEqual(['', 'food', 'recipe']);
    expect(page.querySelector('select[name="type"] option:disabled')).toBeNull();
  });

  it('「準備中」「未対応」の文を出さない', async () => {
    const page = await renderServerPage(AdminModerationPage({ searchParams: {} }));

    for (const word of PENDING_WORDS) expect(page.textContent, word).not.toContain(word);
    expect(page.textContent).not.toContain('AIコンテンツ');
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

  it.each(['ai_content', 'unknown'])('URL で type=%s を指定されたら、種類を絞らない一覧 (全タイプ) として API を呼ぶ。案内も「準備中」も出さない', async (type) => {
    const page = await renderServerPage(AdminModerationPage({ searchParams: { type } }));

    expect(adminFetch).toHaveBeenCalledTimes(1);
    expect(String(adminFetch.mock.calls[0][0])).not.toContain('type=');
    expect(page.querySelector<HTMLSelectElement>('select[name="type"]')?.querySelector('option[selected]')?.getAttribute('value') ?? '').toBe('');
    for (const word of PENDING_WORDS) expect(page.textContent, word).not.toContain(word);
  });
});

describe('/admin/moderation/[type]/[id] (個別審査)', () => {
  it('type=ai_content は API を呼ばずに 404 (「準備中」の案内は出さない)', async () => {
    await expect(
      AdminModerationDetailPage({ params: { type: 'ai_content', id: '00000000-0000-4000-8000-000000000001' } }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it('未知の type は従来どおり 404', async () => {
    await expect(
      AdminModerationDetailPage({ params: { type: 'unknown', id: 'x' } }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(adminFetch).not.toHaveBeenCalled();
  });
});
