/**
 * #1917: family_groups への利用者 (anon / authenticated) からの直接の DELETE を塞ぎ、家族の削除を解散の仕組み
 * (解散の RPC・運営の強制解散・解散から 90 日の purge) だけにする (migration 20261022200000_family_groups_no_direct_delete.sql)。
 *
 * 修正前は、ポリシー family_groups_delete_representative と anon / authenticated の DELETE の権限により、家族の代表者が
 * PostgREST の直接の DELETE で家族の行を消せた。そのとき保護者の同意の記録 (parental_consents) が外部キーの CASCADE で
 * 物理削除され、解散の RPC (監査 group_dissolved・解散の知らせ) も通らなかった。
 *
 * 確かめること:
 *   - G-1: 代表者の直接の DELETE は 42501 で止まり、家族の行・メンバー・招待・保護者の同意の記録は残る
 *   - G-2: 大人・別の家族の代表者・未認証の直接の DELETE も 42501 で、行は残る
 *   - G-3: カタログ: DELETE のポリシーが無く、anon / authenticated は DELETE・TRUNCATE を持たない (TRUNCATE も 42501 で止まる)。
 *          SELECT・UPDATE のポリシーと authenticated の SELECT・UPDATE、service_role の DELETE は残る
 *   - G-4: 代表者の解散の RPC (dissolve_family_by_representative) は今までどおり通り、同意の記録は取り消し済みとして残る。
 *          解散のあとも代表者 (元) は直接 DELETE できない
 *   - G-5: 運営の強制解散 (operator_force_dissolve_family) は今までどおり通る
 *   - G-6: 解散から 90 日の purge (purge_dissolved_family_groups。service_role) は今までどおり、同意の記録を持たない家族を消し
 *          (招待・メンバーは CASCADE)、同意の記録を持つ家族と同意の行は残す
 *   - G-7: service_role の直接の DELETE (運営の手作業・テストと e2e の後片付け) は今までどおり通る
 *   - G-8: 戻し口 (supabase/rollbacks/) を 1 つのトランザクションで流して巻き戻す (DB には残らない):
 *          本冊の戻し口だけ → DELETE のポリシーと anon / authenticated の DELETE が戻り、TRUNCATE は付かない (本冊の直前は
 *          20261022190000 が外していて無い)。新しい順 (本冊 → 190000) に戻す → DELETE と TRUNCATE が戻る (190000 の直前 = ベースライン)。
 *          190000 の戻し口だけ (順序外) → family_groups には DELETE も TRUNCATE も付かない
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/family-groups-no-direct-delete.test.ts
 * カタログの確認と TRUNCATE の試しは、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { PARENTAL_CONSENT_DOCUMENT, todayLocal } from '@homegohan/shared';
import { grantFamilyPlan } from '../helpers/family-plan';
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
/** 解散から物理削除までの保存期間 (日)。20261018010000_purge_dissolved_family_groups.sql の c_retention */
const PURGE_RETENTION_DAYS = 90;
/** purge の候補にするために、解散の日時を戻す日数 (保存期間 + 1 日) */
const DAYS_PAST_RETENTION = PURGE_RETENTION_DAYS + 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** 成人の生年月日 (保護者の同意に署名する代表者) */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 保護者の同意が要る子供の年齢 (歳) */
const CHILD_AGE_YEARS = 8;
const SIGNED_NAME = 'テスト 保護者';
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒。利用者・家族を複数作る) */
const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
let seq = 0;

const emailOf = (label: string) => `rls-fam-no-direct-delete-${label}-${RUN}-${++seq}@homegohan.test`;

async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

const ROOT = path.resolve(__dirname, '../../..');
const readRollback = (stem: string) => fs.readFileSync(path.join(ROOT, 'supabase', 'rollbacks', `${stem}.down.sql`), 'utf-8');
/** 本冊の戻し口 (family_groups の DELETE のポリシーと権限を戻す) */
const OWN_ROLLBACK = readRollback('20261022200000_family_groups_no_direct_delete');
/** 本冊の直前の migration の戻し口 (public の全部の表の anon / authenticated の TRUNCATE を付け直す) */
const HARDENING_ROLLBACK = readRollback('20261022190000_db_privilege_hardening');
/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'FAMILY_GROUPS_ROLLBACK_RESULT:';

interface RollbackOutcome {
  deletePolicy: boolean;
  anonDelete: boolean;
  anonTruncate: boolean;
  authenticatedDelete: boolean;
  authenticatedTruncate: boolean;
}

/** 応答の本文の中から、目印を含む文字列を探す (postgres-meta の失敗の本文の形が版で違っても拾えるように、値を順に見る) */
function findMarkedText(body: unknown): string | null {
  if (typeof body === 'string') return body.includes(ROLLBACK_RESULT_MARKER) ? body : null;
  if (body && typeof body === 'object') {
    for (const value of Object.values(body as Record<string, unknown>)) {
      const found = findMarkedText(value);
      if (found) return found;
    }
  }
  return null;
}

/**
 * sql (戻し口) を流し、family_groups のポリシーと anon / authenticated の権限を返す。全部が 1 つのトランザクションで、
 * 最後の例外 (結果を載せる) で巻き戻る (DB には何も残らない)
 */
async function familyGroupsAfterRolledBack(sql: string): Promise<RollbackOutcome> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%', json_build_object(
    'deletePolicy', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'family_groups'
                              AND policyname = 'family_groups_delete_representative'),
    'anonDelete', has_table_privilege('anon', 'public.family_groups', 'DELETE'),
    'anonTruncate', has_table_privilege('anon', 'public.family_groups', 'TRUNCATE'),
    'authenticatedDelete', has_table_privilege('authenticated', 'public.family_groups', 'DELETE'),
    'authenticatedTruncate', has_table_privilege('authenticated', 'public.family_groups', 'TRUNCATE')
  )::text;
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const json = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  // 結果は入れ子の無い 1 つのオブジェクト (値は真偽だけ) なので、最初の } までが結果 (後ろに CONTEXT などの文が続くことがある)
  return JSON.parse(json.slice(0, json.indexOf('}') + 1)) as RollbackOutcome;
}

async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

function yearsAgo(years: number): string {
  const today = todayLocal();
  const monthDay = today.slice(4) === '-02-29' ? '-02-28' : today.slice(4);
  return `${String(Number(today.slice(0, 4)) - years).padStart(4, '0')}${monthDay}`;
}

async function signIn(email: string): Promise<{ client: SupabaseClient; jwt: string }> {
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signInClient = anon();
  const { data, error } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: signInClient, jwt: data.session.access_token };
}

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = emailOf(`user-${label}`);
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      {
        id: data.user.id,
        nickname: `no-direct-delete-${label}`,
        age_group: '30s',
        gender: 'other',
        birth_date: ADULT_BIRTH_DATE,
        ...(roles ? { roles } : {}),
      },
      { onConflict: 'id' },
    ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const { jwt } = await signIn(email);
  return { id: data.user.id, email, jwt };
}

/** 家族プランを付与した代表者が create_family_group で作るグループ (家族プランが無いと代表者以外のメンバーを足せない。billing/03 §6.6) */
async function createFamily(rep: TestUser, label: string): Promise<string> {
  await grantFamilyPlan(srAdmin, rep.id);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', { p_name: `#1917 nd ${label} ${RUN}`, p_plan_key: 'free' });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  return familyId;
}

async function inviteToken(rep: TestUser, familyId: string, email: string): Promise<{ id: string; token: string }> {
  const { data, error } = await asUser(rep.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: email });
  if (error || !data) throw new Error(`create_family_invite: ${error?.message}`);
  return data as { id: string; token: string };
}

async function join(rep: TestUser, familyId: string, user: TestUser): Promise<void> {
  const { token } = await inviteToken(rep, familyId, user.email);
  const { error } = await asUser(user.jwt).rpc('accept_family_invite', { p_token: token });
  if (error) throw new Error(`accept_family_invite: ${error.message}`);
}

/** アカウントの無い子供 (保護者の同意あり) を代表者が足す。メンバーの id を返す */
async function addConsentedChild(rep: TestUser, familyId: string, name: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('add_family_child', {
    p_family_id: familyId,
    p_display_name: name,
    p_child_profile: { note: '#1917 no-direct-delete' },
    p_birth_date: yearsAgo(CHILD_AGE_YEARS),
    p_consent_version: PARENTAL_CONSENT_DOCUMENT.version,
    p_signed_name: SIGNED_NAME,
    p_guardian_attested: true,
  });
  if (error || !data) throw new Error(`add_family_child ${name}: ${error?.message}`);
  return (data as { id: string }).id;
}

interface FamilyRow {
  status: string;
  representative_id: string | null;
  dissolved_at: string | null;
}

async function familyRow(familyId: string): Promise<FamilyRow | null> {
  const { data, error } = await srAdmin.from('family_groups').select('status, representative_id, dissolved_at').eq('id', familyId).maybeSingle();
  if (error) throw new Error(`family_groups: ${error.message}`);
  return data as FamilyRow | null;
}

async function countRows(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await srAdmin.from(table).select('id', { count: 'exact', head: true }).eq(column, value);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

interface ConsentRow {
  id: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

async function consentsOf(familyId: string): Promise<ConsentRow[]> {
  const { data, error } = await srAdmin.from('parental_consents').select('id, revoked_at, revoked_reason').eq('family_id', familyId);
  if (error) throw new Error(`parental_consents: ${error.message}`);
  return (data ?? []) as ConsentRow[];
}

async function auditCount(familyId: string, action: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('membership_audit')
    .select('id', { count: 'exact', head: true })
    .eq('scope', 'family')
    .eq('scope_id', familyId)
    .eq('action', action);
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return count ?? 0;
}

/** PostgREST で family_groups の行を直接 DELETE する (消えた行の id を返させる) */
async function directDelete(c: SupabaseClient, familyId: string) {
  return c.from('family_groups').delete().eq('id', familyId).select('id');
}

/** 直接の DELETE が権限で止まり、行が残っていること */
async function expectDeleteDenied(c: SupabaseClient, familyId: string, who: string): Promise<void> {
  const { data, error } = await directDelete(c, familyId);
  expect(error?.code, `${who}: ${JSON.stringify(error)}`).toBe(INSUFFICIENT_PRIVILEGE);
  expect(data ?? [], who).toEqual([]);
  expect(await familyRow(familyId), who).not.toBeNull();
}

/** 解散の日時を保存期間より前に戻す (service_role は guard_family_groups_privileged の対象外) */
async function backdateDissolvedAt(familyId: string): Promise<void> {
  const { error } = await srAdmin
    .from('family_groups')
    .update({ dissolved_at: new Date(Date.now() - DAYS_PAST_RETENTION * MS_PER_DAY).toISOString() })
    .eq('id', familyId);
  if (error) throw new Error(`family_groups.dissolved_at: ${error.message}`);
}

let rep: TestUser;
let adult: TestUser;
let otherRep: TestUser;
let family: string;
let otherFamily: string;
let childMemberId: string;
let pendingInviteId: string;

beforeAll(async () => {
  rep = await createUser('rep');
  adult = await createUser('adult');
  otherRep = await createUser('other-rep');
  family = await createFamily(rep, 'main');
  otherFamily = await createFamily(otherRep, 'other');
  await join(rep, family, adult);
  childMemberId = await addConsentedChild(rep, family, 'main-child');
  pendingInviteId = (await inviteToken(rep, family, emailOf('pending'))).id;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin.from('user_profiles').update({ family_id: null }).in('id', createdUserIds);
  }
  if (createdFamilyIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdFamilyIds);
    await srAdmin.from('parental_consents').delete().in('family_id', createdFamilyIds);
    // family_members / family_invites は family_groups の削除で CASCADE。representative_id は RESTRICT のため家族を先に消す
    await srAdmin.from('family_groups').delete().in('id', createdFamilyIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, SETUP_TIMEOUT_MS);

describe('#1917 family_groups の直接の DELETE は、だれでも 42501 で止まる', () => {
  it('G-1: 代表者の直接の DELETE は 42501。家族の行・メンバー・招待・保護者の同意の記録は残る', async () => {
    const membersBefore = await countRows('family_members', 'family_id', family);
    expect(membersBefore).toBe(3); // 代表者・大人・子供
    const consentsBefore = await consentsOf(family);
    expect(consentsBefore).toHaveLength(1);
    expect(consentsBefore[0].revoked_at).toBeNull();

    await expectDeleteDenied(asUser(rep.jwt), family, '代表者');

    expect(await familyRow(family)).toMatchObject({ status: 'active', representative_id: rep.id });
    expect(await countRows('family_members', 'family_id', family)).toBe(membersBefore);
    expect(await countRows('family_invites', 'id', pendingInviteId)).toBe(1);
    expect(await consentsOf(family)).toEqual(consentsBefore);
    expect(await countRows('family_members', 'id', childMemberId)).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('G-2: 大人・別の家族の代表者・未認証の直接の DELETE も 42501 で、行は残る', async () => {
    await expectDeleteDenied(asUser(adult.jwt), family, '大人');
    await expectDeleteDenied(asUser(otherRep.jwt), family, '別の家族の代表者');
    await expectDeleteDenied(asUser(otherRep.jwt), otherFamily, '別の家族の代表者 (自分の家族)');
    await expectDeleteDenied(anon(), family, '未認証');
  }, TEST_TIMEOUT_MS);

  it('G-3: DELETE のポリシーが無く、anon / authenticated は DELETE・TRUNCATE を持たない。SELECT・UPDATE と service_role の DELETE は残る', async () => {
    const policies = await pgQuery<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'family_groups' ORDER BY policyname;`,
    );
    expect(policies).toEqual([
      { policyname: 'family_groups_select_member', cmd: 'SELECT' },
      { policyname: 'family_groups_update_adult', cmd: 'UPDATE' },
    ]);

    const privileges = await pgQuery<{ role: string; privilege: string; allowed: boolean }>(`
      SELECT r AS role, p AS privilege, has_table_privilege(r, 'public.family_groups', p) AS allowed
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r,
             unnest(ARRAY['SELECT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
       ORDER BY r, p;`);
    const allowed = (role: string, privilege: string) => privileges.find((row) => row.role === role && row.privilege === privilege)?.allowed;
    for (const role of ['anon', 'authenticated']) {
      expect(allowed(role, 'DELETE'), `${role} DELETE`).toBe(false);
      expect(allowed(role, 'TRUNCATE'), `${role} TRUNCATE`).toBe(false);
    }
    expect(allowed('authenticated', 'SELECT')).toBe(true);
    expect(allowed('authenticated', 'UPDATE')).toBe(true);
    expect(allowed('service_role', 'DELETE')).toBe(true);

    // TRUNCATE は RLS が効かない。権限の確認は外部キーの確認 (参照されている表は CASCADE なしでは消せない) より先に行われる
    const claims = JSON.stringify({ sub: rep.id, role: 'authenticated' });
    const truncate = await pgRequest(`
      SELECT set_config('request.jwt.claims', '${claims}', true);
      SET LOCAL ROLE authenticated;
      TRUNCATE public.family_groups;`);
    expect(truncate.ok, JSON.stringify(truncate.body)).toBe(false);
    expect((truncate.body as { code?: unknown } | null)?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await familyRow(family)).not.toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('#1917 解散の仕組みは今までどおり動く', () => {
  it('G-4: 代表者の解散の RPC は通り、同意の記録は取り消し済み (member_left) として残る。解散のあとも直接の DELETE はできない', async () => {
    const dissolveRep = await createUser('g4-rep');
    const dissolveFamily = await createFamily(dissolveRep, 'g4');
    await addConsentedChild(dissolveRep, dissolveFamily, 'g4-child');

    const { error } = await asUser(dissolveRep.jwt).rpc('dissolve_family_by_representative', { p_family_id: dissolveFamily });
    expect(error, JSON.stringify(error)).toBeNull();

    expect(await familyRow(dissolveFamily)).toMatchObject({ status: 'dissolved', representative_id: null });
    expect(await auditCount(dissolveFamily, 'group_dissolved')).toBe(1);
    const consents = await consentsOf(dissolveFamily);
    expect(consents).toHaveLength(1);
    expect(consents[0].revoked_reason).toBe('member_left');
    expect(consents[0].revoked_at).not.toBeNull();

    await expectDeleteDenied(asUser(dissolveRep.jwt), dissolveFamily, '解散した家族の元の代表者');
    expect(await consentsOf(dissolveFamily)).toEqual(consents);
  }, TEST_TIMEOUT_MS);

  it('G-5: 運営の強制解散は今までどおり通る (家族の行は dissolved になり、消えない)', async () => {
    const operator = await createUser('g5-operator', ['user', 'super_admin']);
    const { client: sessionClient } = await signIn(operator.email);
    const aal2 = await promoteToAal2(sessionClient);
    const forcedRep = await createUser('g5-rep');
    const forcedFamily = await createFamily(forcedRep, 'g5');

    const { error } = await asUser(aal2).rpc('operator_force_dissolve_family', { p_family_id: forcedFamily, p_reason: '#1917 no-direct-delete G-5' });
    expect(error, JSON.stringify(error)).toBeNull();
    expect(await familyRow(forcedFamily)).toMatchObject({ status: 'dissolved', representative_id: null });
    expect(await auditCount(forcedFamily, 'operator_force_dissolve')).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('G-6: 解散から 90 日の purge は、同意の記録を持たない家族を消し (招待・メンバーは CASCADE)、同意の記録を持つ家族と同意の行は残す', async () => {
    const plainRep = await createUser('g6-plain-rep');
    const plainFamily = await createFamily(plainRep, 'g6-plain');
    const plainInviteId = (await inviteToken(plainRep, plainFamily, emailOf('g6-invite'))).id;
    const consentRep = await createUser('g6-consent-rep');
    const consentFamily = await createFamily(consentRep, 'g6-consent');
    await addConsentedChild(consentRep, consentFamily, 'g6-child');

    for (const [user, familyId] of [[plainRep, plainFamily], [consentRep, consentFamily]] as const) {
      const { error } = await asUser(user.jwt).rpc('dissolve_family_by_representative', { p_family_id: familyId });
      expect(error, JSON.stringify(error)).toBeNull();
      await backdateDissolvedAt(familyId);
    }
    const consentsBefore = await consentsOf(consentFamily);
    expect(consentsBefore).toHaveLength(1);

    const { data, error } = await srAdmin.rpc('purge_dissolved_family_groups', { p_dry_run: false });
    expect(error, JSON.stringify(error)).toBeNull();
    const result = (data as Array<{ purge_count: number; skipped_with_consents_count: number }>)[0];
    expect(result.purge_count).toBeGreaterThanOrEqual(1);
    expect(result.skipped_with_consents_count).toBeGreaterThanOrEqual(1);

    expect(await familyRow(plainFamily)).toBeNull();
    expect(await countRows('family_members', 'family_id', plainFamily)).toBe(0);
    expect(await countRows('family_invites', 'id', plainInviteId)).toBe(0);

    expect(await familyRow(consentFamily)).toMatchObject({ status: 'dissolved' });
    expect(await consentsOf(consentFamily)).toEqual(consentsBefore);
  }, TEST_TIMEOUT_MS);

  it('G-7: service_role の直接の DELETE (運営の手作業・テストと e2e の後片付け) は今までどおり通る', async () => {
    const srRep = await createUser('g7-rep');
    const srFamily = await createFamily(srRep, 'g7');
    const { data, error } = await directDelete(srAdmin, srFamily);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: srFamily }]);
    expect(await familyRow(srFamily)).toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('#1917 戻し口を流したときの family_groups の権限 (1 つのトランザクションで流して巻き戻す)', () => {
  it('G-8: 本冊の戻し口は DELETE のポリシーと DELETE を戻し、TRUNCATE は付けない。新しい順に 190000 まで戻すと TRUNCATE も戻る。190000 だけを先に戻しても family_groups に TRUNCATE は付かない', async () => {
    // 本冊だけを戻す: 本冊の直前の状態 (DELETE はあり・TRUNCATE は 20261022190000 が外していて無い)
    expect(await familyGroupsAfterRolledBack(OWN_ROLLBACK)).toEqual({
      deletePolicy: true,
      anonDelete: true,
      anonTruncate: false,
      authenticatedDelete: true,
      authenticatedTruncate: false,
    });
    // 新しい順 (本冊 → 190000) に戻す: 190000 の直前 (ベースラインの DELETE・TRUNCATE) に戻る
    expect(await familyGroupsAfterRolledBack(`${OWN_ROLLBACK}\n${HARDENING_ROLLBACK}`)).toEqual({
      deletePolicy: true,
      anonDelete: true,
      anonTruncate: true,
      authenticatedDelete: true,
      authenticatedTruncate: true,
    });
    // 順序外 (本冊を残したまま 190000 だけを戻す): 本冊が外した DELETE・TRUNCATE はどちらも付かない
    expect(await familyGroupsAfterRolledBack(HARDENING_ROLLBACK)).toEqual({
      deletePolicy: false,
      anonDelete: false,
      anonTruncate: false,
      authenticatedDelete: false,
      authenticatedTruncate: false,
    });
    // 巻き戻ったこと: いまの DB は本冊が当たったまま (G-3 と同じ)
    const now = await pgQuery<{ anon_truncate: boolean; auth_delete: boolean }>(`
      SELECT has_table_privilege('anon', 'public.family_groups', 'TRUNCATE') AS anon_truncate,
             has_table_privilege('authenticated', 'public.family_groups', 'DELETE') AS auth_delete;`);
    expect(now).toEqual([{ anon_truncate: false, auth_delete: false }]);
  }, TEST_TIMEOUT_MS);
});
