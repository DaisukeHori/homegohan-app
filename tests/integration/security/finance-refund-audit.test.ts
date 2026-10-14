/**
 * #1185 POST /api/admin/finance/refunds の回帰テスト (実 DB + 実ルート)
 *
 * このアプリは返金を実行しない。担当者が Stripe ダッシュボードで返金する前に、
 * 「誰が・いつ・誰に・いくら・なぜ」を admin_audit_logs に記録し、記録できたときだけ
 * Stripe ダッシュボードのリンクを返す。修正前は返金の記録口そのものが無く、
 * 返金をしても社内の監査ログに何も残らなかった。
 * 単体テスト (tests/admin-finance-refunds-route.test.ts) は Supabase をモックしているため、
 * RLS (audit_logs_insert_admins) と本物のテーブルに通ることはここで確かめる。
 *
 * 期待する挙動:
 *   - 未認証は 401、support / 一般ユーザーは 403。どちらも監査ログは作られない
 *     (admin_audit_logs の RLS は support にも INSERT を許すので、止めているのは route の権限確認)
 *   - 不正な入力は 400 で、監査ログは作られない
 *   - finance / admin / super_admin は 200。action_type = 'admin.refund.issue' の行が
 *     ちょうど 1 件、呼び出した本人を actor として作られる (金額・通貨・理由・Stripe の ID 入り)
 *   - x-forwarded-for が複数の IP や IP でない値でも記録できる (ip_address は inet 型。そのまま入れると INSERT が失敗する)
 *   - finance は監査ログを読み戻せない (SELECT できるのは super_admin / admin だけ) ので、
 *     route は INSERT の結果だけを見る。また他人名義の行は finance の権限では作れない
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/finance-refund-audit.test.ts
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const asUser = (jwt: string) => client(anonKey, jwt);

const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const PATH = '/api/admin/finance/refunds';
const ACTION_TYPE = 'admin.refund.issue';
const TEST_USER_AGENT = 'finance-refund-audit-test/1185';

interface TestUser {
  id: string;
  jwt: string;
}

interface AuditRow {
  id: string;
  actor_id: string | null;
  action_type: string;
  target_id: string | null;
  target_type: string | null;
  severity: string;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string | null;
}

const TS = Date.now();
const TAG = `#1185-${TS}`;
const createdUserIds: string[] = [];

async function createUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `sec-refund-${label}-${TS}@homegohan.test`;
  // テスト用ユーザーのパスワードは固定値を置かず、実行ごとに作る
  const password = `Aa1!${randomUUID()}`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  // roles は特権列なので service_role で設定する (本人の JWT では変更できない)
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert(
      { id: data.user.id, nickname: `refund-${label}`, age_group: '30s', gender: 'other', roles },
      { onConflict: 'id' },
    );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

let finance: TestUser;
let admin: TestUser;
let superAdmin: TestUser;
let support: TestUser;
let plainUser: TestUser;
let customer: TestUser; // 返金される側のユーザー

const INVOICE_ID = 'in_1MtHbELkdIwHu7ixl4OzzPMv';
const CHARGE_ID = 'ch_3MmlLrLkdIwHu7ix0snN0B15';

/** テストごとに理由を変えて、そのテストで作られた行だけを見分ける */
let reasonSeq = 0;
function uniqueReason(label: string): string {
  reasonSeq += 1;
  return `${TAG} ${label} ${reasonSeq}`;
}

function validBody(reason: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: customer.id,
    stripe_invoice_id: INVOICE_ID,
    amount: 1200,
    currency: 'JPY',
    reason,
    ...overrides,
  };
}

/** この返金対象のユーザーに作られた返金の記録のうち、reason が一致するもの (service_role で読む) */
async function refundRows(reason: string): Promise<AuditRow[]> {
  const { data, error } = await srAdmin
    .from('admin_audit_logs')
    .select('id, actor_id, action_type, target_id, target_type, severity, details, ip_address, user_agent, created_at')
    .eq('action_type', ACTION_TYPE)
    .eq('target_id', customer.id);
  if (error) throw new Error(`refundRows: ${error.message}`);
  return ((data ?? []) as AuditRow[]).filter((row) => row.details?.reason === reason);
}

/** この返金対象のユーザーに作られた返金の記録の総数 */
async function countRefundRows(): Promise<number> {
  const { count, error } = await srAdmin
    .from('admin_audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('action_type', ACTION_TYPE)
    .eq('target_id', customer.id);
  if (error) throw new Error(`countRefundRows: ${error.message}`);
  return count ?? 0;
}

async function postWithForwardedFor(jwt: string, forwardedFor: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      'x-forwarded-for': forwardedFor,
      'user-agent': TEST_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { data?: { stripe_dashboard_url?: string } } };
}

beforeAll(async () => {
  [finance, admin, superAdmin, support, plainUser, customer] = await Promise.all([
    createUser('finance', ['finance']),
    createUser('admin', ['admin']),
    createUser('superadmin', ['super_admin']),
    createUser('support', ['support']),
    createUser('user', ['user']),
    createUser('customer', ['user']),
  ]);

  // dev サーバの初回コンパイル (ルート + middleware) で最初のテストがタイムアウトしないよう、先に 1 回呼んでおく
  await apiCall('POST', PATH, null, {});
}, 180_000);

afterAll(async () => {
  // admin_audit_logs.actor_id には ON DELETE の指定が無い外部キーもあり、記録を作ったユーザーは
  // 記録を消さないと削除できない。先に記録を消してから、ユーザーを消す
  // (このテストのユーザーが actor の行と、返金対象のユーザー宛の返金の記録の両方)
  if (createdUserIds.length > 0) {
    await srAdmin.from('admin_audit_logs').delete().in('actor_id', createdUserIds);
  }
  if (customer) {
    await srAdmin.from('admin_audit_logs').delete().eq('action_type', ACTION_TYPE).eq('target_id', customer.id);
  }
  for (const id of createdUserIds) {
    const { error } = await srAdmin.auth.admin.deleteUser(id);
    if (error) throw new Error(`deleteUser ${id}: ${error.message}`);
  }
  if (customer) {
    const { data: left } = await srAdmin
      .from('admin_audit_logs')
      .select('id')
      .eq('action_type', ACTION_TYPE)
      .eq('target_id', customer.id);
    expect(left ?? []).toEqual([]);
  }
}, 60_000);

describe('#1185 POST /api/admin/finance/refunds', () => {
  it('R-1: 未認証なら 401。監査ログは作られない', async () => {
    const reason = uniqueReason('unauthenticated');
    const res = await apiCall('POST', PATH, null, validBody(reason));

    expect(res.status).toBe(401);
    expect(await refundRows(reason)).toEqual([]);
  });

  it('R-2: 一般ユーザーは 403。監査ログは作られない', async () => {
    const reason = uniqueReason('plain-user');
    const res = await apiCall('POST', PATH, plainUser.jwt, validBody(reason));

    expect(res.status).toBe(403);
    expect(await refundRows(reason)).toEqual([]);
  });

  it('R-3: support は 403。監査ログは作られない (RLS は support の INSERT を許すので、止めているのは route の権限確認)', async () => {
    const reason = uniqueReason('support');
    const res = await apiCall('POST', PATH, support.jwt, validBody(reason));

    expect(res.status).toBe(403);
    expect(await refundRows(reason)).toEqual([]);
  });

  it('R-4: 不正な入力は 400。監査ログは作られない', async () => {
    const cases: Array<[string, (reason: string) => Record<string, unknown>]> = [
      ['決済 ID も請求書 ID も無い', (r) => validBody(r, { stripe_invoice_id: undefined })],
      ['決済 ID と請求書 ID の両方', (r) => validBody(r, { stripe_charge_id: CHARGE_ID })],
      ['請求書 ID の形式が違う', (r) => validBody(r, { stripe_invoice_id: 'inv_123' })],
      ['金額が 0', (r) => validBody(r, { amount: 0 })],
      ['金額が小数', (r) => validBody(r, { amount: 12.5 })],
      ['通貨が 3 文字でない', (r) => validBody(r, { currency: 'YEN1' })],
      ['ユーザー ID が UUID でない', (r) => validBody(r, { user_id: 'not-a-uuid' })],
      ['理由が空白だけ', () => validBody('   ')],
      ['理由に NUL 文字', (r) => validBody(`${r}\u0000`)],
    ];
    const before = await countRefundRows();
    for (const [label, build] of cases) {
      const reason = uniqueReason(`invalid ${label}`);
      const res = await apiCall('POST', PATH, finance.jwt, build(reason));
      expect(res.status, label).toBe(400);
      expect(await refundRows(reason), label).toEqual([]);
    }
    // 理由が空白だけの入力は、その理由では行を探せない。返金対象のユーザーの記録が 1 件も増えていないことでも確かめる
    expect(await countRefundRows()).toBe(before);
  });

  it('R-5: finance は 200。action_type = admin.refund.issue の行がちょうど 1 件、本人を actor として作られる', async () => {
    const reason = uniqueReason('finance');
    const res = await apiCall<{ data: { stripe_dashboard_url: string } }>('POST', PATH, finance.jwt, validBody(reason));

    expect(res.status).toBe(200);
    // 開発サーバはテストモード (/test) のリンク。本番ビルドでは /test が付かない
    expect(res.body.data.stripe_dashboard_url).toMatch(
      new RegExp(`^https://dashboard\\.stripe\\.com/(test/)?invoices/${INVOICE_ID}$`),
    );

    const rows = await refundRows(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: finance.id,
      action_type: ACTION_TYPE,
      target_id: customer.id,
      target_type: 'user',
      severity: 'warn',
    });
    expect(rows[0].details).toEqual({
      amount: 1200,
      currency: 'JPY',
      reason,
      stripe_charge_id: null,
      stripe_invoice_id: INVOICE_ID,
    });
    expect(rows[0].created_at).toBeTruthy();
  });

  it('R-6: 決済 (charge) への返金・通貨の省略・小文字の通貨・理由の前後の空白も記録される', async () => {
    const reason = uniqueReason('charge');
    const res = await apiCall<{ data: { stripe_dashboard_url: string } }>(
      'POST',
      PATH,
      finance.jwt,
      validBody(`  ${reason}  `, { stripe_invoice_id: undefined, stripe_charge_id: CHARGE_ID, currency: undefined, amount: 500 }),
    );

    expect(res.status).toBe(200);
    expect(res.body.data.stripe_dashboard_url).toMatch(
      new RegExp(`^https://dashboard\\.stripe\\.com/(test/)?payments/${CHARGE_ID}$`),
    );
    const rows = await refundRows(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toEqual({
      amount: 500,
      currency: 'JPY',
      reason,
      stripe_charge_id: CHARGE_ID,
      stripe_invoice_id: null,
    });

    const lower = uniqueReason('lowercase-currency');
    const res2 = await apiCall('POST', PATH, finance.jwt, validBody(lower, { currency: 'usd', amount: 1234 }));
    expect(res2.status).toBe(200);
    expect((await refundRows(lower))[0].details).toMatchObject({ amount: 1234, currency: 'USD' });
  });

  it('R-7: admin と super_admin も 200。それぞれ本人を actor として 1 件ずつ記録される', async () => {
    for (const [label, user] of [
      ['admin', admin],
      ['super_admin', superAdmin],
    ] as const) {
      const reason = uniqueReason(label);
      const res = await apiCall('POST', PATH, user.jwt, validBody(reason));

      expect(res.status, label).toBe(200);
      const rows = await refundRows(reason);
      expect(rows, label).toHaveLength(1);
      expect(rows[0].actor_id, label).toBe(user.id);
      expect(rows[0].action_type, label).toBe(ACTION_TYPE);
    }
  });

  it('R-8: 入力に actor_id / severity を混ぜても、本人名義・warn で記録される', async () => {
    const reason = uniqueReason('spoof');
    const res = await apiCall(
      'POST',
      PATH,
      finance.jwt,
      validBody(reason, { actor_id: admin.id, severity: 'info', action_type: 'admin.user.note_update' }),
    );

    expect(res.status).toBe(200);
    const rows = await refundRows(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: finance.id, action_type: ACTION_TYPE, severity: 'warn' });
  });

  it('R-9: x-forwarded-for が複数の IP でも記録できる (先頭の IP が ip_address に入る)。User-Agent も記録される', async () => {
    const reason = uniqueReason('forwarded-for');
    const res = await postWithForwardedFor(finance.jwt, '203.0.113.5, 70.41.3.18, 150.172.238.178', validBody(reason));

    expect(res.status).toBe(200);
    const rows = await refundRows(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0].ip_address).toBe('203.0.113.5');
    expect(rows[0].user_agent).toBe(TEST_USER_AGENT);
  });

  it('R-10: x-forwarded-for が IP でない値でも記録できる (ip_address は null)', async () => {
    const reason = uniqueReason('forwarded-for-garbage');
    const res = await postWithForwardedFor(finance.jwt, 'not-an-ip', validBody(reason));

    expect(res.status).toBe(200);
    const rows = await refundRows(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0].ip_address).toBeNull();
  });

  it('R-11: 前提: finance は監査ログを読み戻せない (だから route は INSERT の結果だけを見る)', async () => {
    const reason = uniqueReason('finance-cannot-read');
    const res = await apiCall('POST', PATH, finance.jwt, validBody(reason));
    expect(res.status).toBe(200);
    expect(await refundRows(reason)).toHaveLength(1);

    const { data, error } = await asUser(finance.jwt)
      .from('admin_audit_logs')
      .select('id')
      .eq('action_type', ACTION_TYPE)
      .eq('target_id', customer.id);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('R-12: 前提: finance の権限では他人名義の監査ログ行を作れない (route が本人名義で記録する理由)', async () => {
    const reason = uniqueReason('finance-spoof-direct');
    const { error } = await asUser(finance.jwt)
      .from('admin_audit_logs')
      .insert({
        actor_id: admin.id,
        action_type: ACTION_TYPE,
        target_id: customer.id,
        target_type: 'user',
        severity: 'warn',
        details: { reason },
      });

    expect(error?.code).toBe('42501');
    expect(await refundRows(reason)).toEqual([]);
  });

  it('R-13: 前提: 複数の IP をそのまま ip_address (inet 型) に入れる INSERT は失敗する (だから route は IP を取り出して確かめる)', async () => {
    const { error } = await srAdmin.from('admin_audit_logs').insert({
      actor_id: finance.id,
      action_type: `${ACTION_TYPE}.premise-check`,
      target_id: customer.id,
      target_type: 'user',
      severity: 'info',
      details: { reason: uniqueReason('inet-premise') },
      ip_address: '203.0.113.5, 70.41.3.18',
    });

    // 22P02: invalid_text_representation。他の管理 API は INSERT の error を見ないので、この失敗は握りつぶされる
    expect(error?.code).toBe('22P02');
  });
});
