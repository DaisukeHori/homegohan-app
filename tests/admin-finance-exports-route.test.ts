/**
 * #1311 /api/admin/finance/exports — NPS の書き出しは admin / super_admin だけ
 *
 * これまで finance (財務ロール) も export_type 'nps' (NPS 回答の CSV。user_id とコメント付き) を書き出せた。
 * ただし nps_surveys を読む RLS (nps_select_admin) は finance を許していないため、出てくるのは空の CSV だけだった。
 * オーナー判断 (2026-10-08) で、財務ロールを NPS / CSAT の集計と書き出しから外した。確認すること:
 *   - POST export_type 'nps': finance だけの人は 403。DB を読まず、監査ログも作らず、CSV を返さない。
 *     admin / super_admin (admin と finance の両方を持つ人を含む) は今までどおり 200 で CSV。
 *   - GET (書き出せる種別の一覧): finance には nps を出さない。admin / super_admin には今までどおり出す。
 *     管理画面 (財務ダッシュボードのクイックリンク) はこの一覧を見て NPS / CSAT のリンクを出すか決める。
 *   - nps 以外 (revenue / invoices / subscriptions) は、finance も今までどおり書き出せる。
 *   - 入口の認可 (未認証は 401、support や一般ユーザーは 403) は変えない。
 *
 * #1433: 期間 (from / to。画面の日付の入力。どちらの日も含む) を JST の暦日で絞る。
 *   invoices (received_at)・subscriptions (created_at)・nps (sent_at) は timestamptz の列なので、以前のように日付の文字列を
 *   そのまま .gte / .lte に渡さず (DB は UTC の 0 時 = JST 9 時と読み、開始日の JST 0:00〜8:59 の行と、
 *   終了日の JST 9:00 以降の行が落ちていた)、開始日の JST 0 時以上 (.gte)・終了日の翌日の JST 0 時未満 (.lt) で絞る。
 *   revenue (revenue_snapshots.date) は date 型の列 (暦日そのもの) なので、日付のまま .gte / .lte。
 *   本文の形が違う (存在しない日付・時刻つきの期間・知らない種別) ときは 400 (DB を読まず、監査ログも作らない)。
 *
 * Supabase クライアントはモック。route 全体の結果は tests/integration/operator/admin-finance-detail.test.ts で、
 * 実 DB を使って検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthError, ForbiddenError } from '../src/lib/auth/errors';
import { TEST_TIME_ZONES, withTimeZoneAsync } from './helpers/time-zones';
import { JST_1010_BOUNDARY_TIMES, satisfiesRangeFilters, type RangeFilter } from './helpers/timestamptz';

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}

interface Chain {
  table: string;
  calls: ChainCall[];
}

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  /** from() を呼ぶたびに 1 件ずつ増える (呼んだテーブルと、そのあとに呼んだメソッド) */
  chains: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
  /** テーブルごとの取得結果 */
  tableResults: {} as Record<string, { data: unknown; error: unknown }>,
}));

/** PostgrestFilterBuilder 相当: どのメソッドでも自分自身を返し、await すると tableResults で解決する */
function makeBuilder(table: string) {
  const chain: Chain = { table, calls: [] };
  mocks.chains.push(chain);
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown) =>
            resolve(mocks.tableResults[table] ?? { data: [], error: null });
        }
        return (...args: unknown[]) => {
          chain.calls.push({ method: String(prop), args });
          return builder;
        };
      },
    },
  );
  return builder;
}

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    from: (table: string) => makeBuilder(table),
  }),
}));

import { GET, POST } from '../src/app/api/admin/finance/exports/route';

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ・ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = 'actor-id';
const NPS_COMMENT = 'NPS の本音コメント';

const NPS_ROWS = [
  {
    id: 'n1',
    user_id: 'respondent-1',
    score: 9,
    comment: NPS_COMMENT,
    plan_key: 'pro',
    sent_at: '2026-03-01T00:00:00+00:00',
    responded_at: '2026-03-02T00:00:00+00:00',
  },
];

const NPS_CSV_HEADER = 'id,user_id,score,comment,plan_key,sent_at,responded_at';

/** 非 nps の種別ごとに、route が読むテーブルと CSV の 1 行目 */
const OTHER_TYPES = [
  {
    exportType: 'revenue',
    table: 'revenue_snapshots',
    header: 'date,total_mrr_jpy,total_arr_jpy,personal_active_users,org_active_orgs,new_signups,cancellations,computed_at',
  },
  {
    exportType: 'invoices',
    table: 'stripe_webhook_events',
    header: 'id,event_type,processing_status,received_at,processed_at,error_message',
  },
  {
    exportType: 'subscriptions',
    table: 'personal_subscriptions',
    header: 'id,user_id,plan_key,status,starts_at,current_period_start,current_period_end,cancelled_at,created_at',
  },
] as const;

/**
 * 本物の requireRole と同じく、route が渡した許可ロールと本人のロールの重なりで判定する。
 * (route が許可ロールの一覧を間違えたら、ここで気づける。呼び出しの引数だけを見るテストでは分からない)
 */
function actAs(...roles: string[]) {
  mocks.requireRole.mockImplementation(async (allowedRoles: readonly string[]) => {
    if (!roles.some((role) => allowedRoles.includes(role))) {
      throw new ForbiddenError('PERM_DENIED', `Requires one of: ${allowedRoles.join(', ')}`);
    }
    return { id: ACTOR_ID, email: 'actor@example.com', roles, organization_id: null };
  });
}

function getRequest() {
  return new NextRequest('http://localhost/api/admin/finance/exports');
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/admin/finance/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function chainsOf(table: string): Chain[] {
  return mocks.chains.filter((c) => c.table === table);
}

function callsOf(chain: Chain, method: string): unknown[][] {
  return chain.calls.filter((c) => c.method === method).map((c) => c.args);
}

/** 監査ログ (admin_audit_logs) に insert した内容 */
function auditInserts(): unknown[] {
  return chainsOf('admin_audit_logs').flatMap((chain) => callsOf(chain, 'insert').map((args) => args[0]));
}

interface AvailableTypesBody {
  data: { available_types: string[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chains.length = 0;
  mocks.tableResults = {
    nps_surveys: { data: NPS_ROWS, error: null },
    revenue_snapshots: { data: [{ date: '2026-03-01', total_mrr_jpy: 1000 }], error: null },
    stripe_webhook_events: { data: [], error: null },
    personal_subscriptions: { data: [], error: null },
  };
  actAs('admin');
});

// ═════════════════════════════════════════════════════════════════════════════
// GET: 書き出せる種別の一覧
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/finance/exports — 書き出せる種別', () => {
  it.each([
    ['admin', ['admin']],
    ['super_admin', ['super_admin']],
    ['admin と finance の両方を持つ人', ['admin', 'finance']],
  ])('%s には nps を含む 4 種別を返す (今までどおり)', async (_label, roles) => {
    actAs(...roles);
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(((await res.json()) as AvailableTypesBody).data.available_types).toEqual([
      'revenue',
      'invoices',
      'subscriptions',
      'nps',
    ]);
  });

  it('財務ロール (finance) だけの人には nps を出さない (#1311)', async () => {
    actAs('finance');
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(((await res.json()) as AvailableTypesBody).data.available_types).toEqual([
      'revenue',
      'invoices',
      'subscriptions',
    ]);
  });

  it('入口の許可ロールは admin / super_admin / finance (finance も一覧は見られる)。DB には何も問い合わせない', async () => {
    actAs('finance');
    await GET(getRequest());
    expect(mocks.requireRole).toHaveBeenCalledTimes(1);
    expect(mocks.requireRole).toHaveBeenCalledWith(['admin', 'super_admin', 'finance']);
    expect(mocks.chains).toHaveLength(0);
  });

  it.each([
    ['support', ['support']],
    ['sales', ['sales']],
    ['一般ユーザー', ['user']],
  ])('%s は 403', async (_label, roles) => {
    actAs(...roles);
    const res = await GET(getRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } });
  });

  it('未認証は 401', async () => {
    mocks.requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: '認証が必要です' } });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST: NPS の書き出し
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/finance/exports — NPS の書き出しは admin / super_admin だけ (#1311)', () => {
  it('財務ロール (finance) だけの人は 403。DB を読まず、監査ログも作らず、CSV を返さない', async () => {
    actAs('finance');
    const res = await POST(postRequest({ export_type: 'nps' }));

    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Content-Disposition')).toBeNull();
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: 'OP_PERMISSION_DENIED', message: 'Requires one of: admin, super_admin' },
    });
    // DB が行を返す状態 (RLS の設定ミスなど) でも、中身は本文に出ない
    expect(text).not.toContain(NPS_COMMENT);
    expect(text).not.toContain('respondent-1');

    expect(mocks.chains).toHaveLength(0);
    expect(auditInserts()).toEqual([]);
  });

  it('期間を付けても同じ (finance は 403)', async () => {
    actAs('finance');
    const res = await POST(postRequest({ export_type: 'nps', from: '2026-03-01', to: '2026-03-31' }));
    expect(res.status).toBe(403);
    expect(mocks.chains).toHaveLength(0);
  });

  it('入口 (admin / super_admin / finance) を通ったあと、NPS だけ admin / super_admin で確かめ直す', async () => {
    await POST(postRequest({ export_type: 'nps' }));
    expect(mocks.requireRole.mock.calls).toEqual([
      [['admin', 'super_admin', 'finance']],
      [['admin', 'super_admin']],
    ]);
  });

  it.each([
    ['admin', ['admin']],
    ['super_admin', ['super_admin']],
    ['admin と finance の両方を持つ人', ['admin', 'finance']],
  ])('%s は 200 で NPS の CSV (今までどおり)。期間で絞り、監査ログを残す', async (_label, roles) => {
    actAs(...roles);
    const res = await POST(postRequest({ export_type: 'nps', from: '2026-03-01', to: '2026-03-31' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="nps_\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await res.text()).split('\n');
    expect(lines[0]).toBe(NPS_CSV_HEADER);
    expect(lines[1]).toContain(NPS_COMMENT);
    expect(lines).toHaveLength(2);

    const chains = chainsOf('nps_surveys');
    expect(chains).toHaveLength(1);
    expect(callsOf(chains[0], 'select')).toEqual([['id, user_id, score, comment, plan_key, sent_at, responded_at']]);
    // 送信日 (sent_at。timestamptz) は、開始日 3/1 の JST 0 時以上・終了日 3/31 の翌日の JST 0 時未満 (#1433)
    expect(callsOf(chains[0], 'gte')).toEqual([['sent_at', '2026-02-28T15:00:00.000Z']]);
    expect(callsOf(chains[0], 'lt')).toEqual([['sent_at', '2026-03-31T15:00:00.000Z']]);
    expect(callsOf(chains[0], 'lte')).toEqual([]);
    // 監査ログには、画面で選んだ日付をそのまま残す
    expect(auditInserts()).toEqual([
      expect.objectContaining({
        actor_id: ACTOR_ID,
        action_type: 'admin.finance.export',
        details: { export_type: 'nps', from: '2026-03-01', to: '2026-03-31' },
      }),
    ]);
  });

  it.each([
    ['support', ['support']],
    ['一般ユーザー', ['user']],
  ])('%s は入口で 403 (NPS でも他の種別でも同じ)。DB には何も問い合わせない', async (_label, roles) => {
    actAs(...roles);
    const res = await POST(postRequest({ export_type: 'nps' }));
    expect(res.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledTimes(1);
    expect(mocks.chains).toHaveLength(0);
  });

  it('未認証は 401', async () => {
    mocks.requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    const res = await POST(postRequest({ export_type: 'nps' }));
    expect(res.status).toBe(401);
    expect(mocks.chains).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST: nps 以外は変えない
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/finance/exports — nps 以外の種別は、finance も今までどおり', () => {
  it.each(OTHER_TYPES)('finance は $exportType を 200 で書き出せる。NPS 用の確かめ直しはしない', async ({ exportType, table, header }) => {
    actAs('finance');
    const res = await POST(postRequest({ export_type: exportType }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toContain(`filename="${exportType}_`);
    expect((await res.text()).split('\n')[0]).toBe(header);

    // 入口の 1 回だけ。nps_surveys には触れない
    expect(mocks.requireRole).toHaveBeenCalledTimes(1);
    expect(mocks.requireRole).toHaveBeenCalledWith(['admin', 'super_admin', 'finance']);
    expect(chainsOf(table)).toHaveLength(1);
    expect(chainsOf('nps_surveys')).toHaveLength(0);
    expect(auditInserts()).toEqual([
      expect.objectContaining({ actor_id: ACTOR_ID, action_type: 'admin.finance.export', details: expect.objectContaining({ export_type: exportType }) }),
    ]);
  });

  it.each(OTHER_TYPES)('admin も $exportType を 200 で書き出せる', async ({ exportType, header }) => {
    actAs('admin');
    const res = await POST(postRequest({ export_type: exportType }));
    expect(res.status).toBe(200);
    expect((await res.text()).split('\n')[0]).toBe(header);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST: 期間は JST の暦日 (#1433)
// ═════════════════════════════════════════════════════════════════════════════

/** timestamptz の列で期間を絞る種別 (route が読むテーブルと、期間の列) */
const TIMESTAMPTZ_PERIOD_TYPES = [
  { exportType: 'invoices', table: 'stripe_webhook_events', column: 'received_at' },
  { exportType: 'subscriptions', table: 'personal_subscriptions', column: 'created_at' },
  { exportType: 'nps', table: 'nps_surveys', column: 'sent_at' },
] as const;

/** テーブルの問い合わせに付いた、列 column の範囲の絞り込み */
function rangeFiltersOf(table: string, column: string): RangeFilter[] {
  return chainsOf(table).flatMap((chain) =>
    chain.calls
      .filter((c) => ['gte', 'gt', 'lte', 'lt'].includes(c.method) && c.args[0] === column)
      .map((c) => ({ method: c.method as RangeFilter['method'], value: String(c.args[1]) })),
  );
}

describe.each(TIMESTAMPTZ_PERIOD_TYPES)('POST /api/admin/finance/exports — $exportType の期間 ($column) は JST の暦日 (#1433)', ({ exportType, table, column }) => {
  it.each(TEST_TIME_ZONES)(
    'TZ=%s でも、from=to=10/10 は JST 10/10 0:00 〜 23:59:59.999999 の行だけ (JST 0:00 ちょうど・8:59:59 は入り、翌日の 0:00 は入らない)',
    async (tz) => {
      const res = await withTimeZoneAsync(tz, () => POST(postRequest({ export_type: exportType, from: '2026-10-10', to: '2026-10-10' })));
      expect(res.status).toBe(200);
      const filters = rangeFiltersOf(table, column);
      expect(filters).toEqual([
        { method: 'gte', value: '2026-10-09T15:00:00.000Z' },
        { method: 'lt', value: '2026-10-10T15:00:00.000Z' },
      ]);
      // 実際に残る行 (timestamptz と同じくマイクロ秒の精度で比べる)
      expect(JST_1010_BOUNDARY_TIMES.filter((row) => satisfiesRangeFilters(row.at, filters)).map((row) => row.id)).toEqual(
        JST_1010_BOUNDARY_TIMES.filter((row) => row.inJst1010).map((row) => row.id),
      );
    },
  );

  it('以前の書き方 (日付の文字列をそのまま .gte / .lte) では、JST 10/10 の 9:00 ちょうどの行しか残らなかった (直した不具合)', () => {
    const legacy: RangeFilter[] = [
      { method: 'gte', value: '2026-10-10T00:00:00Z' }, // DB は '2026-10-10' を UTC の 0 時と読む
      { method: 'lte', value: '2026-10-10T00:00:00Z' },
    ];
    expect(JST_1010_BOUNDARY_TIMES.filter((row) => satisfiesRangeFilters(row.at, legacy)).map((row) => row.id)).toEqual([
      'jst-10-10-09:00',
    ]);
  });

  it.each([
    ['開始日だけ', { from: '2026-10-10' }, [{ method: 'gte', value: '2026-10-09T15:00:00.000Z' }]],
    ['終了日だけ', { to: '2026-10-10' }, [{ method: 'lt', value: '2026-10-10T15:00:00.000Z' }]],
    [
      '月末をまたぐ (10/31 〜 11/1)',
      { from: '2026-10-31', to: '2026-11-01' },
      [
        { method: 'gte', value: '2026-10-30T15:00:00.000Z' },
        { method: 'lt', value: '2026-11-01T15:00:00.000Z' },
      ],
    ],
    [
      '年末をまたぐ (12/31 〜 1/1)',
      { from: '2026-12-31', to: '2027-01-01' },
      [
        { method: 'gte', value: '2026-12-30T15:00:00.000Z' },
        { method: 'lt', value: '2027-01-01T15:00:00.000Z' },
      ],
    ],
    ['期間なし', {}, []],
    ['空欄 (空文字) は「指定なし」', { from: '', to: '' }, []],
  ] as const)('%s', async (_label, period, expected) => {
    const res = await POST(postRequest({ export_type: exportType, ...period }));
    expect(res.status).toBe(200);
    expect(rangeFiltersOf(table, column)).toEqual(expected);
  });
});

describe('POST /api/admin/finance/exports — revenue (date 型の列) は日付のまま両端を含めて絞る', () => {
  it('from / to をそのまま .gte / .lte に渡す (暦日そのものの列なので、時刻に直さない)', async () => {
    const res = await POST(postRequest({ export_type: 'revenue', from: '2026-10-10', to: '2026-10-10' }));
    expect(res.status).toBe(200);
    const chains = chainsOf('revenue_snapshots');
    expect(chains).toHaveLength(1);
    expect(callsOf(chains[0], 'gte')).toEqual([['date', '2026-10-10']]);
    expect(callsOf(chains[0], 'lte')).toEqual([['date', '2026-10-10']]);
    expect(callsOf(chains[0], 'lt')).toEqual([]);
  });
});

describe('POST /api/admin/finance/exports — 本文の形が違うときは 400 (#1433)', () => {
  it.each([
    ['存在しない日付', { export_type: 'invoices', from: '2026-02-30' }],
    ['形の違う日付', { export_type: 'subscriptions', to: '2026/10/10' }],
    ['時刻つきの期間 (日付だけを受ける)', { export_type: 'nps', to: '2026-03-31T23:59:59Z' }],
    ['日付でない文字列', { export_type: 'revenue', from: 'garbage' }],
    ['知らない種別', { export_type: 'INVALID_TYPE' }],
    ['種別なし', {}],
  ])('%s は 400 (VALIDATION_ERROR)。DB を読まず、監査ログも作らない', async (_label, body) => {
    const res = await POST(postRequest(body));
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect(mocks.chains).toHaveLength(0);
    expect(auditInserts()).toEqual([]);
  });

  it('400 より先に入口の認可を確かめる (一般ユーザーは、本文の形が違っても 403)', async () => {
    actAs('user');
    const res = await POST(postRequest({ export_type: 'nps', from: '2026-02-30' }));
    expect(res.status).toBe(403);
    expect(mocks.chains).toHaveLength(0);
  });
});
