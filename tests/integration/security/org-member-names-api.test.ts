/**
 * #2073 S4 組織のメンバーの一覧 (GET /api/org/members) とオーナーの譲渡の候補 (GET /api/org/owner-transfer/candidates) を、
 * 本物の RLS と service_role で確かめる結合テスト
 *
 * 不具合: user_profiles の SELECT の RLS は本人の行だけ (Users can view own profile) なので、組織のメンバーの画面と
 * オーナーの譲渡の画面が利用者のクライアントで user_profiles を直接読むと、本番では自分の行しか返らなかった
 * (メンバーの一覧に他の人が出ない・譲渡の候補が 1 人も出ない)。
 *
 * 直したあと (RLS は変えない):
 *   - 2 つの route が、JWT の本人・所属組織・役割を確かめてから、確かめた組織のメンバーだけを service_role で読む
 *   - メンバーの一覧は同じ組織の管理者 (owner / admin) だけが呼べる。一般メンバーは 403・未ログインは 401
 *   - 譲渡の候補はその組織のオーナーだけが呼べ、自分とオーナーを除いたメンバーを返す。管理者・一般メンバーは 403
 *   - 返す列は id・表示名 (nickname)・組織内の役割 (org_role)・参加した日 (joined_org_at) の 4 つだけ
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-member-names-api.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';
import { createPlaceholderOrgOwner, deletePlaceholderOrgOwner } from '../helpers/org-owner';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

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
  nickname: string;
}

/** API が返す 1 人分の項目 (この 4 つだけ) */
const RETURNED_KEYS = ['id', 'joined_org_at', 'nickname', 'org_role'];

type NameRow = Record<string, unknown>;

const TS = Date.now();
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-orgnames-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const nickname = `名前-${label}-${TS}`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token, nickname };
}

/** 所属を service_role で設定する (特権列は本人の JWT では変更できない)。参加した日は並びを決めるために明示する */
async function setMembership(userId: string, orgId: string, orgRole: 'owner' | 'admin' | 'member', joinedOrgAt: string) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgRole, is_active_in_org: true, joined_org_at: joinedOrgAt })
    .eq('id', userId);
  if (error) throw new Error(`setMembership: ${error.message}`);
}

let orgA = '';
let orgB = '';
/** 組織の持ち主 (owner_id は NOT NULL)。どの組織のメンバーでもない作り物。afterAll で組織の後に消す */
let orgOwnerId = '';

let owner: TestUser; // 組織 A の owner
let admin: TestUser; // 組織 A の admin
let member1: TestUser; // 組織 A の一般メンバー
let member2: TestUser; // 組織 A の一般メンバー
let otherOwner: TestUser; // 組織 B の owner
let otherMember: TestUser; // 組織 B の一般メンバー
let outsider: TestUser; // どの組織にも属していない

beforeAll(async () => {
  orgOwnerId = await createPlaceholderOrgOwner(srAdmin, '2073-names');
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([
      { name: `#2073 names Org A ${TS}`, owner_id: orgOwnerId },
      { name: `#2073 names Org B ${TS}`, owner_id: orgOwnerId },
    ])
    .select('id, name');
  if (orgError || !orgs) throw new Error(`organizations: ${orgError?.message}`);
  orgA = orgs.find((o) => o.name.startsWith('#2073 names Org A'))!.id;
  orgB = orgs.find((o) => o.name.startsWith('#2073 names Org B'))!.id;

  [owner, admin, member1, member2, otherOwner, otherMember, outsider] = await Promise.all([
    createUser('owner'),
    createUser('admin'),
    createUser('member1'),
    createUser('member2'),
    createUser('other-owner'),
    createUser('other-member'),
    createUser('outsider'),
  ]);
  await setMembership(owner.id, orgA, 'owner', '2026-10-01T00:00:00.000Z');
  await setMembership(admin.id, orgA, 'admin', '2026-10-02T00:00:00.000Z');
  await setMembership(member1.id, orgA, 'member', '2026-10-03T00:00:00.000Z');
  await setMembership(member2.id, orgA, 'member', '2026-10-04T00:00:00.000Z');
  await setMembership(otherOwner.id, orgB, 'owner', '2026-10-01T00:00:00.000Z');
  await setMembership(otherMember.id, orgB, 'member', '2026-10-02T00:00:00.000Z');
}, 60_000);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false, joined_org_at: null })
      .in('id', createdUserIds);
  }
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    await srAdmin.from('organizations').delete().eq('id', orgId);
  }
  // 持ち主は組織を消した後に消す (owner_id → auth.users は ON DELETE RESTRICT)
  if (orgOwnerId) await deletePlaceholderOrgOwner(srAdmin, orgOwnerId);
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

async function listMembers(jwt: string | null) {
  return apiCall<{ members?: NameRow[]; error?: unknown }>('GET', '/api/org/members', jwt);
}

async function listCandidates(jwt: string | null) {
  return apiCall<{ candidates?: NameRow[]; error?: unknown }>('GET', '/api/org/owner-transfer/candidates', jwt);
}

describe('#2073 S4 前提: user_profiles の RLS は本人の行だけ (この修正で変えない)', () => {
  it('組織の管理者でも、利用者のクライアントで同じ組織の user_profiles を読むと自分の行しか返らない', async () => {
    const { data, error } = await asUser(admin.jwt)
      .from('user_profiles')
      .select('id, nickname, org_role, joined_org_at')
      .eq('organization_id', orgA);
    expect(error).toBeNull();
    expect((data ?? []).map((row) => row.id)).toEqual([admin.id]);
  });
});

describe('#2073 S4 GET /api/org/members: 管理者は同じ組織のメンバーの名前を読める', () => {
  it('管理者 (admin) は、ほかのメンバーを含む組織 A の全員を、参加した日の古い順で読める', async () => {
    const res = await listMembers(admin.jwt);

    expect(res.status).toBe(200);
    const members = res.body.members ?? [];
    expect(members.map((m) => m.id)).toEqual([owner.id, admin.id, member1.id, member2.id]);
    expect(members.map((m) => m.nickname)).toEqual([owner.nickname, admin.nickname, member1.nickname, member2.nickname]);
    expect(members.map((m) => m.org_role)).toEqual(['owner', 'admin', 'member', 'member']);
  });

  it('オーナーも読める', async () => {
    const res = await listMembers(owner.jwt);

    expect(res.status).toBe(200);
    expect((res.body.members ?? []).map((m) => m.id)).toEqual([owner.id, admin.id, member1.id, member2.id]);
  });

  it('返る列は id・表示名・組織内の役割・参加した日の 4 つだけ', async () => {
    const res = await listMembers(admin.jwt);

    expect(Object.keys(res.body)).toEqual(['members']);
    for (const member of res.body.members ?? []) {
      expect(Object.keys(member).sort()).toEqual(RETURNED_KEYS);
    }
    const first = (res.body.members ?? [])[0];
    expect(typeof first?.joined_org_at).toBe('string');
  });

  it('一般メンバーは 403', async () => {
    const res = await listMembers(member1.jwt);
    expect(res.status).toBe(403);
    expect(res.body.members).toBeUndefined();
  });

  it('組織に属していない人は 403', async () => {
    const res = await listMembers(outsider.jwt);
    expect(res.status).toBe(403);
  });

  it('別の組織の一般メンバーは 403', async () => {
    const res = await listMembers(otherMember.jwt);
    expect(res.status).toBe(403);
  });

  it('別の組織のオーナーには、自分の組織のメンバーだけが返り、組織 A の人は返らない', async () => {
    const res = await listMembers(otherOwner.jwt);

    expect(res.status).toBe(200);
    expect((res.body.members ?? []).map((m) => m.id)).toEqual([otherOwner.id, otherMember.id]);
  });

  it('未ログインは 401', async () => {
    const res = await listMembers(null);
    expect(res.status).toBe(401);
  });
});

describe('#2073 S4 GET /api/org/owner-transfer/candidates: オーナーだけが候補を読める', () => {
  it('オーナーは、自分を除いた組織 A のメンバー (管理者と一般メンバー) を、参加した日の古い順で読める', async () => {
    const res = await listCandidates(owner.jwt);

    expect(res.status).toBe(200);
    const candidates = res.body.candidates ?? [];
    expect(candidates.map((m) => m.id)).toEqual([admin.id, member1.id, member2.id]);
    expect(candidates.map((m) => m.nickname)).toEqual([admin.nickname, member1.nickname, member2.nickname]);
  });

  it('返る列は id・表示名・組織内の役割・参加した日の 4 つだけ', async () => {
    const res = await listCandidates(owner.jwt);

    expect(Object.keys(res.body)).toEqual(['candidates']);
    for (const candidate of res.body.candidates ?? []) {
      expect(Object.keys(candidate).sort()).toEqual(RETURNED_KEYS);
    }
  });

  it('管理者 (admin) は 403', async () => {
    const res = await listCandidates(admin.jwt);
    expect(res.status).toBe(403);
    expect(res.body.candidates).toBeUndefined();
  });

  it('一般メンバーは 403', async () => {
    const res = await listCandidates(member1.jwt);
    expect(res.status).toBe(403);
  });

  it('組織に属していない人は 403', async () => {
    const res = await listCandidates(outsider.jwt);
    expect(res.status).toBe(403);
  });

  it('別の組織のオーナーには、自分の組織の候補だけが返り、組織 A の人は返らない', async () => {
    const res = await listCandidates(otherOwner.jwt);

    expect(res.status).toBe(200);
    expect((res.body.candidates ?? []).map((m) => m.id)).toEqual([otherMember.id]);
  });

  it('未ログインは 401', async () => {
    const res = await listCandidates(null);
    expect(res.status).toBe(401);
  });
});
