/**
 * #1917 整合ゲートの候補 2 件の回帰テスト (migration 20261022190000_db_privilege_hardening.sql)
 *
 * 修正前は
 *   - 組織の owner / admin が、PostgREST の直接の UPDATE (RLS organizations_update_admin) で、自分の組織の契約の状態と期限
 *     (subscription_status / subscription_expires_at) と解散の時刻 (dissolved_at) を書けた。ガード guard_organizations_privileged は
 *     owner_id と status だけを止めていた
 *   - ベースラインの GRANT ALL と既定の権限で、public のほとんどの表に anon / authenticated の TRUNCATE が残っていた
 *
 * 確かめること:
 *   - H: owner / admin の JWT の直接の UPDATE で 3 列を変えると 42501 (CANNOT_MODIFY_PRIVILEGED_COLUMN) で、行は変わらない。
 *        3 列を変えない UPDATE (組織名・同じ値を書く UPDATE) は今までどおり通る。service_role は 3 列を書ける。
 *        オーナーの解散 (dissolve_org_by_owner。SECURITY DEFINER) は今までどおり dissolved_at を書ける
 *   - T: public の全部の表・ビューで、anon / authenticated に TRUNCATE が無い。SELECT・INSERT・UPDATE・DELETE と service_role の
 *        TRUNCATE は変えていない。既定の権限 (postgres が public に作る表) にも anon / authenticated の TRUNCATE が無い
 *   - G: ガード関数の属性 (SECURITY INVOKER・search_path の指定なし) とトリガーは変えていない
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST / RPC を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/db-privilege-hardening.test.ts
 * カタログの確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で読み取りだけ行う。
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
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

/** ローカルスタックの postgres-meta で SQL を実行する (カタログの確認だけに使う。読み取り専用) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

/** 権限が無い書き込み・ガードの拒否の SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** ガード guard_organizations_privileged の例外の文 */
const GUARD_MESSAGE = 'CANNOT_MODIFY_PRIVILEGED_COLUMN';
/** 成人の生年月日 (年齢の判定に掛からない値) */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 準備で入れる契約の状態 (src/lib/org-plans.ts の ORG_SUBSCRIPTION_STATUS_VALUES の 1 つ) */
const INITIAL_SUBSCRIPTION_STATUS = 'active';
/** 利用者が書こうとする契約の状態 (準備の値と違う値) */
const TAMPERED_SUBSCRIPTION_STATUS = 'trial';
/** 準備で入れる契約の期限 */
const INITIAL_EXPIRES_AT = '2027-01-01T00:00:00+00:00';
/** 利用者が書こうとする、先へ延ばした契約の期限 */
const TAMPERED_EXPIRES_AT = '2099-12-31T00:00:00+00:00';
/** service_role が書く契約の期限 (運営が直す経路) */
const OPERATOR_EXPIRES_AT = '2028-06-30T00:00:00+00:00';
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒。利用者・組織を複数作る) */
const SETUP_TIMEOUT_MS = 180_000;
/** TRUNCATE を外す対象の relkind (表・パーティションの親・ビュー・マテリアライズドビュー・外部表) */
const RELKINDS_SQL = "('r', 'p', 'v', 'm', 'f')";

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

interface OrgRow {
  name: string;
  status: string;
  owner_id: string | null;
  subscription_status: string | null;
  subscription_expires_at: string | null;
  dissolved_at: string | null;
}

const ORG_COLUMNS = 'name, status, owner_id, subscription_status, subscription_expires_at, dissolved_at';

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
let seq = 0;

const address = (label: string) => `sec-db-priv-${label}-${RUN}-${++seq}@homegohan.test`;

async function createUser(label: string): Promise<TestUser> {
  const email = address(label);
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      { id: data.user.id, nickname: `db-priv-${label}`, age_group: '30s', gender: 'other', birth_date: ADULT_BIRTH_DATE },
      { onConflict: 'id' },
    ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

async function setOrgMembership(user: TestUser, orgId: string, role: 'owner' | 'admin' | 'member'): Promise<void> {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: role, is_active_in_org: true, joined_org_at: new Date().toISOString() })
    .eq('id', user.id);
  if (error) throw new Error(`membership ${role}: ${error.message}`);
}

/** 組織を service_role で作り (契約の状態と期限も service_role で入れる)、オーナーを owner として所属させる */
async function createOrg(owner: TestUser, label: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({
      name: `db-priv ${label} ${RUN}`,
      owner_id: owner.id,
      subscription_status: INITIAL_SUBSCRIPTION_STATUS,
      subscription_expires_at: INITIAL_EXPIRES_AT,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = (data as { id: string }).id;
  createdOrgIds.push(orgId);
  await setOrgMembership(owner, orgId, 'owner');
  return orgId;
}

async function orgRow(orgId: string): Promise<OrgRow> {
  const { data, error } = await srAdmin.from('organizations').select(ORG_COLUMNS).eq('id', orgId).single();
  if (error || !data) throw new Error(`organizations: ${error?.message}`);
  return data as OrgRow;
}

/** 時刻の列を Date の値で比べられる形にする (PostgREST の表記の揺れ (+00:00 / Z・秒の小数) を吸収する) */
const instant = (value: string | null): number | null => (value === null ? null : new Date(value).getTime());

function expectGuardRejected(error: { code?: string; message?: string } | null): void {
  expect(error, `${GUARD_MESSAGE} (42501) で断られること`).not.toBeNull();
  expect(error!.code).toBe(INSUFFICIENT_PRIVILEGE);
  expect(error!.message).toBe(GUARD_MESSAGE);
}

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
/** owner の組織 (admin と member が所属する) */
let orgA: string;

beforeAll(async () => {
  owner = await createUser('owner');
  admin = await createUser('admin');
  member = await createUser('member');
  orgA = await createOrg(owner, 'A');
  await setOrgMembership(admin, orgA, 'admin');
  await setOrgMembership(member, orgA, 'member');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false, joined_org_at: null })
      .in('id', createdUserIds);
  }
  if (createdOrgIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdOrgIds);
    await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, SETUP_TIMEOUT_MS);

describe('#1917 組織の契約の状態・期限・解散の時刻は、利用者が直接書けない', () => {
  it('H-1: owner は subscription_status を直接 UPDATE できない (42501)。行は変わらない', async () => {
    const before = await orgRow(orgA);
    const { error } = await asUser(owner.jwt)
      .from('organizations')
      .update({ subscription_status: TAMPERED_SUBSCRIPTION_STATUS })
      .eq('id', orgA)
      .select('id');
    expectGuardRejected(error);
    expect(await orgRow(orgA)).toEqual(before);
  });

  it('H-2: owner は subscription_expires_at を直接 UPDATE できない (42501)。期限は延びない', async () => {
    const before = await orgRow(orgA);
    const { error } = await asUser(owner.jwt)
      .from('organizations')
      .update({ subscription_expires_at: TAMPERED_EXPIRES_AT })
      .eq('id', orgA)
      .select('id');
    expectGuardRejected(error);
    const after = await orgRow(orgA);
    expect(after).toEqual(before);
    expect(instant(after.subscription_expires_at)).toBe(instant(INITIAL_EXPIRES_AT));
  });

  it('H-3: owner は dissolved_at を直接 UPDATE できない (42501。status を変えない UPDATE でも)', async () => {
    const before = await orgRow(orgA);
    const { error } = await asUser(owner.jwt)
      .from('organizations')
      .update({ dissolved_at: new Date().toISOString() })
      .eq('id', orgA)
      .select('id');
    expectGuardRejected(error);
    expect(await orgRow(orgA)).toEqual(before);
  });

  it('H-4: admin も 3 列のどれも直接 UPDATE できない (42501)', async () => {
    const before = await orgRow(orgA);
    for (const patch of [
      { subscription_status: TAMPERED_SUBSCRIPTION_STATUS },
      { subscription_expires_at: TAMPERED_EXPIRES_AT },
      { dissolved_at: new Date().toISOString() },
    ]) {
      const { error } = await asUser(admin.jwt).from('organizations').update(patch).eq('id', orgA).select('id');
      expectGuardRejected(error);
    }
    expect(await orgRow(orgA)).toEqual(before);
  });

  it('H-5: 一般メンバーと未認証は、RLS で行に届かない (0 行・変わらない)', async () => {
    const before = await orgRow(orgA);
    for (const db of [asUser(member.jwt), anon()]) {
      const { data, error } = await db
        .from('organizations')
        .update({ subscription_status: TAMPERED_SUBSCRIPTION_STATUS })
        .eq('id', orgA)
        .select('id');
      // 一般メンバーは organizations_update_admin の条件 (owner / admin) に当たらず、anon はポリシーの対象外 (TO authenticated)。
      // どちらも RLS で 0 行になり、エラーにはならない
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    expect(await orgRow(orgA)).toEqual(before);
  });

  it('H-6: 3 列を変えない UPDATE は今までどおり通る (組織名の変更・3 列に今と同じ値を書く UPDATE)', async () => {
    const before = await orgRow(orgA);
    const renamed = `${before.name} renamed`;
    const { data, error } = await asUser(owner.jwt)
      .from('organizations')
      .update({
        name: renamed,
        subscription_status: before.subscription_status,
        subscription_expires_at: before.subscription_expires_at,
        dissolved_at: before.dissolved_at,
      })
      .eq('id', orgA)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([{ id: orgA }]);
    expect(await orgRow(orgA)).toEqual({ ...before, name: renamed });
  });

  it('H-7: service_role は 3 列を書ける (運営が直す経路)', async () => {
    const before = await orgRow(orgA);
    const { error } = await srAdmin
      .from('organizations')
      .update({ subscription_status: TAMPERED_SUBSCRIPTION_STATUS, subscription_expires_at: OPERATOR_EXPIRES_AT })
      .eq('id', orgA);
    expect(error).toBeNull();
    const after = await orgRow(orgA);
    expect(after.subscription_status).toBe(TAMPERED_SUBSCRIPTION_STATUS);
    expect(instant(after.subscription_expires_at)).toBe(instant(OPERATOR_EXPIRES_AT));
    // 後のテストのために戻す
    const { error: restoreError } = await srAdmin
      .from('organizations')
      .update({ subscription_status: before.subscription_status, subscription_expires_at: before.subscription_expires_at })
      .eq('id', orgA);
    expect(restoreError).toBeNull();
  });

  it('H-8: オーナーの解散 (dissolve_org_by_owner。SECURITY DEFINER) は今までどおり status と dissolved_at を書ける', async () => {
    const dissolver = await createUser('dissolver');
    const orgD = await createOrg(dissolver, 'D');
    const { error } = await asUser(dissolver.jwt).rpc('dissolve_org_by_owner', { p_organization_id: orgD });
    expect(error).toBeNull();
    const row = await orgRow(orgD);
    expect(row.status).toBe('dissolved');
    expect(row.dissolved_at).not.toBeNull();
    expect(row.owner_id).toBeNull();
  }, SETUP_TIMEOUT_MS);
});

describe('#1917 anon / authenticated の TRUNCATE の権限', () => {
  it('T-1: public の全部の表・ビューで、anon にも authenticated にも TRUNCATE が無い', async () => {
    const rows = await pgQuery<{ relname: string; anon_truncate: boolean; auth_truncate: boolean }>(`
      SELECT c.relname,
             has_table_privilege('anon', c.oid, 'TRUNCATE') AS anon_truncate,
             has_table_privilege('authenticated', c.oid, 'TRUNCATE') AS auth_truncate
        FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relkind IN ${RELKINDS_SQL}
       ORDER BY c.relname`);
    // 見つけ方が空振りしていないこと (organizations は必ずある)
    expect(rows.map((r) => r.relname)).toContain('organizations');
    expect(rows.filter((r) => r.anon_truncate || r.auth_truncate).map((r) => r.relname)).toEqual([]);
  });

  it('T-2: TRUNCATE のほかの権限は変えていない (ベースラインの GRANT ALL の表は、SELECT・INSERT・UPDATE・DELETE が残る)', async () => {
    // REFERENCES と TRIGGER を持つ (= GRANT ALL の跡が残る) 表で、書き込み・読み取りの権限が残っていること
    const rows = await pgQuery<{ relname: string; role: string; s: boolean; i: boolean; u: boolean; d: boolean }>(`
      SELECT c.relname, r.role,
             has_table_privilege(r.role, c.oid, 'SELECT') AS s,
             has_table_privilege(r.role, c.oid, 'INSERT') AS i,
             has_table_privilege(r.role, c.oid, 'UPDATE') AS u,
             has_table_privilege(r.role, c.oid, 'DELETE') AS d
        FROM pg_class c
       CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relkind = 'r'
         AND c.relname IN ('organizations', 'user_profiles', 'meals')`);
    expect(rows.length).toBeGreaterThan(0);
    // 後の migration が意図して外した権限 (20261022190000 の検査の対象外)。キーは「表 / ロール」
    //   - organizations / anon の DELETE: 20261023100000_organizations_no_owner_direct_delete.sql (#1917 の続き) が外した
    const removedLater: Readonly<Record<string, { d?: false }>> = {
      'organizations / anon': { d: false },
    };
    for (const row of rows) {
      const key = `${row.relname} / ${row.role}`;
      expect({ ...row }, key).toMatchObject({ s: true, i: true, u: true, d: true, ...removedLater[key] });
    }
  });

  it('T-3: service_role の TRUNCATE は変えていない', async () => {
    const rows = await pgQuery<{ relname: string; sr_truncate: boolean }>(`
      SELECT c.relname, has_table_privilege('service_role', c.oid, 'TRUNCATE') AS sr_truncate
        FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('organizations', 'user_profiles', 'meals')`);
    expect(rows.map((r) => r.relname).sort()).toEqual(['meals', 'organizations', 'user_profiles']);
    expect(rows.every((r) => r.sr_truncate)).toBe(true);
  });

  it('T-4: postgres の表の既定の権限 (public・全スキーマ) に、anon / authenticated の TRUNCATE が無い。ほかの既定の権限は残る', async () => {
    const rows = await pgQuery<{ scope: string; grantee: string; privilege_type: string }>(`
      SELECT CASE WHEN d.defaclnamespace = 0 THEN '(all)' ELSE d.defaclnamespace::regnamespace::text END AS scope,
             a.grantee::regrole::text AS grantee,
             a.privilege_type
        FROM pg_default_acl d
       CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       WHERE d.defaclrole = 'postgres'::regrole
         AND d.defaclobjtype = 'r'
         AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
         AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)`);
    expect(rows.filter((r) => r.privilege_type === 'TRUNCATE')).toEqual([]);
    for (const grantee of ['anon', 'authenticated']) {
      const privileges = rows.filter((r) => r.scope === 'public' && r.grantee === grantee).map((r) => r.privilege_type);
      expect(privileges, grantee).toEqual(expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE', 'DELETE']));
    }
  });
});

describe('#1917 ガード関数とトリガーの属性', () => {
  it('G-1: guard_organizations_privileged は SECURITY INVOKER・search_path の指定なしのまま、organizations の BEFORE UPDATE のトリガーから呼ばれる', async () => {
    const fns = await pgQuery<{ prosecdef: boolean; proconfig: string[] | null }>(`
      SELECT p.prosecdef, p.proconfig
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'guard_organizations_privileged'`);
    expect(fns).toEqual([{ prosecdef: false, proconfig: null }]);
    const triggers = await pgQuery<{ tgname: string; enabled: string }>(`
      SELECT t.tgname, t.tgenabled::text AS enabled
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'public.organizations'::regclass AND p.proname = 'guard_organizations_privileged'`);
    expect(triggers).toEqual([{ tgname: 'trg_guard_organizations_privileged', enabled: 'O' }]);
  });
});
