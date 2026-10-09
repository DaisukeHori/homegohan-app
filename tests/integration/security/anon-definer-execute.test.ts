/**
 * #1103 (7) SECURITY DEFINER 関数に anon の EXECUTE が残っていないことの回帰テスト
 *
 * 背景: Supabase は public スキーマに関数を作ると、anon / authenticated / service_role へ EXECUTE を自動で付ける
 * (ALTER DEFAULT PRIVILEGES。本番も同じ)。PostgreSQL は PUBLIC (全員) にも EXECUTE を付ける。
 * そのため `REVOKE ... FROM PUBLIC` だけでは anon の権限は消えず、`REVOKE ... FROM anon, authenticated` だけでは
 * PUBLIC 経由の権限が残る。SECURITY DEFINER 関数は所有者 (postgres) の権限で動くので、anon が呼ぶ理由の無い関数に
 * anon の EXECUTE が付いたままだと、anon キー (公開鍵) だけで /rest/v1/rpc/<関数> から直接呼べてしまう。
 *
 * 修正前 (本番の 2026-10-07 スナップショット + その後の migration) は、anon が EXECUTE できる public の
 * SECURITY DEFINER 関数が 7 本あった。
 *   - get_invite_details / get_promotion_details : 未ログインの招待ページ・承認ページが呼ぶ (残す)
 *   - preview_family_invite / preview_org_invite  : 呼び出し元が無い (anon を外す)
 *   - can_view_user_meals / organizations_owner_id_unchanged : RLS ポリシーの中で呼ばれるだけ (anon を外す)。
 *       ポリシーが TO public のままだと anon の問い合わせが「0 行」ではなく 42501 で失敗するので、
 *       ポリシー (meals_select_owner_or_family / organizations_update_admin) を TO authenticated にする
 *   - cleanup_handson_tour_sandbox_rows : 夜間バッチ (pg_cron) 専用。PUBLIC に EXECUTE が付いていたため
 *       anon・ログインユーザーの誰でも呼べた (anon / authenticated への REVOKE が PUBLIC に効いていなかった)
 *
 * 期待する挙動 (20261008160000_revoke_anon_execute_on_definer_functions.sql の後):
 *   - A: anon が EXECUTE できる public の SECURITY DEFINER 関数は、このファイルの許可リストの 2 本だけ。
 *        新しい関数が既定の権限のまま作られると、このテストが落ちる。
 *        anon に適用されるポリシーは、anon が実行できない関数を呼ばない (呼ぶと 0 行ではなく 42501 になる)
 *   - B: 関数ごとの EXECUTE 権限 (anon / authenticated / service_role / PUBLIC) が決定表のとおり
 *   - C: PostgREST (/rest/v1/rpc) で、anon は外した関数を呼べない (42501、HTTP 401 / 403)。残した 2 本は未ログインで呼べる
 *   - D: ログインユーザーの経路は変わらない。家族のメンバーは共有された食事を読め、組織の admin は組織を更新できる。
 *        anon が meals / organizations を読み書きしても、エラーにならず 0 行のまま
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST / RPC を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/anon-definer-execute.test.ts
 *
 * 関数・ポリシーの権限の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で読み取りだけ行う。
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

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
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

/** ローカルスタックの postgres-meta で SQL を実行する (カタログの確認だけに使う。読み取り専用) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

// ================================================================
// 許可リスト
// ================================================================

/**
 * 未ログインの anon が EXECUTE してよい、public の SECURITY DEFINER 関数。キーは `名前(引数の型)`。
 *
 * ここに足すのは、未ログインの画面・API が実際にその関数を呼ぶときだけ。値に、呼び出し元を書く。
 * 呼び出し元が無い、またはログイン後にしか呼ばれないなら、足さずに migration で
 * `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated, service_role;` を入れ、必要な役割
 * (authenticated / service_role) へだけ明示的に GRANT する。
 * RLS ポリシーの中で呼ぶだけの関数も足さない (ポリシーを TO authenticated にして anon を外す。下の A2 を参照)。
 */
const ANON_EXECUTABLE_DEFINER_ALLOWLIST: Record<string, string> = {
  'get_invite_details(text)':
    '招待ページ /invite/[token] が、ログイン前に招待の中身 (組織名・メール・期限) を出すために呼ぶ (src/app/invite/[token]/page.tsx)',
  'get_promotion_details(text)':
    '参加リクエストの承認ページ /family/promotions/[token] が、ログイン前に内容を出すために呼ぶ (src/app/family/promotions/[token]/page.tsx)',
};

/** anon が EXECUTE できる public の SECURITY DEFINER 関数 (拡張機能が持つ関数は除く) */
async function anonExecutableDefinerFunctions() {
  return pgQuery<{ sig: string; public_exec: boolean }>(`
    SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
           EXISTS (
             SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           ) AS public_exec
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
    ORDER BY 1
  `);
}

describe('#1103 (7) A: anon が EXECUTE できる SECURITY DEFINER 関数は許可リストの 2 本だけ', () => {
  it('A1: 許可リストに無い SECURITY DEFINER 関数が、anon に EXECUTE を許していない', async () => {
    const rows = await anonExecutableDefinerFunctions();
    const allowed = new Set(Object.keys(ANON_EXECUTABLE_DEFINER_ALLOWLIST));
    const unexpected = rows
      .filter((r) => !allowed.has(r.sig))
      .map((r) => `${r.sig}${r.public_exec ? ' (PUBLIC に EXECUTE が付いている)' : ''}`);
    expect(
      unexpected,
      [
        '許可リストに無い SECURITY DEFINER 関数を、未ログインの anon が /rest/v1/rpc から直接呼べる。',
        'Supabase は関数の作成時に anon / authenticated / service_role へ EXECUTE を自動で付け、PostgreSQL は PUBLIC にも付ける。',
        'その関数を作る migration に、引数の型まで書いた完全形で次を足す (既に本番に入っている関数なら、新しい migration で)。',
        '  REVOKE ALL ON FUNCTION public.<関数>(<型>) FROM PUBLIC, anon, authenticated, service_role;',
        '  GRANT EXECUTE ON FUNCTION public.<関数>(<型>) TO <必要な役割だけ>;',
        '未ログインの画面が呼ぶ関数なら、呼び出し元を添えて、このファイルの許可リストに足す。',
      ].join('\n'),
    ).toEqual([]);
  });

  it('A1b: 許可リストの 2 本は、いまも anon が呼べる (外すと未ログインの招待ページ・承認ページが動かなくなる)', async () => {
    const rows = await anonExecutableDefinerFunctions();
    const actual = rows.map((r) => r.sig);
    const missing = Object.keys(ANON_EXECUTABLE_DEFINER_ALLOWLIST).filter((sig) => !actual.includes(sig));
    expect(
      missing,
      '許可リストの関数が、存在しない・SECURITY DEFINER でない・anon が EXECUTE できない。意図して外したなら許可リストからも消す。',
    ).toEqual([]);
  });

  it('A2: anon に適用されるポリシー (TO public / anon) は、anon が実行できない関数を呼んでいない', async () => {
    // 呼ぶと、anon の問い合わせが「0 行」ではなく `42501 permission denied for function ...` で失敗する
    // (関数の EXECUTE 権限は、式が評価される前の実行開始時に確認される)。
    // その場合は関数に anon の EXECUTE を戻すのではなく、ポリシーを TO authenticated にする
    // (anon は auth.uid() が NULL で、元から 0 行)。
    const rows = await pgQuery<{ tbl: string; policy: string; roles: string; fn: string }>(`
      SELECT cn.nspname || '.' || c.relname AS tbl,
             pol.polname AS policy,
             CASE WHEN 0::oid = ANY (pol.polroles) THEN 'PUBLIC' ELSE 'anon' END AS roles,
             regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS fn
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace cn ON cn.oid = c.relnamespace
      JOIN pg_depend d
        ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid AND d.refclassid = 'pg_proc'::regclass
      JOIN pg_proc p ON p.oid = d.refobjid
      WHERE (0::oid = ANY (pol.polroles) OR 'anon'::regrole::oid = ANY (pol.polroles))
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      ORDER BY 1, 2, 3
    `);
    expect(rows.map((r) => `${r.tbl} ${r.policy} (TO ${r.roles}) -> ${r.fn}`)).toEqual([]);
  });
});

// ================================================================
// B: 関数ごとの EXECUTE 権限 (決定表)
// ================================================================

interface AclRow {
  sig: string;
  secdef: boolean;
  anon_exec: boolean;
  auth_exec: boolean;
  sr_exec: boolean;
  public_exec: boolean;
}

/**
 * 決定表。anon / authenticated / service_role / PUBLIC の EXECUTE がどうなっているべきか。
 * authenticated・service_role は「この修正では変えない」ものを書いている
 * (変えたのは cleanup_handson_tour_sandbox_rows の PUBLIC 経由の authenticated だけ)。
 */
const EXPECTED_ACL: Array<{
  sig: string;
  anon: boolean;
  authenticated: boolean;
  /** undefined は確認しない (本番の現状は service_role に付いていない関数。この修正では触らない) */
  serviceRole?: boolean;
  why: string;
}> = [
  {
    sig: 'get_invite_details(text)',
    anon: true,
    authenticated: true,
    serviceRole: true,
    why: '未ログインの招待ページが呼ぶ (残す)',
  },
  {
    sig: 'get_promotion_details(text)',
    anon: true,
    authenticated: true,
    why: '未ログインの参加リクエスト承認ページが呼ぶ (残す)',
  },
  {
    sig: 'preview_family_invite(text)',
    anon: false,
    authenticated: true,
    serviceRole: true,
    why: '呼び出し元が無い。anon だけ外す (get_invite_details が同じ内容を返す)',
  },
  {
    sig: 'preview_org_invite(text)',
    anon: false,
    authenticated: true,
    serviceRole: true,
    why: '呼び出し元が無い。anon だけ外す (get_invite_details が同じ内容を返す)',
  },
  {
    sig: 'can_view_user_meals(uuid)',
    anon: false,
    authenticated: true,
    serviceRole: true,
    why: 'meals の SELECT ポリシーの中で呼ぶだけ。ポリシーを TO authenticated にして anon を外す',
  },
  {
    sig: 'organizations_owner_id_unchanged(uuid,uuid)',
    anon: false,
    authenticated: true,
    serviceRole: true,
    why: 'organizations の UPDATE ポリシーの中で呼ぶだけ。ポリシーを TO authenticated にして anon を外す',
  },
  {
    sig: 'cleanup_handson_tour_sandbox_rows()',
    anon: false,
    authenticated: false,
    serviceRole: true,
    why: '夜間バッチ (pg_cron、所有者 postgres) と service_role 専用。PUBLIC の EXECUTE も外す',
  },
];

describe('#1103 (7) B: 関数ごとの EXECUTE 権限 (決定表)', () => {
  let acl: AclRow[] = [];

  beforeAll(async () => {
    const names = [...new Set(EXPECTED_ACL.map((e) => e.sig.split('(')[0]))];
    acl = await pgQuery<AclRow>(`
      SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
             p.prosecdef AS secdef,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
             EXISTS (
               SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (${names.map((n) => `'${n}'`).join(', ')})
      ORDER BY 1
    `);
  });

  for (const expected of EXPECTED_ACL) {
    it(`B: ${expected.sig} — ${expected.why}`, () => {
      const row = acl.find((r) => r.sig === expected.sig);
      expect(row, `${expected.sig} が見つからない`).toBeDefined();
      expect(row!.secdef).toBe(true);
      expect(row!.public_exec, 'PUBLIC (全員) に EXECUTE が付いていない').toBe(false);
      expect(row!.anon_exec, 'anon').toBe(expected.anon);
      expect(row!.auth_exec, 'authenticated').toBe(expected.authenticated);
      if (expected.serviceRole !== undefined) expect(row!.sr_exec, 'service_role').toBe(expected.serviceRole);
    });
  }

  it('B2: cleanup_handson_tour_sandbox_rows は所有者 postgres のまま、所有者の EXECUTE を外していない (pg_cron が動く)', async () => {
    const rows = await pgQuery<{ sig: string; owner: string; owner_exec: boolean }>(`
      SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
             pg_get_userbyid(p.proowner) AS owner,
             has_function_privilege(p.proowner, p.oid, 'EXECUTE') AS owner_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'cleanup_handson_tour_sandbox_rows'
    `);
    expect(rows).toEqual([{ sig: 'cleanup_handson_tour_sandbox_rows()', owner: 'postgres', owner_exec: true }]);
  });
});

// ================================================================
// C / D: PostgREST を通した挙動
// ================================================================

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-anon-definer-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `anon-definer-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** 所属を service_role で設定する (特権列は本人の JWT では変更できない) */
async function setOrgMembership(userId: string, orgId: string, orgRole: 'owner' | 'admin' | 'member'): Promise<void> {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgRole, is_active_in_org: true })
    .eq('id', userId);
  if (error) throw new Error(`org membership: ${error.message}`);
}

let famRep: TestUser;
let famAdult: TestUser;
let outsider: TestUser;
let orgOwner: TestUser;
let orgAdmin: TestUser;
let orgMember: TestUser;
let familyId = '';
let repMemberId = '';
let repMealId = '';
let orgId = '';
const ORG_NAME = `#1103 anon-definer org ${TS}`;
const orgInviteToken = `anon-definer-org-${randomBytes(16).toString('hex')}`;
const familyInviteToken = `anon-definer-family-${randomBytes(16).toString('hex')}`;

async function createFixture(): Promise<void> {
  [famRep, famAdult, outsider, orgOwner, orgAdmin, orgMember] = await Promise.all([
    createUser('fam-rep'),
    createUser('fam-adult'),
    createUser('outsider'),
    createUser('org-owner'),
    createUser('org-admin'),
    createUser('org-member'),
  ]);

  // 家族: 代表者 + 大人 (どちらも active で、食事を共有する)。招待の流れは別のテストが確かめるので、service_role で直接入れる
  const { data: family, error: familyError } = await srAdmin
    .from('family_groups')
    .insert({ name: `#1103 anon-definer family ${TS}`, representative_id: famRep.id })
    .select('id')
    .single();
  if (familyError || !family) throw new Error(`family_groups: ${familyError?.message}`);
  familyId = family.id as string;
  const { data: members, error: memberError } = await srAdmin
    .from('family_members')
    .insert([
      { family_id: familyId, user_id: famRep.id, role: 'representative', status: 'active', share_meals: true },
      { family_id: familyId, user_id: famAdult.id, role: 'adult', status: 'active', share_meals: true },
    ])
    .select('id, user_id');
  if (memberError || !members) throw new Error(`family_members: ${memberError?.message}`);
  repMemberId = members.find((m) => m.user_id === famRep.id)!.id as string;

  // 代表者の食事 1 件
  const { data: meal, error: mealError } = await srAdmin
    .from('meals')
    .insert({ user_id: famRep.id, eaten_at: new Date().toISOString(), meal_type: 'breakfast' })
    .select('id')
    .single();
  if (mealError || !meal) throw new Error(`meals: ${mealError?.message}`);
  repMealId = meal.id as string;

  // 組織: owner / admin / 一般メンバー
  const { data: org, error: orgError } = await srAdmin
    .from('organizations')
    .insert({ name: ORG_NAME, owner_id: orgOwner.id })
    .select('id')
    .single();
  if (orgError || !org) throw new Error(`organizations: ${orgError?.message}`);
  orgId = org.id as string;
  await setOrgMembership(orgOwner.id, orgId, 'owner');
  await setOrgMembership(orgAdmin.id, orgId, 'admin');
  await setOrgMembership(orgMember.id, orgId, 'member');

  // 未ログインの招待ページ用の、有効な招待 (組織・家族)
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const { error: orgInviteError } = await srAdmin.from('organization_invites').insert({
    organization_id: orgId,
    email: `sec-anon-definer-org-invitee-${TS}@homegohan.test`,
    token: orgInviteToken,
    expires_at: expiresAt,
    invited_by: orgOwner.id,
  });
  if (orgInviteError) throw new Error(`organization_invites: ${orgInviteError.message}`);
  const { error: familyInviteError } = await srAdmin.from('family_invites').insert({
    family_id: familyId,
    email: `sec-anon-definer-family-invitee-${TS}@homegohan.test`,
    token: familyInviteToken,
    expires_at: expiresAt,
    invited_by: famRep.id,
  });
  if (familyInviteError) throw new Error(`family_invites: ${familyInviteError.message}`);
}

async function cleanupFixture(): Promise<void> {
  if (createdUserIds.length > 0) await srAdmin.from('meals').delete().in('user_id', createdUserIds);
  if (orgId) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', orgId);
    await srAdmin.from('organization_invites').delete().eq('organization_id', orgId);
  }
  if (familyId) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', familyId);
    // family_members / family_invites は CASCADE。family_groups.representative_id は ON DELETE RESTRICT なので家族を先に消す
    await srAdmin.from('family_groups').delete().eq('id', familyId);
  }
  if (createdUserIds.length > 0) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .in('id', createdUserIds);
  }
  if (orgId) await srAdmin.from('organizations').delete().eq('id', orgId);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  }
}

/** anon が外された関数。PostgREST の引数名は関数の引数名と同じ */
const REVOKED_FOR_ANON: Array<{ name: string; args?: Record<string, unknown> }> = [
  { name: 'preview_family_invite', args: { p_token: 'x'.repeat(64) } },
  { name: 'preview_org_invite', args: { p_token: 'x'.repeat(64) } },
  { name: 'can_view_user_meals', args: { p_target_user_id: ZERO_UUID } },
  { name: 'organizations_owner_id_unchanged', args: { p_org_id: ZERO_UUID, p_new_owner_id: ZERO_UUID } },
  { name: 'cleanup_handson_tour_sandbox_rows' },
];

const LONG = 120_000;

describe('#1103 (7) C / D: PostgREST を通した挙動', () => {
  beforeAll(createFixture, LONG);
  afterAll(cleanupFixture, LONG);

  // ----------------------------------------------------------------
  // C: RPC (/rest/v1/rpc) の実行可否
  // ----------------------------------------------------------------

  for (const fn of REVOKED_FOR_ANON) {
    it(`C1: anon は ${fn.name} を呼べない (42501、HTTP 401 / 403)`, async () => {
      const { data, error, status } = await anon().rpc(fn.name, fn.args);
      expect(error?.code, `${fn.name}: ${error?.message}`).toBe('42501');
      expect([401, 403]).toContain(status);
      expect(data).toBeNull();
    });
  }

  it('C2: cleanup_handson_tour_sandbox_rows は、ログインユーザーも呼べない (修正前は PUBLIC 経由で誰でも呼べた)', async () => {
    const { data, error, status } = await asUser(outsider.jwt).rpc('cleanup_handson_tour_sandbox_rows');
    expect(error?.code, error?.message).toBe('42501');
    expect(status).toBe(403);
    expect(data).toBeNull();
  });

  it('C3: ログインユーザーと service_role は、anon を外した preview_org_invite / preview_family_invite を従来どおり呼べる', async () => {
    for (const who of [
      { label: 'authenticated', api: asUser(outsider.jwt) },
      { label: 'service_role', api: srAdmin },
    ]) {
      const org = await who.api.rpc('preview_org_invite', { p_token: orgInviteToken });
      expect(org.error, `${who.label}: preview_org_invite`).toBeNull();
      expect(org.data).toHaveLength(1);
      expect(org.data[0]).toMatchObject({ organization_name: ORG_NAME });

      const family = await who.api.rpc('preview_family_invite', { p_token: familyInviteToken });
      expect(family.error, `${who.label}: preview_family_invite`).toBeNull();
      expect(family.data).toHaveLength(1);
    }
  });

  it('C4: anon は get_invite_details で、未ログインのまま招待の中身 (組織・家族) を引ける', async () => {
    const org = await anon().rpc('get_invite_details', { p_token: orgInviteToken });
    expect(org.error).toBeNull();
    expect(org.data).toMatchObject({ scope: 'organization', scope_name: ORG_NAME, status: 'pending' });

    const family = await anon().rpc('get_invite_details', { p_token: familyInviteToken });
    expect(family.error).toBeNull();
    expect(family.data).toMatchObject({ scope: 'family', status: 'pending' });

    const missing = await anon().rpc('get_invite_details', { p_token: randomBytes(32).toString('hex') });
    expect(missing.error).toBeNull();
    expect(missing.data).toBeNull();
  });

  it('C5: anon は get_promotion_details を呼べる (トークンが無ければ NULL。中身が返る経路は family-child-promotion-consent.test.ts)', async () => {
    const { data, error } = await anon().rpc('get_promotion_details', { p_token: randomBytes(32).toString('hex') });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  // ----------------------------------------------------------------
  // D: RLS の中の関数呼び出し (ログインユーザーの経路は変わらない。anon はエラーにならず 0 行のまま)
  // ----------------------------------------------------------------

  it('D1: 家族の active メンバーは、食事を共有している相手の meals を読める。家族の外の人は読めない。共有を切ると読めなくなる', async () => {
    // can_view_user_meals が meals の SELECT ポリシーの中で、authenticated の権限で呼ばれる
    const own = await asUser(famRep.jwt).from('meals').select('id').eq('user_id', famRep.id);
    expect(own.error).toBeNull();
    expect(own.data).toHaveLength(1);

    const shared = await asUser(famAdult.jwt).from('meals').select('id').eq('user_id', famRep.id);
    expect(shared.error).toBeNull();
    expect(shared.data).toHaveLength(1);

    const outsiderRead = await asUser(outsider.jwt).from('meals').select('id').eq('user_id', famRep.id);
    expect(outsiderRead.error).toBeNull();
    expect(outsiderRead.data).toEqual([]);

    // 代表者が食事の共有を切る (service_role。本人以外の共有設定は JWT では変えられない)
    const { error: unshareError } = await srAdmin.from('family_members').update({ share_meals: false }).eq('id', repMemberId);
    expect(unshareError).toBeNull();
    try {
      const unshared = await asUser(famAdult.jwt).from('meals').select('id').eq('user_id', famRep.id);
      expect(unshared.error).toBeNull();
      expect(unshared.data).toEqual([]);
      // 本人は共有を切っても自分の食事を読める
      const ownAfter = await asUser(famRep.jwt).from('meals').select('id').eq('user_id', famRep.id);
      expect(ownAfter.error).toBeNull();
      expect(ownAfter.data).toHaveLength(1);
    } finally {
      const { error: reshareError } = await srAdmin.from('family_members').update({ share_meals: true }).eq('id', repMemberId);
      expect(reshareError).toBeNull();
    }
  });

  it('D2: ログインユーザーは自分の食事を書き込み、そのまま読み返せる (INSERT ... RETURNING も SELECT ポリシーを通る)', async () => {
    const inserted = await asUser(famAdult.jwt)
      .from('meals')
      .insert({ user_id: famAdult.id, eaten_at: new Date().toISOString(), meal_type: 'lunch' })
      .select('id, user_id');
    expect(inserted.error).toBeNull();
    expect(inserted.data).toEqual([{ id: expect.any(String), user_id: famAdult.id }]);
  });

  it('D3: 組織の admin は自組織を更新できる。一般メンバーは更新できない。owner_id は誰も (admin でも) 書き換えられない', async () => {
    // organizations_owner_id_unchanged が organizations の UPDATE ポリシー (WITH CHECK) の中で、authenticated の権限で呼ばれる
    const renamed = `${ORG_NAME} (renamed)`;
    const ok = await asUser(orgAdmin.jwt).from('organizations').update({ name: renamed }).eq('id', orgId).select('id, name');
    expect(ok.error).toBeNull();
    expect(ok.data).toEqual([{ id: orgId, name: renamed }]);

    const memberTry = await asUser(orgMember.jwt)
      .from('organizations')
      .update({ name: 'member should not rename' })
      .eq('id', orgId)
      .select('id');
    expect(memberTry.error).toBeNull();
    expect(memberTry.data).toEqual([]);

    const ownerSwap = await asUser(orgAdmin.jwt)
      .from('organizations')
      .update({ owner_id: orgAdmin.id })
      .eq('id', orgId)
      .select('id');
    expect(ownerSwap.error).not.toBeNull();

    const { data: after, error: afterError } = await srAdmin
      .from('organizations')
      .select('name, owner_id')
      .eq('id', orgId)
      .single();
    expect(afterError).toBeNull();
    expect(after).toEqual({ name: renamed, owner_id: orgOwner.id });
  });

  it('D4: anon が meals・organizations (と meals を参照するポリシーを持つ表) を読み書きしても、エラーにならず 0 行', async () => {
    // ポリシーが TO public のまま関数の anon EXECUTE だけ外すと、ここが 0 行ではなく 42501 になる
    const meals = await anon().from('meals').select('id').eq('user_id', famRep.id);
    expect(meals.error).toBeNull();
    expect(meals.data).toEqual([]);

    const estimates = await anon().from('meal_nutrition_estimates').select('id').limit(1);
    expect(estimates.error).toBeNull();
    expect(estimates.data).toEqual([]);

    const feedbacks = await anon().from('meal_ai_feedbacks').select('id').limit(1);
    expect(feedbacks.error).toBeNull();
    expect(feedbacks.data).toEqual([]);

    const mealUpdate = await anon().from('meals').update({ meal_type: 'dinner' }).eq('id', repMealId).select('id');
    expect(mealUpdate.error).toBeNull();
    expect(mealUpdate.data).toEqual([]);

    const mealDelete = await anon().from('meals').delete().eq('id', repMealId).select('id');
    expect(mealDelete.error).toBeNull();
    expect(mealDelete.data).toEqual([]);

    const orgUpdate = await anon().from('organizations').update({ name: 'anon should not rename' }).eq('id', orgId).select('id');
    expect(orgUpdate.error).toBeNull();
    expect(orgUpdate.data).toEqual([]);

    // どれも 0 行のままで、実際に何も書き換わっていない
    const { data: meal } = await srAdmin.from('meals').select('meal_type').eq('id', repMealId).single();
    expect(meal?.meal_type).toBe('breakfast');
    const { data: org } = await srAdmin.from('organizations').select('name').eq('id', orgId).single();
    expect(org?.name).not.toBe('anon should not rename');
  });

  // #1101 (20261008200500) が meals_select_owner_or_family の式に「隠した行は本人だけ」の条件を足した。
  // 対象ロール (authenticated) と can_view_user_meals の判定はそのまま残っているので、ここでは呼び出しが残っていることを確かめる
  it('D5: meals_select_owner_or_family と organizations_update_admin は authenticated 限定。can_view_user_meals / organizations_owner_id_unchanged の判定が残っている', async () => {
    const rows = await pgQuery<{
      tablename: string;
      policyname: string;
      cmd: string;
      roles: string;
      qual: string | null;
      with_check: string | null;
    }>(`
      SELECT tablename, policyname, cmd, array_to_string(roles, ',') AS roles, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname IN ('meals_select_owner_or_family', 'organizations_update_admin')
      ORDER BY tablename
    `);
    expect(rows.map((r) => `${r.tablename}.${r.policyname}:${r.cmd}:${r.roles}`)).toEqual([
      'meals.meals_select_owner_or_family:SELECT:authenticated',
      'organizations.organizations_update_admin:UPDATE:authenticated',
    ]);
    expect(rows[0].qual).toContain('can_view_user_meals(user_id)');
    expect(rows[1].with_check).toContain('organizations_owner_id_unchanged(id, owner_id)');
  });
});
