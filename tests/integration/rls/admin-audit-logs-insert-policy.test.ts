/**
 * #1736 admin_audit_logs の INSERT のポリシー (20261016238000_admin_audit_logs_insert_actor_only.sql) の回帰テスト (実 DB)
 *
 * 修正前の INSERT のポリシーは 2 本 (roles=public・PERMISSIVE。OR で合成される) だった。
 *   "Admins can create audit logs": 本人のロールが admin / super_admin / support なら通す (actor_id も action_type も見ない)
 *   "audit_logs_insert_admins":     actor_id = auth.uid() かつ運営の 6 ロールなら通す (action_type は見ない)
 * そのため運営のロールの人は、自分の JWT で PostgREST に INSERT を直接送れば、他人や NULL (= system) を actor にした行や、
 * system.* の行 (GET /api/admin/finance/reconciliation が action_type だけで読む行など) を作れた。
 *
 * 期待する挙動 (修正後):
 *   - 運営でない人 (一般ユーザー・org_admin) と anon の直接の INSERT は 42501
 *   - 運営のロールの人でも、actor_id を他人・NULL にした INSERT は 42501
 *   - 運営のロールの人でも、action_type が system.* の INSERT は 42501
 *   - 運営のロールの人でも、actor_email_snapshot / actor_role_snapshot / impersonated_by を入れた INSERT は 42501
 *   - 今の書き手 (recordAdminAudit を本人の JWT の client で呼ぶ経路) は、運営の 6 ロールのどれでも今までどおり書ける
 *   - service_role の書き手 (課金の監査・MFA の監査) は RLS の対象外なので、system.* と actor_id NULL の行を今までどおり書ける
 * 修正前は N-3 (admin が他人を actor に)・N-4 (admin が actor_id NULL)・N-5 / N-6 (system.*)・N-7 (snapshot) が失敗する。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/admin-audit-logs-insert-policy.test.ts
 *   (dev サーバーは要らない。PostgREST を supabase-js で直接叩く)
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { recordAdminAudit } from '@/lib/admin/audit';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

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

/** RLS の WITH CHECK に反した INSERT の SQLSTATE (insufficient_privilege) */
const RLS_DENIED = '42501';

/** 運営の 6 ロール (audit_logs_insert_admins の一覧。operator/07 §3.2) */
const OPERATOR_ROLES = ['admin', 'super_admin', 'support', 'sales', 'finance', 'content_moderator'] as const;
type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** このテストが作る行の action_type (system.* でない、運営の名前の形) */
const ACTION_TYPE = 'admin.test.audit_insert_policy_1736';
/** 照合の画面が action_type だけで読む system の行 (src/app/api/admin/finance/reconciliation/route.ts) */
const RECONCILE_ACTION_TYPE = 'system.stripe.reconcile_discrepancy';
/** 課金の監査が service_role で書く system の行 (src/lib/billing/core.ts の BILLING_AUDIT_ACTIONS) */
const BILLING_SYSTEM_ACTION_TYPE = 'system.billing.subscription_status_changed';

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
/** このテストで作った行を details.tag で見分ける */
const TAG = `#1736-${TS}`;
const createdUserIds: string[] = [];

async function createUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `rls-1736-${label}-${TS}@homegohan.test`;
  // テスト用ユーザーのパスワードは固定値を置かず、実行ごとに作る
  const password = `Aa1!${randomUUID()}`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  // roles は特権列なので service_role で設定する (本人の JWT では変更できない)
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert(
        { id: data.user.id, nickname: `rls-1736-${label}`, age_group: '30s', gender: 'other', roles },
        { onConflict: 'id' },
      ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

let plainUser: TestUser;
let orgAdmin: TestUser;
const operatorUsers = new Map<OperatorRole, TestUser>();

/** 運営のロールのテストユーザー (beforeAll で作る) */
function op(role: OperatorRole): TestUser {
  const user = operatorUsers.get(role);
  if (!user) throw new Error(`運営のテストユーザー ${role} が作られていません`);
  return user;
}

/** テストごとに違う値を details.case に入れ、そのテストで作られた行だけを数える */
let caseSeq = 0;
function uniqueCase(label: string): string {
  caseSeq += 1;
  return `${label}-${caseSeq}`;
}

/** details.tag / details.case が一致する行 (service_role で読む。RLS の影響を受けない) */
async function rowsForCase(caseLabel: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await srAdmin
    .from('admin_audit_logs')
    .select('id, actor_id, action_type, target_id, target_type, severity, details')
    .contains('details', { tag: TAG, case: caseLabel });
  if (error) throw new Error(`rowsForCase: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

function baseRow(actorId: string | null, caseLabel: string): Record<string, unknown> {
  return {
    actor_id: actorId,
    action_type: ACTION_TYPE,
    target_id: plainUser.id,
    target_type: 'user',
    severity: 'info',
    details: { tag: TAG, case: caseLabel },
  };
}

beforeAll(async () => {
  [plainUser, orgAdmin] = await Promise.all([
    createUser('plain', ['user']),
    createUser('org-admin', ['org_admin']),
  ]);
  const created = await Promise.all(OPERATOR_ROLES.map((role) => createUser(role.replace('_', '-'), [role])));
  OPERATOR_ROLES.forEach((role, index) => {
    operatorUsers.set(role, created[index]);
  });
});

afterAll(async () => {
  // 監査ログは UPDATE / DELETE を RLS で禁じているが、service_role は RLS の対象外なので後片付けできる
  await srAdmin.from('admin_audit_logs').delete().contains('details', { tag: TAG });
  if (createdUserIds.length > 0) {
    await srAdmin.from('admin_audit_logs').delete().in('actor_id', createdUserIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
});

describe('#1736 admin_audit_logs: 運営でない人の直接の INSERT は 42501', () => {
  it('N-1: 一般ユーザーが自分を actor にした直接の INSERT は 42501 で、行は作られない', async () => {
    const caseLabel = uniqueCase('plain-self');
    const { error } = await asUser(plainUser.jwt).from('admin_audit_logs').insert(baseRow(plainUser.id, caseLabel));
    expect(error?.code).toBe(RLS_DENIED);
    expect(await rowsForCase(caseLabel)).toEqual([]);
  });

  it('N-2: org_admin (組織の管理者。運営ではない) の直接の INSERT も 42501', async () => {
    const caseLabel = uniqueCase('org-admin-self');
    const { error } = await asUser(orgAdmin.jwt).from('admin_audit_logs').insert(baseRow(orgAdmin.id, caseLabel));
    expect(error?.code).toBe(RLS_DENIED);
    expect(await rowsForCase(caseLabel)).toEqual([]);
  });

  it('N-2b: 未認証 (anon) の直接の INSERT も 42501', async () => {
    const caseLabel = uniqueCase('anon-null');
    const { error } = await client(anonKey).from('admin_audit_logs').insert(baseRow(null, caseLabel));
    expect(error?.code).toBe(RLS_DENIED);
    expect(await rowsForCase(caseLabel)).toEqual([]);
  });
});

describe('#1736 admin_audit_logs: 運営のロールの人でも actor・system の行・actor の表示は偽れない', () => {
  // 修正前に actor を偽れたのは、古いポリシーが効く admin / super_admin / support。3 ロールとも確かめる
  const ROLES_COVERED_BY_OLD_POLICY = ['admin', 'super_admin', 'support'] as const;

  it.each(ROLES_COVERED_BY_OLD_POLICY)('N-3: %s が actor_id を他人 (別の運営者) にした直接の INSERT は 42501', async (role) => {
    const caseLabel = uniqueCase(`${role}-spoof-actor`);
    const victim = role === 'admin' ? op('super_admin') : op('admin');
    const { error } = await asUser(op(role).jwt).from('admin_audit_logs').insert(baseRow(victim.id, caseLabel));
    expect(error?.code).toBe(RLS_DENIED);
    expect(await rowsForCase(caseLabel)).toEqual([]);
  });

  it.each(ROLES_COVERED_BY_OLD_POLICY)('N-4: %s が actor_id を NULL (= system) にした直接の INSERT は 42501', async (role) => {
    const caseLabel = uniqueCase(`${role}-null-actor`);
    const { error } = await asUser(op(role).jwt).from('admin_audit_logs').insert(baseRow(null, caseLabel));
    expect(error?.code).toBe(RLS_DENIED);
    expect(await rowsForCase(caseLabel)).toEqual([]);
  });

  it.each(OPERATOR_ROLES)('N-5: %s が自分を actor にしても、action_type が system.* の直接の INSERT は 42501', async (role) => {
    const caseLabel = uniqueCase(`${role}-system-action`);
    const { error } = await asUser(op(role).jwt)
      .from('admin_audit_logs')
      .insert({ ...baseRow(op(role).id, caseLabel), action_type: RECONCILE_ACTION_TYPE });
    expect(error?.code).toBe(RLS_DENIED);
    expect(await rowsForCase(caseLabel)).toEqual([]);
  });

  it('N-6: super_admin が課金の system の行 (system.billing.*) を actor_id NULL で直接作る INSERT も 42501', async () => {
    const caseLabel = uniqueCase('super-admin-billing-system');
    const { error } = await asUser(op('super_admin').jwt)
      .from('admin_audit_logs')
      .insert({ ...baseRow(null, caseLabel), action_type: BILLING_SYSTEM_ACTION_TYPE });
    expect(error?.code).toBe(RLS_DENIED);
    expect(await rowsForCase(caseLabel)).toEqual([]);
  });

  const ACTOR_DISPLAY_COLUMNS = ['actor_email_snapshot', 'actor_role_snapshot', 'impersonated_by'] as const;

  it.each(ACTOR_DISPLAY_COLUMNS)('N-7: admin が自分を actor にしても、%s を入れた直接の INSERT は 42501', async (column) => {
    const caseLabel = uniqueCase(`admin-${column}`);
    const value = column === 'impersonated_by' ? op('super_admin').id : `spoof-${column}`;
    const { error } = await asUser(op('admin').jwt)
      .from('admin_audit_logs')
      .insert({ ...baseRow(op('admin').id, caseLabel), [column]: value });
    expect(error?.code).toBe(RLS_DENIED);
    expect(await rowsForCase(caseLabel)).toEqual([]);
  });
});

describe('#1736 admin_audit_logs: 今の書き手は今までどおり書ける', () => {
  it.each(OPERATOR_ROLES)('W-1: %s は recordAdminAudit (本人の JWT の client) で自分を actor にした行を書ける', async (role) => {
    const caseLabel = uniqueCase(`${role}-record-admin-audit`);
    const result = await recordAdminAudit({
      supabase: asUser(op(role).jwt),
      actorId: op(role).id,
      actionType: ACTION_TYPE,
      targetId: plainUser.id,
      targetType: 'user',
      details: { tag: TAG, case: caseLabel },
      request: new Request('http://localhost/api/test', {
        headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'admin-audit-insert-policy-test/1736' },
      }),
      routeName: 'tests/integration/rls/admin-audit-logs-insert-policy',
    });

    expect(result).toEqual({ ok: true });
    const rows = await rowsForCase(caseLabel);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: op(role).id,
      action_type: ACTION_TYPE,
      target_id: plainUser.id,
      target_type: 'user',
      severity: 'info',
    });
  });

  it('W-2: recordAdminAudit でも actorId を他人にすると書けない (ok: false。行は作られない)', async () => {
    const caseLabel = uniqueCase('record-admin-audit-spoof');
    const result = await recordAdminAudit({
      supabase: asUser(op('support').jwt),
      actorId: op('admin').id,
      actionType: ACTION_TYPE,
      targetId: plainUser.id,
      targetType: 'user',
      details: { tag: TAG, case: caseLabel },
      request: new Request('http://localhost/api/test'),
      routeName: 'tests/integration/rls/admin-audit-logs-insert-policy',
    });

    expect(result.ok).toBe(false);
    expect(await rowsForCase(caseLabel)).toEqual([]);
  });

  it('W-3: service_role の書き手 (課金の監査・MFA の監査) は system.* と actor_id NULL の行を今までどおり書ける', async () => {
    const caseLabel = uniqueCase('service-role-system');
    const { error } = await srAdmin
      .from('admin_audit_logs')
      .insert({ ...baseRow(null, caseLabel), action_type: BILLING_SYSTEM_ACTION_TYPE });
    expect(error).toBeNull();
    const rows = await rowsForCase(caseLabel);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: null, action_type: BILLING_SYSTEM_ACTION_TYPE });
  });
});
