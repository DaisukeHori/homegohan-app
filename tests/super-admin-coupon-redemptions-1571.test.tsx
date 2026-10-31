/**
 * #1571 運営のクーポン詳細 (/super-admin/coupons/[id]) の「適用履歴」タブ
 *
 * #1570 の整合のコメントで見つかった 2 点の回帰テスト:
 *   (a) 適用履歴の取得 (fetchRedemptions) は res.ok を見ず、失敗を黙って捨てていた (#1570 の 404 が長く気づかれなかった)。
 *       失敗を画面に出す。1 ページ目が取れなかったときは、前に読んだ履歴を残さない
 *   (b) API の既定 (1 ページ 50 件) の先頭のページしか出していなかった。残りは「さらに読み込む」で次のページを足す
 *       (1 ページ目は ?page を付けずに API の既定で呼び、2 ページ目からは ?page=N)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/super-admin-coupon-redemptions-1570.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const COUPON_ID = '15711571-1571-4571-8571-157115711571';
const COUPON_CODE = 'SPRING1571';
const DETAIL_URL = `/api/super-admin/coupons/${COUPON_ID}`;
const REDEMPTIONS_URL = `/api/super-admin/coupons/${COUPON_ID}/redemptions`;
const NOT_FOUND_MESSAGE = 'クーポンが見つかりません';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: COUPON_ID }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const COUPON = {
  id: COUPON_ID,
  code: COUPON_CODE,
  display_name: '#1571 のテスト',
  discount_type: 'fixed',
  discount_value: 500,
  applicable_to: 'all',
  applicable_plans: [],
  valid_from: '2026-10-01T00:00:00.000Z',
  valid_until: '2026-12-31T14:59:59.000Z',
  max_uses: null,
  uses_count: 3,
  per_user_limit: 1,
  duration_months: null,
  gross_margin_preview_jpy: null,
  status: 'active',
  created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  created_at: '2026-10-01T00:00:00.000Z',
};

/** 適用履歴の 1 行。割引額で見分ける */
function redemption(index: number) {
  return {
    id: `r-${index}`,
    user_id: `${index}`.padStart(8, '0') + '-user-0000-0000-000000000000',
    organization_id: null,
    subscription_target: 'personal',
    discount_amount_jpy: 1000 + index,
    redeemed_at: '2026-10-10T03:00:00.000Z',
    ended_at: null,
  };
}

const { default: CouponDetailPage } = await import('@/app/super-admin/coupons/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
/** 適用履歴の URL ごとの応答 (詳細は常に 200) */
let redemptionResponses: Record<string, FakeResponse | Error>;

beforeEach(() => {
  redemptionResponses = {};
  fetchMock = vi.fn(async (url: string) => {
    if (url === DETAIL_URL) return jsonResponse(200, { data: COUPON });
    const response = redemptionResponses[url];
    if (response instanceof Error) throw response;
    if (response) return response;
    throw new Error(`想定していない fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

async function openRedemptionsTab() {
  await act(async () => {
    root.render(<CouponDetailPage />);
  });
  await act(async () => {
    button('適用履歴')!.click();
  });
}

function shownAmounts(): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map((tr) => tr.textContent ?? '');
}

function redemptionUrls(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.startsWith(REDEMPTIONS_URL));
}

describe('(a) 取得の失敗を画面に出す', () => {
  it('API が 404 を返したら、その理由を画面に出し、「適用履歴がありません」とは言わない', async () => {
    redemptionResponses[REDEMPTIONS_URL] = jsonResponse(404, { error: { code: 'OP_COUPON_NOT_FOUND', message: NOT_FOUND_MESSAGE } });

    await openRedemptionsTab();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(NOT_FOUND_MESSAGE);
    expect(container.textContent).not.toContain('適用履歴がありません');
  });

  it('API が 401 (ログインが切れた) を返したら、本文の文ではなく「ログインし直してください」を出す (#2112 Z4)', async () => {
    redemptionResponses[REDEMPTIONS_URL] = jsonResponse(401, { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } });

    await openRedemptionsTab();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('ログインし直してください');
    expect(container.textContent).not.toContain('認証が必要です');
    expect(container.textContent).not.toContain('適用履歴がありません');
  });

  it('本文が JSON でない失敗 (500 の HTML など) でも、決まった文で失敗を出す', async () => {
    redemptionResponses[REDEMPTIONS_URL] = { ok: false, status: 500, json: () => Promise.reject(new SyntaxError('not json')) };

    await openRedemptionsTab();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('適用履歴の取得に失敗しました');
  });

  it('通信の失敗も画面に出す', async () => {
    redemptionResponses[REDEMPTIONS_URL] = new TypeError('Failed to fetch');

    await openRedemptionsTab();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('ネットワークエラー');
  });

  it('タブを開き直して 1 ページ目が取れなかったら、前に読んだ履歴を残さない', async () => {
    redemptionResponses[REDEMPTIONS_URL] = jsonResponse(200, { data: [redemption(1)], meta: { total: 1, page: 1, per_page: 50 } });
    await openRedemptionsTab();
    expect(shownAmounts()).toHaveLength(1);

    redemptionResponses[REDEMPTIONS_URL] = jsonResponse(500, { error: { message: '内部エラー' } });
    await act(async () => {
      button('詳細')!.click();
    });
    await act(async () => {
      button('適用履歴')!.click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('内部エラー');
    expect(container.textContent).not.toContain(`¥${(1001).toLocaleString()}`);
  });
});

describe('(b) 「さらに読み込む」で次のページを取る', () => {
  it('合計が表示した件数より多ければボタンを出し、押すと ?page=2 を足して表示し、全部読んだらボタンを消す', async () => {
    redemptionResponses[REDEMPTIONS_URL] = jsonResponse(200, {
      data: [redemption(1), redemption(2)],
      meta: { total: 3, page: 1, per_page: 2, coupon_code: COUPON_CODE },
    });
    redemptionResponses[`${REDEMPTIONS_URL}?page=2`] = jsonResponse(200, {
      data: [redemption(3)],
      meta: { total: 3, page: 2, per_page: 2, coupon_code: COUPON_CODE },
    });

    await openRedemptionsTab();

    // 1 ページ目は API の既定 (?page を付けない) で呼ぶ
    expect(redemptionUrls()).toEqual([REDEMPTIONS_URL]);
    expect(shownAmounts()).toHaveLength(2);
    expect(container.textContent).toContain('2 / 3 件を表示');
    const loadMore = container.querySelector<HTMLButtonElement>('[data-testid="redemptions-load-more"]');
    expect(loadMore?.textContent).toContain('さらに読み込む');

    await act(async () => {
      loadMore!.click();
    });

    expect(redemptionUrls()).toEqual([REDEMPTIONS_URL, `${REDEMPTIONS_URL}?page=2`]);
    const rows = shownAmounts();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain(`¥${(1003).toLocaleString()}`);
    expect(container.querySelector('[data-testid="redemptions-load-more"]')).toBeNull();
  });

  it('全部が 1 ページに収まるときはボタンを出さない', async () => {
    redemptionResponses[REDEMPTIONS_URL] = jsonResponse(200, { data: [redemption(1)], meta: { total: 1, page: 1, per_page: 50 } });

    await openRedemptionsTab();

    expect(shownAmounts()).toHaveLength(1);
    expect(container.querySelector('[data-testid="redemptions-load-more"]')).toBeNull();
  });

  it('次のページの取得に失敗したら、読んだ分は残して失敗を出し、ボタンで取り直せる', async () => {
    redemptionResponses[REDEMPTIONS_URL] = jsonResponse(200, { data: [redemption(1), redemption(2)], meta: { total: 3, page: 1, per_page: 2 } });
    redemptionResponses[`${REDEMPTIONS_URL}?page=2`] = jsonResponse(500, { error: { message: '内部エラー' } });

    await openRedemptionsTab();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="redemptions-load-more"]')!.click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('内部エラー');
    expect(shownAmounts()).toHaveLength(2);

    redemptionResponses[`${REDEMPTIONS_URL}?page=2`] = jsonResponse(200, { data: [redemption(3)], meta: { total: 3, page: 2, per_page: 2 } });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="redemptions-load-more"]')!.click();
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(shownAmounts()).toHaveLength(3);
  });
});
