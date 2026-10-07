/**
 * #1235 (第2段) POST /api/org/members (モバイルの「メンバー追加」) を招待メール方式にすることの回帰テスト
 *
 * 修正前の POST /api/org/members は、組織の owner / admin が指定したメールアドレスとパスワードで
 * 「メール確認済み」の auth ユーザーを作っていた (auth.admin.createUser の email_confirm: true)。
 * その後のプロフィール作成は制約違反 (org_role 欠落・年代 / 性別の NOT NULL) で失敗して 500 を返すが、
 * アカウントだけは残り、管理者が決めたパスワードでログインできた。
 * メールの持ち主の確認無しに使えるアカウントを作れることは、アカウント事前乗っ取り (pre-hijacking) の原因になる。
 *
 * 2026-10-07 のオーナー判断「招待メール方式に直す」:
 *   - アカウントは作らない (パスワードは受け取っても使わない)
 *   - Web の「メンバーを招待」と同じ組織招待 (create_org_invite + 招待メール) を送る。役割は member
 *   - 招待された本人が、自分のメールで確認したアカウントで招待を承諾して組織に入る
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-members-invite.test.ts
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
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = 'TestPass!2026-sec';
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-members-invite-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `invite-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

/** そのメールアドレスの auth ユーザーがいれば id を返す (後片付け用にも記録する) */
async function findAuthUserId(email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await srAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) {
      if (!createdUserIds.includes(found.id)) createdUserIds.push(found.id);
      return found.id;
    }
    if (data.users.length < 200) return null;
  }
  return null;
}

let orgA = '';
let owner: TestUser; // 組織 A の owner
let member: TestUser; // 組織 A の一般メンバー
let existing: TestUser; // どこにも所属していない既存ユーザー

const NEW_EMAIL = `sec-members-invite-new-${TS}@homegohan.test`;
const ADMIN_CHOSEN_PASSWORD = 'Chosen-by-admin-2026!';

beforeAll(async () => {
  const { data: org, error: orgError } = await srAdmin
    .from('organizations')
    .insert({ name: `#1235 members invite ${TS}` })
    .select('id')
    .single();
  if (orgError || !org) throw new Error(`organizations: ${orgError?.message}`);
  orgA = org.id as string;

  [owner, member, existing] = await Promise.all([createUser('owner'), createUser('member'), createUser('existing')]);
  for (const [u, role] of [
    [owner, 'owner'],
    [member, 'member'],
  ] as const) {
    const { error } = await srAdmin
      .from('user_profiles')
      .update({ organization_id: orgA, org_role: role, is_active_in_org: true })
      .eq('id', u.id);
    if (error) throw new Error(`membership: ${error.message}`);
  }
}, 60_000);

afterAll(async () => {
  await findAuthUserId(NEW_EMAIL); // 修正前のコードで作られたアカウントも後片付けの対象にする
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .in('id', createdUserIds);
  }
  if (orgA) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', orgA);
    await srAdmin.from('organization_invites').delete().eq('organization_id', orgA);
    await srAdmin.from('organizations').delete().eq('id', orgA);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

async function pendingInvite(email: string) {
  const { data, error } = await srAdmin
    .from('organization_invites')
    .select('id, token, invited_role, status, invited_by')
    .eq('organization_id', orgA)
    .eq('email', email.toLowerCase())
    .eq('status', 'pending');
  if (error) throw new Error(`organization_invites: ${error.message}`);
  return data ?? [];
}

describe('#1235 POST /api/org/members は招待メールを送る', () => {
  it('I-1: 新しいメールアドレス: 成功し、組織 A への member 招待 (pending) ができる', async () => {
    const res = await apiCall('POST', '/api/org/members', owner.jwt, {
      email: NEW_EMAIL,
      password: ADMIN_CHOSEN_PASSWORD,
      nickname: '新しいメンバー',
    });
    expect(res.status).toBe(201);
    const body = res.body as { ok: boolean; invite: { email: string; role: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.invite).toMatchObject({ email: NEW_EMAIL.toLowerCase(), role: 'member', status: 'pending' });

    const invites = await pendingInvite(NEW_EMAIL);
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ invited_role: 'member', invited_by: owner.id });
  });

  it('I-2: アカウントは作られず、管理者が決めたパスワードではログインできない', async () => {
    expect(await findAuthUserId(NEW_EMAIL)).toBeNull();
    const signIn = await anon().auth.signInWithPassword({ email: NEW_EMAIL, password: ADMIN_CHOSEN_PASSWORD });
    expect(signIn.data.session).toBeNull();
    expect(signIn.error).not.toBeNull();
  });

  it('I-3: 招待された本人が自分で確認したアカウントで承諾すると、組織 A の member になる', async () => {
    const { data: created, error } = await srAdmin.auth.admin.createUser({
      email: NEW_EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    expect(error).toBeNull();
    createdUserIds.push(created.user!.id);
    await srAdmin
      .from('user_profiles')
      .upsert({ id: created.user!.id, nickname: 'invitee', age_group: '30s', gender: 'other' }, { onConflict: 'id' });
    const signIn = await anon().auth.signInWithPassword({ email: NEW_EMAIL, password: PASSWORD });
    expect(signIn.error).toBeNull();

    const [invite] = await pendingInvite(NEW_EMAIL);
    const { error: acceptError } = await asUser(signIn.data.session!.access_token).rpc('accept_org_invite', {
      p_token: invite.token,
    });
    expect(acceptError).toBeNull();
    const { data: profile } = await srAdmin
      .from('user_profiles')
      .select('organization_id, org_role')
      .eq('id', created.user!.id)
      .single();
    expect(profile).toEqual({ organization_id: orgA, org_role: 'member' });
  });

  it('I-4: 既存ユーザーのメールアドレス: 成功し、招待ができる。既存アカウントのパスワードは変わらない', async () => {
    const res = await apiCall('POST', '/api/org/members', owner.jwt, {
      email: existing.email,
      password: ADMIN_CHOSEN_PASSWORD,
      nickname: '既存ユーザー',
    });
    expect(res.status).toBe(201);
    expect(await pendingInvite(existing.email)).toHaveLength(1);

    const withAdminPassword = await anon().auth.signInWithPassword({
      email: existing.email,
      password: ADMIN_CHOSEN_PASSWORD,
    });
    expect(withAdminPassword.data.session).toBeNull();
    const withOwnPassword = await anon().auth.signInWithPassword({ email: existing.email, password: PASSWORD });
    expect(withOwnPassword.error).toBeNull();
  });

  it('I-5: メールアドレスが無ければ 400', async () => {
    const res = await apiCall('POST', '/api/org/members', owner.jwt, { nickname: 'no email' });
    expect(res.status).toBe(400);
  });

  it('I-6: 一般メンバーは 403 で、招待は作られない', async () => {
    const email = `sec-members-invite-by-member-${TS}@homegohan.test`;
    const res = await apiCall('POST', '/api/org/members', member.jwt, { email, nickname: 'x' });
    expect(res.status).toBe(403);
    expect(await pendingInvite(email)).toHaveLength(0);
    expect(await findAuthUserId(email)).toBeNull();
  });
});
