/**
 * #1917 の続き: 運営 (admin / super_admin) の announcements (お知らせ) と moderation_flags (食事の通報) の FOR ALL のポリシーを
 * SELECT だけにし、anon / authenticated の書き込みの権限を外した (migration 20261024110000_announcements_moderation_flags_select_only.sql)。
 * 修正前は、MFA 済み (aal2) の運営が自分のセッションの JWT で PostgREST からお知らせ・通報を直接 INSERT / UPDATE / DELETE でき、
 * 運営の API (POST /api/announcements・運営の通報の API) と監査ログ (admin_audit_logs) を通らなかった。
 *
 * 直接の操作の結果 (この表で固定する):
 *   | 呼び出し元                         | 操作                         | 修正前           | 修正後                       |
 *   |------------------------------------|------------------------------|------------------|------------------------------|
 *   | 運営 (admin・super_admin・aal2)    | INSERT / UPDATE / DELETE     | 書ける           | 42501・行は変わらない (A-1)  |
 *   | 運営 (admin・aal2)                 | SELECT (非公開・通報)        | 見える           | 見える (A-2)                 |
 *   | 運営 (admin・TOTP 登録済み・aal1)  | SELECT (非公開・通報)        | 見えない         | 見えない (MFA の判定。A-3)   |
 *   | 利用者 (user)                      | SELECT                       | 公開だけ・通報 0 | 公開だけ・通報 0 (A-4)       |
 *   | 利用者 (user)・未認証 (anon)       | INSERT / UPDATE / DELETE     | 42501 / 0 行     | 42501 (A-5)                  |
 *   | service_role                       | INSERT / UPDATE / DELETE     | 書ける           | 書ける (A-6)                 |
 *
 * 確かめること:
 *   - A-1: aal2 の admin と super_admin の、お知らせと通報の直接の INSERT / UPDATE / DELETE は 42501 で、行は変わらない
 *   - A-2: aal2 の admin は、非公開のお知らせと通報を読める (管理用の一覧 GET /api/announcements が本人のセッションで読む)
 *   - A-3: TOTP を登録済みの admin の aal1 のセッションは、非公開のお知らせと通報を読めない (運営の MFA の判定が残っている)
 *   - A-4: 利用者は公開のお知らせだけを読め、通報は 1 行も読めない
 *   - A-5: 利用者と未認証の直接の書き込みは 42501
 *   - A-6: service_role は今までどおり書ける (POST /api/announcements・運営の通報の API・テストの後片付けが使う)
 *   - A-7: カタログ: 2 つの表のポリシーは SELECT だけで、運営の SELECT のポリシーは TO authenticated・operator_mfa_satisfied() を呼ぶ。
 *          anon / authenticated は INSERT / UPDATE / DELETE / TRUNCATE を持たず SELECT を持つ。service_role は書き込みを持つ
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

/** 本冊が書き込みを塞いだ表 */
const TABLES = ['announcements', 'moderation_flags'] as const;
type Table = (typeof TABLES)[number];
/** 本冊の後の、表ごとのポリシー (名前 → 種類) */
const EXPECTED_POLICIES: Readonly<Record<Table, ReadonlyArray<readonly [string, string]>>> = {
  announcements: [
    ['Admins can view announcements', 'SELECT'],
    ['Public announcements are viewable by everyone', 'SELECT'],
  ],
  moderation_flags: [['moderation_flags_admin_select', 'SELECT']],
};
/** 本冊が作った運営の SELECT のポリシー */
const OPERATOR_SELECT_POLICY: Readonly<Record<Table, string>> = {
  announcements: 'Admins can view announcements',
  moderation_flags: 'moderation_flags_admin_select',
};
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
const USER_DB_ROLES = ['anon', 'authenticated'] as const;

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

/** 表ごとの、直接の書き込みに使う行の作り方と書き換え */
const NEW_ROW: Readonly<Record<Table, () => Record<string, unknown>>> = {
  announcements: () => ({ title: `#1917 direct ${RUN}`, content: 'direct', is_public: true }),
  moderation_flags: () => ({ reason: `#1917 direct ${RUN}`, status: 'pending' }),
};
const PATCH: Readonly<Record<Table, Record<string, unknown>>> = {
  announcements: { title: `#1917 tampered ${RUN}` },
  moderation_flags: { status: 'approved' },
};

let adminUser: TestUser;
let superAdminUser: TestUser;
let plainUser: TestUser;
let adminAal2 = '';
let superAdminAal2 = '';
/** TOTP を登録済みの admin の aal1 のセッション */
let adminAal1AfterEnroll = '';
let publicAnnouncementId = '';
let draftAnnouncementId = '';
let flagId = '';

/** 表の id の行 (service_role で読む。書き換わっていないことの確認に使う) */
async function rowOf(table: Table, id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`${table} ${id}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

const existingIdOf = (table: Table) => (table === 'announcements' ? publicAnnouncementId : flagId);

beforeAll(async () => {
  adminUser = await createUser('admin', ['admin']);
  superAdminUser = await createUser('super-admin', ['super_admin']);
  plainUser = await createUser('user', ['user']);
  adminAal2 = await aal2Jwt(adminUser);
  superAdminAal2 = await aal2Jwt(superAdminUser);
  adminAal1AfterEnroll = (await signIn(adminUser.email)).jwt;
  publicAnnouncementId = await insertAnnouncement('public', true);
  draftAnnouncementId = await insertAnnouncement('draft', false);
  flagId = await insertFlag('existing');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdAnnouncementIds.length > 0) await srAdmin.from('announcements').delete().in('id', createdAnnouncementIds);
  if (createdFlagIds.length > 0) await srAdmin.from('moderation_flags').delete().in('id', createdFlagIds);
  // 直接の書き込みが (もし) 通ってしまったときに残る行も消す
  await srAdmin.from('announcements').delete().like('title', `%${RUN}%`);
  await srAdmin.from('moderation_flags').delete().like('reason', `%${RUN}%`);
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
    const marker = table === 'announcements' ? 'title' : 'reason';
    const { data } = await srAdmin.from(table).select('id').eq(marker, `#1917 direct ${RUN}`);
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
    const { data: flags, error: flagError } = await asUser(adminAal2).from('moderation_flags').select('id').eq('id', flagId);
    expect(flagError).toBeNull();
    expect((flags ?? []).map((r) => r.id)).toEqual([flagId]);
  }, TEST_TIMEOUT_MS);

  it('A-3: TOTP を登録済みの admin の aal1 のセッションは、非公開のお知らせと通報を読めない (公開のお知らせは読める)', async () => {
    const { data: announcements, error } = await asUser(adminAal1AfterEnroll).from('announcements').select('id').in('id', [publicAnnouncementId, draftAnnouncementId]);
    expect(error).toBeNull();
    expect((announcements ?? []).map((r) => r.id)).toEqual([publicAnnouncementId]);
    const { data: flags, error: flagError } = await asUser(adminAal1AfterEnroll).from('moderation_flags').select('id').eq('id', flagId);
    expect(flagError).toBeNull();
    expect(flags ?? []).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

describe('A-4 / A-5: 利用者と未認証', () => {
  it('A-4: 利用者は公開のお知らせだけを読め、通報は読めない', async () => {
    const { data: announcements, error } = await asUser(plainUser.jwt).from('announcements').select('id').in('id', [publicAnnouncementId, draftAnnouncementId]);
    expect(error).toBeNull();
    expect((announcements ?? []).map((r) => r.id)).toEqual([publicAnnouncementId]);
    const { data: flags, error: flagError } = await asUser(plainUser.jwt).from('moderation_flags').select('id').eq('id', flagId);
    expect(flagError).toBeNull();
    expect(flags ?? []).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each(TABLES)('A-5: %s: 利用者と未認証の INSERT / UPDATE / DELETE は 42501', async (table) => {
    const id = existingIdOf(table);
    for (const [label, db] of [['user', asUser(plainUser.jwt)], ['anon', anon()]] as const) {
      expect((await db.from(table).insert(NEW_ROW[table]())).error?.code, `${label} INSERT`).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await db.from(table).update(PATCH[table]).eq('id', id)).error?.code, `${label} UPDATE`).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await db.from(table).delete().eq('id', id)).error?.code, `${label} DELETE`).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await rowOf(table, id)).not.toBeNull();
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
  it.each(TABLES)('%s: ポリシーは SELECT だけ。運営の SELECT のポリシーは TO authenticated で operator_mfa_satisfied() を呼ぶ', async (table) => {
    const rows = await pgQuery<{ policyname: string; cmd: string; roles: string; qual: string | null; with_check: string | null }>(`
      SELECT policyname, cmd, roles::text AS roles, qual, with_check
      FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}'
      ORDER BY policyname COLLATE "C"`);
    expect(rows.map((r) => [r.policyname, r.cmd])).toEqual([...EXPECTED_POLICIES[table]].map(([n, c]) => [n, c]));
    const operator = rows.find((r) => r.policyname === OPERATOR_SELECT_POLICY[table]);
    expect(operator?.roles).toBe('{authenticated}');
    expect(operator?.qual ?? '').toContain('operator_mfa_satisfied()');
    expect(operator?.with_check).toBeNull();
  }, TEST_TIMEOUT_MS);

  it.each(TABLES)('%s: anon / authenticated は書き込みの権限を持たず SELECT を持つ。service_role は書き込みを持つ', async (table) => {
    const checks = [...USER_DB_ROLES, 'service_role'].flatMap((role) =>
      [...WRITE_PRIVILEGES, 'SELECT'].map((privilege) => `SELECT '${role}' AS role, '${privilege}' AS privilege, has_table_privilege('${role}', 'public.${table}', '${privilege}') AS held`),
    );
    const rows = await pgQuery<{ role: string; privilege: string; held: boolean }>(checks.join(' UNION ALL '));
    const held = new Map(rows.map((r) => [`${r.role} ${r.privilege}`, r.held]));
    for (const role of USER_DB_ROLES) {
      for (const privilege of WRITE_PRIVILEGES) expect(held.get(`${role} ${privilege}`), `${role} ${privilege}`).toBe(false);
      expect(held.get(`${role} SELECT`), `${role} SELECT`).toBe(true);
    }
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'SELECT']) expect(held.get(`service_role ${privilege}`), `service_role ${privilege}`).toBe(true);
  }, TEST_TIMEOUT_MS);
});
