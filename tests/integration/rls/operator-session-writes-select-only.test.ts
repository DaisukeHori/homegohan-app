/**
 * #1917 の続き: 運営 (と組織の管理者のポリシーの運営の枝) が自分のセッションの JWT で PostgREST から直接書けた 17 本のポリシーを閉じ、
 * 利用者の INSERT が運営の判定の列を指定できないようにした (migration 20261025100000_operator_session_writes_select_only.sql)。
 * 運営の API は requireRole の後で service_role の client で書く (API の結合テストは tests/integration/operator/** が受け持つ)。
 *
 * 直接の操作の結果 (この表で固定する):
 *   | 呼び出し元                                   | 操作                                               | 修正前               | 修正後                         |
 *   |----------------------------------------------|----------------------------------------------------|----------------------|--------------------------------|
 *   | 運営 (super_admin・admin は aal2、support・sales) | 運営だけが書く 10 表の INSERT / UPDATE / DELETE  | 書ける (ロールによる) | 42501・行は変わらない (O-1)   |
 *   | 運営 (aal2)                                  | 運営だけが書く表の SELECT                          | 読める               | 読める (O-2)                   |
 *   | 運営 (support・admin)                        | 問い合わせの UPDATE / DELETE                       | UPDATE は書ける       | 42501 (O-3)                    |
 *   | 運営 (support)                               | チケットの代理の INSERT・UPDATE・内部メモの INSERT | 書ける               | 42501 (O-3)                    |
 *   | 運営 (super_admin・aal2・組織の member)       | 自組織の部署・チャレンジの書き込み・招待の DELETE  | 書ける               | 42501 / 0 行 (G-1)             |
 *   | 組織の owner                                 | 自組織の部署・チャレンジの書き込み・招待の DELETE  | 書ける               | 書ける (G-2)                   |
 *   | 利用者                                       | レシピの通報・問い合わせ・チケットの INSERT に運営の判定の列を入れる | 書ける | 42501 (U-1)               |
 *   | 利用者・未認証                               | 運営の判定の列を入れない通報・問い合わせ・チケット・メッセージの INSERT | 書ける | 書ける (U-2)          |
 *   | 利用者・未認証                               | 運営だけが書く表・問い合わせ・チケットの書き込み   | 42501 / 0 行         | 42501 (U-3)                    |
 * カタログ (C-1・C-2): 17 の表のポリシーの名前と種類・残る書き込みのポリシーが運営のロールを見ないこと・anon / authenticated / service_role の権限。
 * 同じ型 (運営のロールで判定する書き込みのポリシー) のいまの状態と台帳の突き合わせは、常設の検査
 * tests/integration/rls/operator-write-policy-ledger.test.ts (実 DB) と tests/operator-write-policy-ledger.test.ts (migration の文面) が受け持つ。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/operator-session-writes-select-only.test.ts
 * カタログの確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { promoteToAal2 } from '../helpers/mfa';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

/** 権限が無い書き込み (permission denied) と、RLS の WITH CHECK に当たらない INSERT の SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 成人の生年月日 */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒。利用者を複数作り、TOTP で昇格させる) */
const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
let seq = 0;
const emailOf = (label: string) => `rls-op-session-writes-${label}-${RUN}-${++seq}@homegohan.test`;
/** 直接の書き込みが通っていないことを見つける印 */
const DIRECT = `#1917 direct ${RUN}`;

interface TestUser {
  id: string;
  email: string;
  /** サインインしただけのセッションの JWT (aal1) */
  jwt: string;
}

async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

async function signIn(email: string): Promise<{ client: SupabaseClient; jwt: string }> {
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signInClient = anon();
  const { data, error } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: signInClient, jwt: data.session.access_token };
}

async function createUser(label: string, roles: string[]): Promise<TestUser> {
  const email = emailOf(label);
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      { id: data.user.id, nickname: `op-session-writes-${label}`, age_group: '30s', gender: 'other', birth_date: ADULT_BIRTH_DATE, roles },
      { onConflict: 'id' },
    ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const { jwt } = await signIn(email);
  return { id: data.user.id, email, jwt };
}

/** TOTP を登録して aal2 にしたセッションの JWT */
async function aal2Jwt(user: TestUser): Promise<string> {
  const { client: sessionClient } = await signIn(user.email);
  return promoteToAal2(sessionClient);
}

/** service_role で 1 行作り、id を返す */
async function seedRow(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await srAdmin.from(table).insert(row).select('id').single();
  if (error || !data) throw new Error(`seed ${table}: ${error?.message}`);
  return (data as { id: string }).id;
}

/** 行を見分ける列と値 (id の無い表は主キーの列。experiment_assignments は experiment_id・user_id、system_settings は key) */
type RowKey = Readonly<Record<string, string>>;

/** 問い合わせに、行を見分ける列の eq を足す */
function whereKey<Q extends { eq: (column: string, value: string) => Q }>(query: Q, key: RowKey): Q {
  return Object.entries(key).reduce((q, [column, value]) => q.eq(column, value), query);
}

async function rowOfKey(table: string, key: RowKey): Promise<Record<string, unknown> | null> {
  const { data, error } = await whereKey(srAdmin.from(table).select('*'), key).maybeSingle();
  if (error) throw new Error(`${table} ${JSON.stringify(key)}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

async function rowOf(table: string, id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`${table} ${id}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

let superAdmin: TestUser;
let admin: TestUser;
let support: TestUser;
let sales: TestUser;
let customer: TestUser;
let other: TestUser;
let orgOwner: TestUser;
/** 組織の member として所属する super_admin (組織の管理 API は 403。運営の枝で直接書けていた) */
let orgOperator: TestUser;
let superAdminAal2 = '';
let adminAal2 = '';
let orgOperatorAal2 = '';
let orgId = '';

/** 運営だけが書く表 (本冊の後、書き込みのポリシーも anon / authenticated の書き込みの権限も無い) */
type OperatorTable =
  | 'admin_user_notes'
  | 'coupons'
  | 'experiments'
  | 'experiment_assignments'
  | 'feature_flags'
  | 'feature_packages'
  | 'sales_leads'
  | 'sales_lead_activities'
  | 'subscription_plans'
  | 'system_settings';

interface OperatorTableSpec {
  table: OperatorTable;
  /** 直接の INSERT に使う行 (権限の検査で止まるので、制約に合わなくても 42501 になる) */
  newRow: () => Record<string, unknown>;
  /** 直接の UPDATE に使う値 */
  patch: Record<string, unknown>;
  /** 本冊の前にこの表を書けた運営 (修正前は書けたことの記録。どの運営も修正後は 42501) */
  formerWriters: ReadonlyArray<'superAdmin' | 'admin' | 'support' | 'sales'>;
  /** 本冊の後も自分のセッションで読める運営 */
  readers: ReadonlyArray<'superAdmin' | 'admin' | 'support' | 'sales'>;
}

const OPERATOR_TABLES: readonly OperatorTableSpec[] = [
  { table: 'admin_user_notes', newRow: () => ({ user_id: customer.id, admin_id: support.id, note: DIRECT }), patch: { note: DIRECT }, formerWriters: ['superAdmin', 'admin', 'support'], readers: ['superAdmin', 'admin', 'support'] },
  {
    table: 'coupons',
    newRow: () => ({ code: `DIRECT${RUN}`.slice(0, 40), discount_type: 'percentage', discount_value: 10, valid_from: new Date().toISOString(), valid_until: new Date().toISOString() }),
    patch: { display_name: DIRECT },
    formerWriters: ['superAdmin', 'admin', 'sales'],
    readers: ['superAdmin', 'admin', 'sales'],
  },
  { table: 'experiments', newRow: () => ({ key: `direct_${RUN}`, name: DIRECT, variants: [] }), patch: { name: DIRECT }, formerWriters: ['superAdmin'], readers: ['superAdmin'] },
  { table: 'experiment_assignments', newRow: () => ({ experiment_id: experimentId, user_id: other.id, variant_key: 'control' }), patch: { variant_key: 'treatment' }, formerWriters: ['superAdmin'], readers: ['superAdmin'] },
  { table: 'feature_flags', newRow: () => ({ key: `direct_${RUN}`, description: DIRECT }), patch: { description: DIRECT }, formerWriters: ['superAdmin'], readers: ['superAdmin'] },
  { table: 'feature_packages', newRow: () => ({ package_key: `direct_${RUN}`, display_name: DIRECT }), patch: { display_name: DIRECT }, formerWriters: ['superAdmin'], readers: ['superAdmin'] },
  { table: 'sales_leads', newRow: () => ({ company_name: DIRECT }), patch: { company_name: DIRECT }, formerWriters: ['superAdmin', 'admin', 'sales'], readers: ['superAdmin', 'admin', 'sales'] },
  { table: 'sales_lead_activities', newRow: () => ({ lead_id: leadId, actor_id: sales.id, activity_type: 'note', details: { memo: DIRECT } }), patch: { details: { memo: DIRECT } }, formerWriters: ['superAdmin', 'admin', 'sales'], readers: ['superAdmin', 'admin', 'sales'] },
  { table: 'subscription_plans', newRow: () => ({ plan_key: `direct_${RUN}`, display_name: DIRECT, plan_type: 'personal' }), patch: { display_name: DIRECT }, formerWriters: ['superAdmin'], readers: ['superAdmin', 'admin'] },
  { table: 'system_settings', newRow: () => ({ key: `direct_${RUN}`, value: { v: DIRECT } }), patch: { value: { v: DIRECT } }, formerWriters: ['superAdmin'], readers: ['superAdmin', 'admin'] },
];

/** 運営だけが書く表の、既にある行 (service_role で作る。subscription_plans は種の行を使う) */
const existingKeys = new Map<OperatorTable, RowKey>();
const setExistingId = (table: OperatorTable, id: string) => existingKeys.set(table, { id });
let experimentId = '';
let leadId = '';
let ticketId = '';
let inquiryId = '';

const jwtOf = (who: 'superAdmin' | 'admin' | 'support' | 'sales'): string =>
  ({ superAdmin: superAdminAal2, admin: adminAal2, support: support.jwt, sales: sales.jwt })[who];

beforeAll(async () => {
  superAdmin = await createUser('super-admin', ['super_admin']);
  admin = await createUser('admin', ['admin']);
  support = await createUser('support', ['support']);
  sales = await createUser('sales', ['sales']);
  customer = await createUser('customer', ['user']);
  other = await createUser('other', ['user']);
  orgOwner = await createUser('org-owner', ['user']);
  orgOperator = await createUser('org-operator', ['super_admin']);
  superAdminAal2 = await aal2Jwt(superAdmin);
  adminAal2 = await aal2Jwt(admin);
  orgOperatorAal2 = await aal2Jwt(orgOperator);

  experimentId = await seedRow('experiments', { key: `seed_${RUN}`, name: `#1917 seed ${RUN}`, variants: [], created_by: superAdmin.id });
  setExistingId('experiments', experimentId);
  // experiment_assignments は id の列を持たない (主キーは experiment_id・user_id)
  const { error: assignmentError } = await srAdmin.from('experiment_assignments').insert({ experiment_id: experimentId, user_id: customer.id, variant_key: 'control' });
  if (assignmentError) throw new Error(`seed experiment_assignments: ${assignmentError.message}`);
  existingKeys.set('experiment_assignments', { experiment_id: experimentId, user_id: customer.id });
  setExistingId('admin_user_notes', await seedRow('admin_user_notes', { user_id: customer.id, admin_id: support.id, note: `#1917 seed ${RUN}` }));
  setExistingId(
    'coupons',
    await seedRow('coupons', {
      code: `SEED${RUN}`.slice(0, 40),
      discount_type: 'percentage',
      discount_value: 10,
      valid_from: new Date().toISOString(),
      valid_until: new Date().toISOString(),
      created_by: superAdmin.id,
    }),
  );
  setExistingId('feature_flags', await seedRow('feature_flags', { key: `seed_${RUN}`, description: `#1917 seed ${RUN}`, enabled: false }));
  // 運営の画面は active 以外のパッケージも読む (本冊が作る feature_packages_select_super_admin)
  setExistingId('feature_packages', await seedRow('feature_packages', { package_key: `seed_${RUN}`, display_name: `#1917 seed ${RUN}`, status: 'deprecated' }));
  leadId = await seedRow('sales_leads', { company_name: `#1917 seed ${RUN}` });
  setExistingId('sales_leads', leadId);
  setExistingId('sales_lead_activities', await seedRow('sales_lead_activities', { lead_id: leadId, actor_id: sales.id, activity_type: 'note', details: { memo: 'seed' } }));
  // system_settings は id の列を持たない (主キーは key)
  const { error: settingError } = await srAdmin.from('system_settings').insert({ key: `seed_${RUN}`, value: { v: 'seed' } });
  if (settingError) throw new Error(`seed system_settings: ${settingError.message}`);
  existingKeys.set('system_settings', { key: `seed_${RUN}` });
  const { data: plan, error: planError } = await retryIdempotentSetup(srAdmin, 'beforeAll: subscription_plans の種の行', (db) =>
    db.from('subscription_plans').select('id').order('display_order').limit(1).single());
  if (planError || !plan) throw new Error(`subscription_plans: ${planError?.message}`);
  setExistingId('subscription_plans', (plan as { id: string }).id);

  ticketId = await seedRow('support_tickets', { user_id: customer.id, subject: `#1917 seed ${RUN}`, category: 'other', priority: 'medium', status: 'open' });
  inquiryId = await seedRow('inquiries', { user_id: customer.id, inquiry_type: 'general', email: customer.email, subject: `#1917 seed ${RUN}`, message: 'seed', status: 'pending' });

  // 組織: owner (org_role owner) と、member として所属する super_admin (aal2)
  const { data: org, error: orgError } = await srAdmin.from('organizations').insert({ name: `#1917 org ${RUN}`, owner_id: orgOwner.id }).select('id').single();
  if (orgError || !org) throw new Error(`organizations: ${orgError?.message}`);
  orgId = (org as { id: string }).id;
  createdOrgIds.push(orgId);
  for (const [user, role] of [[orgOwner, 'owner'], [orgOperator, 'member']] as const) {
    const { error } = await srAdmin
      .from('user_profiles')
      .update({ organization_id: orgId, org_role: role, is_active_in_org: true, joined_org_at: new Date().toISOString() })
      .eq('id', user.id);
    if (error) throw new Error(`membership ${role}: ${error.message}`);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await srAdmin.from('admin_user_notes').delete().eq('user_id', customer?.id ?? '');
  await srAdmin.from('coupons').delete().in('code', [`SEED${RUN}`.slice(0, 40), `DIRECT${RUN}`.slice(0, 40)]);
  if (experimentId) await srAdmin.from('experiment_assignments').delete().eq('experiment_id', experimentId);
  await srAdmin.from('experiments').delete().in('key', [`seed_${RUN}`, `direct_${RUN}`]);
  await srAdmin.from('feature_flags').delete().in('key', [`seed_${RUN}`, `direct_${RUN}`]);
  await srAdmin.from('feature_packages').delete().in('package_key', [`seed_${RUN}`, `direct_${RUN}`]);
  if (leadId) await srAdmin.from('sales_lead_activities').delete().eq('lead_id', leadId);
  await srAdmin.from('sales_leads').delete().like('company_name', `%${RUN}%`);
  await srAdmin.from('system_settings').delete().in('key', [`seed_${RUN}`, `direct_${RUN}`]);
  await srAdmin.from('subscription_plans').delete().eq('plan_key', `direct_${RUN}`);
  await srAdmin.from('recipe_flags').delete().like('reason', `%${RUN}%`);
  await srAdmin.from('inquiries').delete().like('subject', `%${RUN}%`);
  if (createdUserIds.length > 0) {
    await srAdmin.from('support_ticket_messages').delete().in('sender_id', createdUserIds);
    await srAdmin.from('support_tickets').delete().in('user_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('user_profiles').update({ organization_id: null, org_role: null, is_active_in_org: false }).in('id', createdUserIds);
  }
  // 部署・チャレンジ・招待は organizations の削除で CASCADE
  if (createdOrgIds.length > 0) await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  for (const id of createdUserIds) await srAdmin.auth.admin.deleteUser(id);
}, SETUP_TIMEOUT_MS);

describe('O-1: 運営だけが書く 10 表は、運営 (aal2 を含む) の自分のセッションの直接の書き込みが 42501 で、行は変わらない', () => {
  it.each(OPERATOR_TABLES)('$table: 本冊の前に書けた運営 ($formerWriters) の INSERT / UPDATE / DELETE は 42501', async (spec) => {
    const key = existingKeys.get(spec.table)!;
    const before = await rowOfKey(spec.table, key);
    expect(before, `${spec.table} の既にある行`).not.toBeNull();
    for (const who of spec.formerWriters) {
      const db = asUser(jwtOf(who));
      expect((await db.from(spec.table).insert(spec.newRow())).error?.code, `${who} INSERT`).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await whereKey(db.from(spec.table).update(spec.patch), key)).error?.code, `${who} UPDATE`).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await whereKey(db.from(spec.table).delete(), key)).error?.code, `${who} DELETE`).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await rowOfKey(spec.table, key)).toEqual(before);
  }, TEST_TIMEOUT_MS);
});

describe('O-2: 運営の読み取りは残る (運営の画面・API は本人のセッションで読む)', () => {
  it.each(OPERATOR_TABLES)('$table: $readers は既にある行を読める', async (spec) => {
    const key = existingKeys.get(spec.table)!;
    for (const who of spec.readers) {
      const { data, error } = await whereKey(asUser(jwtOf(who)).from(spec.table).select('*'), key);
      expect(error, who).toBeNull();
      expect(data, who).toHaveLength(1);
    }
  }, TEST_TIMEOUT_MS);
});

describe('O-3: 問い合わせとチケットの運営の直接の書き込みは 42501 (運営の API が service_role で書く)', () => {
  it('問い合わせ: support と admin (aal2) の UPDATE / DELETE は 42501 で、行は変わらない (読むのはできる)', async () => {
    const before = await rowOf('inquiries', inquiryId);
    for (const [who, jwt] of [['support', support.jwt], ['admin', adminAal2]] as const) {
      const db = asUser(jwt);
      expect((await db.from('inquiries').update({ status: 'resolved', admin_notes: DIRECT }).eq('id', inquiryId)).error?.code, `${who} UPDATE`).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await db.from('inquiries').delete().eq('id', inquiryId)).error?.code, `${who} DELETE`).toBe(INSUFFICIENT_PRIVILEGE);
      const { data, error } = await db.from('inquiries').select('id').eq('id', inquiryId);
      expect(error, who).toBeNull();
      expect(data, who).toEqual([{ id: inquiryId }]);
    }
    expect(await rowOf('inquiries', inquiryId)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it('チケット: support の代理の INSERT・UPDATE・DELETE と、内部メモの INSERT は 42501 (読むのはできる)', async () => {
    const before = await rowOf('support_tickets', ticketId);
    const db = asUser(support.jwt);
    const proxied = await db.from('support_tickets').insert({ user_id: customer.id, subject: DIRECT, category: 'other', priority: 'medium', status: 'open' });
    expect(proxied.error?.code, '代理の INSERT').toBe(INSUFFICIENT_PRIVILEGE);
    expect((await db.from('support_tickets').update({ status: 'resolved', assignee_id: support.id }).eq('id', ticketId)).error?.code, 'UPDATE').toBe(INSUFFICIENT_PRIVILEGE);
    expect((await db.from('support_tickets').delete().eq('id', ticketId)).error?.code, 'DELETE').toBe(INSUFFICIENT_PRIVILEGE);
    const memo = await db.from('support_ticket_messages').insert({ ticket_id: ticketId, sender_id: support.id, is_internal: true, body: DIRECT });
    expect(memo.error?.code, '内部メモの INSERT').toBe(INSUFFICIENT_PRIVILEGE);
    const reply = await db.from('support_ticket_messages').insert({ ticket_id: ticketId, sender_id: support.id, is_internal: false, body: DIRECT });
    expect(reply.error?.code, '返信の INSERT').toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rowOf('support_tickets', ticketId)).toEqual(before);
    const { data: messages } = await srAdmin.from('support_ticket_messages').select('id').eq('body', DIRECT);
    expect(messages ?? []).toEqual([]);
    const { data, error } = await db.from('support_tickets').select('id').eq('id', ticketId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: ticketId }]);
  }, TEST_TIMEOUT_MS);
});

describe('G: 組織の 3 本は、組織の管理者の枝だけが残る', () => {
  const departmentNames = async () => {
    const { data } = await srAdmin.from('departments').select('name').eq('organization_id', orgId);
    return (data ?? []).map((r) => (r as { name: string }).name);
  };

  it('G-1: 組織の member として所属する super_admin (aal2) は、部署・チャレンジを直接作れず (42501)、書き換え・削除も 0 行', async () => {
    const db = asUser(orgOperatorAal2);
    const department = await db.from('departments').insert({ organization_id: orgId, name: `${DIRECT} op-dept` });
    expect(department.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await departmentNames()).not.toContain(`${DIRECT} op-dept`);

    const challenge = await db.from('organization_challenges').insert({
      organization_id: orgId,
      title: `${DIRECT} op-challenge`,
      challenge_type: 'breakfast_rate',
      start_date: '2026-11-01',
      end_date: '2026-11-30',
      status: 'draft',
    });
    expect(challenge.error?.code).toBe(INSUFFICIENT_PRIVILEGE);

    // owner が作った行を、運営の枝で書き換え・削除できない (0 行)
    const departmentId = await seedRow('departments', { organization_id: orgId, name: `#1917 seed dept ${RUN}` });
    const updated = await db.from('departments').update({ name: `${DIRECT} renamed` }).eq('id', departmentId).select('id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([]);
    const deleted = await db.from('departments').delete().eq('id', departmentId).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([]);
    expect(await rowOf('departments', departmentId)).toMatchObject({ name: `#1917 seed dept ${RUN}` });

    const invite = await asUser(orgOwner.jwt).rpc('create_org_invite', { p_organization_id: orgId, p_email: emailOf('invitee'), p_role: 'member' });
    expect(invite.error).toBeNull();
    const inviteId = (invite.data as { id: string }).id;
    const inviteDeleted = await db.from('organization_invites').delete().eq('id', inviteId).select('id');
    expect(inviteDeleted.error).toBeNull();
    expect(inviteDeleted.data).toEqual([]);
    expect(await rowOf('organization_invites', inviteId)).not.toBeNull();
  }, TEST_TIMEOUT_MS);

  it('G-2: 組織の owner は、今までどおり部署・チャレンジ (下書き) を作り・書き換え・消せ、招待を消せる', async () => {
    const db = asUser(orgOwner.jwt);
    const { data: department, error } = await db.from('departments').insert({ organization_id: orgId, name: `#1917 owner dept ${RUN}` }).select('id').single();
    expect(error).toBeNull();
    const departmentId = (department as { id: string }).id;
    const renamed = await db.from('departments').update({ name: `#1917 owner dept renamed ${RUN}` }).eq('id', departmentId).select('id');
    expect(renamed.data).toEqual([{ id: departmentId }]);
    const removed = await db.from('departments').delete().eq('id', departmentId).select('id');
    expect(removed.data).toEqual([{ id: departmentId }]);

    const { data: challenge, error: challengeError } = await db
      .from('organization_challenges')
      .insert({
        organization_id: orgId,
        title: `#1917 owner challenge ${RUN}`,
        challenge_type: 'breakfast_rate',
        start_date: '2026-11-01',
        end_date: '2026-11-30',
        status: 'draft',
        created_by: orgOwner.id,
      })
      .select('id')
      .single();
    expect(challengeError).toBeNull();
    const challengeId = (challenge as { id: string }).id;
    const retitled = await db.from('organization_challenges').update({ title: `#1917 owner challenge renamed ${RUN}` }).eq('id', challengeId).select('id');
    expect(retitled.data).toEqual([{ id: challengeId }]);
    const dropped = await db.from('organization_challenges').delete().eq('id', challengeId).select('id');
    expect(dropped.data).toEqual([{ id: challengeId }]);

    const invite = await db.rpc('create_org_invite', { p_organization_id: orgId, p_email: emailOf('owner-invitee'), p_role: 'member' });
    expect(invite.error).toBeNull();
    const inviteId = (invite.data as { id: string }).id;
    const inviteDeleted = await db.from('organization_invites').delete().eq('id', inviteId).select('id');
    expect(inviteDeleted.data).toEqual([{ id: inviteId }]);
  }, TEST_TIMEOUT_MS);
});

describe('U: 利用者の INSERT は、運営の判定の列を指定できない', () => {
  it.each([
    ['status を判定済みにした', { status: 'reviewed' }],
    ['reviewed_by に運営の id を入れた', { reviewed_by: 'ADMIN_ID' }],
    ['reviewed_at を入れた', { reviewed_at: new Date().toISOString() }],
    ['status を NULL にした', { status: null }],
  ] as const)('U-1: レシピの通報で %s INSERT は 42501', async (_label, extra) => {
    const values = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v === 'ADMIN_ID' ? admin.id : v]));
    const reason = `${DIRECT} recipe ${_label}`;
    const { error } = await asUser(customer.jwt).from('recipe_flags').insert({ reporter_id: customer.id, reason, ...values });
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const { data } = await srAdmin.from('recipe_flags').select('id').eq('reason', reason);
    expect(data ?? []).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each([
    ['status を対応済みにした', { status: 'resolved' }],
    ['admin_notes を入れた', { admin_notes: 'memo' }],
    ['resolved_at を入れた', { resolved_at: new Date().toISOString() }],
    ['user_id に他人の id を入れた', { user_id: 'OTHER_ID' }],
  ] as const)('U-1: 問い合わせで %s INSERT は 42501 (利用者)', async (_label, extra) => {
    const values = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v === 'OTHER_ID' ? other.id : v]));
    const subject = `${DIRECT} inquiry ${_label}`;
    const { error } = await asUser(customer.jwt)
      .from('inquiries')
      .insert({ user_id: customer.id, inquiry_type: 'general', email: customer.email, subject, message: 'm', status: 'pending', ...values });
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const { data } = await srAdmin.from('inquiries').select('id').eq('subject', subject);
    expect(data ?? []).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('U-1: 未認証の問い合わせで、他人の user_id や対応済みの status を入れた INSERT は 42501', async () => {
    for (const [label, values] of [['user_id', { user_id: customer.id }], ['status', { status: 'resolved' }]] as const) {
      const subject = `${DIRECT} anon inquiry ${label}`;
      const { error } = await anon().from('inquiries').insert({ inquiry_type: 'general', email: 'anon@example.com', subject, message: 'm', status: 'pending', ...values });
      expect(error?.code, label).toBe(INSUFFICIENT_PRIVILEGE);
    }
  }, TEST_TIMEOUT_MS);

  it.each([
    ['担当 (assignee_id) を入れた', { assignee_id: 'SUPPORT_ID' }],
    ['status を解決済みにした', { status: 'resolved' }],
    ['first_response_at を入れた', { first_response_at: new Date().toISOString() }],
    ['resolved_at を入れた', { resolved_at: new Date().toISOString() }],
    ['closed_at を入れた', { closed_at: new Date().toISOString() }],
  ] as const)('U-1: チケットで %s INSERT は 42501', async (_label, extra) => {
    const values = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v === 'SUPPORT_ID' ? support.id : v]));
    const subject = `${DIRECT} ticket ${_label}`;
    const { error } = await asUser(customer.jwt)
      .from('support_tickets')
      .insert({ user_id: customer.id, subject, category: 'other', priority: 'medium', ...values });
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const { data } = await srAdmin.from('support_tickets').select('id').eq('subject', subject);
    expect(data ?? []).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('U-2: 運営の判定の列を入れない通報・問い合わせ・チケット・メッセージは、今までどおり作れる', async () => {
    const db = asUser(customer.jwt);
    const report = await db.from('recipe_flags').insert({ reporter_id: customer.id, reason: `#1917 own report ${RUN}` }).select('reporter_id, status, reviewed_by, reviewed_at');
    expect(report.error).toBeNull();
    expect(report.data).toEqual([{ reporter_id: customer.id, status: 'pending', reviewed_by: null, reviewed_at: null }]);
    const explicitPending = await db.from('recipe_flags').insert({ reporter_id: customer.id, reason: `#1917 own report pending ${RUN}`, status: 'pending' });
    expect(explicitPending.error).toBeNull();

    // POST /api/contact と同じ形 (ログイン中は本人の user_id・status = pending。未ログインは user_id = NULL)
    const own = await db.from('inquiries').insert({ user_id: customer.id, inquiry_type: 'general', email: customer.email, subject: `#1917 own inquiry ${RUN}`, message: 'm', status: 'pending' });
    expect(own.error).toBeNull();
    const guest = await anon().from('inquiries').insert({ user_id: null, inquiry_type: 'general', email: 'guest@example.com', subject: `#1917 guest inquiry ${RUN}`, message: 'm', status: 'pending' });
    expect(guest.error).toBeNull();

    const { data: ticket, error: ticketError } = await db
      .from('support_tickets')
      .insert({ user_id: customer.id, subject: `#1917 own ticket ${RUN}`, category: 'other', priority: 'high' })
      .select('id, status, assignee_id')
      .single();
    expect(ticketError).toBeNull();
    expect(ticket).toMatchObject({ status: 'open', assignee_id: null });
    const ownTicketId = (ticket as { id: string }).id;
    const message = await db.from('support_ticket_messages').insert({ ticket_id: ownTicketId, sender_id: customer.id, is_internal: false, body: `#1917 own message ${RUN}` });
    expect(message.error).toBeNull();
    const internal = await db.from('support_ticket_messages').insert({ ticket_id: ownTicketId, sender_id: customer.id, is_internal: true, body: `${DIRECT} own internal` });
    expect(internal.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  }, TEST_TIMEOUT_MS);

  it('U-3: 利用者と未認証は、運営だけが書く表・問い合わせ・チケットを書き換えられない (42501)', async () => {
    for (const [label, db] of [['user', asUser(customer.jwt)], ['anon', anon()]] as const) {
      for (const spec of OPERATOR_TABLES) {
        expect((await db.from(spec.table).insert(spec.newRow())).error?.code, `${label} ${spec.table} INSERT`).toBe(INSUFFICIENT_PRIVILEGE);
        expect((await whereKey(db.from(spec.table).update(spec.patch), existingKeys.get(spec.table)!)).error?.code, `${label} ${spec.table} UPDATE`).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect((await db.from('inquiries').update({ status: 'resolved' }).eq('id', inquiryId)).error?.code, `${label} inquiries UPDATE`).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await db.from('support_tickets').update({ status: 'resolved' }).eq('id', ticketId)).error?.code, `${label} support_tickets UPDATE`).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await db.from('support_tickets').delete().eq('id', ticketId)).error?.code, `${label} support_tickets DELETE`).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect((await anon().from('support_tickets').insert({ user_id: customer.id, subject: DIRECT, category: 'other', priority: 'medium' })).error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rowOf('support_tickets', ticketId)).toMatchObject({ status: 'open', assignee_id: null });
  }, TEST_TIMEOUT_MS);
});

/** 本冊の後の、表ごとのポリシー (名前 → 種類。policyname の COLLATE "C" の順) と、anon / authenticated に残る書き込みの権限 */
const CATALOG: ReadonlyArray<{ table: string; policies: ReadonlyArray<readonly [string, string]>; anon: readonly string[]; authenticated: readonly string[] }> = [
  { table: 'admin_user_notes', policies: [['Admins can view user notes', 'SELECT']], anon: [], authenticated: [] },
  { table: 'coupons', policies: [['coupons_select_sales_or_above', 'SELECT']], anon: [], authenticated: [] },
  { table: 'departments', policies: [['Org admins can manage departments', 'ALL'], ['Org members can view departments', 'SELECT']], anon: [], authenticated: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'experiment_assignments', policies: [['experiment_assignments_select_super_admin', 'SELECT']], anon: [], authenticated: [] },
  { table: 'experiments', policies: [['experiments_select_super_admin', 'SELECT']], anon: [], authenticated: [] },
  { table: 'feature_flags', policies: [['feature_flags_select_super_admin', 'SELECT']], anon: [], authenticated: [] },
  { table: 'feature_packages', policies: [['feature_packages_select_authenticated', 'SELECT'], ['feature_packages_select_super_admin', 'SELECT']], anon: [], authenticated: [] },
  {
    table: 'inquiries',
    policies: [['Admins can view all inquiries', 'SELECT'], ['Anyone can create inquiries', 'INSERT'], ['Users can view own inquiries', 'SELECT']],
    anon: ['INSERT'],
    authenticated: ['INSERT'],
  },
  {
    table: 'organization_challenges',
    policies: [['Org admins can manage challenges', 'ALL'], ['Org challenges can be deleted only as draft or cancelled', 'DELETE'], ['Org members can view challenges', 'SELECT']],
    anon: [],
    authenticated: ['INSERT', 'UPDATE', 'DELETE'],
  },
  {
    table: 'organization_invites',
    policies: [['Org admins can delete invites', 'DELETE'], ['Org admins can view invites', 'SELECT'], ['org_invites_select_admin', 'SELECT']],
    anon: [],
    authenticated: ['DELETE'],
  },
  { table: 'recipe_flags', policies: [['Anyone can create recipe flags', 'INSERT'], ['Users and admins can view recipe flags', 'SELECT']], anon: [], authenticated: ['INSERT'] },
  { table: 'sales_lead_activities', policies: [['sales_activities_select', 'SELECT']], anon: [], authenticated: [] },
  { table: 'sales_leads', policies: [['sales_leads_select', 'SELECT']], anon: [], authenticated: [] },
  { table: 'subscription_plans', policies: [['subscription_plans_select_operator', 'SELECT'], ['subscription_plans_select_public', 'SELECT']], anon: [], authenticated: [] },
  { table: 'support_ticket_messages', policies: [['ticket_messages_insert', 'INSERT'], ['ticket_messages_select', 'SELECT']], anon: [], authenticated: ['INSERT'] },
  { table: 'support_tickets', policies: [['tickets_insert_user', 'INSERT'], ['tickets_select', 'SELECT']], anon: [], authenticated: ['INSERT'] },
  { table: 'system_settings', policies: [['Admins can view system settings', 'SELECT']], anon: [], authenticated: [] },
];
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

describe('C: カタログ', () => {
  it.each(CATALOG)('C-1: $table: ポリシーの名前と種類。SELECT 以外のポリシーは運営のロールと運営の MFA の判定を見ない。運営の SELECT は TO authenticated で判定を呼ぶ', async ({ table, policies }) => {
    const rows = await pgQuery<{ policyname: string; cmd: string; roles: string; qual: string | null; with_check: string | null }>(`
      SELECT policyname, cmd, roles::text AS roles, qual, with_check
      FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}'
      ORDER BY policyname COLLATE "C"`);
    expect(rows.map((r) => [r.policyname, r.cmd])).toEqual(policies.map(([n, c]) => [n, c]));
    for (const row of rows) {
      const expression = `${row.qual ?? ''} ${row.with_check ?? ''}`;
      if (row.cmd !== 'SELECT') {
        expect(expression, row.policyname).not.toMatch(/\broles\b/);
        expect(expression, row.policyname).not.toMatch(/operator_mfa_satisfied/);
      } else if (/\broles\b/.test(expression)) {
        expect(row.roles, row.policyname).toBe('{authenticated}');
        expect(expression, row.policyname).toContain('operator_mfa_satisfied()');
      }
    }
  }, TEST_TIMEOUT_MS);

  it('C-1: 利用者の INSERT の 3 本の WITH CHECK と TO', async () => {
    const rows = await pgQuery<{ tablename: string; policyname: string; roles: string; with_check: string | null }>(`
      SELECT tablename, policyname, roles::text AS roles, with_check FROM pg_policies
      WHERE schemaname = 'public' AND policyname IN ('Anyone can create recipe flags', 'Anyone can create inquiries', 'tickets_insert_user')
      ORDER BY tablename COLLATE "C"`);
    expect(rows).toEqual([
      {
        tablename: 'inquiries',
        policyname: 'Anyone can create inquiries',
        roles: '{anon,authenticated}',
        with_check: "((status = 'pending'::text) AND (admin_notes IS NULL) AND (resolved_at IS NULL) AND ((user_id IS NULL) OR (user_id = auth.uid())))",
      },
      {
        tablename: 'recipe_flags',
        policyname: 'Anyone can create recipe flags',
        roles: '{authenticated}',
        with_check: "((reporter_id = auth.uid()) AND (status = 'pending'::text) AND (reviewed_by IS NULL) AND (reviewed_at IS NULL))",
      },
      {
        tablename: 'support_tickets',
        policyname: 'tickets_insert_user',
        roles: '{authenticated}',
        with_check:
          "((user_id = auth.uid()) AND ((status)::text = 'open'::text) AND (assignee_id IS NULL) AND (first_response_at IS NULL) AND (resolved_at IS NULL) AND (closed_at IS NULL))",
      },
    ]);
  }, TEST_TIMEOUT_MS);

  it.each(CATALOG)('C-2: $table: anon / authenticated の書き込みの権限は残すものだけ、SELECT は持つ。service_role は書き込みを持つ', async ({ table, anon: anonWrites, authenticated }) => {
    const checks = ['anon', 'authenticated', 'service_role'].flatMap((role) =>
      [...WRITE_PRIVILEGES, 'SELECT'].map((privilege) => `SELECT '${role}' AS role, '${privilege}' AS privilege, has_table_privilege('${role}', 'public.${table}', '${privilege}') AS held`),
    );
    const rows = await pgQuery<{ role: string; privilege: string; held: boolean }>(checks.join(' UNION ALL '));
    const held = new Map(rows.map((r) => [`${r.role} ${r.privilege}`, r.held]));
    for (const [role, kept] of [['anon', anonWrites], ['authenticated', authenticated]] as const) {
      for (const privilege of WRITE_PRIVILEGES) expect(held.get(`${role} ${privilege}`), `${role} ${privilege}`).toBe(kept.includes(privilege));
      expect(held.get(`${role} SELECT`), `${role} SELECT`).toBe(true);
    }
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'SELECT']) expect(held.get(`service_role ${privilege}`), `service_role ${privilege}`).toBe(true);
  }, TEST_TIMEOUT_MS);
});
