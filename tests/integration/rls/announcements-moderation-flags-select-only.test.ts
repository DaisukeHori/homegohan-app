/**
 * #1917 の続き: 運営 (admin / super_admin) の announcements (お知らせ) と moderation_flags (食事の通報) の FOR ALL のポリシーを
 * SELECT だけにし、recipe_flags (レシピの通報) の運営の FOR UPDATE のポリシーを消し、anon / authenticated の書き込みの権限を外した
 * (migration 20261024110000_announcements_moderation_flags_select_only.sql)。
 * 修正前は、MFA 済み (aal2) の運営が自分のセッションの JWT で PostgREST からお知らせ・食事の通報を直接 INSERT / UPDATE / DELETE でき、
 * レシピの通報を直接 UPDATE でき、運営の API (POST /api/announcements・運営の通報の API) と監査ログ (admin_audit_logs) を通らなかった。
 * recipe_flags の利用者の通報 (INSERT・reporter_id = 本人) は残す。
 *
 * 直接の操作の結果 (この表で固定する。「通報」は moderation_flags と recipe_flags):
 *   | 呼び出し元                         | 操作                                    | 修正前                       | 修正後                       |
 *   |------------------------------------|-----------------------------------------|------------------------------|------------------------------|
 *   | 運営 (admin・super_admin・aal2)    | INSERT / UPDATE / DELETE                | 書ける (recipe_flags は UPDATE だけ) | 42501・行は変わらない (A-1)  |
 *   | 運営 (admin・aal2)                 | SELECT (非公開・通報)                   | 見える                       | 見える (A-2)                 |
 *   | 運営 (admin・TOTP 登録済み・aal1)  | SELECT (非公開・通報)                   | 見えない                     | 見えない (MFA の判定。A-3)   |
 *   | 利用者 (user)                      | SELECT                                  | 公開だけ・他人の通報 0       | 公開だけ・他人の通報 0 (A-4) |
 *   | 利用者 (user)・未認証 (anon)       | INSERT / UPDATE / DELETE                | 42501 / 0 行                 | 42501 (A-5)                  |
 *   | 利用者・運営 (aal2)                | recipe_flags の本人を reporter にした INSERT | 書ける                  | 書ける (A-8)                 |
 *   | service_role                       | INSERT / UPDATE / DELETE                | 書ける                       | 書ける (A-6)                 |
 *
 * 確かめること:
 *   - A-1: aal2 の admin と super_admin の、お知らせと通報の直接の INSERT / UPDATE / DELETE は 42501 で、行は変わらない
 *          (recipe_flags の INSERT は他人を reporter にした行。本人を reporter にした通報は A-8)
 *   - A-2: aal2 の admin は、非公開のお知らせと通報を読める (管理用の一覧 GET /api/announcements が本人のセッションで読む)
 *   - A-3: TOTP を登録済みの admin の aal1 のセッションは、非公開のお知らせと通報を読めない (運営の MFA の判定が残っている)
 *   - A-4: 利用者は公開のお知らせだけを読め、他人の通報は 1 行も読めない
 *   - A-5: 利用者と未認証の直接の書き込みは 42501 (通報した本人の、自分の通報の UPDATE / DELETE も)
 *   - A-6: service_role は今までどおり書ける (POST /api/announcements・運営の通報の API・テストの後片付けが使う)
 *   - A-7: カタログ: 3 つの表に UPDATE / DELETE / ALL のポリシーが無く、INSERT のポリシーは recipe_flags の利用者の通報だけ。
 *          運営の SELECT のポリシーは TO authenticated・operator_mfa_satisfied() を呼ぶ。anon / authenticated は UPDATE / DELETE /
 *          TRUNCATE を持たず、INSERT は recipe_flags の authenticated だけが持ち、SELECT を持つ。service_role は書き込みを持つ
 *   - A-8: recipe_flags の利用者の通報 (本人を reporter にした INSERT) は、利用者も aal2 の運営も今までどおり作れる
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

/** 本冊が運営の直接の書き込みを塞いだ表 */
const TABLES = ['announcements', 'moderation_flags', 'recipe_flags'] as const;
type Table = (typeof TABLES)[number];
/** 通報の表 (読み取りの確認に使う) */
const FLAG_TABLES = ['moderation_flags', 'recipe_flags'] as const;
/** recipe_flags に残す利用者の通報の INSERT のポリシー */
const USER_REPORT_INSERT_POLICY = 'Anyone can create recipe flags';
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
};
/** 運営の SELECT のポリシー (announcements と moderation_flags は本冊が作り直した。recipe_flags はもとからある) */
const OPERATOR_SELECT_POLICY: Readonly<Record<Table, string>> = {
  announcements: 'Admins can view announcements',
  moderation_flags: 'moderation_flags_admin_select',
  recipe_flags: 'Users and admins can view recipe flags',
};
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
const USER_DB_ROLES = ['anon', 'authenticated'] as const;
type UserDbRole = (typeof USER_DB_ROLES)[number];
/** 本冊の後も利用者のロールに残る書き込みの権限 (recipe_flags の利用者の通報) */
const KEPT_USER_WRITES: Readonly<Record<Table, Readonly<Record<UserDbRole, readonly string[]>>>> = {
  announcements: { anon: [], authenticated: [] },
  moderation_flags: { anon: [], authenticated: [] },
  recipe_flags: { anon: [], authenticated: ['INSERT'] },
};
/** 通報の行を見つける列 (お知らせは title) */
const MARKER_COLUMN: Readonly<Record<Table, string>> = { announcements: 'title', moderation_flags: 'reason', recipe_flags: 'reason' };

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

/**
 * 表ごとの、直接の書き込みに使う行の作り方と書き換え。
 * recipe_flags の行は通報した利用者 (reporterUser) を reporter にする: 呼び出し元から見て他人の名前の通報 (利用者の通報の INSERT の
 * ポリシーにも当たらない)。本人を reporter にした通報は A-8 が見る
 */
const NEW_ROW: Readonly<Record<Table, () => Record<string, unknown>>> = {
  announcements: () => ({ title: `#1917 direct ${RUN}`, content: 'direct', is_public: true }),
  moderation_flags: () => ({ reason: `#1917 direct ${RUN}`, status: 'pending' }),
  recipe_flags: () => ({ reason: `#1917 direct ${RUN}`, reporter_id: reporterUser.id }),
};
const PATCH: Readonly<Record<Table, Record<string, unknown>>> = {
  announcements: { title: `#1917 tampered ${RUN}` },
  moderation_flags: { status: 'approved' },
  recipe_flags: { status: 'reviewed' },
};

let adminUser: TestUser;
let superAdminUser: TestUser;
let plainUser: TestUser;
/** レシピの通報を作った利用者 (既存の通報の reporter) */
let reporterUser: TestUser;
let adminAal2 = '';
let superAdminAal2 = '';
/** TOTP を登録済みの admin の aal1 のセッション */
let adminAal1AfterEnroll = '';
let publicAnnouncementId = '';
let draftAnnouncementId = '';
let flagId = '';
let recipeFlagId = '';

/** 表の id の行 (service_role で読む。書き換わっていないことの確認に使う) */
async function rowOf(table: Table, id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`${table} ${id}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

const existingIdOf = (table: Table): string =>
  ({ announcements: publicAnnouncementId, moderation_flags: flagId, recipe_flags: recipeFlagId })[table];
const flagIdOf = (table: (typeof FLAG_TABLES)[number]): string => existingIdOf(table);

beforeAll(async () => {
  adminUser = await createUser('admin', ['admin']);
  superAdminUser = await createUser('super-admin', ['super_admin']);
  plainUser = await createUser('user', ['user']);
  reporterUser = await createUser('reporter', ['user']);
  adminAal2 = await aal2Jwt(adminUser);
  superAdminAal2 = await aal2Jwt(superAdminUser);
  adminAal1AfterEnroll = (await signIn(adminUser.email)).jwt;
  publicAnnouncementId = await insertAnnouncement('public', true);
  draftAnnouncementId = await insertAnnouncement('draft', false);
  flagId = await insertFlag('existing');
  recipeFlagId = await insertRecipeFlag('existing', reporterUser.id);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdAnnouncementIds.length > 0) await srAdmin.from('announcements').delete().in('id', createdAnnouncementIds);
  if (createdFlagIds.length > 0) await srAdmin.from('moderation_flags').delete().in('id', createdFlagIds);
  if (createdRecipeFlagIds.length > 0) await srAdmin.from('recipe_flags').delete().in('id', createdRecipeFlagIds);
  // 直接の書き込みが (もし) 通ってしまったときに残る行と、A-8 の利用者の通報も消す
  await srAdmin.from('announcements').delete().like('title', `%${RUN}%`);
  await srAdmin.from('moderation_flags').delete().like('reason', `%${RUN}%`);
  await srAdmin.from('recipe_flags').delete().like('reason', `%${RUN}%`);
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
  it('A-2: aal2 の admin は、非公開のお知らせと通報を読める', async () => {
    const { data: announcements, error } = await asUser(adminAal2).from('announcements').select('id').in('id', [publicAnnouncementId, draftAnnouncementId]);
    expect(error).toBeNull();
    expect((announcements ?? []).map((r) => r.id).sort()).toEqual([publicAnnouncementId, draftAnnouncementId].sort());
    for (const table of FLAG_TABLES) {
      const { data: flags, error: flagError } = await asUser(adminAal2).from(table).select('id').eq('id', flagIdOf(table));
      expect(flagError, table).toBeNull();
      expect((flags ?? []).map((r) => r.id), table).toEqual([flagIdOf(table)]);
    }
  }, TEST_TIMEOUT_MS);

  it('A-3: TOTP を登録済みの admin の aal1 のセッションは、非公開のお知らせと通報を読めない (公開のお知らせは読める)', async () => {
    const { data: announcements, error } = await asUser(adminAal1AfterEnroll).from('announcements').select('id').in('id', [publicAnnouncementId, draftAnnouncementId]);
    expect(error).toBeNull();
    expect((announcements ?? []).map((r) => r.id)).toEqual([publicAnnouncementId]);
    for (const table of FLAG_TABLES) {
      const { data: flags, error: flagError } = await asUser(adminAal1AfterEnroll).from(table).select('id').eq('id', flagIdOf(table));
      expect(flagError, table).toBeNull();
      expect(flags ?? [], table).toEqual([]);
    }
  }, TEST_TIMEOUT_MS);
});

describe('A-4 / A-5: 利用者と未認証', () => {
  it('A-4: 利用者は公開のお知らせだけを読め、他人の通報は読めない', async () => {
    const { data: announcements, error } = await asUser(plainUser.jwt).from('announcements').select('id').in('id', [publicAnnouncementId, draftAnnouncementId]);
    expect(error).toBeNull();
    expect((announcements ?? []).map((r) => r.id)).toEqual([publicAnnouncementId]);
    for (const table of FLAG_TABLES) {
      const { data: flags, error: flagError } = await asUser(plainUser.jwt).from(table).select('id').eq('id', flagIdOf(table));
      expect(flagError, table).toBeNull();
      expect(flags ?? [], table).toEqual([]);
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

  it('A-5: recipe_flags: 通報した本人も、自分の通報の UPDATE / DELETE は 42501 (修正前は 0 行で黙って終わった)', async () => {
    const before = await rowOf('recipe_flags', recipeFlagId);
    const db = asUser(reporterUser.jwt);
    expect((await db.from('recipe_flags').update(PATCH.recipe_flags).eq('id', recipeFlagId)).error?.code, 'UPDATE').toBe(INSUFFICIENT_PRIVILEGE);
    expect((await db.from('recipe_flags').delete().eq('id', recipeFlagId)).error?.code, 'DELETE').toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rowOf('recipe_flags', recipeFlagId)).toEqual(before);
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
});

describe('A-7: カタログ', () => {
  it.each(TABLES)('%s: UPDATE / DELETE / ALL のポリシーが無い (INSERT は利用者の通報だけ)。運営の SELECT のポリシーは TO authenticated で operator_mfa_satisfied() を呼ぶ', async (table) => {
    const rows = await pgQuery<{ policyname: string; cmd: string; roles: string; qual: string | null; with_check: string | null }>(`
      SELECT policyname, cmd, roles::text AS roles, qual, with_check
      FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}'
      ORDER BY policyname COLLATE "C"`);
    expect(rows.map((r) => [r.policyname, r.cmd])).toEqual([...EXPECTED_POLICIES[table]].map(([n, c]) => [n, c]));
    const operator = rows.find((r) => r.policyname === OPERATOR_SELECT_POLICY[table]);
    expect(operator?.roles).toBe('{authenticated}');
    expect(operator?.qual ?? '').toContain('operator_mfa_satisfied()');
    expect(operator?.with_check).toBeNull();
    for (const row of rows) expect(row.cmd, row.policyname).toBe(row.policyname === USER_REPORT_INSERT_POLICY ? 'INSERT' : 'SELECT');
    const report = rows.find((r) => r.policyname === USER_REPORT_INSERT_POLICY);
    if (report) {
      // 残す利用者の通報は、本人を reporter にした行だけ (運営の枝を持たない)
      expect(report.roles).toBe('{authenticated}');
      expect(report.with_check).toBe('(reporter_id = auth.uid())');
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
