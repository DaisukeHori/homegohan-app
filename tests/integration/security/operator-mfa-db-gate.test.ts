/**
 * #1707 運営ロールの MFA 段 E: DB を本人の JWT で直接呼ぶ経路の判定 (docs/design/cross/12-operator-mfa.md §11.4・§20.1・§21.8・付録 A)
 *
 * 段 E の migration (supabase/migrations/<番号>_operator_mfa_db_gate.sql) の後、PostgREST / RPC を本人の JWT で直接呼んでも、
 * TOTP を登録済みの必須ロール (super_admin / admin / finance / org_industrial_doctor) の運営は、aal2 のセッションでなければ
 * 運営の枝のポリシーと運営の関数 7 本を使えない。本人の行の枝・公開の枝・未登録の運営・必須ロールでない運営は今までどおり。
 *
 *   DB-1 (⑪) 運営ロールの条件を持つ public のポリシーは、どれも operator_mfa_satisfied() を呼び、TO public / anon でない
 *   DB-2 (⑫) 運営ロールを確かめる SECURITY DEFINER の関数は、除外を除いてどれも operator_mfa_satisfied() を呼ぶ
 *   DB-3      operator_mfa_satisfied() の EXECUTE は authenticated と service_role だけ
 *   DB-4〜11  登録済み / 未登録の運営・support・anon の aal1 / aal2 の token で、関数・ポリシーの実際の結果 (S-24・S-29・S-30・S-31)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST / RPC を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/operator-mfa-db-gate.test.ts
 * 利用者は service_role で作り、使い捨ての anon client でサインインする (anon-definer-execute.test.ts の createUser と同じ作り)。
 * TOTP の登録と aal2 への昇格は tests/integration/helpers/mfa.ts の promoteToAal2 (段 B の道具)。aal1 の token は、登録の後に
 * もう一度 signInWithPassword して得る (verify は同じ利用者の他のセッションを終えるので、昇格の前のセッションは使わない)。
 * カタログの確認は postgres-meta (/pg/query、service_role キー) の読み取りだけ。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { promoteToAal2 } from '../helpers/mfa';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { grantFamilyPlan } from '../helpers/family-plan';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

/** 準備と後片付けの時間の上限 (利用者 7 人の作成・TOTP の昇格 2 人・家族の作成) */
const SETUP_TIMEOUT_MS = 180_000;
/** DB の判定で止まったときの例外の message (§11.4 の 7 本の関数) */
const OPERATOR_MFA_REQUIRED = 'OPERATOR_MFA_REQUIRED';
/**
 * 判定を通った後の list_orgs_with_inactive_owner が、返す行があると必ず出す既存の失敗 (段 E と無関係・判定より後の RETURN QUERY で起きる):
 * 戻り値の列 owner_email は text だが、本体が auth.users.email (varchar(255)) をそのまま返すので
 * `structure of query does not match function result type` (42804) になる。結合のスイートの共有の DB には、他のテストが作った
 * 「オーナーが 30 日ログインしていない組織」が残るので、行の有無はこのテストで決められない。判定を通ったことは
 * 「OPERATOR_MFA_REQUIRED でない」ことで見て、関数の本文の既存の失敗はこの値だけを許す (本文は §11.4 のとおり 1 文字も変えない)
 */
const PRE_EXISTING_RESULT_TYPE_MISMATCH = '42804';
/** 判定を通った後に、行を変えずに止まる関数の例外 (operator_force_owner_transfer の対象の確認。存在しない組織) */
const TARGET_NOT_IN_ORG = 'TARGET_NOT_IN_ORG';

/** 権限の不足 (RLS の WITH CHECK に反する INSERT) */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 公開の枝が読むプランの状態 (subscription_plans_select_public の USING) */
const PUBLIC_PLAN_STATUSES = ['public', 'private'] as const;

/** 運営ロールの条件を持つポリシーの見つけ方 (付録 A.3 と同じ)。qual / with_check をつないだ文字列に両方が当たるもの */
const POLICY_ROLES_COLUMN_PATTERN = /\broles\b/;
const POLICY_OPERATOR_ROLE_LITERAL_PATTERN = /'(super_admin|admin|finance|org_industrial_doctor)'::text/;
/**
 * 番兵: 見つけ方が空振りしていないこと。2026-10-16 の本番の母集合の数 (付録 A。58 から 56 に動いた) から、
 * 20261024140000_announcements_moderation_flags_select_only.sql (#1917 の続き) が recipe_flags の "Admins can update recipe flags" と
 * personal_subscriptions の personal_subscriptions_insert_admin / personal_subscriptions_update_admin を消して 53 にした
 * (announcements と moderation_flags は FOR ALL を消して SELECT を作り直したので数は変わらない)。
 * 20261025100000_operator_session_writes_select_only.sql (#1917 の続き) が運営の書き込みのポリシー 7 本を消し、4 本から運営の枝を外して
 * 42 にした (FOR ALL を消して SELECT を作り直した 6 表は数が変わらない)
 */
const DB_GATED_POLICY_MIN_COUNT = 42;
/** 運営ロールを確かめる関数の見つけ方: public の SECURITY DEFINER で authenticated か anon が EXECUTE でき、本体 (prosrc) に両方が当たるもの */
const FUNCTION_ROLES_PATTERN = /\broles\b/;
const FUNCTION_OPERATOR_ROLE_LITERAL_PATTERN = /'(super_admin|admin|finance|org_industrial_doctor)'/;
/** 番兵: §11.4 の表の 7 本 */
const DB_GATED_FUNCTION_MIN_COUNT = 7;
/** 除外の理由の最小の文字数 (理由の無い除外を作らない。⑧ と同じ考え方) */
const EXCLUSION_REASON_MIN_LENGTH = 10;
/** 見つけ方に当たるが、運営ロールの判定ではない関数。キーは `名前(引数の型)` (regprocedure から public. を外した形)。理由を書く */
const DB_FUNCTION_SCAN_EXCLUSIONS: Readonly<Record<string, string>> = {
  'operator_mfa_satisfied()': '判定の関数そのもの (必須ロールの配列を持つ)',
  'remove_org_member(uuid,uuid)':
    "'admin' は組織の中の役割 (user_profiles.org_role) の値。roles は 'org_admin' を外す更新 (array_remove) に出るだけで、運営ロールの判定ではない",
};
/** 判定の呼び出し (ポリシーの式・関数の本体) */
const GATE_CALL_PATTERN = /\boperator_mfa_satisfied\(\)/;

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
// DB-1〜DB-3: カタログ (§20.1)
// ================================================================

describe('#1707 段 E: カタログの機械検査 (§20.1)', () => {
  it('DB-1 (⑪): 運営ロールの条件を持つ public のポリシーは、どれも operator_mfa_satisfied() を呼び、TO public / anon でない。数は DB_GATED_POLICY_MIN_COUNT 以上 (§20.1)', async () => {
    const rows = await pgQuery<{ tablename: string; policyname: string; roles: string; qual: string | null; with_check: string | null }>(`
      SELECT tablename, policyname, roles::text AS roles, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename COLLATE "C", policyname COLLATE "C"
    `);
    const gated = rows.filter((r) => {
      const expr = `${r.qual ?? ''} ${r.with_check ?? ''}`;
      return POLICY_ROLES_COLUMN_PATTERN.test(expr) && POLICY_OPERATOR_ROLE_LITERAL_PATTERN.test(expr);
    });
    expect(gated.length).toBeGreaterThanOrEqual(DB_GATED_POLICY_MIN_COUNT);
    const offenders = gated
      .filter((r) => {
        const expr = `${r.qual ?? ''} ${r.with_check ?? ''}`;
        return !GATE_CALL_PATTERN.test(expr) || r.roles !== '{authenticated}';
      })
      .map((r) => `${r.tablename} ${r.policyname} (TO ${r.roles})`);
    expect(
      offenders,
      [
        '運営ロールの条件を持つポリシーに、判定の関数が無い / TO authenticated でない。',
        '運営ロールの条件の項を (<条件> AND (SELECT public.operator_mfa_satisfied())) にし、ポリシーを TO authenticated にする',
        '(docs/design/cross/12-operator-mfa.md §11.4・付録 A)。',
      ].join('\n'),
    ).toEqual([]);
    // 判定の項は運営の条件の数だけある (USING と WITH CHECK を両方持つポリシーは、それぞれに 1 つ)
    for (const r of gated) {
      for (const expr of [r.qual, r.with_check]) {
        if (expr && POLICY_OPERATOR_ROLE_LITERAL_PATTERN.test(expr)) {
          expect(GATE_CALL_PATTERN.test(expr), `${r.tablename} ${r.policyname}: ${expr}`).toBe(true);
        }
      }
    }
  });

  it('DB-2 (⑫): 運営ロールを確かめる SECURITY DEFINER の関数は、除外を除いてどれも operator_mfa_satisfied() を呼ぶ。数は DB_GATED_FUNCTION_MIN_COUNT 以上。除外の各行は今も当たり、理由が 10 文字以上 (§20.1)', async () => {
    const rows = await pgQuery<{ sig: string; src: string }>(`
      SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig, p.prosrc AS src
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef
        AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
        )
      ORDER BY 1
    `);
    const matched = rows.filter((r) => FUNCTION_ROLES_PATTERN.test(r.src) && FUNCTION_OPERATOR_ROLE_LITERAL_PATTERN.test(r.src));
    const matchedSigs = new Set(matched.map((r) => r.sig));
    const gated = matched.filter((r) => !(r.sig in DB_FUNCTION_SCAN_EXCLUSIONS));
    expect(gated.length).toBeGreaterThanOrEqual(DB_GATED_FUNCTION_MIN_COUNT);
    const offenders = gated.filter((r) => !GATE_CALL_PATTERN.test(r.src)).map((r) => r.sig);
    expect(
      offenders,
      [
        '運営ロールを確かめる SECURITY DEFINER の関数が、判定の関数を呼んでいない。',
        '役割の判定の END IF; の直後に IF NOT public.operator_mfa_satisfied() THEN RAISE EXCEPTION \'OPERATOR_MFA_REQUIRED\' ... を足す',
        '(docs/design/cross/12-operator-mfa.md §11.4)。運営ロールの判定でないなら、理由を添えて DB_FUNCTION_SCAN_EXCLUSIONS に足す。',
      ].join('\n'),
    ).toEqual([]);
    for (const [sig, reason] of Object.entries(DB_FUNCTION_SCAN_EXCLUSIONS)) {
      expect(matchedSigs.has(sig), `除外 ${sig} が、存在しない / 見つけ方に当たらない (一覧が古い)`).toBe(true);
      expect(reason.length, `除外 ${sig} の理由`).toBeGreaterThanOrEqual(EXCLUSION_REASON_MIN_LENGTH);
    }
  });

  it('DB-3: operator_mfa_satisfied() の EXECUTE は authenticated と service_role だけ (anon・PUBLIC に無い)', async () => {
    const rows = await pgQuery<{ anon_exec: boolean; auth_exec: boolean; sr_exec: boolean; public_exec: boolean; secdef: boolean }>(`
      SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
             EXISTS (
               SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_exec,
             p.prosecdef AS secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'operator_mfa_satisfied'
    `);
    expect(rows).toEqual([{ anon_exec: false, auth_exec: true, sr_exec: true, public_exec: false, secdef: true }]);
  });
});

// ================================================================
// DB-4〜DB-11: PostgREST / RPC を本人の JWT で直接呼ぶ
// ================================================================

const TS = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const PASSWORD = `Mfa-DbGate-${randomBytes(12).toString('hex')}`;

interface TestUser {
  readonly id: string;
  readonly email: string;
  /** 作った直後 (TOTP の登録より前) の aal1 の token。登録した利用者には使わない */
  readonly jwt: string;
}

interface EnrolledOperator {
  readonly id: string;
  /** promoteToAal2 の戻り (aal2) */
  readonly aal2: string;
  /** 登録の後にもう一度サインインした aal1 */
  readonly aal1: string;
}

/** 存在しない組織・利用者の id (operator_force_owner_transfer が判定の後の対象の確認で止まる) */
const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';

/**
 * list_orgs_with_inactive_owner が判定を通ったこと: error が null か、判定より後の既存の失敗 (PRE_EXISTING_RESULT_TYPE_MISMATCH) だけ。
 * OPERATOR_MFA_REQUIRED (判定で止まった) やほかのエラーは赤
 */
function expectPassedGate(error: { code?: string; message?: string } | null): void {
  if (error === null) return;
  expect(error.message).not.toBe(OPERATOR_MFA_REQUIRED);
  expect(error.code, error.message).toBe(PRE_EXISTING_RESULT_TYPE_MISMATCH);
}

const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
const createdNoteIds: string[] = [];
const createdInquiryIds: string[] = [];
const createdTicketIds: string[] = [];
const FEATURE_FLAG_KEY = `operator-mfa-db-gate-${TS}`;

async function signIn(email: string): Promise<{ client: SupabaseClient; jwt: string }> {
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signInClient = anon();
  const { data, error } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: signInClient, jwt: data.session.access_token };
}

async function createUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `sec-mfa-db-gate-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db
      .from('user_profiles')
      .upsert({ id: data.user.id, nickname: `mfa-db-gate-${label}`, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const { jwt } = await signIn(email);
  return { id: data.user.id, email, jwt };
}

/** TOTP を登録して aal2 の token を得たうえで、もう一度サインインして aal1 の token も得る */
async function createEnrolledOperator(label: string, roles: string[]): Promise<EnrolledOperator> {
  const user = await createUser(label, roles);
  const { client: sessionClient } = await signIn(user.email);
  const aal2 = await promoteToAal2(sessionClient);
  const { jwt: aal1 } = await signIn(user.email);
  return { id: user.id, aal2, aal1 };
}

let superEnrolled: EnrolledOperator;
let adminEnrolled: EnrolledOperator;
let superUnenrolled: TestUser;
let adminUnenrolled: TestUser;
let supportOnly: TestUser;
let ordinary: TestUser;
let familyRep: TestUser;
let familyId = '';
let ownInquiryId = '';
let otherInquiryId = '';
let otherTicketId = '';

async function createFixture(): Promise<void> {
  [superEnrolled, adminEnrolled] = await Promise.all([
    createEnrolledOperator('super-enrolled', ['user', 'super_admin']),
    createEnrolledOperator('admin-enrolled', ['user', 'admin']),
  ]);
  [superUnenrolled, adminUnenrolled, supportOnly, ordinary, familyRep] = await Promise.all([
    createUser('super-unenrolled', ['user', 'super_admin']),
    createUser('admin-unenrolled', ['user', 'admin']),
    createUser('support-only', ['user', 'support']),
    createUser('ordinary', ['user']),
    createUser('family-rep', ['user']),
  ]);

  // DB-5: 家族は代表者の rpc('create_family_group') で作る (family-member-status-guard.test.ts と同じ形)
  // billing/03 §6.6: 家族グループは家族プランの契約者だけが作れるので、作る前に家族プランを手動付与する
  await grantFamilyPlan(srAdmin, familyRep.id);
  const { data: family, error: familyError } = await asUser(familyRep.jwt).rpc('create_family_group', {
    p_name: `#1707 mfa-db-gate ${TS}`,
    p_plan_key: 'free',
  });
  if (familyError || !family) throw new Error(`create_family_group: ${familyError?.message}`);
  familyId = (family as { id: string }).id;
  createdFamilyIds.push(familyId);

  // DB-6: この結合テストだけの機能フラグ (他のテストの行に依存しない)
  const { error: flagError } = await srAdmin.from('feature_flags').insert({ key: FEATURE_FLAG_KEY, enabled: false });
  if (flagError) throw new Error(`feature_flags: ${flagError.message}`);

  // DB-8: 登録済み admin 本人の問い合わせと、一般の利用者の問い合わせ
  const { data: inquiries, error: inquiryError } = await srAdmin
    .from('inquiries')
    .insert([
      { user_id: adminEnrolled.id, inquiry_type: 'general', email: 'admin-enrolled@homegohan.test', subject: `own ${TS}`, message: '本文' },
      { user_id: ordinary.id, inquiry_type: 'general', email: 'ordinary@homegohan.test', subject: `other ${TS}`, message: '本文' },
    ])
    .select('id, user_id');
  if (inquiryError || !inquiries) throw new Error(`inquiries: ${inquiryError?.message}`);
  for (const row of inquiries as Array<{ id: string; user_id: string }>) {
    createdInquiryIds.push(row.id);
    if (row.user_id === adminEnrolled.id) ownInquiryId = row.id;
    else otherInquiryId = row.id;
  }

  // DB-10: 一般の利用者の問い合わせチケット
  const { data: ticket, error: ticketError } = await srAdmin
    .from('support_tickets')
    .insert({ user_id: ordinary.id, category: 'other', subject: `#1707 mfa-db-gate ${TS}` })
    .select('id')
    .single();
  if (ticketError || !ticket) throw new Error(`support_tickets: ${ticketError?.message}`);
  otherTicketId = (ticket as { id: string }).id;
  createdTicketIds.push(otherTicketId);
}

async function cleanupFixture(): Promise<void> {
  if (createdNoteIds.length > 0) await srAdmin.from('admin_user_notes').delete().in('id', createdNoteIds);
  if (createdInquiryIds.length > 0) await srAdmin.from('inquiries').delete().in('id', createdInquiryIds);
  if (createdTicketIds.length > 0) await srAdmin.from('support_tickets').delete().in('id', createdTicketIds);
  await srAdmin.from('feature_flags').delete().eq('key', FEATURE_FLAG_KEY);
  if (createdFamilyIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdFamilyIds);
    // family_members は CASCADE。family_groups.representative_id は ON DELETE RESTRICT なので家族を先に消す
    await srAdmin.from('family_groups').delete().in('id', createdFamilyIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles・auth.mfa_factors は CASCADE
  }
}

describe('#1707 段 E: PostgREST / RPC を本人の JWT で直接呼ぶ', () => {
  beforeAll(createFixture, SETUP_TIMEOUT_MS);
  afterAll(cleanupFixture, SETUP_TIMEOUT_MS);

  it("DB-4: 登録済み super_admin の aal1 の token で rpc('list_orgs_with_inactive_owner') は message 'OPERATOR_MFA_REQUIRED' のエラー、同じ利用者の aal2 の token (promoteToAal2 の戻り) では error が null (S-24)", async () => {
    const denied = await asUser(superEnrolled.aal1).rpc('list_orgs_with_inactive_owner');
    expect(denied.error?.message).toBe(OPERATOR_MFA_REQUIRED);
    expect(denied.data).toBeNull();
    const allowed = await asUser(superEnrolled.aal2).rpc('list_orgs_with_inactive_owner');
    expectPassedGate(allowed.error);
    // 判定を通ったことを、行の有無に依らずに確かめる: 存在しない組織への移譲は、判定の後の対象の確認で止まる (何も変わらない)
    const transferDenied = await asUser(superEnrolled.aal1).rpc('operator_force_owner_transfer', {
      p_organization_id: NONEXISTENT_ID,
      p_new_owner_id: NONEXISTENT_ID,
      p_reason: '#1707 段 E の結合テスト',
    });
    expect(transferDenied.error?.message).toBe(OPERATOR_MFA_REQUIRED);
    const transferPassed = await asUser(superEnrolled.aal2).rpc('operator_force_owner_transfer', {
      p_organization_id: NONEXISTENT_ID,
      p_new_owner_id: NONEXISTENT_ID,
      p_reason: '#1707 段 E の結合テスト',
    });
    expect(transferPassed.error?.message).toBe(TARGET_NOT_IN_ORG);
  });

  it("DB-5: 登録済み super_admin の aal1 の token で rpc('operator_force_dissolve_family', { p_family_id, p_reason }) は 'OPERATOR_MFA_REQUIRED' のエラーで、家族の status は 'active' のまま", async () => {
    const { error } = await asUser(superEnrolled.aal1).rpc('operator_force_dissolve_family', {
      p_family_id: familyId,
      p_reason: '#1707 段 E の結合テスト',
    });
    expect(error?.message).toBe(OPERATOR_MFA_REQUIRED);
    const { data, error: readError } = await srAdmin.from('family_groups').select('status').eq('id', familyId).single();
    expect(readError).toBeNull();
    expect((data as { status: string }).status).toBe('active');
    // 家族のメンバーも 1 人も外れていない (関数の中の更新は 1 つも走らない)
    const { data: members } = await srAdmin.from('family_members').select('status').eq('family_id', familyId);
    expect((members as Array<{ status: string }>).map((m) => m.status)).toEqual(['active']);
  });

  it('DB-6: 登録済み super_admin の aal1 の token で feature_flags を select すると 0 行、aal2 の token では 1 行以上 (feature_flags_super_admin_all の運営の枝)', async () => {
    const denied = await asUser(superEnrolled.aal1).from('feature_flags').select('key').eq('key', FEATURE_FLAG_KEY);
    expect(denied.error).toBeNull();
    expect(denied.data).toEqual([]);
    const allowed = await asUser(superEnrolled.aal2).from('feature_flags').select('key').eq('key', FEATURE_FLAG_KEY);
    expect(allowed.error).toBeNull();
    expect(allowed.data).toEqual([{ key: FEATURE_FLAG_KEY }]);
  });

  it('DB-7: 登録済み admin の aal1 の token では admin_user_notes を読めず、aal2 の token では読める (SELECT の運営の枝)。どちらの token でも直接の insert は code 42501 (書き込みは API が service_role で書く。20261025100000・#1917 の続き)', async () => {
    const { data: seeded, error: seedError } = await srAdmin
      .from('admin_user_notes')
      .insert({ user_id: ordinary.id, admin_id: adminEnrolled.id, note: `#1707 seeded ${TS}` })
      .select('id')
      .single();
    expect(seedError).toBeNull();
    const seededId = (seeded as { id: string }).id;
    createdNoteIds.push(seededId);

    const deniedRead = await asUser(adminEnrolled.aal1).from('admin_user_notes').select('id').eq('id', seededId);
    expect(deniedRead.error).toBeNull();
    expect(deniedRead.data).toEqual([]);
    const allowedRead = await asUser(adminEnrolled.aal2).from('admin_user_notes').select('id').eq('id', seededId);
    expect(allowedRead.error).toBeNull();
    expect(allowedRead.data).toEqual([{ id: seededId }]);

    for (const [label, jwt] of [['aal1', adminEnrolled.aal1], ['aal2', adminEnrolled.aal2]] as const) {
      const denied = await asUser(jwt)
        .from('admin_user_notes')
        .insert({ user_id: ordinary.id, admin_id: adminEnrolled.id, note: `#1707 ${label} ${TS}` });
      expect(denied.error?.code, label).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // 直接の insert は行を作っていない
    const { data: notes } = await srAdmin.from('admin_user_notes').select('note').eq('user_id', ordinary.id);
    expect((notes as Array<{ note: string }>).map((n) => n.note)).toEqual([`#1707 seeded ${TS}`]);
  });

  it('DB-8: 登録済み admin の aal1 の token で inquiries を select すると、自分の行だけが読め、他人の行は読めない (S-29。本人の行の枝は判定を通さない)', async () => {
    const aal1 = await asUser(adminEnrolled.aal1).from('inquiries').select('id').in('id', [ownInquiryId, otherInquiryId]);
    expect(aal1.error).toBeNull();
    expect((aal1.data as Array<{ id: string }>).map((r) => r.id)).toEqual([ownInquiryId]);
    // aal2 なら運営の枝で他人の行も読める (判定が閉じているのは aal1 だけ)
    const aal2 = await asUser(adminEnrolled.aal2).from('inquiries').select('id').in('id', [ownInquiryId, otherInquiryId]);
    expect(aal2.error).toBeNull();
    expect((aal2.data as Array<{ id: string }>).map((r) => r.id).sort()).toEqual([ownInquiryId, otherInquiryId].sort());
  });

  it("DB-9: 未登録の super_admin の aal1 の token で rpc('list_orgs_with_inactive_owner') は error が null (S-30。未登録は DB で止めない §0.3)", async () => {
    const { error } = await asUser(superUnenrolled.jwt).rpc('list_orgs_with_inactive_owner');
    expectPassedGate(error);
    const transfer = await asUser(superUnenrolled.jwt).rpc('operator_force_owner_transfer', {
      p_organization_id: NONEXISTENT_ID,
      p_new_owner_id: NONEXISTENT_ID,
      p_reason: '#1707 段 E の結合テスト',
    });
    expect(transfer.error?.message).toBe(TARGET_NOT_IN_ORG);
  });

  it('DB-10: support だけの利用者 (aal1) は support_tickets の他人の行を読める (必須ロールでないので判定は真。今までどおり)', async () => {
    const { data, error } = await asUser(supportOnly.jwt).from('support_tickets').select('id').eq('id', otherTicketId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: otherTicketId }]);
  });

  it('DB-11: anon は subscription_plans の status が public / private の行を読め、error が null (S-31)。未登録・登録済みのどちらの admin の aal1 でも同じ行が読める', async () => {
    const idsOf = async (db: SupabaseClient): Promise<string[]> => {
      const { data, error } = await db.from('subscription_plans').select('id').in('status', [...PUBLIC_PLAN_STATUSES]);
      expect(error).toBeNull();
      return (data as Array<{ id: string }>).map((r) => r.id).sort();
    };
    const anonIds = await idsOf(anon());
    expect(anonIds.length).toBeGreaterThan(0);
    expect(await idsOf(asUser(adminUnenrolled.jwt))).toEqual(anonIds);
    expect(await idsOf(asUser(adminEnrolled.aal1))).toEqual(anonIds);
    // 登録済み admin の aal1 は運営の枝 (subscription_plans_select_operator) が閉じるので、全体でも anon と同じ行だけ
    const all = async (db: SupabaseClient): Promise<string[]> => {
      const { data, error } = await db.from('subscription_plans').select('id');
      expect(error).toBeNull();
      return (data as Array<{ id: string }>).map((r) => r.id).sort();
    };
    expect(await all(asUser(adminEnrolled.aal1))).toEqual(await all(anon()));
  });
});
