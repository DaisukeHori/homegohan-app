/**
 * #1235 (第1段) 組織の管理者判定を org_role に一本化することの回帰テスト
 *
 * 修正前は、組織管理 API 5 本 (settings / stats / members / challenges / departments) と
 * 組織テーブル 5 つの RLS が roles 配列の 'org_admin' で管理者を判定していた。
 * 'org_admin' はどの組織で付与されたかを区別せず、脱退・除名でも消えないため、
 * 別組織で管理者だったユーザーが無関係な組織に一般メンバーとして加入しただけで、
 * その組織の設定・部署・招待 (admin 招待の発行を含む)・統計を操作できた。
 * 逆に、招待で org_role = owner / admin になったユーザーは 'org_admin' を持たないため使えなかった。
 *
 * 期待する挙動 (修正後):
 *   - 管理者は「同じ組織で org_role が owner / admin」のユーザーだけ (roles の 'org_admin' は見ない)
 *   - 運営のグローバル admin / super_admin が自組織のテーブルを直接操作できる点は第2段まで現状維持
 *
 * API ルート (Bearer JWT) と PostgREST 直叩きの両方で検証する。
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next dev サーバ (npm run dev) が起動済み。
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-admin-tenant-scope.test.ts
 */

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

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-orgadmin-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `sec-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** 所属と roles を service_role で設定する (特権列は本人の JWT では変更できない) */
async function setMembership(
  userId: string,
  orgId: string | null,
  orgRole: 'owner' | 'admin' | 'member' | null,
  roles: string[],
) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgRole, is_active_in_org: orgId !== null, roles })
    .eq('id', userId);
  if (error) throw new Error(`setMembership: ${error.message}`);
}

let orgA = '';
let orgB = '';
let challengeId = '';
let inviteId = '';

let residual: TestUser; // かつて別組織で org_admin。今は B の一般メンバー (roles に 'org_admin' が残存)
let invitedAdmin: TestUser; // 招待で B の admin になった新方式の管理者 (roles に 'org_admin' なし)
let legacyOwner: TestUser; // B の owner で roles にも 'org_admin' がある従来形
let member: TestUser; // B の一般メンバー
let otherOrgAdmin: TestUser; // A の admin (B に対しては部外者)
let globalAdmin: TestUser; // 運営のグローバル admin で、B に一般メンバーとして所属

beforeAll(async () => {
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([{ name: `#1235 Org A ${TS}` }, { name: `#1235 Org B ${TS}` }])
    .select('id, name');
  if (orgError || !orgs) throw new Error(`organizations: ${orgError?.message}`);
  orgA = orgs.find((o) => o.name.startsWith('#1235 Org A'))!.id;
  orgB = orgs.find((o) => o.name.startsWith('#1235 Org B'))!.id;

  [residual, invitedAdmin, legacyOwner, member, otherOrgAdmin, globalAdmin] = await Promise.all([
    createUser('residual'),
    createUser('invited-admin'),
    createUser('legacy-owner'),
    createUser('member'),
    createUser('other-org-admin'),
    createUser('global-admin'),
  ]);

  await setMembership(residual.id, orgB, 'member', ['user', 'org_admin']);
  await setMembership(invitedAdmin.id, orgB, 'admin', ['user']);
  await setMembership(legacyOwner.id, orgB, 'owner', ['user', 'org_admin']);
  await setMembership(member.id, orgB, 'member', ['user']);
  await setMembership(otherOrgAdmin.id, orgA, 'admin', ['user', 'org_admin']);
  await setMembership(globalAdmin.id, orgB, 'member', ['user', 'admin']);

  // B の既存データ (service_role で用意)
  const { data: challenge, error: challengeError } = await srAdmin
    .from('organization_challenges')
    .insert({
      organization_id: orgB,
      title: 'B challenge',
      challenge_type: 'custom',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    })
    .select('id')
    .single();
  if (challengeError || !challenge) throw new Error(`organization_challenges: ${challengeError?.message}`);
  challengeId = challenge.id;

  const { error: statsError } = await srAdmin
    .from('org_daily_stats')
    .insert({ organization_id: orgB, date: '2026-10-01', member_count: 4 });
  if (statsError) throw new Error(`org_daily_stats: ${statsError.message}`);

  const { data: invite, error: inviteError } = await srAdmin
    .from('organization_invites')
    .insert({
      organization_id: orgB,
      email: `sec-orgadmin-invitee-${TS}@homegohan.test`,
      token: `sec-orgadmin-invite-${TS}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      invited_by: legacyOwner.id,
    })
    .select('id')
    .single();
  if (inviteError || !invite) throw new Error(`organization_invites: ${inviteError?.message}`);
  inviteId = invite.id;
}, 120_000);

afterAll(async () => {
  // 子テーブルは organizations の削除で CASCADE される。所属は先に外す (owner_id 等の参照に備える)
  for (const id of createdUserIds) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .eq('id', id);
  }
  await srAdmin.from('admin_audit_logs').delete().in('actor_id', createdUserIds);
  if (orgA || orgB) await srAdmin.from('organizations').delete().in('id', [orgA, orgB].filter(Boolean));
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

async function departmentNames(orgId: string): Promise<string[]> {
  const { data } = await srAdmin.from('departments').select('name').eq('organization_id', orgId);
  return (data ?? []).map((d) => d.name as string);
}

// ================================================================
// RLS (PostgREST 直叩き)
// ================================================================
describe('#1235 RLS: 残存した org_admin だけでは組織テーブルを操作できない', () => {
  it('departments に INSERT できない', async () => {
    const { error } = await asUser(residual.jwt)
      .from('departments')
      .insert({ organization_id: orgB, name: `residual-dept-${TS}` });
    expect(error).not.toBeNull();
    expect(await departmentNames(orgB)).not.toContain(`residual-dept-${TS}`);
  });

  it('admin 招待を発行できない (承諾されると正規の org_role = admin に昇格できてしまう)', async () => {
    const email = `sec-orgadmin-accomplice-${TS}@homegohan.test`;
    const { error } = await asUser(residual.jwt)
      .from('organization_invites')
      .insert({
        organization_id: orgB,
        email,
        role: 'admin',
        invited_role: 'admin',
        token: `sec-orgadmin-residual-${TS}`,
        expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        invited_by: residual.id,
      });
    expect(error).not.toBeNull();
    const { data } = await srAdmin.from('organization_invites').select('id').eq('email', email);
    expect(data ?? []).toHaveLength(0);
  });

  it('既存の招待を取り消せない (DELETE)', async () => {
    await asUser(residual.jwt).from('organization_invites').delete().eq('id', inviteId);
    const { data } = await srAdmin.from('organization_invites').select('id').eq('id', inviteId);
    expect(data ?? []).toHaveLength(1);
  });

  it('チャレンジを書き換えられない (UPDATE)', async () => {
    await asUser(residual.jwt)
      .from('organization_challenges')
      .update({ title: 'hijacked by residual' })
      .eq('id', challengeId);
    const { data } = await srAdmin.from('organization_challenges').select('title').eq('id', challengeId).single();
    expect(data?.title).toBe('B challenge');
  });

  it('組織の統計 (org_daily_stats) を読めない', async () => {
    const { data } = await asUser(residual.jwt).from('org_daily_stats').select('id').eq('organization_id', orgB);
    expect(data ?? []).toHaveLength(0);
  });

  it('組織レポートを作れない', async () => {
    const { error } = await asUser(residual.jwt).from('organization_reports').insert({
      organization_id: orgB,
      report_type: 'weekly',
      period_start: '2026-10-01',
      period_end: '2026-10-07',
      data: {},
    });
    expect(error).not.toBeNull();
  });

  it('運営の監査ログ (admin_audit_logs) に書き込めない', async () => {
    const { error } = await asUser(residual.jwt)
      .from('admin_audit_logs')
      .insert({ actor_id: residual.id, action_type: 'forged.by.org_admin' });
    expect(error).not.toBeNull();
    const { data } = await srAdmin.from('admin_audit_logs').select('id').eq('action_type', 'forged.by.org_admin');
    expect(data ?? []).toHaveLength(0);
  });
});

describe('#1235 RLS: 同じ組織の org_role = owner / admin だけが管理者として操作できる', () => {
  it('招待で admin になったユーザー (org_admin なし) は部署を作れる', async () => {
    const name = `invited-admin-dept-${TS}`;
    const { error } = await asUser(invitedAdmin.jwt).from('departments').insert({ organization_id: orgB, name });
    expect(error).toBeNull();
    expect(await departmentNames(orgB)).toContain(name);
  });

  it('招待で admin になったユーザーは統計を読める', async () => {
    const { data } = await asUser(invitedAdmin.jwt).from('org_daily_stats').select('id').eq('organization_id', orgB);
    expect(data ?? []).toHaveLength(1);
  });

  it('従来形の owner (org_admin あり) も引き続き部署を作れる', async () => {
    const name = `legacy-owner-dept-${TS}`;
    const { error } = await asUser(legacyOwner.jwt).from('departments').insert({ organization_id: orgB, name });
    expect(error).toBeNull();
    expect(await departmentNames(orgB)).toContain(name);
  });

  it('一般メンバーは部署を作れない', async () => {
    const { error } = await asUser(member.jwt)
      .from('departments')
      .insert({ organization_id: orgB, name: `member-dept-${TS}` });
    expect(error).not.toBeNull();
  });

  it('別組織の admin は B の部署を作れない', async () => {
    const { error } = await asUser(otherOrgAdmin.jwt)
      .from('departments')
      .insert({ organization_id: orgB, name: `other-org-dept-${TS}` });
    expect(error).not.toBeNull();
    expect(await departmentNames(orgB)).not.toContain(`other-org-dept-${TS}`);
  });

  it('運営のグローバル admin は自組織のテーブルを直接操作できる (第2段まで現状維持)', async () => {
    const name = `global-admin-dept-${TS}`;
    const { error } = await asUser(globalAdmin.jwt).from('departments').insert({ organization_id: orgB, name });
    expect(error).toBeNull();
  });

  it('招待で admin になったユーザーは招待を取り消せる (DELETE)', async () => {
    const { data: invite } = await srAdmin
      .from('organization_invites')
      .insert({
        organization_id: orgB,
        email: `sec-orgadmin-revoke-${TS}@homegohan.test`,
        token: `sec-orgadmin-revoke-${TS}`,
        expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        invited_by: invitedAdmin.id,
      })
      .select('id')
      .single();
    await asUser(invitedAdmin.jwt).from('organization_invites').delete().eq('id', invite!.id);
    const { data } = await srAdmin.from('organization_invites').select('id').eq('id', invite!.id);
    expect(data ?? []).toHaveLength(0);
  });
});

// ================================================================
// API ルート (Bearer JWT)
// ================================================================
type ErrorBody = { error?: { code?: string } | string };

describe('#1235 API: 組織管理 API は同じ組織の org_role = owner / admin だけが使える', () => {
  const readEndpoints = ['/api/org/settings', '/api/org/stats', '/api/org/members', '/api/org/challenges'];

  for (const path of readEndpoints) {
    it(`残存した org_admin だけのユーザーは GET ${path} で 403`, async () => {
      const res = await apiCall<ErrorBody>('GET', path, residual.jwt);
      expect(res.status).toBe(403);
    });

    it(`招待で admin になったユーザーは GET ${path} で 200`, async () => {
      const res = await apiCall('GET', path, invitedAdmin.jwt);
      expect(res.status).toBe(200);
    });
  }

  it('残存した org_admin だけのユーザーは GET /api/org/departments で 403', async () => {
    const res = await apiCall<ErrorBody>('GET', '/api/org/departments', residual.jwt);
    expect(res.status).toBe(403);
  });

  it('招待で admin になったユーザーは /api/org/departments の認可を通過する', async () => {
    // 部署 API は存在しないテーブル organization_departments を参照する既存の別不具合があり
    // (#1235 の設計 v2 F-5、別 PR で修正)、認可を通過した後に失敗する。ここでは認可だけを確認する
    const res = await apiCall('GET', '/api/org/departments', invitedAdmin.jwt);
    expect(res.status).not.toBe(403);
  });

  it('残存した org_admin だけのユーザーは組織名を変更できない (PUT /api/org/settings)', async () => {
    const res = await apiCall('PUT', '/api/org/settings', residual.jwt, { name: 'hijacked by residual' });
    expect(res.status).toBe(403);
    const { data } = await srAdmin.from('organizations').select('name').eq('id', orgB).single();
    expect(data?.name).toBe(`#1235 Org B ${TS}`);
  });

  it('残存した org_admin だけのユーザーはチャレンジを作れない (POST /api/org/challenges)', async () => {
    const res = await apiCall('POST', '/api/org/challenges', residual.jwt, {
      title: 'residual challenge',
      challengeType: 'custom',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    });
    expect(res.status).toBe(403);
  });

  it('従来形の owner (org_admin あり) は引き続き GET /api/org/settings で 200', async () => {
    const res = await apiCall('GET', '/api/org/settings', legacyOwner.jwt);
    expect(res.status).toBe(200);
  });

  it('一般メンバーは GET /api/org/settings で 403', async () => {
    const res = await apiCall('GET', '/api/org/settings', member.jwt);
    expect(res.status).toBe(403);
  });

  it('運営のグローバル admin でも org_role が member なら組織管理 API は 403', async () => {
    const res = await apiCall('GET', '/api/org/settings', globalAdmin.jwt);
    expect(res.status).toBe(403);
  });
});
