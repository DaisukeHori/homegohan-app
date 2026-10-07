/**
 * #1235 (第2段) 部署 API (/api/org/departments) を設計 v2 どおりに直すことの回帰テスト
 *
 * 修正前の部署 API は、存在しないテーブル organization_departments を参照しており、
 * 組織の owner / admin でも全メソッドが 500 だった (設計 v2 の F-5)。
 * 画面 (src/app/(org)/org/departments、apps/mobile の部署画面) は
 * { id, name, parentId, managerId, displayOrder, memberCount, createdAt } を期待している。
 *
 * 期待する挙動 (設計 v2 §3 / §3.3.1、2026-10-07 のオーナー判断「設計 v2 どおり」):
 *   - departments テーブルを読み書きし、画面の形で返す
 *   - memberCount は user_profiles.department_id の人数 (service_role で集計)
 *   - チャレンジ・招待・子部署から参照されている部署の削除は 409 DEPARTMENT_IN_USE、無い部署は 404
 *   - 部署に所属しているメンバーがいても削除できる (所属は外れる: ON DELETE SET NULL)
 *   - user_profiles.department_id は本人が変更できない (特権列ガード)。既存の保護 (frozen_* 等) も維持
 *   - 脱退・除名で department_id も外れる
 *   - チャレンジ作成で、他組織の部署 id は指定できない (400)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-departments-api.test.ts
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

interface DepartmentDto {
  id: string;
  name: string;
  parentId: string | null;
  managerId: string | null;
  displayOrder: number;
  memberCount: number;
  createdAt: string | null;
}

const TS = Date.now();
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-dept-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `dept-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** 所属を service_role で設定する (特権列は本人の JWT では変更できない) */
async function setMembership(userId: string, orgId: string, orgRole: 'owner' | 'admin' | 'member') {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgRole, is_active_in_org: true })
    .eq('id', userId);
  if (error) throw new Error(`setMembership: ${error.message}`);
}

async function assignDepartment(userId: string, departmentId: string | null) {
  const { error } = await srAdmin.from('user_profiles').update({ department_id: departmentId }).eq('id', userId);
  if (error) throw new Error(`assignDepartment: ${error.message}`);
}

async function departmentOf(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('department_id').eq('id', userId).single();
  if (error) throw new Error(`departmentOf: ${error.message}`);
  return (data as { department_id: string | null }).department_id;
}

let orgA = '';
let orgB = '';
let deptB = ''; // 組織 B の部署 (組織 A からは他組織)

let owner: TestUser; // 組織 A の owner
let admin: TestUser; // 組織 A の admin
let member1: TestUser; // 組織 A の一般メンバー
let member2: TestUser; // 組織 A の一般メンバー
let otherAdmin: TestUser; // 組織 B の admin

beforeAll(async () => {
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([{ name: `#1235 dept Org A ${TS}` }, { name: `#1235 dept Org B ${TS}` }])
    .select('id, name');
  if (orgError || !orgs) throw new Error(`organizations: ${orgError?.message}`);
  orgA = orgs.find((o) => o.name.startsWith('#1235 dept Org A'))!.id;
  orgB = orgs.find((o) => o.name.startsWith('#1235 dept Org B'))!.id;

  [owner, admin, member1, member2, otherAdmin] = await Promise.all([
    createUser('owner'),
    createUser('admin'),
    createUser('member1'),
    createUser('member2'),
    createUser('other-admin'),
  ]);
  await setMembership(owner.id, orgA, 'owner');
  await setMembership(admin.id, orgA, 'admin');
  await setMembership(member1.id, orgA, 'member');
  await setMembership(member2.id, orgA, 'member');
  await setMembership(otherAdmin.id, orgB, 'admin');

  const { data: dB, error: dBError } = await srAdmin
    .from('departments')
    .insert({ organization_id: orgB, name: `dept B ${TS}` })
    .select('id')
    .single();
  if (dBError || !dB) throw new Error(`departments: ${dBError?.message}`);
  deptB = dB.id as string;
}, 60_000);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false, department_id: null })
      .in('id', createdUserIds);
  }
  // 部署・チャレンジ・招待は organizations の削除で CASCADE
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    await srAdmin.from('organization_challenges').delete().eq('organization_id', orgId);
    await srAdmin.from('organization_invites').delete().eq('organization_id', orgId);
    await srAdmin.from('departments').delete().eq('organization_id', orgId).not('parent_id', 'is', null);
    await srAdmin.from('organizations').delete().eq('id', orgId);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

async function createDepartment(jwt: string, name: string): Promise<DepartmentDto> {
  const res = await apiCall('POST', '/api/org/departments', jwt, { name });
  expect(res.status).toBe(201);
  return (res.body as { department: DepartmentDto }).department;
}

async function listDepartments(jwt: string): Promise<DepartmentDto[]> {
  const res = await apiCall('GET', '/api/org/departments', jwt);
  expect(res.status).toBe(200);
  return (res.body as { departments: DepartmentDto[] }).departments;
}

describe('#1235 部署 API: 一覧・作成・更新', () => {
  it('D-1: owner が部署を作ると 201 で、画面の形 (memberCount 0) で返る', async () => {
    const dept = await createDepartment(owner.jwt, `営業部 ${TS}`);
    expect(dept).toMatchObject({
      name: `営業部 ${TS}`,
      parentId: null,
      managerId: null,
      displayOrder: 0,
      memberCount: 0,
    });
    expect(dept.id).toBeTruthy();
    expect(dept.createdAt).toBeTruthy();
  });

  it('D-2: 一覧は自組織の部署だけで、memberCount は所属人数', async () => {
    const dept = await createDepartment(admin.jwt, `開発部 ${TS}`);
    await assignDepartment(member1.id, dept.id);
    await assignDepartment(member2.id, dept.id);

    const list = await listDepartments(owner.jwt);
    const names = list.map((d) => d.name);
    expect(names).toContain(`営業部 ${TS}`);
    expect(names).toContain(`開発部 ${TS}`);
    expect(names).not.toContain(`dept B ${TS}`);
    expect(list.find((d) => d.id === dept.id)?.memberCount).toBe(2);
    expect(list.find((d) => d.name === `営業部 ${TS}`)?.memberCount).toBe(0);
  });

  it('D-3: 名前を変えられる。他組織の部署は 404', async () => {
    const dept = await createDepartment(owner.jwt, `総務部 ${TS}`);
    const res = await apiCall('PUT', '/api/org/departments', owner.jwt, { id: dept.id, name: `総務・人事部 ${TS}` });
    expect(res.status).toBe(200);
    expect((res.body as { department: DepartmentDto }).department.name).toBe(`総務・人事部 ${TS}`);

    const other = await apiCall('PUT', '/api/org/departments', owner.jwt, { id: deptB, name: 'tampered' });
    expect(other.status).toBe(404);
    const { data } = await srAdmin.from('departments').select('name').eq('id', deptB).single();
    expect(data?.name).toBe(`dept B ${TS}`);
  });

  it('D-4: 名前が空・101 文字以上なら 400', async () => {
    const empty = await apiCall('POST', '/api/org/departments', owner.jwt, { name: '  ' });
    expect(empty.status).toBe(400);
    const tooLong = await apiCall('POST', '/api/org/departments', owner.jwt, { name: 'あ'.repeat(101) });
    expect(tooLong.status).toBe(400);
  });

  it('D-5: 一般メンバーは 403、別組織の admin には組織 A の部署が見えない', async () => {
    const res = await apiCall('GET', '/api/org/departments', member1.jwt);
    expect(res.status).toBe(403);
    const post = await apiCall('POST', '/api/org/departments', member1.jwt, { name: 'x' });
    expect(post.status).toBe(403);
    const otherList = await listDepartments(otherAdmin.jwt);
    expect(otherList.map((d) => d.id)).toEqual([deptB]);
  });
});

describe('#1235 部署 API: 削除', () => {
  it('X-1: チャレンジから参照されている部署は 409 DEPARTMENT_IN_USE', async () => {
    const dept = await createDepartment(owner.jwt, `参照される部署 ${TS}`);
    const { error } = await srAdmin.from('organization_challenges').insert({
      organization_id: orgA,
      title: `dept challenge ${TS}`,
      challenge_type: 'breakfast_rate',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
      department_id: dept.id,
      created_by: owner.id,
    });
    expect(error).toBeNull();
    const res = await apiCall('DELETE', `/api/org/departments?id=${dept.id}`, owner.jwt);
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('DEPARTMENT_IN_USE');
  });

  it('X-2: 子部署がある部署は 409 DEPARTMENT_IN_USE', async () => {
    const parent = await createDepartment(owner.jwt, `親部署 ${TS}`);
    const { error } = await srAdmin
      .from('departments')
      .insert({ organization_id: orgA, name: `子部署 ${TS}`, parent_id: parent.id });
    expect(error).toBeNull();
    const res = await apiCall('DELETE', `/api/org/departments?id=${parent.id}`, owner.jwt);
    expect(res.status).toBe(409);
  });

  it('X-3: 所属メンバーがいる部署は削除でき、メンバーの所属は外れる', async () => {
    const dept = await createDepartment(owner.jwt, `解散する部署 ${TS}`);
    await assignDepartment(member2.id, dept.id);
    const res = await apiCall('DELETE', `/api/org/departments?id=${dept.id}`, owner.jwt);
    expect(res.status).toBe(200);
    expect(await departmentOf(member2.id)).toBeNull();
  });

  it('X-4: 他組織の部署・存在しない部署は 404 で、他組織の部署は残る', async () => {
    const other = await apiCall('DELETE', `/api/org/departments?id=${deptB}`, owner.jwt);
    expect(other.status).toBe(404);
    const { data } = await srAdmin.from('departments').select('id').eq('id', deptB);
    expect((data ?? []).length).toBe(1);
    const missing = await apiCall('DELETE', '/api/org/departments?id=00000000-0000-0000-0000-000000000000', owner.jwt);
    expect(missing.status).toBe(404);
  });
});

describe('#1235 user_profiles.department_id', () => {
  it('G-1: 本人は自分の department_id を変えられない (42501)', async () => {
    const { error } = await asUser(member1.jwt).from('user_profiles').update({ department_id: null }).eq('id', member1.id);
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('G-2: 既存の特権列 (frozen_reason) の保護も維持される (42501)', async () => {
    const { error } = await asUser(member1.jwt)
      .from('user_profiles')
      .update({ frozen_reason: 'self-unfreeze attempt' })
      .eq('id', member1.id);
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('G-3: remove_org_member で除名されると department_id も外れる', async () => {
    expect(await departmentOf(member1.id)).not.toBeNull();
    const { error } = await asUser(owner.jwt).rpc('remove_org_member', { p_organization_id: orgA, p_user_id: member1.id });
    expect(error).toBeNull();
    expect(await departmentOf(member1.id)).toBeNull();
  });

  it('G-4: leave_org で脱退すると department_id も外れる', async () => {
    const dept = await createDepartment(owner.jwt, `脱退前の部署 ${TS}`);
    await assignDepartment(admin.id, dept.id);
    const { error } = await asUser(admin.jwt).rpc('leave_org');
    expect(error).toBeNull();
    expect(await departmentOf(admin.id)).toBeNull();
  });
});

describe('#1235 チャレンジ作成の部署 id', () => {
  it('C-1: 自組織の部署なら作成できる', async () => {
    const dept = await createDepartment(owner.jwt, `チャレンジ用部署 ${TS}`);
    const res = await apiCall('POST', '/api/org/challenges', owner.jwt, {
      title: `own dept challenge ${TS}`,
      challengeType: 'breakfast_rate',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      departmentId: dept.id,
    });
    expect(res.status).toBe(200);
  });

  it('C-2: 他組織の部署 id は 400 で、チャレンジは作られない', async () => {
    const res = await apiCall('POST', '/api/org/challenges', owner.jwt, {
      title: `other org dept challenge ${TS}`,
      challengeType: 'breakfast_rate',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      departmentId: deptB,
    });
    expect(res.status).toBe(400);
    const { data } = await srAdmin
      .from('organization_challenges')
      .select('id')
      .eq('title', `other org dept challenge ${TS}`);
    expect(data ?? []).toEqual([]);
  });
});
