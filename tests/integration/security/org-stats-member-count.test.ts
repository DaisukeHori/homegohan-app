/**
 * #1325 GET /api/org/stats の member_count が、組織の実際の人数になることの回帰テスト
 *
 * 組織ダッシュボードの「Total Members」は、GET /api/org/stats の member_count を表示する。
 * user_profiles の SELECT ポリシーは「本人の行だけ」(Users can view own profile) で、
 * 組織の管理者が使える、他のメンバーの行を読むポリシーは無い。
 * 以前の route は利用者本人の権限で数えていたため、組織に何人いても、管理者自身の 1 になっていた。
 * 修正後は、認可 (requireOrgAdmin) を通したあとに service_role で、呼び出した管理者の所属組織だけを数える。
 *
 * 確認すること:
 *   A. 前提: 管理者本人の権限で数えると 1、service_role なら実際の人数 (RLS が本人の行しか見せないこと)
 *   B. GET /api/org/stats の member_count は実際の人数。ほかの組織の人数は混ざらない
 *   C. 一般メンバーは 403 で、人数は返らない
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next dev サーバ (npm run dev) が起動済み。
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-stats-member-count.test.ts
 * dev サーバが localhost:3000 以外のときは INTEGRATION_BASE_URL で指定する。本番には接続しない。
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
let orgA = '';
let orgB = '';

let adminA: TestUser; // 組織 A の管理者
let memberA1: TestUser; // 組織 A の一般メンバー
let memberA2: TestUser;
let adminB: TestUser; // 別の組織 B の管理者 (組織 B は 2 人)
let memberB1: TestUser;

async function createMember(
  label: string,
  orgId: string,
  orgRole: 'owner' | 'admin' | 'member',
): Promise<TestUser> {
  const email = `sec-orgstats-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `sec-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);

  // 所属は特権列なので service_role で設定する (本人の JWT では変更できない)
  const { error: membershipError } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgRole, is_active_in_org: true })
    .eq('id', data.user.id);
  if (membershipError) throw new Error(`membership ${label}: ${membershipError.message}`);

  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

beforeAll(async () => {
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([{ name: `#1325 Org A ${TS}` }, { name: `#1325 Org B ${TS}` }])
    .select('id, name');
  if (orgError || !orgs) throw new Error(`organizations: ${orgError?.message}`);
  orgA = orgs.find((o) => o.name.startsWith('#1325 Org A'))!.id;
  orgB = orgs.find((o) => o.name.startsWith('#1325 Org B'))!.id;

  adminA = await createMember('admin-a', orgA, 'admin');
  memberA1 = await createMember('member-a1', orgA, 'member');
  memberA2 = await createMember('member-a2', orgA, 'member');
  adminB = await createMember('admin-b', orgB, 'owner');
  memberB1 = await createMember('member-b1', orgB, 'member');
}, 120_000);

afterAll(async () => {
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

async function countMembers(supabase: SupabaseClient, orgId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from('user_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId);
  if (error) throw new Error(`count: ${error.message}`);
  return count;
}

type StatsBody = { stats?: { member_count?: number; organization_id?: string } };

describe('#1325 A. 前提: 利用者本人の権限では、組織の人数を数えられない', () => {
  it('組織の管理者が自分の権限で数えると 1 (自分だけ)。service_role なら実際の人数', async () => {
    expect(await countMembers(asUser(adminA.jwt), orgA)).toBe(1);
    expect(await countMembers(srAdmin, orgA)).toBe(3);
    expect(await countMembers(srAdmin, orgB)).toBe(2);
  });
});

describe('#1325 B. GET /api/org/stats の member_count は組織の実際の人数', () => {
  it('組織 A の管理者には、組織 A の人数 (3) が返る', async () => {
    const res = await apiCall<StatsBody>('GET', '/api/org/stats', adminA.jwt);

    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({ member_count: 3, organization_id: orgA });
  });

  it('別の組織 B の管理者には、組織 B の人数 (2) が返る。組織 A の人数は混ざらない', async () => {
    const res = await apiCall<StatsBody>('GET', '/api/org/stats', adminB.jwt);

    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({ member_count: 2, organization_id: orgB });
  });

  it('メンバーが増えれば、人数も増える', async () => {
    const extra = await createMember('member-a3', orgA, 'member');
    expect(extra.id).toBeTruthy();

    const res = await apiCall<StatsBody>('GET', '/api/org/stats', adminA.jwt);

    expect(res.status).toBe(200);
    expect(res.body.stats?.member_count).toBe(4);
  });
});

describe('#1325 C. 組織の管理者でない人には人数を返さない', () => {
  it('一般メンバーは 403', async () => {
    for (const member of [memberA1, memberA2, memberB1]) {
      const res = await apiCall<StatsBody>('GET', '/api/org/stats', member.jwt);

      expect(res.status).toBe(403);
      expect(res.body.stats).toBeUndefined();
    }
  });

  it('未ログインは 401', async () => {
    const res = await apiCall<StatsBody>('GET', '/api/org/stats', null);

    expect(res.status).toBe(401);
    expect(res.body.stats).toBeUndefined();
  });
});
