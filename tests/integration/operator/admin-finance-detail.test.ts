/**
 * Integration tests: 運営の経理 (finance) API (#849 / T07)
 *   GET  /api/admin/finance/invoices
 *   GET  /api/admin/finance/invoices/[id]
 *   POST /api/admin/finance/exports
 *   GET  /api/admin/finance/nps
 *   GET  /api/admin/finance/reconciliation
 *
 * 権限: finance / admin / super_admin。ほかのロール (support など) と一般ユーザーは 403、未認証は 401。
 * ただし NPS / CSAT の集計 (GET nps) と NPS の書き出し (POST exports の export_type=nps) は admin / super_admin だけ。
 * finance は 403 (#1311。財務ロールを NPS / CSAT から外した)。書き出せる種別の一覧 (GET exports) にも、finance には nps を出さない。
 * 入力エラーは 400 を期待する (AC の「422 相当」)。ただし現状の finance ルートは、JSON として読めない本文・不正な日時・
 * 最終ページより先のページ指定を握っておらず、500 になる (reconciliation は検証自体が無い) 箇所がある。
 * その箇所は `[既知の不具合]` の it.fails で固定してある。
 * (#1433 で、exports の本文と nps の期間は入口で検査して 400 を返すようになった。期間は JST の暦日の日付 YYYY-MM-DD)
 *
 * テストデータは service_role で直接 seed する (本番や共有 DB の既存行には依存しない)。
 * 集計系 (nps / revenue / reconciliation) は、他の行と混ざらないよう専用の plan_key / 日付 / 期間で絞る。
 *
 * 既知の不具合 (請求書系): stripe_webhook_events は RLS が `USING (false)` の service_role 専用テーブルだが、
 * invoices / invoices/[id] / exports(type=invoices) はユーザー権限のクライアントで読むため、
 * 行があっても常に空 (一覧) / 404 (詳細) になる。直ったら該当テストの `.fails` を外すこと。
 *
 * 実行: CONTRIBUTING.md の「インテグレーションテスト」(ローカル Supabase + Next dev サーバ) を参照。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth, apiCallRaw } from '../helpers/api';
import {
  TestUserPool,
  dataOf,
  expectError,
  latestAuditLog,
} from '../helpers/admin-test-utils';

const TS = Date.now();
const pool = new TestUserPool(TS, 'findt');

let financeUser: TestUser;
let adminFinanceUser: TestUser; // admin と finance の両方を持つ (finance を外しても admin の権限は残る。#1311)
let adminUser: TestUser;
let superAdminUser: TestUser;
let generalUser: TestUser; // 権限なし (role=user)。NPS の回答者としても使う
let supportUser: TestUser; // 運営だが finance ではない (別ドメインのスタッフは 403)

// seed したデータの識別子 (他のテスト・既存行と混ざらないよう TS 入りにする)
const INVOICE_EVENT_ID = `evt_t849_${TS}`;
const SUBSCRIPTION_ID = `sub_t849_${TS}`;
const CUSTOMER_ID = `cus_t849_${TS}`;
const INVOICE_NUMBER = `T849-${TS}`;
const NPS_PLAN_KEY = `t849-${TS}`;
const NPS_SENT_AT = '2026-05-01T00:00:00Z';
// 期間 (from / to) は画面と同じ日付 (YYYY-MM-DD。JST の暦日。どちらの日も含む)。NPS_SENT_AT (UTC 5/1 0:00) は JST 5/1 9:00 (#1433)
const NPS_SENT_DATE = '2026-05-01';
// 実運用の日次スナップショットと衝突しない過去日。期間フィルタの両端を確かめるため、前後の日にも行を置く
const SNAPSHOT_BEFORE = '2001-02-02';
const SNAPSHOT_DATE = '2001-02-03';
const SNAPSHOT_AFTER = '2001-02-04';
let discrepancyLogId: string | null = null;

const EXPORT_HEADERS = {
  revenue:
    'date,total_mrr_jpy,total_arr_jpy,personal_active_users,org_active_orgs,new_signups,cancellations,computed_at',
  invoices: 'id,event_type,processing_status,received_at,processed_at,error_message',
  subscriptions:
    'id,user_id,plan_key,status,starts_at,current_period_start,current_period_end,cancelled_at,created_at',
  nps: 'id,user_id,score,comment,plan_key,sent_at,responded_at',
} as const;

function csvLines(body: unknown): string[] {
  expect(typeof body, `CSV は文字列で返る。応答本文: ${JSON.stringify(body)}`).toBe('string');
  return (body as string).split('\n');
}

beforeAll(async () => {
  ({ financeUser, adminFinanceUser, adminUser, superAdminUser, generalUser, supportUser } = await pool.createMany({
    financeUser: ['finance'],
    adminFinanceUser: ['admin', 'finance'],
    adminUser: ['admin'],
    superAdminUser: ['super_admin'],
    generalUser: ['user'],
    supportUser: ['support'],
  }));

  // 請求書イベント (Stripe の invoice.paid 相当)
  const { error: invoiceError } = await supabaseAdmin.from('stripe_webhook_events').insert({
    id: INVOICE_EVENT_ID,
    event_type: 'invoice.paid',
    payload: {
      id: INVOICE_EVENT_ID,
      type: 'invoice.paid',
      data: {
        object: {
          id: `in_t849_${TS}`,
          customer: CUSTOMER_ID,
          subscription: SUBSCRIPTION_ID,
          amount_paid: 98000,
          amount_due: 98000,
          currency: 'jpy',
          number: INVOICE_NUMBER,
          invoice_pdf: 'https://example.com/t849-invoice.pdf',
          period_start: 1735689600, // 2025-01-01T00:00:00Z
          period_end: 1738368000, // 2025-02-01T00:00:00Z
        },
      },
    },
    processing_status: 'completed',
    processed_at: new Date().toISOString(),
  });
  if (invoiceError) throw new Error(`seed stripe_webhook_events failed: ${invoiceError.message}`);

  // NPS: 回答 3 件 (10 / 9 / 3 点) + 送信済み・未回答 1 件
  const respondent = generalUser.userId;
  const { error: npsError } = await supabaseAdmin.from('nps_surveys').insert([
    { user_id: respondent, score: 10, comment: 'great', plan_key: NPS_PLAN_KEY, sent_at: NPS_SENT_AT, responded_at: '2026-05-02T00:00:00Z' },
    { user_id: respondent, score: 9, comment: 'good', plan_key: NPS_PLAN_KEY, sent_at: NPS_SENT_AT, responded_at: '2026-05-03T00:00:00Z' },
    { user_id: respondent, score: 3, comment: 'bad', plan_key: NPS_PLAN_KEY, sent_at: NPS_SENT_AT, responded_at: '2026-05-04T00:00:00Z' },
    { user_id: respondent, score: 8, comment: null, plan_key: NPS_PLAN_KEY, sent_at: NPS_SENT_AT, responded_at: null },
  ]);
  if (npsError) throw new Error(`seed nps_surveys failed: ${npsError.message}`);

  // 収益スナップショット (PK = date。前回の取り残しがあっても上書きする)
  const { error: snapshotError } = await supabaseAdmin.from('revenue_snapshots').upsert(
    [
      { date: SNAPSHOT_BEFORE, total_mrr_jpy: 111111, total_arr_jpy: 1333332, new_signups: 1, cancellations: 0 },
      { date: SNAPSHOT_DATE, total_mrr_jpy: 123456, total_arr_jpy: 1481472, new_signups: 7, cancellations: 2 },
      { date: SNAPSHOT_AFTER, total_mrr_jpy: 222222, total_arr_jpy: 2666664, new_signups: 3, cancellations: 1 },
    ],
    { onConflict: 'date' },
  );
  if (snapshotError) throw new Error(`seed revenue_snapshots failed: ${snapshotError.message}`);

  // 整合性チェックの不一致ログ (cron が書く system.stripe.reconcile_discrepancy 相当)
  const { data: log, error: logError } = await supabaseAdmin
    .from('admin_audit_logs')
    .insert({
      actor_id: null,
      action_type: 'system.stripe.reconcile_discrepancy',
      target_id: generalUser.userId,
      target_type: 'user',
      severity: 'warn',
      details: {
        type: 'status_mismatch',
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_status: 'active',
        db_status: 'past_due',
        stripe_amount: 980,
        db_amount: 980,
        detail: 'T849 seeded discrepancy',
      },
    })
    .select('id')
    .single();
  if (logError || !log) throw new Error(`seed reconcile log failed: ${logError?.message}`);
  discrepancyLogId = log.id as string;
}, 60000);

afterAll(async () => {
  // nps_surveys.user_id は auth.users への外部キー (NO ACTION)。ユーザーより先に消す。
  await supabaseAdmin.from('nps_surveys').delete().eq('plan_key', NPS_PLAN_KEY);
  await supabaseAdmin.from('stripe_webhook_events').delete().eq('id', INVOICE_EVENT_ID);
  await supabaseAdmin
    .from('revenue_snapshots')
    .delete()
    .in('date', [SNAPSHOT_BEFORE, SNAPSHOT_DATE, SNAPSHOT_AFTER]);
  if (discrepancyLogId) {
    await supabaseAdmin.from('admin_audit_logs').delete().eq('id', discrepancyLogId);
  }
  await pool.cleanup();
}, 60000);

// ─── GET /api/admin/finance/invoices ──────────────────────────────────────────

describe('GET /api/admin/finance/invoices', () => {
  it('200 for finance role - returns the paginated list shape', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices', financeUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as {
      data: unknown[];
      meta: { total: number; page: number; per_page: number };
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toMatchObject({ page: 1, per_page: 50 });
    expect(typeof body.meta.total).toBe('number');
  });

  it('200 for admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices', adminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices', superAdminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('200 per_page is echoed in meta and caps the page size', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices?page=1&per_page=1', adminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: { page: number; per_page: number } };
    expect(body.meta).toMatchObject({ page: 1, per_page: 1 });
    expect(body.data.length).toBeLessThanOrEqual(1);
  });

  // 既知の不具合: stripe_webhook_events は RLS で service_role 専用 (USING false)。
  // ユーザー権限のクライアントで読むため、seed した行があっても一覧に出ない。
  it.fails('[既知の不具合] 200 lists the seeded invoice event (現状は RLS で常に空)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices?per_page=200', adminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as {
      data: Array<Record<string, unknown>>;
      meta: { total: number };
    };
    const item = body.data.find((i) => i.id === INVOICE_EVENT_ID);
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      event_type: 'invoice.paid',
      stripe_customer_id: CUSTOMER_ID,
      stripe_subscription_id: SUBSCRIPTION_ID,
      amount_paid: 98000,
      currency: 'jpy',
      invoice_number: INVOICE_NUMBER,
      status: 'completed',
    });
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
  });

  // 既知の不具合: InvoiceQuerySchema.parse() の ZodError を握っておらず、汎用の catch で 500 になる。
  // 直ったら `.fails` を外すこと。
  it.fails('[既知の不具合] 400 for invalid status filter (現状は 500 INTERNAL_ERROR)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices?status=INVALID_STATUS', financeUser.jwt);
    expect(res.status).toBe(400);
  });

  it.fails('[既知の不具合] 400 for per_page out of range (現状は 500 INTERNAL_ERROR)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices?per_page=0', financeUser.jwt);
    expect(res.status).toBe(400);
  });

  // 既知の不具合: 最終ページより先を指定すると PostgREST が 416 (Requested range not satisfiable) を返し、
  // それを握らず 500 になる。空のページ (200 + data: []) を返すのが期待。直ったら `.fails` を外すこと。
  it.fails('[既知の不具合] 200 with an empty page when page is beyond the last page (現状は 500)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices?page=1000&per_page=1', financeUser.jwt);
    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toEqual([]);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices', generalUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for support role (staff of another domain)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices', supportUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/finance/invoices');
    expectError(res, 401);
  });
});

// ─── GET /api/admin/finance/invoices/[id] ─────────────────────────────────────

describe('GET /api/admin/finance/invoices/[id]', () => {
  // 既知の不具合: 一覧と同じ。RLS (USING false) のせいで seed した行が見えず、常に 404 になる。
  it.fails('[既知の不具合] 200 for finance role - returns the invoice detail (現状は RLS で常に 404)', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/finance/invoices/${INVOICE_EVENT_ID}`,
      financeUser.jwt,
    );
    const data = dataOf<Record<string, unknown>>(res);
    expect(data).toMatchObject({
      id: INVOICE_EVENT_ID,
      event_type: 'invoice.paid',
      processing_status: 'completed',
      stripe_customer_id: CUSTOMER_ID,
      stripe_subscription_id: SUBSCRIPTION_ID,
      amount_paid: 98000,
      amount_due: 98000,
      currency: 'jpy',
      invoice_number: INVOICE_NUMBER,
      invoice_pdf: 'https://example.com/t849-invoice.pdf',
      period_start: '2025-01-01T00:00:00.000Z',
      period_end: '2025-02-01T00:00:00.000Z',
    });
    expect(data.stripe_links).toMatchObject({
      customer: expect.stringContaining(`/customers/${CUSTOMER_ID}`),
      subscription: expect.stringContaining(`/subscriptions/${SUBSCRIPTION_ID}`),
    });
  });

  it.fails('[既知の不具合] 200 for admin role (現状は RLS で常に 404)', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/finance/invoices/${INVOICE_EVENT_ID}`,
      adminUser.jwt,
    );
    expect(res.status).toBe(200);
  });

  it('404 for a non-existent invoice id', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/finance/invoices/evt_does_not_exist_${TS}`,
      financeUser.jwt,
    );
    expectError(res, 404, 'NOT_FOUND');
  });

  it('403 for general user', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/finance/invoices/${INVOICE_EVENT_ID}`,
      generalUser.jwt,
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for support role (staff of another domain)', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/finance/invoices/${INVOICE_EVENT_ID}`,
      supportUser.jwt,
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', `/api/admin/finance/invoices/${INVOICE_EVENT_ID}`);
    expectError(res, 401);
  });
});

// ─── GET /api/admin/finance/exports ───────────────────────────────────────────

describe('GET /api/admin/finance/exports', () => {
  const NON_NPS_TYPES = ['revenue', 'invoices', 'subscriptions'];

  it('200 for finance role - lists the export types without nps (#1311)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/exports', financeUser.jwt);
    expect(dataOf<{ available_types: string[] }>(res).available_types).toEqual(NON_NPS_TYPES);
  });

  it.each([
    { role: 'admin', user: () => adminUser },
    { role: 'super_admin', user: () => superAdminUser },
  ])('200 for $role role - lists the export types including nps', async ({ user }) => {
    const res = await apiCall('GET', '/api/admin/finance/exports', user().jwt);
    expect(dataOf<{ available_types: string[] }>(res).available_types).toEqual([...NON_NPS_TYPES, 'nps']);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/finance/exports', generalUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for support role (staff of another domain)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/exports', supportUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/finance/exports');
    expectError(res, 401);
  });
});

// ─── POST /api/admin/finance/exports ──────────────────────────────────────────

describe('POST /api/admin/finance/exports', () => {
  const cases = [
    { exportType: 'revenue', role: 'finance' },
    { exportType: 'invoices', role: 'admin' },
    { exportType: 'subscriptions', role: 'super_admin' },
    { exportType: 'subscriptions', role: 'finance' },
    { exportType: 'nps', role: 'admin' },
    { exportType: 'nps', role: 'super_admin' },
  ] as const;

  it.each(cases)(
    '200 for $role role - exports $exportType CSV with the expected header',
    async ({ exportType, role }) => {
      const jwt = { finance: financeUser, admin: adminUser, super_admin: superAdminUser }[role].jwt;
      const res = await apiCall('POST', '/api/admin/finance/exports', jwt, {
        export_type: exportType,
      });
      expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toMatch(
        new RegExp(`^attachment; filename="${exportType}_\\d{4}-\\d{2}-\\d{2}\\.csv"$`),
      );
      expect(csvLines(res.body)[0]).toBe(EXPORT_HEADERS[exportType]);
    },
  );

  it('200 revenue export is filtered by from/to - a single day excludes the days before and after it', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', financeUser.jwt, {
      export_type: 'revenue',
      from: SNAPSHOT_DATE,
      to: SNAPSHOT_DATE,
    });
    expect(res.status).toBe(200);
    const lines = csvLines(res.body);
    expect(lines[0]).toBe(EXPORT_HEADERS.revenue);
    expect(lines).toHaveLength(2);
    // date,total_mrr_jpy,total_arr_jpy,personal_active_users,org_active_orgs,new_signups,cancellations,computed_at
    expect(lines[1].split(',').slice(0, 7)).toEqual([SNAPSHOT_DATE, '123456', '1481472', '0', '0', '7', '2']);
  });

  it('200 revenue export lists the rows in the period newest first', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', adminUser.jwt, {
      export_type: 'revenue',
      from: SNAPSHOT_BEFORE,
      to: SNAPSHOT_AFTER,
    });
    expect(res.status).toBe(200);
    const lines = csvLines(res.body);
    expect(lines[0]).toBe(EXPORT_HEADERS.revenue);
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([
      SNAPSHOT_AFTER,
      SNAPSHOT_DATE,
      SNAPSHOT_BEFORE,
    ]);
  });

  it('200 revenue export is header-only when from/to matches no row', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', adminUser.jwt, {
      export_type: 'revenue',
      from: '2001-01-01',
      to: '2001-01-02',
    });
    expect(res.status).toBe(200);
    expect(csvLines(res.body)).toEqual([EXPORT_HEADERS.revenue]);
  });

  it('200 nps export is filtered by from/to and contains the seeded survey rows', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', adminUser.jwt, {
      export_type: 'nps',
      from: NPS_SENT_DATE,
      to: NPS_SENT_DATE,
    });
    expect(res.status).toBe(200);
    const rows = csvLines(res.body).filter((line) => line.includes(NPS_PLAN_KEY));
    expect(rows).toHaveLength(4);
  });

  // #1311: NPS 回答の書き出しは admin / super_admin だけ。finance は 403 (これまでは RLS で空の CSV になるだけだった)
  it('403 for finance role on the nps export - returns an error instead of a CSV, and leaves no audit log (#1311)', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', financeUser.jwt, {
      export_type: 'nps',
      from: NPS_SENT_DATE,
      to: NPS_SENT_DATE,
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toBeUndefined();
    // seed した NPS 回答が本文に混ざっていない
    expect(JSON.stringify(res.body)).not.toContain(NPS_PLAN_KEY);

    // 監査ログ (admin.finance.export) に nps の記録が作られていない
    const { data, error } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('id')
      .eq('actor_id', financeUser.userId)
      .eq('action_type', 'admin.finance.export')
      .eq('details->>export_type', 'nps');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('200 for a user who has both admin and finance - the nps export still works, and nps is listed', async () => {
    const list = await apiCall('GET', '/api/admin/finance/exports', adminFinanceUser.jwt);
    expect(dataOf<{ available_types: string[] }>(list).available_types).toContain('nps');

    const res = await apiCall('POST', '/api/admin/finance/exports', adminFinanceUser.jwt, {
      export_type: 'nps',
      from: NPS_SENT_DATE,
      to: NPS_SENT_DATE,
    });
    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
    expect(csvLines(res.body).filter((line) => line.includes(NPS_PLAN_KEY))).toHaveLength(4);
  });

  // 既知の不具合: invoices エクスポートも stripe_webhook_events を RLS 越しに読むため、行があっても空。
  it.fails('[既知の不具合] 200 invoices export contains the seeded event (現状は RLS で常にヘッダのみ)', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', adminUser.jwt, {
      export_type: 'invoices',
    });
    expect(res.status).toBe(200);
    expect(csvLines(res.body).some((line) => line.startsWith(INVOICE_EVENT_ID))).toBe(true);
  });

  it('200 writes an audit log (admin.finance.export)', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', adminUser.jwt, {
      export_type: 'subscriptions',
    });
    expect(res.status).toBe(200);
    const log = await latestAuditLog({
      actorId: adminUser.userId,
      actionType: 'admin.finance.export',
    });
    expect(log).not.toBeNull();
    expect(log!.target_type).toBe('finance_data');
    expect(log!.details).toMatchObject({ export_type: 'subscriptions' });
  });

  // #1433 で本文を safeParse し、形の違う本文は 400 (VALIDATION_ERROR) を返すようになった
  // (以前は ExportRequestSchema.parse() の ZodError を握っておらず、汎用の catch で 500 になっていた)
  it('400 for invalid export_type (VALIDATION_ERROR)', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', financeUser.jwt, {
      export_type: 'INVALID_TYPE',
    });
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('400 for missing export_type (VALIDATION_ERROR)', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', financeUser.jwt, {});
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('400 for a period with a time or a non-existent date - from / to take JST calendar dates only (#1433)', async () => {
    for (const period of [{ from: NPS_SENT_AT }, { to: '2026-02-30' }]) {
      const res = await apiCall('POST', '/api/admin/finance/exports', adminUser.jwt, { export_type: 'nps', ...period });
      expectError(res, 400, 'VALIDATION_ERROR');
    }
  });

  // 既知の不具合: request.json() の失敗 (JSON として読めない本文) を握っておらず、汎用の catch で 500 になる。
  // (以前のテストは [400, 422, 500] を許容していて、この不具合を隠していた) 直ったら `.fails` を外すこと。
  it.fails('[既知の不具合] 400 for malformed JSON body (現状は 500 INTERNAL_ERROR)', async () => {
    const res = await apiCallRaw(
      'POST',
      '/api/admin/finance/exports',
      financeUser.jwt,
      '{"export_type": ',
    );
    expect(res.status).toBe(400);
  });

  it('403 for general user', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', generalUser.jwt, {
      export_type: 'revenue',
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for support role (staff of another domain)', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', supportUser.jwt, {
      export_type: 'revenue',
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/admin/finance/exports', {
      export_type: 'revenue',
    });
    expectError(res, 401);
  });
});

// ─── GET /api/admin/finance/nps ───────────────────────────────────────────────

describe('GET /api/admin/finance/nps', () => {
  interface NpsBody {
    data: {
      nps: {
        total_responses: number;
        promoters: number;
        passives: number;
        detractors: number;
        nps_score: number;
        avg_score: number;
        response_rate: number;
        recent_comments: Array<{ score: number; comment: string | null; plan_key: string | null }>;
      };
      csat: { total_responses: number; avg_score: number; score_distribution: Record<string, number> };
    };
  }

  // #1311: NPS / CSAT の集計は admin / super_admin だけ。finance は 403 (これまでは RLS で NPS 0 件・CSAT は本人の分だけの、
  // 誤った集計が返っていた)。admin と finance の両方を持つ人は admin として今までどおり使える。
  it('403 for finance role - no nps / csat data is returned (#1311)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/nps', financeUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
    expect(JSON.stringify(res.body)).not.toContain('recent_comments');
  });

  it('200 for a user who has both admin and finance - aggregates the seeded surveys', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/finance/nps?plan_key=${encodeURIComponent(NPS_PLAN_KEY)}`,
      adminFinanceUser.jwt,
    );
    expect(res.status).toBe(200);
    expect((res.body as NpsBody).data.nps).toMatchObject({ total_responses: 3, nps_score: 33.3 });
  });

  it('200 for admin role - returns nps and csat data in the expected shape', async () => {
    const res = await apiCall('GET', '/api/admin/finance/nps', adminUser.jwt);
    expect(res.status).toBe(200);
    const { nps, csat } = (res.body as NpsBody).data;
    expect(nps).toEqual(
      expect.objectContaining({
        total_responses: expect.any(Number),
        promoters: expect.any(Number),
        passives: expect.any(Number),
        detractors: expect.any(Number),
        nps_score: expect.any(Number),
        avg_score: expect.any(Number),
        response_rate: expect.any(Number),
        recent_comments: expect.any(Array),
      }),
    );
    expect(csat).toEqual(
      expect.objectContaining({
        total_responses: expect.any(Number),
        avg_score: expect.any(Number),
        score_distribution: expect.objectContaining({ '1': expect.any(Number), '5': expect.any(Number) }),
      }),
    );
  });

  it('200 for admin role - aggregates the seeded surveys (plan_key filter)', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/finance/nps?plan_key=${encodeURIComponent(NPS_PLAN_KEY)}`,
      adminUser.jwt,
    );
    expect(res.status).toBe(200);
    const { nps } = (res.body as NpsBody).data;
    // 回答 3 件 (10 / 9 / 3): 推奨者 2・中立 0・批判者 1。
    // NPS = (2-1)/3*100 = 33.3、平均 = 22/3 = 7.3、回答率 = 回答 3 / 送信 4 = 75%
    expect(nps).toMatchObject({
      total_responses: 3,
      promoters: 2,
      passives: 0,
      detractors: 1,
      nps_score: 33.3,
      avg_score: 7.3,
      response_rate: 75,
    });
    // 新しい回答順
    expect(nps.recent_comments.map((c) => c.score)).toEqual([3, 9, 10]);
    expect(nps.recent_comments.map((c) => c.comment)).toEqual(['bad', 'good', 'great']);
    expect(nps.recent_comments.every((c) => c.plan_key === NPS_PLAN_KEY)).toBe(true);
  });

  it('200 for super_admin role - sees the same aggregation', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/finance/nps?plan_key=${encodeURIComponent(NPS_PLAN_KEY)}`,
      superAdminUser.jwt,
    );
    expect(res.status).toBe(200);
    expect((res.body as NpsBody).data.nps).toMatchObject({ total_responses: 3, nps_score: 33.3 });
  });

  it('200 from/to narrows by sent_at (a period before the surveys yields zero)', async () => {
    // to=4/30 は JST 4/30 の終わりまで (= 4/30 14:59:59.999999 UTC)。JST 5/1 9:00 に送った分は入らない (#1433)
    const res = await apiCall(
      'GET',
      `/api/admin/finance/nps?plan_key=${encodeURIComponent(NPS_PLAN_KEY)}&to=2026-04-30`,
      adminUser.jwt,
    );
    expect(res.status).toBe(200);
    expect((res.body as NpsBody).data.nps).toMatchObject({
      total_responses: 0,
      nps_score: 0,
      avg_score: 0,
      response_rate: 0,
      recent_comments: [],
    });
  });

  it('200 an unknown plan_key yields zero responses', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/finance/nps?plan_key=${encodeURIComponent(`unknown-${TS}`)}`,
      adminUser.jwt,
    );
    expect(res.status).toBe(200);
    expect((res.body as NpsBody).data.nps.total_responses).toBe(0);
  });

  // #1433 で from / to を日付 (YYYY-MM-DD の実在する日付) として入口で検査するようになり、不正な値は 400 になった
  // (以前は検査せず DB にそのまま渡し、DB エラーの 500 になっていた)
  it('400 for an invalid from date (VALIDATION_ERROR)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/nps?from=not-a-date', adminUser.jwt);
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('200 from/to of the same day covers the whole JST day (the survey sent at JST 9:00 on that day is counted)', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/finance/nps?plan_key=${encodeURIComponent(NPS_PLAN_KEY)}&from=${NPS_SENT_DATE}&to=${NPS_SENT_DATE}`,
      adminUser.jwt,
    );
    expect(res.status).toBe(200);
    expect((res.body as NpsBody).data.nps).toMatchObject({ total_responses: 3, nps_score: 33.3 });
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/finance/nps', generalUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for support role (staff of another domain)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/nps', supportUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/finance/nps');
    expectError(res, 401);
  });
});

// ─── GET /api/admin/finance/reconciliation ────────────────────────────────────

describe('GET /api/admin/finance/reconciliation', () => {
  interface ReconciliationBody {
    data: {
      discrepancies: Array<Record<string, unknown>>;
      db_summary: { total_active_in_db: number; by_status: Record<string, number> };
      stripe_summary: { stripe_available: boolean };
    };
    meta: { total: number; page: number; per_page: number; note?: string };
  }

  it('200 for admin role - returns the seeded discrepancy, db_summary and stripe_summary', async () => {
    const res = await apiCall('GET', '/api/admin/finance/reconciliation?per_page=100', adminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as ReconciliationBody;

    const item = body.data.discrepancies.find((d) => d.id === discrepancyLogId);
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      type: 'status_mismatch',
      stripe_subscription_id: SUBSCRIPTION_ID,
      stripe_status: 'active',
      db_status: 'past_due',
      stripe_amount: 980,
      db_amount: 980,
      user_id: generalUser.userId,
      detail: 'T849 seeded discrepancy',
    });
    expect(typeof item!.detected_at).toBe('string');

    expect(body.data.db_summary.total_active_in_db).toEqual(expect.any(Number));
    expect(body.data.db_summary.by_status).toEqual(expect.any(Object));
    // Stripe の秘密鍵が無い環境 (CI / ローカル) では stripe_available=false。値そのものは環境次第なので型だけ確認
    expect(typeof body.data.stripe_summary.stripe_available).toBe('boolean');
    expect(body.meta).toMatchObject({ page: 1, per_page: 100 });
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
    expect(body.meta.note).toBeUndefined();
  });

  it('200 for finance role - DB side only, with an explanatory note', async () => {
    const res = await apiCall('GET', '/api/admin/finance/reconciliation', financeUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as ReconciliationBody;
    expect(Array.isArray(body.data.discrepancies)).toBe(true);
    expect(body.data.db_summary).toBeDefined();
    expect(body.meta.note).toContain('finance');
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/reconciliation', superAdminUser.jwt);
    expect(res.status).toBe(200);
    expect((res.body as ReconciliationBody).meta.note).toBeUndefined();
  });

  it('200 per_page caps the page size', async () => {
    const res = await apiCall('GET', '/api/admin/finance/reconciliation?per_page=1', adminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as ReconciliationBody;
    expect(body.data.discrepancies.length).toBeLessThanOrEqual(1);
    expect(body.meta.per_page).toBe(1);
  });

  it('200 from filters out discrepancies detected before it', async () => {
    const res = await apiCall(
      'GET',
      '/api/admin/finance/reconciliation?from=2999-01-01T00:00:00Z',
      adminUser.jwt,
    );
    expect(res.status).toBe(200);
    const body = res.body as ReconciliationBody;
    expect(body.data.discrepancies).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  // 既知の不具合: page / per_page / from / to を検証せず、parseInt の結果や不正な日時をそのまま DB に渡す。
  // page=abc は 200 (meta.page が null)、page=-1・範囲外のページ・不正な日時は DB エラーの 500 になる。
  // 不正な値は 400 (VALIDATION_ERROR)、範囲外のページは空のページ (200) を返すのが期待。
  // 直ったら `.fails` を外すこと。
  const invalidQueries = [
    { name: 'page that is not a number', query: 'page=abc', expected: 400 },
    { name: 'negative page', query: 'page=-1', expected: 400 },
    { name: 'per_page=0', query: 'per_page=0', expected: 400 },
    { name: 'an invalid from date', query: 'from=not-a-date', expected: 400 },
    { name: 'a page beyond the last page (empty page)', query: 'page=1000&per_page=1', expected: 200 },
  ];
  for (const { name, query, expected } of invalidQueries) {
    it.fails(`[既知の不具合] ${expected} for ${name} (現状は検証が無く 200 / 500)`, async () => {
      const res = await apiCall('GET', `/api/admin/finance/reconciliation?${query}`, adminUser.jwt);
      expect(res.status).toBe(expected);
    });
  }

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/finance/reconciliation', generalUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for support role (staff of another domain)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/reconciliation', supportUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/finance/reconciliation');
    expectError(res, 401);
  });
});
