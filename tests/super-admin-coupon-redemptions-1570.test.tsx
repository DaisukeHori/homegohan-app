/**
 * #1570 運営のクーポン詳細 (/super-admin/coupons/[id]) の「適用履歴」タブが常に空だった欠陥の回帰テスト
 *
 * 画面は GET /api/super-admin/coupons/{code}/redemptions とクーポンの code で呼んでいたが、
 * API (src/app/api/super-admin/coupons/[id]/redemptions/route.ts) は coupons.id (uuid) で引くので、いつも 404 だった。
 * その結果、#1326 の閲覧の監査ログ (super_admin.coupon.view_redemptions) も実際の画面からは記録されなかった。
 *
 * 確かめること:
 *   (a) 画面: 「適用履歴」タブを開くと、クーポンの id で API を呼び (code では呼ばない)、返った履歴を表に出す
 *   (b) API: id で呼べば履歴を返し、監査ログ super_admin.coupon.view_redemptions を 1 回だけ記録する。
 *       code で呼ぶと 404 で、監査ログは記録しない (API は id で引く契約のまま)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/plan-detail-page-deprecate.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const COUPON_ID = '15701570-1570-4570-8570-157015701570';
const COUPON_CODE = 'WELCOME1570';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REDEMPTION_ID = 'r-1570';
const DISCOUNT_AMOUNT_JPY = 1234;

const REDEMPTION = {
  id: REDEMPTION_ID,
  coupon_id: COUPON_ID,
  user_id: USER_ID,
  organization_id: null,
  subscription_target: 'personal',
  discount_amount_jpy: DISCOUNT_AMOUNT_JPY,
  redeemed_at: '2026-10-10T03:00:00.000Z',
  ended_at: null,
};

const COUPON = {
  id: COUPON_ID,
  code: COUPON_CODE,
  display_name: '#1570 のテスト',
  discount_type: 'fixed',
  discount_value: 500,
  applicable_to: 'all',
  applicable_plans: [],
  valid_from: '2026-10-01T00:00:00.000Z',
  valid_until: '2026-12-31T14:59:59.000Z',
  max_uses: null,
  uses_count: 1,
  per_user_limit: 1,
  duration_months: null,
  gross_margin_preview_jpy: null,
  status: 'active',
  created_by: ACTOR_ID,
  created_at: '2026-10-01T00:00:00.000Z',
};

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

const mockRequireRole = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: COUPON_ID }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: vi.fn().mockReturnThis(),
  }),
  generateRequestId: () => 'req_test',
}));

type Row = Record<string, unknown>;
type Insert = { table: string; row: Row };

/**
 * テーブルの行を持ち、.eq(列, 値) の条件で実際に絞り込む簡易 Supabase モック。
 * single() は 1 行に絞れたときだけその行を返し、それ以外は PostgREST と同じく error を返す。maybeSingle() は 0 行なら data: null。
 * insert は引数を記録する。order / range などほかのメソッドは受け付けるだけ。
 */
function makeClient(tables: Record<string, Row[]>) {
  const inserts: Insert[] = [];
  const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];
  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    const matched = () => (tables[table] ?? []).filter((row) => filters.every(([col, val]) => row[col] === val));
    const builder: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
              const rows = matched();
              return Promise.resolve({ data: rows, error: null, count: rows.length }).then(onFulfilled, onRejected);
            };
          }
          if (prop === 'eq') {
            return (column: string, value: unknown) => {
              filters.push([column, value]);
              eqCalls.push({ table, column, value });
              return builder;
            };
          }
          if (prop === 'insert') {
            return (row: Row) => {
              inserts.push({ table, row });
              return Promise.resolve({ data: null, error: null });
            };
          }
          if (prop === 'maybeSingle') {
            // 行が無いときは失敗にせず data: null (PostgREST の maybeSingle と同じ。2 行以上は失敗)
            return () => {
              const rows = matched();
              return Promise.resolve(
                rows.length <= 1
                  ? { data: rows[0] ?? null, error: null }
                  : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
              );
            };
          }
          if (prop === 'single') {
            return () => {
              const rows = matched();
              return Promise.resolve(
                rows.length === 1
                  ? { data: rows[0], error: null }
                  : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
              );
            };
          }
          return () => builder;
        },
      },
    );
    return builder;
  });
  return {
    from,
    eqCalls,
    auditRows: () => inserts.filter((i) => i.table === 'admin_audit_logs').map((i) => i.row),
  };
}

let userScopedClient: ReturnType<typeof makeClient>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(userScopedClient),
  getSupabaseAdmin: () => userScopedClient,
}));

const { default: CouponDetailPage } = await import('@/app/super-admin/coupons/[id]/page');
const redemptionsRoute = await import('@/app/api/super-admin/coupons/[id]/redemptions/route');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DETAIL_URL = `/api/super-admin/coupons/${COUPON_ID}`;
const REDEMPTIONS_BY_ID_URL = `/api/super-admin/coupons/${COUPON_ID}/redemptions`;
const REDEMPTIONS_BY_CODE_URL = `/api/super-admin/coupons/${COUPON_CODE}/redemptions`;

async function nextGet(url: string) {
  const { NextRequest } = await import('next/server');
  return new NextRequest(url, { method: 'GET', headers: { 'user-agent': 'vitest' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ id: ACTOR_ID, email: 'super@example.com', roles: ['super_admin'], organization_id: null });
  userScopedClient = makeClient({
    coupons: [{ id: COUPON_ID, code: COUPON_CODE }],
    coupon_redemptions: [REDEMPTION],
    admin_audit_logs: [],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) 画面
// ─────────────────────────────────────────────────────────────────────────────

describe('#1570 クーポン詳細の画面: 適用履歴をクーポンの id で取得する', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  function jsonResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
  }

  beforeEach(() => {
    // 実際の API と同じく、詳細と適用履歴は id のときだけ 200、それ以外 (code など) は 404 を返す
    fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') !== 'GET') throw new Error(`想定していない fetch: ${init?.method} ${url}`);
      if (url === DETAIL_URL) return jsonResponse(200, { data: COUPON });
      if (url === REDEMPTIONS_BY_ID_URL) {
        return jsonResponse(200, { data: [REDEMPTION], meta: { total: 1, page: 1, per_page: 50, coupon_code: COUPON_CODE } });
      }
      return jsonResponse(404, { error: { code: 'OP_COUPON_NOT_FOUND', message: 'クーポンが見つかりません' } });
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

  function fetchedUrls(): string[] {
    return fetchMock.mock.calls.map(([url]) => String(url));
  }

  it('「適用履歴」タブを開くと /api/super-admin/coupons/{id}/redemptions を呼び、返った履歴を表に出す', async () => {
    await act(async () => {
      root.render(<CouponDetailPage />);
    });
    expect(container.textContent).toContain(COUPON_CODE);
    // 詳細タブのままでは適用履歴を取りに行かない
    expect(fetchedUrls().some((u) => u.endsWith('/redemptions'))).toBe(false);

    const tab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('適用履歴'));
    expect(tab).toBeDefined();
    await act(async () => {
      tab!.click();
    });

    const redemptionCalls = fetchedUrls().filter((u) => u.endsWith('/redemptions'));
    expect(redemptionCalls).toEqual([REDEMPTIONS_BY_ID_URL]);
    expect(fetchedUrls()).not.toContain(REDEMPTIONS_BY_CODE_URL);
    // 返った 1 件が表に出る (以前は 404 で常に空だった)
    const bodyRows = container.querySelectorAll('tbody tr');
    expect(bodyRows).toHaveLength(1);
    expect(bodyRows[0].textContent).toContain(`¥${DISCOUNT_AMOUNT_JPY.toLocaleString()}`);
    expect(bodyRows[0].textContent).toContain(USER_ID.slice(0, 8));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) API
// ─────────────────────────────────────────────────────────────────────────────

describe('#1570 GET /api/super-admin/coupons/[id]/redemptions: id で引く', () => {
  it('id で呼ぶと履歴を返し、監査ログ super_admin.coupon.view_redemptions を 1 回だけ記録する', async () => {
    const res = await redemptionsRoute.GET((await nextGet(`http://localhost${REDEMPTIONS_BY_ID_URL}`)) as never, {
      params: { id: COUPON_ID },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; meta: { total: number; coupon_code: string } };
    expect(body.data.map((r) => r.id)).toEqual([REDEMPTION_ID]);
    expect(body.meta).toMatchObject({ total: 1, coupon_code: COUPON_CODE });

    // クーポンは id で引き、履歴はそのクーポンの id で絞る
    expect(userScopedClient.eqCalls).toContainEqual({ table: 'coupons', column: 'id', value: COUPON_ID });
    expect(userScopedClient.eqCalls).toContainEqual({ table: 'coupon_redemptions', column: 'coupon_id', value: COUPON_ID });

    const audits = userScopedClient.auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'super_admin.coupon.view_redemptions',
      target_id: COUPON_ID,
      target_type: 'coupon',
    });
  });

  it('code で呼ぶと 404 で、監査ログは記録しない (API は id で引く契約のまま)', async () => {
    const res = await redemptionsRoute.GET((await nextGet(`http://localhost${REDEMPTIONS_BY_CODE_URL}`)) as never, {
      params: { id: COUPON_CODE },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('OP_COUPON_NOT_FOUND');
    // コードは UUID の形でないので、DB に渡さずに 404 (#1917。uuid 型の列に渡すと 22P02 の失敗になり、500 に入ってしまうため)
    expect(userScopedClient.eqCalls.filter((call) => call.table === 'coupons')).toEqual([]);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });
});
