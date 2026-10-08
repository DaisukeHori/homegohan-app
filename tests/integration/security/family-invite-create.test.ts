/**
 * 家族の招待の作成 POST /api/family/invites (実際の API と DB での回帰テスト)
 *
 * 修正前は、招待者のプロフィールを読む select に user_profiles に存在しない列 (display_name) が入っていた。
 * PostgREST は存在しない列を含む select を 42703 で失敗させるため、プロフィールが null になり、
 * 家族の代表者を含む全員が 403 NOT_FAMILY_ADULT になっていた (本番で家族の招待が一切作れない)。
 * 単体テストは Supabase をモックしていて列の有無を見ないため、この不具合を検出できなかった。
 *
 * ここでは実際の Next サーバーと実 DB の組み合わせで、次を確かめる。
 *   F-1: 家族の代表者は招待を作れる (201)。招待の行が pending で 1 件でき、応答の招待 ID と一致する
 *   F-2: 家族に入っていない人は、その家族の招待を作れない (403 NOT_FAMILY_ADULT。修正後も変わらない)
 *   F-3: 別の家族の代表者は、他の家族の招待を作れない (403 NOT_FAMILY_ADULT)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/family-invite-create.test.ts
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

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

interface TestFamily {
  rep: TestUser;
  familyId: string;
}

interface CreateInviteBody {
  data?: { invite?: { id?: string; token?: string }; invite_url?: string };
  error?: { code?: string; message?: string };
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];

/** 宛先ごとに一意なメールアドレス (実行ごとに変わる) */
const recipient = (label: string) => `fam-invite-${label}-${TS}@homegohan.test`;

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-fam-invite-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `fam-invite-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

async function createFamily(label: string): Promise<TestFamily> {
  const rep = await createUser(`rep-${label}`);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `family-invite-create ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  return { rep, familyId };
}

async function familyInviteRows(familyId: string, email: string) {
  const { data, error } = await srAdmin
    .from('family_invites')
    .select('id, family_id, email, status')
    .eq('family_id', familyId)
    .eq('email', email.toLowerCase());
  if (error) throw new Error(`family_invites: ${error.message}`);
  return (data ?? []) as Array<{ id: string; family_id: string; email: string; status: string }>;
}

let famA: TestFamily;
let famB: TestFamily;
let outsider: TestUser;

beforeAll(async () => {
  famA = await createFamily('a');
  famB = await createFamily('b');
  outsider = await createUser('outsider');
}, 60_000);

afterAll(async () => {
  for (const id of createdFamilyIds) {
    await srAdmin.from('family_invites').delete().eq('family_id', id);
  }
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin.from('user_profiles').update({ family_id: null }).in('id', createdUserIds);
  }
  for (const id of createdFamilyIds) {
    await srAdmin.from('family_members').delete().eq('family_id', id);
    await srAdmin.from('family_groups').delete().eq('id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

describe('POST /api/family/invites: 家族の代表者が招待を作れる', () => {
  it('F-1: 代表者の招待は 201。招待の行が pending で 1 件でき、応答の招待 ID と一致する', async () => {
    const email = recipient('a-1');
    const res = await apiCall<CreateInviteBody>('POST', '/api/family/invites', famA.rep.jwt, {
      family_id: famA.familyId,
      email,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const inviteId = res.body.data?.invite?.id;
    expect(typeof inviteId).toBe('string');
    expect(res.body.data?.invite_url).toEqual(expect.any(String));

    const rows = await familyInviteRows(famA.familyId, email);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(inviteId);
    expect(rows[0].status).toBe('pending');
  }, 30_000);
});

describe('POST /api/family/invites: 家族の外からは招待を作れない (修正後も変わらない)', () => {
  it('F-2: 家族に入っていない人は 403 NOT_FAMILY_ADULT。招待の行はできない', async () => {
    const email = recipient('outsider');
    const res = await apiCall<CreateInviteBody>('POST', '/api/family/invites', outsider.jwt, {
      family_id: famA.familyId,
      email,
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('NOT_FAMILY_ADULT');
    expect(await familyInviteRows(famA.familyId, email)).toHaveLength(0);
  }, 30_000);

  it('F-3: 別の家族の代表者は、他の家族の招待を作れない (403 NOT_FAMILY_ADULT)', async () => {
    const email = recipient('cross');
    const res = await apiCall<CreateInviteBody>('POST', '/api/family/invites', famB.rep.jwt, {
      family_id: famA.familyId,
      email,
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('NOT_FAMILY_ADULT');
    expect(await familyInviteRows(famA.familyId, email)).toHaveLength(0);
  }, 30_000);
});
