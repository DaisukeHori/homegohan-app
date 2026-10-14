/**
 * 組織・家族の招待 RPC (create_org_invite / create_family_invite) が招待を作れることの回帰テスト
 *
 * 本番 (2026-10-06 のスナップショット) の 2 つの RPC は、招待トークンを encode(gen_random_bytes(32), 'hex') で作っていた。
 * gen_random_bytes は pgcrypto の関数で、Supabase では extensions スキーマにある。
 * 2 つの RPC は search_path を public に固定しているため解決できず、
 * `42883 function gen_random_bytes(integer) does not exist` で必ず失敗する
 * (Web の「メンバーを招待」(POST /api/org/invites) と家族の招待が 500 になる)。
 * 修正版 (20260511000134_fix_gen_random_bytes.sql、gen_random_uuid() でトークンを作る) は台帳上は適用済みだが、
 * 本番の関数本文は古いままだった。
 *
 * 期待する挙動 (修正後):
 *   - 組織の owner が create_org_invite で招待を作れる。トークンは 64 文字の 16 進数
 *   - 家族の代表者が create_family_invite で招待を作れる。トークンは 64 文字の 16 進数
 *   - POST /api/org/invites が 200 を返す
 *   - 権限の無いユーザーは従来どおり作れない (NOT_ORG_ADMIN / NOT_FAMILY_ADULT)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/invite-rpc-token.test.ts
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
  const email = `sec-invite-token-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `invite-token-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

let orgId = '';
let familyId = '';
let orgOwner: TestUser;
let orgMember: TestUser;
let familyRep: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  const { data: org, error: orgError } = await srAdmin
    .from('organizations')
    .insert({ name: `invite-token org ${TS}` })
    .select('id')
    .single();
  if (orgError || !org) throw new Error(`organizations: ${orgError?.message}`);
  orgId = org.id as string;

  [orgOwner, orgMember, familyRep, outsider] = await Promise.all([
    createUser('org-owner'),
    createUser('org-member'),
    createUser('family-rep'),
    createUser('outsider'),
  ]);
  for (const [u, role] of [
    [orgOwner, 'owner'],
    [orgMember, 'member'],
  ] as const) {
    const { error } = await srAdmin
      .from('user_profiles')
      .update({ organization_id: orgId, org_role: role, is_active_in_org: true })
      .eq('id', u.id);
    if (error) throw new Error(`membership: ${error.message}`);
  }

  const { data: family, error: familyError } = await srAdmin
    .from('family_groups')
    .insert({ name: `invite-token family ${TS}`, representative_id: familyRep.id })
    .select('id')
    .single();
  if (familyError || !family) throw new Error(`family_groups: ${familyError?.message}`);
  familyId = family.id as string;
  const { error: memberError } = await srAdmin
    .from('family_members')
    .insert({ family_id: familyId, user_id: familyRep.id, role: 'representative', status: 'active' });
  if (memberError) throw new Error(`family_members: ${memberError.message}`);
}, 60_000);

afterAll(async () => {
  if (orgId) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', orgId);
    await srAdmin.from('organization_invites').delete().eq('organization_id', orgId);
  }
  if (familyId) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', familyId);
    await srAdmin.from('family_groups').delete().eq('id', familyId); // family_members / family_invites は CASCADE
  }
  if (createdUserIds.length > 0) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .in('id', createdUserIds);
  }
  if (orgId) await srAdmin.from('organizations').delete().eq('id', orgId);
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

describe('招待 RPC がトークンを作れる', () => {
  it('T-1: 組織の owner は create_org_invite で招待を作れる (トークンは 64 文字の 16 進数)', async () => {
    const { data, error } = await asUser(orgOwner.jwt).rpc('create_org_invite', {
      p_organization_id: orgId,
      p_email: `invite-token-org-${TS}@homegohan.test`,
      p_role: 'member',
    });
    expect(error).toBeNull();
    expect((data as { token: string }).token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('T-2: 家族の代表者は create_family_invite で招待を作れる (トークンは 64 文字の 16 進数)', async () => {
    const { data, error } = await asUser(familyRep.jwt).rpc('create_family_invite', {
      p_family_id: familyId,
      p_email: `invite-token-family-${TS}@homegohan.test`,
    });
    expect(error).toBeNull();
    expect((data as { token: string }).token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('T-3: POST /api/org/invites (Web の「メンバーを招待」) は 200 で招待 URL を返す', async () => {
    const res = await apiCall('POST', '/api/org/invites', orgOwner.jwt, {
      email: `invite-token-api-${TS}@homegohan.test`,
      role: 'member',
    });
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; invite: { invite_url: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.invite.status).toBe('pending');
    expect(body.invite.invite_url).toMatch(/\/invite\/[0-9a-f]{64}$/);
  });

  it('T-4: 組織の一般メンバーは招待を作れない (NOT_ORG_ADMIN)', async () => {
    const { error } = await asUser(orgMember.jwt).rpc('create_org_invite', {
      p_organization_id: orgId,
      p_email: `invite-token-by-member-${TS}@homegohan.test`,
      p_role: 'member',
    });
    expect(error?.message).toContain('NOT_ORG_ADMIN');
  });

  it('T-5: 家族に所属していないユーザーは家族の招待を作れない (NOT_FAMILY_ADULT)', async () => {
    const { error } = await asUser(outsider.jwt).rpc('create_family_invite', {
      p_family_id: familyId,
      p_email: `invite-token-by-outsider-${TS}@homegohan.test`,
    });
    expect(error?.message).toContain('NOT_FAMILY_ADULT');
  });
});
