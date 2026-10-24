/**
 * #1917 の続き: 運営 (admin / super_admin) の announcements (お知らせ) と moderation_flags (食事の通報) の FOR ALL のポリシーを
 * SELECT だけにし、recipe_flags (レシピの通報) の運営の FOR UPDATE のポリシーと personal_subscriptions (個人の契約) の運営の
 * FOR INSERT / FOR UPDATE のポリシーを消し、anon / authenticated の書き込みの権限を外した
 * (migration 20261024140000_announcements_moderation_flags_select_only.sql)。
 * 修正前は、MFA 済み (aal2) の運営が自分のセッションの JWT で PostgREST からお知らせ・食事の通報を直接 INSERT / UPDATE / DELETE でき、
 * レシピの通報を直接 UPDATE でき、契約を直接 INSERT / UPDATE でき、運営の API (POST /api/announcements・運営の通報の API・
 * 手動付与の API) と監査ログ (admin_audit_logs) を通らなかった (契約は、手動付与の関数の不変条件 (live な行の衝突の判定・
 * plan_key_cached と family_groups の同期) も通らなかった)。recipe_flags の利用者の通報 (INSERT・reporter_id = 本人) は残す。
 *
 * 直接の操作の結果 (この表で固定する。「通報」は moderation_flags と recipe_flags):
 *   | 呼び出し元                         | 操作                                    | 修正前                       | 修正後                       |
 *   |------------------------------------|-----------------------------------------|------------------------------|------------------------------|
 *   | 運営 (admin・super_admin・aal2)    | INSERT / UPDATE / DELETE                | 書ける (recipe_flags は UPDATE だけ、契約は INSERT / UPDATE) | 42501・行は変わらない (A-1) |
 *   | 運営 (admin・aal2)                 | SELECT (非公開・通報・他人の契約)       | 見える                       | 見える (A-2)                 |
 *   | 運営 (admin・TOTP 登録済み・aal1)  | SELECT (非公開・通報・他人の契約)       | 見えない                     | 見えない (MFA の判定。A-3)   |
 *   | 利用者 (user)                      | SELECT                                  | 公開だけ・他人の通報と契約 0 | 公開だけ・他人の通報と契約 0 (A-4) |
 *   | 利用者 (user)・未認証 (anon)       | INSERT / UPDATE / DELETE                | 42501 / 0 行                 | 42501 (A-5)                  |
 *   | 通報した本人・契約の本人           | 自分の行の UPDATE / DELETE              | 0 行                         | 42501 (A-5)                  |
 *   | 利用者・運営 (aal2)                | recipe_flags の本人を reporter にした INSERT | 書ける                  | 書ける (A-8)                 |
 *   | service_role                       | INSERT / UPDATE / DELETE・契約の関数    | 書ける                       | 書ける (A-6)                 |
 *
 * 確かめること:
 *   - A-1: aal2 の admin と super_admin の、お知らせ・通報・契約の直接の INSERT / UPDATE / DELETE は 42501 で、行は変わらない
 *          (recipe_flags の INSERT は他人を reporter にした行・契約の INSERT は他人の行。本人を reporter にした通報は A-8)
 *   - A-2: aal2 の admin は、非公開のお知らせと通報と他人の契約を読める (管理用の一覧 GET /api/announcements・運営の画面が本人のセッションで読む)
 *   - A-3: TOTP を登録済みの admin の aal1 のセッションは、非公開のお知らせと通報と他人の契約を読めない (運営の MFA の判定が残っている)
 *   - A-4: 利用者は公開のお知らせだけを読め、他人の通報と契約は 1 行も読めない
 *   - A-5: 利用者と未認証の直接の書き込みは 42501 (通報した本人・契約の本人の、自分の行の UPDATE / DELETE も)
 *   - A-6: service_role は今までどおり書ける (POST /api/announcements・運営の通報の API・テストの後片付けが使う)。契約は、手動付与と
 *          取り消しの関数 (billing_grant_manual_subscription / billing_revoke_manual_subscription。SECURITY DEFINER) も今までどおり書ける
 *   - A-7: カタログ: 4 つの表に書き込みを許すポリシーが無い (SELECT 以外は recipe_flags の利用者の通報の INSERT と、契約の常に偽の
 *          DELETE の禁止だけ)。運営の SELECT のポリシーは TO authenticated・operator_mfa_satisfied() を呼ぶ。anon / authenticated は
 *          UPDATE / DELETE / TRUNCATE を持たず、INSERT は recipe_flags の authenticated だけが持ち、SELECT を持つ。service_role は書き込みを持つ
 *   - A-8: recipe_flags の利用者の通報 (本人を reporter にした INSERT) は、利用者も aal2 の運営も今までどおり作れる
 * 同じ型 (運営のロールで判定する書き込みのポリシー) のいまの状態と台帳の突き合わせは、本冊から切り離した常設の検査
 * tests/integration/rls/operator-write-policy-ledger.test.ts (実 DB) と tests/operator-write-policy-ledger.test.ts (migration の文面) が受け持つ。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/announcements-moderation-flags-select-only.test.ts
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

/** 権限が無い書き込み (permission denied) の SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 成人の生年月日 */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒。利用者を複数作り、TOTP で昇格させる) */
const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;
/** 契約の行に使うプラン (公開の個人プラン。手動付与の関数が付与できる) */
const SUBSCRIPTION_PLAN_KEY = 'pro';

/** 本冊が運営の直接の書き込みを塞いだ表 */
const TABLES = ['announcements', 'moderation_flags', 'recipe_flags', 'personal_subscriptions'] as const;
type Table = (typeof TABLES)[number];
/** 他人の行を運営 (aal2) だけが読める表 (通報と契約。読み取りの確認に使う) */
const PRIVATE_ROW_TABLES = ['moderation_flags', 'recipe_flags', 'personal_subscriptions'] as const;
type PrivateRowTable = (typeof PRIVATE_ROW_TABLES)[number];
/** 行に本人 (通報した利用者・契約の利用者) がいる表 */
const OWNED_ROW_TABLES = ['recipe_flags', 'personal_subscriptions'] as const;
type OwnedRowTable = (typeof OWNED_ROW_TABLES)[number];
/** recipe_flags に残す利用者の通報の INSERT のポリシー */
const USER_REPORT_INSERT_POLICY = 'Anyone can create recipe flags';
/** personal_subscriptions に残す、常に偽の DELETE のポリシー */
const SUBSCRIPTION_NO_DELETE_POLICY = 'personal_subscriptions_no_delete';
/** 本冊の後に残る SELECT 以外のポリシー (名前 → 種類) */
const KEPT_NON_SELECT_POLICIES: Readonly<Record<string, string>> = {
  [USER_REPORT_INSERT_POLICY]: 'INSERT',
  [SUBSCRIPTION_NO_DELETE_POLICY]: 'DELETE',
};
/** 本冊の後の、表ごとのポリシー (名前 → 種類。policyname の COLLATE "C" の順) */
const EXPECTED_POLICIES: Readonly<Record<Table, ReadonlyArray<readonly [string, string]>>> = {
  announcements: [
    ['Admins can view announcements', 'SELECT'],
    ['Public announcements are viewable by everyone', 'SELECT'],
  ],
  moderation_flags: [['moderation_flags_admin_select', 'SELECT']],
  recipe_flags: [
    [USER_REPORT_INSERT_POLICY, 'INSERT'],
    ['Users and admins can view recipe flags', 'SELECT'],
  ],
  personal_subscriptions: [
    [SUBSCRIPTION_NO_DELETE_POLICY, 'DELETE'],
    ['personal_subscriptions_select', 'SELECT'],
  ],
};
/** 運営の SELECT のポリシー (announcements と moderation_flags は本冊が作り直した。recipe_flags と personal_subscriptions はもとからある) */
const OPERATOR_SELECT_POLICY: Readonly<Record<Table, string>> = {
  announcements: 'Admins can view announcements',
  moderation_flags: 'moderation_flags_admin_select',
  recipe_flags: 'Users and admins can view recipe flags',
  personal_subscriptions: 'personal_subscriptions_select',
};
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
const USER_DB_ROLES = ['anon', 'authenticated'] as const;
type UserDbRole = (typeof USER_DB_ROLES)[number];
/** 本冊の後も利用者のロールに残る書き込みの権限 (recipe_flags の利用者の通報) */
const KEPT_USER_WRITES: Readonly<Record<Table, Readonly<Record<UserDbRole, readonly string[]>>>> = {
  announcements: { anon: [], authenticated: [] },
  moderation_flags: { anon: [], authenticated: [] },
  recipe_flags: { anon: [], authenticated: ['INSERT'] },
  personal_subscriptions: { anon: [], authenticated: [] },
};
/** 直接の INSERT が通っていないことを見つける列 (お知らせは title・通報は reason・契約は notes) */
const MARKER_COLUMN: Readonly<Record<Table, string>> = {
  announcements: 'title',
  moderation_flags: 'reason',
  recipe_flags: 'reason',
  personal_subscriptions: 'notes',
};

interface TestUser {
  id: string;
  email: string;
  /** サインインしただけのセッションの JWT (aal1) */
  jwt: string;
}

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdAnnouncementIds: string[] = [];
const createdFlagIds: string[] = [];
const createdRecipeFlagIds: string[] = [];
let seq = 0;

const emailOf = (label: string) => `rls-ann-mod-select-only-${label}-${RUN}-${++seq}@homegohan.test`;

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
      {
        id: data.user.id,
        nickname: `ann-mod-select-only-${label}`,
        age_group: '30s',
        gender: 'other',
        birth_date: ADULT_BIRTH_DATE,
        roles,
      },
      { onConflict: 'id' },
    ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const { jwt } = await signIn(email);
  return { id: data.user.id, email, jwt };
}

/** TOTP を登録して aal2 にしたセッションの JWT (verify は同じ利用者のほかのセッションを終えるので、aal1 の JWT は後で取り直す) */
async function aal2Jwt(user: TestUser): Promise<string> {
  const { client: sessionClient } = await signIn(user.email);
  return promoteToAal2(sessionClient);
}

async function insertAnnouncement(label: string, isPublic: boolean): Promise<string> {
  const { data, error } = await srAdmin
    .from('announcements')
    .insert({ title: `#1917 ann ${label} ${RUN}`, content: 'content', is_public: isPublic })
    .select('id')
    .single();
  if (error || !data) throw new Error(`announcements ${label}: ${error?.message}`);
  createdAnnouncementIds.push(data.id as string);
  return data.id as string;
}

async function insertFlag(label: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('moderation_flags')
    .insert({ reason: `#1917 flag ${label} ${RUN}`, status: 'pending' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`moderation_flags ${label}: ${error?.message}`);
  createdFlagIds.push(data.id as string);
  return data.id as string;
}

/** レシピの通報を service_role で作る (reporter = 通報した利用者) */
async function insertRecipeFlag(label: string, reporterId: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('recipe_flags')
    .insert({ reporter_id: reporterId, reason: `#1917 recipe flag ${label} ${RUN}` })
    .select('id')
    .single();
  if (error || !data) throw new Error(`recipe_flags ${label}: ${error?.message}`);
  createdRecipeFlagIds.push(data.id as string);
  return data.id as string;
}

/** 契約の行を service_role で作る (live でない expired の行。利用者ごとに 1 行の live の制約に当たらない。退会で CASCADE で消える) */
async function insertSubscription(label: string, userId: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('personal_subscriptions')
    .insert({ user_id: userId, plan_key: SUBSCRIPTION_PLAN_KEY, status: 'expired', notes: `#1917 subscription ${label} ${RUN}` })
    .select('id')
    .single();
  if (error || !data) throw new Error(`personal_subscriptions ${label}: ${error?.message}`);
  return data.id as string;
}

/**
 * 表ごとの、直接の書き込みに使う行の作り方と書き換え。
 * recipe_flags の行は通報した利用者 (reporterUser) を reporter にし、personal_subscriptions の行は契約の利用者 (subscriberUser) の行にする:
 * 呼び出し元から見て他人の行 (利用者の通報の INSERT のポリシーにも当たらない)。本人を reporter にした通報は A-8 が見る
 */
const NEW_ROW: Readonly<Record<Table, () => Record<string, unknown>>> = {
  announcements: () => ({ title: `#1917 direct ${RUN}`, content: 'direct', is_public: true }),
  moderation_flags: () => ({ reason: `#1917 direct ${RUN}`, status: 'pending' }),
  recipe_flags: () => ({ reason: `#1917 direct ${RUN}`, reporter_id: reporterUser.id }),
  personal_subscriptions: () => ({ user_id: subscriberUser.id, plan_key: SUBSCRIPTION_PLAN_KEY, status: 'active', notes: `#1917 direct ${RUN}` }),
};
const PATCH: Readonly<Record<Table, Record<string, unknown>>> = {
  announcements: { title: `#1917 tampered ${RUN}` },
  moderation_flags: { status: 'approved' },
  recipe_flags: { status: 'reviewed' },
  // 期限切れの契約を有料の active に戻す (手動付与の関数を通らずにプランを与える書き込み)
  personal_subscriptions: { status: 'active' },
};

let adminUser: TestUser;
let superAdminUser: TestUser;
let plainUser: TestUser;
/** レシピの通報を作った利用者 (既存の通報の reporter) */
let reporterUser: TestUser;
/** 契約の行を持つ利用者 (既存の契約の本人) */
let subscriberUser: TestUser;
/** 手動付与の関数で契約を付与する利用者 (live な行を持たない) */
let granteeUser: TestUser;
let adminAal2 = '';
let superAdminAal2 = '';
/** TOTP を登録済みの admin の aal1 のセッション */
let adminAal1AfterEnroll = '';
let publicAnnouncementId = '';
let draftAnnouncementId = '';
let flagId = '';
let recipeFlagId = '';
let subscriptionId = '';

/** 表の id の行 (service_role で読む。書き換わっていないことの確認に使う) */
async function rowOf(table: Table, id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`${table} ${id}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

const existingIdOf = (table: Table): string =>
  ({ announcements: publicAnnouncementId, moderation_flags: flagId, recipe_flags: recipeFlagId, personal_subscriptions: subscriptionId })[table];
const privateRowIdOf = (table: PrivateRowTable): string => existingIdOf(table);
/** 行の本人 (通報した利用者・契約の利用者) */
const ownerOf = (table: OwnedRowTable): TestUser => ({ recipe_flags: reporterUser, personal_subscriptions: subscriberUser })[table];

async function planKeyCachedOf(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('plan_key_cached').eq('id', userId).single();
  if (error) throw new Error(`user_profiles ${userId}: ${error.message}`);
  return (data as { plan_key_cached: string | null }).plan_key_cached;
}

beforeAll(async () => {
  adminUser = await createUser('admin', ['admin']);
  superAdminUser = await createUser('super-admin', ['super_admin']);
  plainUser = await createUser('user', ['user']);
  reporterUser = await createUser('reporter', ['user']);
  subscriberUser = await createUser('subscriber', ['user']);
  granteeUser = await createUser('grantee', ['user']);
  adminAal2 = await aal2Jwt(adminUser);
  superAdminAal2 = await aal2Jwt(superAdminUser);
  adminAal1AfterEnroll = (await signIn(adminUser.email)).jwt;
  publicAnnouncementId = await insertAnnouncement('public', true);
  draftAnnouncementId = await insertAnnouncement('draft', false);
  flagId = await insertFlag('existing');
  recipeFlagId = await insertRecipeFlag('existing', reporterUser.id);
  subscriptionId = await insertSubscription('existing', subscriberUser.id);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdAnnouncementIds.length > 0) await srAdmin.from('announcements').delete().in('id', createdAnnouncementIds);
  if (createdFlagIds.length > 0) await srAdmin.from('moderation_flags').delete().in('id', createdFlagIds);
  if (createdRecipeFlagIds.length > 0) await srAdmin.from('recipe_flags').delete().in('id', createdRecipeFlagIds);
  // 直接の書き込みが (もし) 通ってしまったときに残る行と、A-8 の利用者の通報も消す
  await srAdmin.from('announcements').delete().like('title', `%${RUN}%`);
  await srAdmin.from('moderation_flags').delete().like('reason', `%${RUN}%`);
  await srAdmin.from('recipe_flags').delete().like('reason', `%${RUN}%`);
  // 契約の行は利用者の退会 (auth.users の削除) で CASCADE で消える。直接の INSERT が (もし) 通った行も同じ利用者の行
  if (createdUserIds.length > 0) await srAdmin.from('personal_subscriptions').delete().in('user_id', createdUserIds);
  for (const id of createdUserIds) await srAdmin.auth.admin.deleteUser(id);
}, SETUP_TIMEOUT_MS);

describe('A-1: aal2 の運営の直接の書き込みは 42501 で、行は変わらない', () => {
  const operators = () => [
    ['admin', adminAal2],
    ['super_admin', superAdminAal2],
  ] as const;

  it.each(TABLES)('%s: INSERT は 42501 で、行は増えない', async (table) => {
    for (const [label, jwt] of operators()) {
      const row = NEW_ROW[table]();
      const { error } = await asUser(jwt).from(table).insert(row);
      expect(error?.code, `${label} ${table} INSERT`).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const { data } = await srAdmin.from(table).select('id').eq(MARKER_COLUMN[table], `#1917 direct ${RUN}`);
    expect(data ?? []).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each(TABLES)('%s: UPDATE は 42501 で、行は変わらない', async (table) => {
    const id = existingIdOf(table);
    const before = await rowOf(table, id);
    for (const [label, jwt] of operators()) {
      const { error } = await asUser(jwt).from(table).update(PATCH[table]).eq('id', id);
      expect(error?.code, `${label} ${table} UPDATE`).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await rowOf(table, id)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it.each(TABLES)('%s: DELETE は 42501 で、行は残る', async (table) => {
    const id = existingIdOf(table);
    for (const [label, jwt] of operators()) {
      const { error } = await asUser(jwt).from(table).delete().eq('id', id);
      expect(error?.code, `${label} ${table} DELETE`).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await rowOf(table, id)).not.toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('A-2 / A-3: 運営の読み取り (MFA の判定は残る)', () => {
  it('A-2: aal2 の admin は、非公開のお知らせと通報と他人の契約を読める', async () => {
    const { data: announcements, error } = await asUser(adminAal2).from('announcements').select('id').in('id', [publicAnnouncementId, draftAnnouncementId]);
    expect(error).toBeNull();
    expect((announcements ?? []).map((r) => r.id).sort()).toEqual([publicAnnouncementId, draftAnnouncementId].sort());
    for (const table of PRIVATE_ROW_TABLES) {
      const { data: rows, error: readError } = await asUser(adminAal2).from(table).select('id').eq('id', privateRowIdOf(table));
      expect(readError, table).toBeNull();
      expect((rows ?? []).map((r) => r.id), table).toEqual([privateRowIdOf(table)]);
    }
  }, TEST_TIMEOUT_MS);

  it('A-3: TOTP を登録済みの admin の aal1 のセッションは、非公開のお知らせと通報と他人の契約を読めない (公開のお知らせは読める)', async () => {
    const { data: announcements, error } = await asUser(adminAal1AfterEnroll).from('announcements').select('id').in('id', [publicAnnouncementId, draftAnnouncementId]);
    expect(error).toBeNull();
    expect((announcements ?? []).map((r) => r.id)).toEqual([publicAnnouncementId]);
    for (const table of PRIVATE_ROW_TABLES) {
      const { data: rows, error: readError } = await asUser(adminAal1AfterEnroll).from(table).select('id').eq('id', privateRowIdOf(table));
      expect(readError, table).toBeNull();
      expect(rows ?? [], table).toEqual([]);
    }
  }, TEST_TIMEOUT_MS);
});

describe('A-4 / A-5: 利用者と未認証', () => {
  it('A-4: 利用者は公開のお知らせだけを読め、他人の通報と契約は読めない', async () => {
    const { data: announcements, error } = await asUser(plainUser.jwt).from('announcements').select('id').in('id', [publicAnnouncementId, draftAnnouncementId]);
    expect(error).toBeNull();
    expect((announcements ?? []).map((r) => r.id)).toEqual([publicAnnouncementId]);
    for (const table of PRIVATE_ROW_TABLES) {
      const { data: rows, error: readError } = await asUser(plainUser.jwt).from(table).select('id').eq('id', privateRowIdOf(table));
      expect(readError, table).toBeNull();
      expect(rows ?? [], table).toEqual([]);
    }
  }, TEST_TIMEOUT_MS);

  it.each(TABLES)('A-5: %s: 利用者と未認証の INSERT / UPDATE / DELETE は 42501', async (table) => {
    const id = existingIdOf(table);
    const before = await rowOf(table, id);
    for (const [label, db] of [['user', asUser(plainUser.jwt)], ['anon', anon()]] as const) {
      expect((await db.from(table).insert(NEW_ROW[table]())).error?.code, `${label} INSERT`).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await db.from(table).update(PATCH[table]).eq('id', id)).error?.code, `${label} UPDATE`).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await db.from(table).delete().eq('id', id)).error?.code, `${label} DELETE`).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await rowOf(table, id)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it.each(OWNED_ROW_TABLES)('A-5: %s: 行の本人 (通報した本人・契約の本人) も、自分の行の UPDATE / DELETE は 42501 (修正前は 0 行で黙って終わった)', async (table) => {
    const id = existingIdOf(table);
    const before = await rowOf(table, id);
    const db = asUser(ownerOf(table).jwt);
    expect((await db.from(table).update(PATCH[table]).eq('id', id)).error?.code, 'UPDATE').toBe(INSUFFICIENT_PRIVILEGE);
    expect((await db.from(table).delete().eq('id', id)).error?.code, 'DELETE').toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rowOf(table, id)).toEqual(before);
  }, TEST_TIMEOUT_MS);
});

describe('A-8: recipe_flags の利用者の通報 (本人を reporter にした INSERT) は残る', () => {
  it.each([
    ['user', () => plainUser.id, () => plainUser.jwt],
    ['admin (aal2)', () => adminUser.id, () => adminAal2],
  ] as const)('%s は自分を reporter にした通報を作れる (status は pending)', async (label, idOf, jwtOf) => {
    const reason = `#1917 own report ${label} ${RUN}`;
    const { data, error } = await asUser(jwtOf()).from('recipe_flags').insert({ reporter_id: idOf(), reason }).select('id, reporter_id, status');
    expect(error).toBeNull();
    expect(data).toEqual([expect.objectContaining({ reporter_id: idOf(), status: 'pending' })]);
  }, TEST_TIMEOUT_MS);
});

describe('A-6: service_role は今までどおり書ける', () => {
  it('お知らせの INSERT / UPDATE / DELETE', async () => {
    const id = await insertAnnouncement('service', false);
    const { error: updateError } = await srAdmin.from('announcements').update({ is_public: true }).eq('id', id);
    expect(updateError).toBeNull();
    expect((await rowOf('announcements', id))?.is_public).toBe(true);
    const { error: deleteError } = await srAdmin.from('announcements').delete().eq('id', id);
    expect(deleteError).toBeNull();
    expect(await rowOf('announcements', id)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('レシピの通報の INSERT / UPDATE / DELETE', async () => {
    const id = await insertRecipeFlag('service', reporterUser.id);
    const { error: updateError } = await srAdmin.from('recipe_flags').update({ status: 'reviewed' }).eq('id', id);
    expect(updateError).toBeNull();
    expect((await rowOf('recipe_flags', id))?.status).toBe('reviewed');
    const { error: deleteError } = await srAdmin.from('recipe_flags').delete().eq('id', id);
    expect(deleteError).toBeNull();
    expect(await rowOf('recipe_flags', id)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('通報の INSERT / UPDATE / DELETE', async () => {
    const id = await insertFlag('service');
    const { error: updateError } = await srAdmin.from('moderation_flags').update({ status: 'approved' }).eq('id', id);
    expect(updateError).toBeNull();
    expect((await rowOf('moderation_flags', id))?.status).toBe('approved');
    const { error: deleteError } = await srAdmin.from('moderation_flags').delete().eq('id', id);
    expect(deleteError).toBeNull();
    expect(await rowOf('moderation_flags', id)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('契約の INSERT / UPDATE / DELETE', async () => {
    const id = await insertSubscription('service', subscriberUser.id);
    const { error: updateError } = await srAdmin.from('personal_subscriptions').update({ notes: `#1917 touched ${RUN}` }).eq('id', id);
    expect(updateError).toBeNull();
    expect((await rowOf('personal_subscriptions', id))?.notes).toBe(`#1917 touched ${RUN}`);
    const { error: deleteError } = await srAdmin.from('personal_subscriptions').delete().eq('id', id);
    expect(deleteError).toBeNull();
    expect(await rowOf('personal_subscriptions', id)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('契約の手動付与と取り消しの関数 (SECURITY DEFINER) は、service_role から今までどおり行を書き、plan_key_cached を合わせる', async () => {
    const granted = await srAdmin.rpc('billing_grant_manual_subscription', {
      p_user_id: granteeUser.id,
      p_plan_key: SUBSCRIPTION_PLAN_KEY,
      p_expires_at: null,
    });
    expect(granted.error).toBeNull();
    const grantedId = (granted.data as { subscription_id: string }).subscription_id;
    expect(await rowOf('personal_subscriptions', grantedId)).toMatchObject({
      user_id: granteeUser.id,
      plan_key: SUBSCRIPTION_PLAN_KEY,
      status: 'active',
      stripe_subscription_id: null,
    });
    expect(await planKeyCachedOf(granteeUser.id)).toBe(SUBSCRIPTION_PLAN_KEY);

    const revoked = await srAdmin.rpc('billing_revoke_manual_subscription', { p_user_id: granteeUser.id });
    expect(revoked.error).toBeNull();
    expect(await rowOf('personal_subscriptions', grantedId)).toMatchObject({ status: 'cancelled' });
    expect(await planKeyCachedOf(granteeUser.id)).toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('A-7: カタログ', () => {
  it.each(TABLES)('%s: 書き込みを許すポリシーが無い (SELECT 以外は利用者の通報の INSERT と常に偽の DELETE の禁止だけ)。運営の SELECT のポリシーは TO authenticated で operator_mfa_satisfied() を呼ぶ', async (table) => {
    const rows = await pgQuery<{ policyname: string; cmd: string; roles: string; qual: string | null; with_check: string | null }>(`
      SELECT policyname, cmd, roles::text AS roles, qual, with_check
      FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}'
      ORDER BY policyname COLLATE "C"`);
    expect(rows.map((r) => [r.policyname, r.cmd])).toEqual([...EXPECTED_POLICIES[table]].map(([n, c]) => [n, c]));
    const operator = rows.find((r) => r.policyname === OPERATOR_SELECT_POLICY[table]);
    expect(operator?.roles).toBe('{authenticated}');
    expect(operator?.qual ?? '').toContain('operator_mfa_satisfied()');
    expect(operator?.with_check).toBeNull();
    for (const row of rows) expect(row.cmd, row.policyname).toBe(KEPT_NON_SELECT_POLICIES[row.policyname] ?? 'SELECT');
    const report = rows.find((r) => r.policyname === USER_REPORT_INSERT_POLICY);
    if (report) {
      // 残す利用者の通報は、本人を reporter にした行だけ (運営の枝を持たない)
      expect(report.roles).toBe('{authenticated}');
      expect(report.with_check).toBe('(reporter_id = auth.uid())');
    }
    const noDelete = rows.find((r) => r.policyname === SUBSCRIPTION_NO_DELETE_POLICY);
    if (noDelete) {
      // 残す DELETE のポリシーは常に偽 (何も消させない)
      expect(noDelete.qual).toBe('false');
      expect(noDelete.with_check).toBeNull();
    }
  }, TEST_TIMEOUT_MS);

  it.each(TABLES)('%s: anon / authenticated は書き込みの権限を持たず (recipe_flags の authenticated の INSERT だけ残る) SELECT を持つ。service_role は書き込みを持つ', async (table) => {
    const checks = [...USER_DB_ROLES, 'service_role'].flatMap((role) =>
      [...WRITE_PRIVILEGES, 'SELECT'].map((privilege) => `SELECT '${role}' AS role, '${privilege}' AS privilege, has_table_privilege('${role}', 'public.${table}', '${privilege}') AS held`),
    );
    const rows = await pgQuery<{ role: string; privilege: string; held: boolean }>(checks.join(' UNION ALL '));
    const held = new Map(rows.map((r) => [`${r.role} ${r.privilege}`, r.held]));
    for (const role of USER_DB_ROLES) {
      for (const privilege of WRITE_PRIVILEGES) {
        expect(held.get(`${role} ${privilege}`), `${role} ${privilege}`).toBe(KEPT_USER_WRITES[table][role].includes(privilege));
      }
      expect(held.get(`${role} SELECT`), `${role} SELECT`).toBe(true);
    }
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'SELECT']) expect(held.get(`service_role ${privilege}`), `service_role ${privilege}`).toBe(true);
  }, TEST_TIMEOUT_MS);
});
