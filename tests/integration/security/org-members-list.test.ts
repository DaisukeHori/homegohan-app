/**
 * GET /api/org/members が、組織の管理者に自組織のメンバー全員を返すことの回帰テスト
 *
 * user_profiles の SELECT ポリシーは「本人の行だけ」(Users can view own profile) で、
 * 組織の管理者が使える、他のメンバーの行を読むポリシーは無い。
 * 以前の route は利用者本人の権限で読んでいたため、組織に何人いても、管理者自身の 1 行しか返らなかった
 * (Web の組織メンバー一覧・モバイルのメンバー画面が「自分だけ」になる)。
 * 修正後は、認可 (requireOrgAdmin) を通したあとに service_role で、呼び出した管理者の所属組織だけを読む。
 *
 * 確認すること:
 *   A. 前提: 管理者本人の権限で組織のメンバーを読むと 1 行 (自分だけ)。service_role なら全員 (RLS が本人の行しか見せないこと)
 *   B. GET /api/org/members は自組織のメンバー全員 (2 人以上) を返し、ほかの組織の人は混ざらない。返す列は限定されている
 *   C. 一般メンバーは 403 で、メンバーは返らない。未ログインは 401
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next dev サーバ (npm run dev) が起動済み。
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-members-list.test.ts
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
const JOINED_AT = '2026-10-01';
const createdUserIds: string[] = [];
let orgA = '';
let orgB = '';

let ownerA: TestUser; // 組織 A のオーナー
let adminA: TestUser; // 組織 A の管理者
let memberA1: TestUser; // 組織 A の一般メンバー
let memberA2: TestUser;
let ownerB: TestUser; // 別の組織 B のオーナー (組織 B は 2 人)
let memberB1: TestUser;
let outsider: TestUser; // どの組織にも所属しない一般ユーザー

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-orgmem-${label}-${TS}@homegohan.test`;
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

async function createMember(
  label: string,
  orgId: string,
  orgRole: 'owner' | 'admin' | 'member',
): Promise<TestUser> {
  const user = await createUser(label);
  // 所属は特権列なので service_role で設定する (本人の JWT では変更できない)
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgRole, is_active_in_org: true, joined_org_at: JOINED_AT })
    .eq('id', user.id);
  if (error) throw new Error(`membership ${label}: ${error.message}`);
  return user;
}

beforeAll(async () => {
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([{ name: `org-members-list Org A ${TS}` }, { name: `org-members-list Org B ${TS}` }])
    .select('id, name');
  if (orgError || !orgs) throw new Error(`organizations: ${orgError?.message}`);
  orgA = orgs.find((o) => o.name.startsWith('org-members-list Org A'))!.id;
  orgB = orgs.find((o) => o.name.startsWith('org-members-list Org B'))!.id;

  ownerA = await createMember('owner-a', orgA, 'owner');
  adminA = await createMember('admin-a', orgA, 'admin');
  memberA1 = await createMember('member-a1', orgA, 'member');
  memberA2 = await createMember('member-a2', orgA, 'member');
  ownerB = await createMember('owner-b', orgB, 'owner');
  memberB1 = await createMember('member-b1', orgB, 'member');
  outsider = await createUser('outsider');

  // next dev は API ルートを初回リクエスト時にコンパイルする。最初のテストが 30 秒のタイムアウトに近づかないよう、
  // 認証なしで 1 回呼んで先にコンパイルさせておく (副作用なし。結果は見ない)
  await apiCall('GET', '/api/org/members', null).catch(() => undefined);
}, 180_000);

afterAll(async () => {
  // 所属は先に外す (user_profiles_org_consistency: organization_id と org_role は両方 NULL か両方あるか。
  // 組織の削除は organization_id を NULL に戻すので、org_role が残っていると制約に反する)
  for (const id of createdUserIds) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false, joined_org_at: null })
      .eq('id', id);
  }
  if (orgA || orgB) await srAdmin.from('organizations').delete().in('id', [orgA, orgB].filter(Boolean));
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

type MemberRow = {
  id: string;
  nickname: string;
  roles: string[] | null;
  org_role: string;
  joined_org_at: string | null;
  created_at: string;
};
type MembersBody = { members?: MemberRow[]; error?: unknown };

async function listOrganization(supabase: SupabaseClient, orgId: string): Promise<string[]> {
  const { data, error } = await supabase.from('user_profiles').select('id').eq('organization_id', orgId);
  if (error) throw new Error(`list: ${error.message}`);
  return (data ?? []).map((row) => row.id as string);
}

const ids = (members: MemberRow[] | undefined) => (members ?? []).map((m) => m.id).sort();

// B・C が確かめる不具合の前提。組織の管理者が他のメンバーの行を RLS で読めるようになった (SELECT ポリシーを足した) ときは、
// この確認を更新すること (その場合も、B・C は route の振る舞いの確認としてそのまま通る)
describe('A. 前提: 利用者本人の権限では、組織のメンバーを読めない', () => {
  it('組織の管理者が自分の権限で読むと 1 行 (自分だけ)。service_role なら全員', async () => {
    expect(await listOrganization(asUser(adminA.jwt), orgA)).toEqual([adminA.id]);
    expect((await listOrganization(srAdmin, orgA)).sort()).toEqual([ownerA.id, adminA.id, memberA1.id, memberA2.id].sort());
    expect((await listOrganization(srAdmin, orgB)).sort()).toEqual([ownerB.id, memberB1.id].sort());
  });
});

describe('B. GET /api/org/members は自組織のメンバー全員を返す', () => {
  it.each([
    ['オーナー', () => ownerA],
    ['管理者', () => adminA],
  ])('組織 A の%sには、組織 A のメンバー全員 (4 人) が返る。ほかの組織の人は混ざらない', async (_label, actor) => {
    const res = await apiCall<MembersBody>('GET', '/api/org/members', actor().jwt);

    expect(res.status).toBe(200);
    expect(res.body.members?.length).toBeGreaterThanOrEqual(2);
    expect(ids(res.body.members)).toEqual([ownerA.id, adminA.id, memberA1.id, memberA2.id].sort());
    expect(ids(res.body.members)).not.toContain(ownerB.id);
    expect(ids(res.body.members)).not.toContain(memberB1.id);
    expect(ids(res.body.members)).not.toContain(outsider.id);
  });

  it('別の組織 B のオーナーには、組織 B のメンバー (2 人) だけが返る。組織 A の人は混ざらない', async () => {
    const res = await apiCall<MembersBody>('GET', '/api/org/members', ownerB.jwt);

    expect(res.status).toBe(200);
    expect(ids(res.body.members)).toEqual([ownerB.id, memberB1.id].sort());
  });

  it('各メンバーの役割と参加日が返る。列は画面が使うものだけで、新しい順 (created_at の降順) に並ぶ', async () => {
    const res = await apiCall<MembersBody>('GET', '/api/org/members', adminA.jwt);

    expect(res.status).toBe(200);
    const members = res.body.members ?? [];
    const byId = new Map(members.map((m) => [m.id, m]));
    expect(byId.get(ownerA.id)?.org_role).toBe('owner');
    expect(byId.get(adminA.id)?.org_role).toBe('admin');
    expect(byId.get(memberA1.id)).toMatchObject({ org_role: 'member', joined_org_at: JOINED_AT, nickname: 'sec-member-a1' });
    for (const member of members) {
      expect(Object.keys(member).sort()).toEqual(['created_at', 'id', 'joined_org_at', 'nickname', 'org_role', 'roles']);
    }
    const createdAt = members.map((m) => Date.parse(m.created_at));
    expect(createdAt).toEqual([...createdAt].sort((a, b) => b - a));
  });

  it('リクエストのクエリに別の組織の id を入れても、自分の組織のメンバーだけが返る', async () => {
    const res = await apiCall<MembersBody>('GET', `/api/org/members?organization_id=${orgB}`, adminA.jwt);

    expect(res.status).toBe(200);
    expect(ids(res.body.members)).toEqual([ownerA.id, adminA.id, memberA1.id, memberA2.id].sort());
  });

  it('メンバーが増えれば、一覧も増える', async () => {
    const extra = await createMember('member-a3', orgA, 'member');

    const res = await apiCall<MembersBody>('GET', '/api/org/members', ownerA.jwt);

    expect(res.status).toBe(200);
    expect(ids(res.body.members)).toEqual([ownerA.id, adminA.id, memberA1.id, memberA2.id, extra.id].sort());
  });
});

describe('C. 組織の管理者でない人にはメンバーを返さない', () => {
  it('一般メンバーは 403', async () => {
    for (const member of [memberA1, memberA2, memberB1]) {
      const res = await apiCall<MembersBody>('GET', '/api/org/members', member.jwt);

      expect(res.status).toBe(403);
      expect(res.body.members).toBeUndefined();
    }
  });

  it('どの組織にも所属しないユーザーは 403', async () => {
    const res = await apiCall<MembersBody>('GET', '/api/org/members', outsider.jwt);

    expect(res.status).toBe(403);
    expect(res.body.members).toBeUndefined();
  });

  it('未ログインは 401', async () => {
    const res = await apiCall<MembersBody>('GET', '/api/org/members', null);

    expect(res.status).toBe(401);
    expect(res.body.members).toBeUndefined();
  });
});
