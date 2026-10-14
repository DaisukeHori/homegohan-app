/**
 * #1273 初期設定 (オンボーディング) より前に招待を承諾すると、所属が user_profiles に入らない問題の回帰テスト
 *
 * 本番には auth.users から user_profiles を作るトリガーが無く、プロフィール行は初期設定の保存で初めて作られる。
 * 招待メールのリンクから新規登録した人は、初期設定より前でも招待ページ (/invite/[token]) で承諾できるため、
 * 承諾の時点でプロフィール行がまだ無い。
 *
 * 修正前:
 *   - accept_family_invite: `UPDATE user_profiles SET family_id` が 0 行で終わる。family_members には active で入るのに
 *     user_profiles.family_id は NULL のまま (家族の画面が「家族なし」になり、家族を新規作成しても ALREADY_IN_FAMILY で失敗する)
 *   - accept_org_invite: 同じ UPDATE が 0 行で終わるが、その後は進む。招待は accepted、used_licenses +1、監査ログが残るのに
 *     所属は入らず、戻り値は全列 NULL の行になる (API は { ok: true, organization_id: null, role: null })
 *
 * 修正後 (20261007150200_invite_accept_creates_missing_profile.sql。accept_child_promotion = #1232 と同じ形):
 *   - プロフィール行が無ければ、アプリの既定値 (nickname 'Guest'、age_group / gender 'unspecified') で作ってから所属を入れる
 *   - 行があるときは所属の列だけを更新する。初期設定の日時は入れないので初期設定の導線は変わらない
 *   - 初期設定の保存 (upsert) は所属の列を送らないため、あとから保存しても所属は残る。本人が所属の列を消すことはできないまま
 *   - 失敗する承諾 (メール不一致・使用済み・期限切れ・席数超過) はプロフィール行を残さない
 *   - 初期設定前に入った人も leave_org で抜けられ、席が戻る。アカウント削除後の JWT での承諾は招待も席も消費しない
 *   - 同じ人が家族と組織の招待を同時に承諾しても、行は 1 つで両方の所属が入る
 *   - CREATE OR REPLACE のため所有者と EXECUTE 権限は本番の現行のまま (anon は実行できない)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next の開発サーバー (API ルートの検証に使う)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/invite-accept-missing-profile.test.ts
 *
 * 関数定義・権限の確認 (has_function_privilege など) は、ローカルスタックの postgres-meta (/pg/query、
 * service_role キーが必要) で読み取りだけ行う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
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
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
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

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
const createdOrgIds: string[] = [];
const TOKEN_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** withProfile: false は「新規登録しただけで初期設定 (オンボーディング) 前」の人 (プロフィール行が無い) */
async function createUser(label: string, options: { withProfile?: boolean } = {}): Promise<TestUser> {
  const email = `sec-invite-accept-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  if (options.withProfile !== false) {
    const { error: profileError } = await srAdmin
      .from('user_profiles')
      .upsert({ id: data.user.id, nickname: `accept-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
    if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  }
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

/** 承諾の確認に使うプロフィールの列。所属の列と、初期設定の導線を決める日時を含む */
const COLS =
  'nickname, age_group, gender, family_id, organization_id, org_role, is_active_in_org, joined_org_at, onboarding_started_at, onboarding_completed_at';

/** service_role でプロフィール行を読む (行が無ければ null) */
async function profileOf(id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from('user_profiles').select(COLS).eq('id', id).maybeSingle();
  if (error) throw new Error(`profileOf: ${error.message}`);
  return data as Record<string, unknown> | null;
}

/** service_role でプロフィール行の全列を読む */
async function fullProfileOf(id: string): Promise<Record<string, unknown>> {
  const { data, error } = await srAdmin.from('user_profiles').select('*').eq('id', id).single();
  if (error) throw new Error(`fullProfileOf: ${error.message}`);
  return data as Record<string, unknown>;
}

async function activeFamilyMembershipCount(userId: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('family_members')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'active');
  if (error) throw new Error(`family_members: ${error.message}`);
  return count ?? 0;
}

async function inviteRow(table: 'family_invites' | 'organization_invites', token: string) {
  const { data, error } = await srAdmin.from(table).select('status, accepted_by').eq('token', token).single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data as { status: string; accepted_by: string | null };
}

async function acceptedAudit(scope: 'family' | 'organization', scopeId: string, userId: string) {
  const { data, error } = await srAdmin
    .from('membership_audit')
    .select('action, actor_id, target_user_id, metadata')
    .eq('scope', scope)
    .eq('scope_id', scopeId)
    .eq('action', 'invite_accepted')
    .eq('target_user_id', userId);
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return (data ?? []) as Array<{
    action: string;
    actor_id: string | null;
    target_user_id: string | null;
    metadata: Record<string, unknown>;
  }>;
}

async function usedLicenses(orgId: string): Promise<number> {
  const { data, error } = await srAdmin.from('org_license_pools').select('used_licenses').eq('organization_id', orgId).single();
  if (error) throw new Error(`org_license_pools: ${error.message}`);
  return (data as { used_licenses: number }).used_licenses;
}

async function createFamily(rep: TestUser, label: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `#1273 family ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  return familyId;
}

async function familyInviteToken(rep: TestUser, familyId: string, email: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: email });
  if (error || !data) throw new Error(`create_family_invite: ${error?.message}`);
  const token = (data as { token: string }).token;
  expect(token).toMatch(TOKEN_RE);
  return token;
}

async function createOrg(label: string, totalLicenses: number): Promise<string> {
  const { data: org, error } = await srAdmin
    .from('organizations')
    .insert({ name: `#1273 ${label} ${TS}` })
    .select('id')
    .single();
  if (error || !org) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = org.id as string;
  createdOrgIds.push(orgId);
  const { error: poolError } = await srAdmin
    .from('org_license_pools')
    .upsert({ organization_id: orgId, total_licenses: totalLicenses, used_licenses: 0 }, { onConflict: 'organization_id' });
  if (poolError) throw new Error(`org_license_pools ${label}: ${poolError.message}`);
  return orgId;
}

async function setOrgMembership(user: TestUser, orgId: string, role: 'owner' | 'admin' | 'member') {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: role, is_active_in_org: true })
    .eq('id', user.id);
  if (error) throw new Error(`membership: ${error.message}`);
}

async function orgInviteToken(
  owner: TestUser,
  orgId: string,
  email: string,
  role: 'member' | 'admin' = 'member',
): Promise<string> {
  const { data, error } = await asUser(owner.jwt).rpc('create_org_invite', {
    p_organization_id: orgId,
    p_email: email,
    p_role: role,
  });
  if (error || !data) throw new Error(`create_org_invite: ${error?.message}`);
  const token = (data as { token: string }).token;
  expect(token).toMatch(TOKEN_RE);
  return token;
}

// 家族 A: 初期設定前の人 (newcomer) の承諾 / 家族 B: 初期設定済みの人 (existing)・API ルート (newcomer2)
// 組織 A: 席数に余裕あり / 組織 B: 席数 1 (席数超過の検証用。org B の owner は ownerB)
// stranger は「初期設定前で、どの招待の宛先でもない人」。失敗する承諾でプロフィール行ができないことの確認に使う
let repA: TestUser;
let repB: TestUser;
let newcomer: TestUser;
let newcomer2: TestUser;
let existing: TestUser;
let stranger: TestUser;
let dual: TestUser;
let famA = '';
let famB = '';
let ownerA: TestUser;
let ownerB: TestUser;
let orgNew1: TestUser;
let orgNew2: TestUser;
let orgExisting: TestUser;
let orgMember: TestUser;
let orgA = '';
let orgB = '';

// 前のテストで消化した招待 (「使用済み」の失敗系で使い回す)
let usedFamilyToken = '';
let usedOrgToken = '';

beforeAll(async () => {
  [repA, repB, newcomer, newcomer2] = await Promise.all([
    createUser('rep-a'),
    createUser('rep-b'),
    createUser('newcomer', { withProfile: false }),
    createUser('newcomer2', { withProfile: false }),
  ]);
  [existing, stranger, dual] = await Promise.all([
    createUser('existing'),
    createUser('stranger', { withProfile: false }),
    createUser('dual', { withProfile: false }),
  ]);
  famA = await createFamily(repA, 'a');
  famB = await createFamily(repB, 'b');

  orgA = await createOrg('org-a', 5);
  orgB = await createOrg('org-b', 1);
  [ownerA, ownerB, orgNew1, orgNew2, orgExisting, orgMember] = await Promise.all([
    createUser('owner-a'),
    createUser('owner-b'),
    createUser('org-new1', { withProfile: false }),
    createUser('org-new2', { withProfile: false }),
    createUser('org-existing'),
    createUser('org-member'),
  ]);
  await setOrgMembership(ownerA, orgA, 'owner');
  await setOrgMembership(ownerB, orgB, 'owner');
  await setOrgMembership(orgMember, orgB, 'member');
}, 120_000);

afterAll(async () => {
  // 先に所属の列を空にする。組織を消すと FK で organization_id だけ NULL になり、org_role が残って
  // user_profiles_org_consistency (organization_id と org_role は両方 NULL か両方あり) に違反するため
  if (createdUserIds.length > 0) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .in('id', createdUserIds);
  }
  for (const id of createdOrgIds) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('organization_invites').delete().eq('organization_id', id);
    await srAdmin.from('org_license_pools').delete().eq('organization_id', id);
    await srAdmin.from('organizations').delete().eq('id', id);
  }
  for (const id of createdFamilyIds) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('family_groups').delete().eq('id', id); // family_members / family_invites は CASCADE
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  }
}, 60_000);

describe('#1273 家族: 初期設定前 (プロフィール行なし) の招待承諾', () => {
  it('F1 (再現): プロフィール行が無い人が承諾すると、既定値のプロフィール行が所属家族つきで作られる', async () => {
    // 新規登録しただけの人にプロフィール行は無い (auth.users から行を作るトリガーは無い)
    expect(await profileOf(newcomer.id)).toBeNull();

    const token = await familyInviteToken(repA, famA, newcomer.email);
    usedFamilyToken = token;
    const { data, error } = await asUser(newcomer.jwt).rpc('accept_family_invite', { p_token: token });
    expect(error).toBeNull();
    expect(data).toMatchObject({ family_id: famA, user_id: newcomer.id, role: 'adult', status: 'active' });

    // 修正前は行が作られない (null)。初期設定の日時は入れない
    expect(await profileOf(newcomer.id)).toEqual({
      nickname: 'Guest',
      age_group: 'unspecified',
      gender: 'unspecified',
      family_id: famA,
      organization_id: null,
      org_role: null,
      is_active_in_org: false,
      joined_org_at: null,
      onboarding_started_at: null,
      onboarding_completed_at: null,
    });
    expect(await activeFamilyMembershipCount(newcomer.id)).toBe(1);
    expect((await inviteRow('family_invites', token)).status).toBe('accepted');
    expect(await acceptedAudit('family', famA, newcomer.id)).toHaveLength(1);
  });

  it('F2: 家族の画面の読み取り (family/dashboard/page.tsx と同じ 3 クエリ) が本人の JWT で通る', async () => {
    const me = asUser(newcomer.jwt);
    // 修正前は family_id が NULL (行が無い) で、画面は /family/setup へ戻される
    const profile = await me.from('user_profiles').select('family_id').eq('id', newcomer.id).single();
    expect(profile.data?.family_id).toBe(famA);
    const group = await me.from('family_groups').select('id, name, member_limit, status').eq('id', famA).single();
    expect(group.data?.id).toBe(famA);
    const members = await me
      .from('family_members')
      .select('id, role, display_name, user_id')
      .eq('family_id', famA)
      .eq('status', 'active');
    expect(members.error).toBeNull();
    expect((members.data ?? []).map((m) => m.user_id).sort()).toEqual([repA.id, newcomer.id].sort());
  });

  it('F3: 初期設定の導線は変わらない (not_started のまま。Guest の名前は返さない)', async () => {
    const status = await apiCall<{ status?: string; nickname?: string }>('GET', '/api/onboarding/status', newcomer.jwt);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ status: 'not_started' });
  }, 60_000);

  it('F4: 初期設定の保存のあとも所属家族は残り、本人が family_id を消すことはできない', async () => {
    const saved = await apiCall('POST', '/api/onboarding/progress', newcomer.jwt, {
      currentStep: 1,
      totalQuestions: 20,
      answers: { nickname: 'はなこ', gender: 'female', age: '25' },
    });
    expect(saved.status).toBe(200);
    // 修正前は、この保存で初めてプロフィール行ができるが family_id は NULL のまま
    expect(await profileOf(newcomer.id)).toMatchObject({
      family_id: famA,
      nickname: 'はなこ',
      age_group: '20s',
      gender: 'female',
      onboarding_completed_at: null,
    });

    // モバイルの初期設定と同じく、本人のセッションで直接 upsert する (family_id は送らない)
    const upserted = await asUser(newcomer.jwt)
      .from('user_profiles')
      .upsert({ id: newcomer.id, nickname: 'はなこ2', age_group: '20s', gender: 'female' })
      .select('family_id, nickname')
      .single();
    expect(upserted.error).toBeNull();
    expect(upserted.data).toEqual({ family_id: famA, nickname: 'はなこ2' });

    // 特権列ガード (guard_user_profiles_privileged) は変わらず効く
    const wipe = await asUser(newcomer.jwt).from('user_profiles').update({ family_id: null }).eq('id', newcomer.id);
    expect(wipe.error?.code).toBe('42501');
    expect((await profileOf(newcomer.id))?.family_id).toBe(famA);
  }, 60_000);

  it('F5: プロフィール行がある人が承諾しても、書き換わるのは family_id だけ', async () => {
    // 初期設定の途中・完了済みの人を想定して、日時や数値の列も入れておく
    const { error: seedError } = await srAdmin
      .from('user_profiles')
      .update({
        nickname: 'すでにいる人',
        age_group: '40s',
        gender: 'female',
        onboarding_started_at: '2026-01-01T00:00:00Z',
        onboarding_completed_at: '2026-01-02T00:00:00Z',
        height: 160,
      })
      .eq('id', existing.id);
    expect(seedError).toBeNull();
    const before = await fullProfileOf(existing.id);
    expect(before.family_id).toBeNull();

    const token = await familyInviteToken(repB, famB, existing.email);
    const { error } = await asUser(existing.jwt).rpc('accept_family_invite', { p_token: token });
    expect(error).toBeNull();

    const after = await fullProfileOf(existing.id);
    expect(after).toEqual({ ...before, family_id: famB });
    expect(after).toMatchObject({ nickname: 'すでにいる人', age_group: '40s', gender: 'female', height: 160 });
  });

  it('F6: POST /api/family/invites/{token}/accept は 200 を返し、プロフィールに family_id が入る', async () => {
    expect(await profileOf(newcomer2.id)).toBeNull();
    const token = await familyInviteToken(repB, famB, newcomer2.email);
    const res = await apiCall<{ data?: { family_id?: string; member_id?: string; role?: string } }>(
      'POST',
      `/api/family/invites/${token}/accept`,
      newcomer2.jwt,
      {},
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ family_id: famB, role: 'adult' });
    expect(res.body.data?.member_id).toMatch(UUID_RE);

    const { data: member } = await srAdmin
      .from('family_members')
      .select('id')
      .eq('user_id', newcomer2.id)
      .eq('status', 'active')
      .single();
    expect(res.body.data?.member_id).toBe((member as { id: string }).id);
    // 修正前は API が 200 を返すのに、プロフィール行が無く family_id も入らない
    expect(await profileOf(newcomer2.id)).toMatchObject({ family_id: famB, nickname: 'Guest' });
  }, 60_000);
});

describe('#1273 家族: 失敗する承諾はプロフィール行を残さない', () => {
  it('F7: メール不一致・使用済み・期限切れ・存在しない招待はエラーになり、プロフィール行も所属も作られない', async () => {
    expect(await profileOf(stranger.id)).toBeNull();

    // 宛先が別のメールアドレスの招待
    const forSomeoneElse = await familyInviteToken(repA, famA, `someone-else-${TS}@homegohan.test`);
    const mismatch = await asUser(stranger.jwt).rpc('accept_family_invite', { p_token: forSomeoneElse });
    expect(mismatch.error?.message).toContain('INVITE_EMAIL_MISMATCH');
    expect(await profileOf(stranger.id)).toBeNull();

    // 既に別の人が承諾した招待 (F1 の招待)。使用済みの判定はメールの照合より先
    const used = await asUser(stranger.jwt).rpc('accept_family_invite', { p_token: usedFamilyToken });
    expect(used.error?.message).toContain('INVITE_ALREADY_USED');
    expect(await profileOf(stranger.id)).toBeNull();

    // 期限切れの招待 (宛先は本人)
    const expiring = await familyInviteToken(repA, famA, stranger.email);
    const { error: expireError } = await srAdmin
      .from('family_invites')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('token', expiring);
    expect(expireError).toBeNull();
    const expired = await asUser(stranger.jwt).rpc('accept_family_invite', { p_token: expiring });
    expect(expired.error?.message).toContain('INVITE_EXPIRED');
    expect(await profileOf(stranger.id)).toBeNull();

    // 存在しない招待
    const missing = await asUser(stranger.jwt).rpc('accept_family_invite', { p_token: randomBytes(32).toString('hex') });
    expect(missing.error?.message).toContain('INVITE_NOT_FOUND');
    expect(await profileOf(stranger.id)).toBeNull();

    expect(await activeFamilyMembershipCount(stranger.id)).toBe(0);
    expect((await inviteRow('family_invites', forSomeoneElse)).status).toBe('pending');
  });

  it('F7b: 同じ人が同じ招待をもう一度承諾すると INVITE_ALREADY_USED で、プロフィールは変わらない', async () => {
    const before = await profileOf(newcomer.id);
    expect(before?.family_id).toBe(famA);
    const { error } = await asUser(newcomer.jwt).rpc('accept_family_invite', { p_token: usedFamilyToken });
    expect(error?.message).toContain('INVITE_ALREADY_USED');
    expect(await profileOf(newcomer.id)).toEqual(before);
    expect(await activeFamilyMembershipCount(newcomer.id)).toBe(1);
  });
});

describe('#1273 組織: 初期設定前 (プロフィール行なし) の招待承諾', () => {
  it('O1 (再現): プロフィール行が無い人が承諾すると、戻り値にも DB にも所属が入り、席・招待・監査ログが揃う', async () => {
    expect(await profileOf(orgNew1.id)).toBeNull();
    const usedBefore = await usedLicenses(orgA);

    const token = await orgInviteToken(ownerA, orgA, orgNew1.email, 'member');
    usedOrgToken = token;
    const { data, error } = await asUser(orgNew1.jwt).rpc('accept_org_invite', { p_token: token });
    expect(error).toBeNull();
    // 修正前は全列 NULL の行が返る (id も NULL)
    expect(data).toMatchObject({ id: orgNew1.id, organization_id: orgA, org_role: 'member' });

    expect(await profileOf(orgNew1.id)).toEqual({
      nickname: 'Guest',
      age_group: 'unspecified',
      gender: 'unspecified',
      family_id: null,
      organization_id: orgA,
      org_role: 'member',
      is_active_in_org: true,
      joined_org_at: expect.stringMatching(DATE_RE),
      onboarding_started_at: null,
      onboarding_completed_at: null,
    });
    expect(await usedLicenses(orgA)).toBe(usedBefore + 1);
    expect(await inviteRow('organization_invites', token)).toEqual({ status: 'accepted', accepted_by: orgNew1.id });
    const audit = await acceptedAudit('organization', orgA, orgNew1.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(orgNew1.id);
    expect(audit[0].metadata.role).toBe('member');
  });

  it('O2: POST /api/org/invites/{token}/accept (admin の招待) は organization_id と role を返す', async () => {
    expect(await profileOf(orgNew2.id)).toBeNull();
    const token = await orgInviteToken(ownerA, orgA, orgNew2.email, 'admin');
    const res = await apiCall('POST', `/api/org/invites/${token}/accept`, orgNew2.jwt);
    expect(res.status).toBe(200);
    // 修正前は { ok: true, organization_id: null, role: null }
    expect(res.body).toEqual({ ok: true, organization_id: orgA, role: 'admin' });
    expect(await profileOf(orgNew2.id)).toMatchObject({
      nickname: 'Guest',
      organization_id: orgA,
      org_role: 'admin',
      is_active_in_org: true,
    });
  }, 60_000);

  it('O3: 初期設定の保存のあとも所属は残り、本人が所属の列を消すことはできない', async () => {
    // O1 で承諾した人 (orgNew1) が、そのあと初期設定を始める
    const afterAccept = await profileOf(orgNew1.id);
    expect(afterAccept).toMatchObject({ organization_id: orgA, org_role: 'member', is_active_in_org: true });

    const saved = await apiCall('POST', '/api/onboarding/progress', orgNew1.jwt, {
      currentStep: 1,
      totalQuestions: 20,
      answers: { nickname: 'じろう', gender: 'male', age: '35' },
    });
    expect(saved.status).toBe(200);
    // 修正前は、この保存で初めてプロフィール行ができるが所属は入っていない
    expect(await profileOf(orgNew1.id)).toMatchObject({
      nickname: 'じろう',
      age_group: '30s',
      organization_id: orgA,
      org_role: 'member',
      is_active_in_org: true,
      joined_org_at: afterAccept?.joined_org_at,
      onboarding_completed_at: null,
    });

    const upserted = await asUser(orgNew1.jwt)
      .from('user_profiles')
      .upsert({ id: orgNew1.id, nickname: 'じろう2', age_group: '30s', gender: 'male' })
      .select('organization_id, org_role, is_active_in_org, nickname')
      .single();
    expect(upserted.error).toBeNull();
    expect(upserted.data).toEqual({ organization_id: orgA, org_role: 'member', is_active_in_org: true, nickname: 'じろう2' });

    const wipe = await asUser(orgNew1.jwt)
      .from('user_profiles')
      .update({ organization_id: null, org_role: null })
      .eq('id', orgNew1.id);
    expect(wipe.error?.code).toBe('42501');
    expect(await profileOf(orgNew1.id)).toMatchObject({ organization_id: orgA, org_role: 'member' });
  }, 60_000);

  it('O4: 席数超過 (SEAT_LIMIT_EXCEEDED) の承諾は、プロフィール行も招待の消化も席数の加算も残さない', async () => {
    expect(await profileOf(stranger.id)).toBeNull();
    // 招待の発行時には席に空きがあり、そのあとで席が埋まる (複数の招待を先に発行して全員が承諾した場合)
    const token = await orgInviteToken(ownerB, orgB, stranger.email, 'member');
    const { error: fillError } = await srAdmin.from('org_license_pools').update({ used_licenses: 1 }).eq('organization_id', orgB);
    expect(fillError).toBeNull();

    const { error } = await asUser(stranger.jwt).rpc('accept_org_invite', { p_token: token });
    expect(error?.message).toContain('SEAT_LIMIT_EXCEEDED');

    // 行を作ったあとに失敗しても、呼び出し全体が巻き戻る
    expect(await profileOf(stranger.id)).toBeNull();
    expect((await inviteRow('organization_invites', token)).status).toBe('pending');
    expect(await usedLicenses(orgB)).toBe(1);
    expect(await acceptedAudit('organization', orgB, stranger.id)).toHaveLength(0);
  });

  it('O4b: メール不一致・使用済み・期限切れ・存在しない招待も、プロフィール行を残さない', async () => {
    expect(await profileOf(stranger.id)).toBeNull();

    const forSomeoneElse = await orgInviteToken(ownerA, orgA, `someone-else-org-${TS}@homegohan.test`, 'member');
    const mismatch = await asUser(stranger.jwt).rpc('accept_org_invite', { p_token: forSomeoneElse });
    expect(mismatch.error?.message).toContain('INVITE_EMAIL_MISMATCH');
    expect(await profileOf(stranger.id)).toBeNull();

    // O1 で別の人が承諾した招待
    const used = await asUser(stranger.jwt).rpc('accept_org_invite', { p_token: usedOrgToken });
    expect(used.error?.message).toContain('INVITE_ALREADY_USED');
    expect(await profileOf(stranger.id)).toBeNull();

    const expiring = await orgInviteToken(ownerA, orgA, stranger.email, 'member');
    const { error: expireError } = await srAdmin
      .from('organization_invites')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('token', expiring);
    expect(expireError).toBeNull();
    const expired = await asUser(stranger.jwt).rpc('accept_org_invite', { p_token: expiring });
    expect(expired.error?.message).toContain('INVITE_EXPIRED');
    expect(await profileOf(stranger.id)).toBeNull();

    const missing = await asUser(stranger.jwt).rpc('accept_org_invite', { p_token: randomBytes(32).toString('hex') });
    expect(missing.error?.message).toContain('INVITE_NOT_FOUND');
    expect(await profileOf(stranger.id)).toBeNull();

    expect((await inviteRow('organization_invites', forSomeoneElse)).status).toBe('pending');
  });

  it('O5: プロフィール行がある人が承諾しても、書き換わるのは所属の 4 列だけ', async () => {
    const { error: seedError } = await srAdmin
      .from('user_profiles')
      .update({
        nickname: 'すでにいる組織の人',
        age_group: '50s',
        gender: 'male',
        onboarding_started_at: '2026-01-01T00:00:00Z',
        onboarding_completed_at: '2026-01-02T00:00:00Z',
        height: 172,
      })
      .eq('id', orgExisting.id);
    expect(seedError).toBeNull();
    const before = await fullProfileOf(orgExisting.id);
    expect(before).toMatchObject({ organization_id: null, org_role: null, is_active_in_org: false, joined_org_at: null });
    const usedBefore = await usedLicenses(orgA);

    const token = await orgInviteToken(ownerA, orgA, orgExisting.email, 'member');
    const { data, error } = await asUser(orgExisting.jwt).rpc('accept_org_invite', { p_token: token });
    expect(error).toBeNull();
    expect(data).toMatchObject({ id: orgExisting.id, organization_id: orgA, org_role: 'member' });

    const after = await fullProfileOf(orgExisting.id);
    expect(after).toEqual({
      ...before,
      organization_id: orgA,
      org_role: 'member',
      is_active_in_org: true,
      joined_org_at: expect.stringMatching(DATE_RE),
    });
    expect(after).toMatchObject({ nickname: 'すでにいる組織の人', age_group: '50s', gender: 'male', height: 172 });
    expect(await usedLicenses(orgA)).toBe(usedBefore + 1);
  });

  it('O5b: 既に別の組織に所属している人は ALREADY_IN_ORG になり、元の所属・席数・招待は変わらない', async () => {
    const before = await fullProfileOf(orgMember.id);
    expect(before).toMatchObject({ organization_id: orgB, org_role: 'member' });
    const usedBeforeA = await usedLicenses(orgA);

    const token = await orgInviteToken(ownerA, orgA, orgMember.email, 'member');
    const { error } = await asUser(orgMember.jwt).rpc('accept_org_invite', { p_token: token });
    expect(error?.message).toContain('ALREADY_IN_ORG');

    expect(await fullProfileOf(orgMember.id)).toEqual(before);
    expect((await inviteRow('organization_invites', token)).status).toBe('pending');
    expect(await usedLicenses(orgA)).toBe(usedBeforeA);
    expect(await acceptedAudit('organization', orgA, orgMember.id)).toHaveLength(0);
  });

  it('O6: 初期設定前に入った人も leave_org で抜けられ、席が戻る (修正前は所属が無く、席を解放する経路も無かった)', async () => {
    // O2 で承諾した人 (orgNew2)。プロフィールは承諾で作られた Guest の行
    expect(await profileOf(orgNew2.id)).toMatchObject({ nickname: 'Guest', organization_id: orgA, org_role: 'admin' });
    const usedBefore = await usedLicenses(orgA);

    const { error } = await asUser(orgNew2.jwt).rpc('leave_org');
    expect(error).toBeNull();
    expect(await profileOf(orgNew2.id)).toMatchObject({
      nickname: 'Guest',
      organization_id: null,
      org_role: null,
      is_active_in_org: false,
      joined_org_at: null,
    });
    expect(await usedLicenses(orgA)).toBe(usedBefore - 1);
  });

  it('O7: アカウント削除後の JWT での承諾は失敗し、孤児のプロフィール行も、招待・席数の消費も残さない', async () => {
    const ghost = await createUser('ghost', { withProfile: false });
    const token = await orgInviteToken(ownerA, orgA, ghost.email, 'member');
    const usedBefore = await usedLicenses(orgA);

    // アクセストークンは削除後も期限まで有効。auth.users に居ないので caller の email は NULL になり、
    // メールの照合 (lower(NULL) <> ...) は素通りする。それでも外部キー違反で呼び出し全体が巻き戻る
    // (修正前は招待の accepted_by、修正後はその前のプロフィールの INSERT (user_profiles_id_fkey) で失敗する。
    //  この確認は修正の前後で結果が変わらない)
    const { error: deleteError } = await srAdmin.auth.admin.deleteUser(ghost.id);
    expect(deleteError).toBeNull();

    const { error } = await asUser(ghost.jwt).rpc('accept_org_invite', { p_token: token });
    expect(error).not.toBeNull();
    expect(await profileOf(ghost.id)).toBeNull();
    expect((await inviteRow('organization_invites', token)).status).toBe('pending');
    expect(await usedLicenses(orgA)).toBe(usedBefore);
  });
});

describe('#1273 家族と組織の承諾が同時に走る場合', () => {
  it('X1: 同じ人が家族と組織の招待を同時に承諾しても、プロフィール行は 1 つで両方の所属が入る', async () => {
    expect(await profileOf(dual.id)).toBeNull();
    const familyToken = await familyInviteToken(repA, famA, dual.email);
    const orgToken = await orgInviteToken(ownerA, orgA, dual.email, 'member');

    // 行が無い状態で 2 つの INSERT ... ON CONFLICT (id) DO UPDATE が競合しても、片方が主キー違反にならず、
    // 片方の所属がもう片方に上書きされて消えることもない
    const [family, org] = await Promise.all([
      asUser(dual.jwt).rpc('accept_family_invite', { p_token: familyToken }),
      asUser(dual.jwt).rpc('accept_org_invite', { p_token: orgToken }),
    ]);
    expect(family.error).toBeNull();
    expect(org.error).toBeNull();

    expect(await profileOf(dual.id)).toEqual({
      nickname: 'Guest',
      age_group: 'unspecified',
      gender: 'unspecified',
      family_id: famA,
      organization_id: orgA,
      org_role: 'member',
      is_active_in_org: true,
      joined_org_at: expect.stringMatching(DATE_RE),
      onboarding_started_at: null,
      onboarding_completed_at: null,
    });
    const { count } = await srAdmin.from('user_profiles').select('id', { count: 'exact', head: true }).eq('id', dual.id);
    expect(count).toBe(1);
  });
});

describe('#1273 関数の属性と権限 (CREATE OR REPLACE で変わらない)', () => {
  it('F8: SECURITY DEFINER・search_path 固定・所有者 postgres。anon は実行できず、authenticated は実行できる', async () => {
    const rows = await pgQuery<{
      sig: string;
      anon_exec: boolean;
      auth_exec: boolean;
      sr_exec: boolean;
      secdef: boolean;
      config: string[] | null;
      owner: string;
    }>(`
      SELECT p.oid::regprocedure::text AS sig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
             p.prosecdef AS secdef,
             p.proconfig AS config,
             pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('accept_family_invite', 'accept_org_invite')
      ORDER BY 1
    `);
    expect(rows.map((r) => r.sig)).toEqual(['accept_family_invite(text,boolean,boolean,boolean)', 'accept_org_invite(text)']);
    for (const row of rows) {
      expect(row.secdef).toBe(true);
      expect(row.config).toContain('search_path=public');
      expect(row.owner).toBe('postgres');
      expect(row.anon_exec).toBe(false);
      expect(row.auth_exec).toBe(true);
    }
    // service_role の EXECUTE は本番の現行のまま (家族は有り、組織は無し)。migration は REVOKE / GRANT を流さない
    expect(Object.fromEntries(rows.map((r) => [r.sig, r.sr_exec]))).toEqual({
      'accept_family_invite(text,boolean,boolean,boolean)': true,
      'accept_org_invite(text)': false,
    });
  });

  it('F8b: anon は 2 つの承諾 RPC を呼べない', async () => {
    const family = await anon().rpc('accept_family_invite', { p_token: randomBytes(32).toString('hex') });
    expect(family.error?.code).toBe('42501');
    const org = await anon().rpc('accept_org_invite', { p_token: randomBytes(32).toString('hex') });
    expect(org.error?.code).toBe('42501');
  });
});
