/**
 * #1257 family_members の SELECT ポリシーの自己参照による無限再帰 (42P17) の回帰テスト
 *
 * 修正前 (20260511000114_membership_family_rls.sql) の family_members_select_self_or_family /
 * family_members_update_self_or_adult は family_members 自身を参照しており、ログインユーザーのセッションで
 * family_members を読むと `42P17 infinite recursion detected in policy for relation "family_members"` になった。
 * family_groups / family_invites のポリシーも family_members を参照するため、同じエラーになった。
 *
 * 期待する認可 (ポリシーの意味は修正前と同じ):
 *   - family_members の SELECT: 自分の行、または自分が active なメンバーである家族の行
 *   - family_members の UPDATE: 自分の行、または自分が active な代表者・大人である家族の行
 *   - family_groups  の SELECT: 自分が active なメンバーである家族 / UPDATE: active な代表者・大人
 *   - family_invites の SELECT / INSERT / UPDATE: その家族の active な代表者・大人
 *   - 別の家族・所属なし・未認証 (anon) は読めず、書けない
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/family-rls-recursion.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

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
  const email = `rls-family-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-rls';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `family-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

let familyF = '';
let familyG = '';

let rep: TestUser; // 家族 F の代表者
let adult: TestUser; // 家族 F の大人
let removed: TestUser; // 家族 F から除名済み (status = removed)
let otherRep: TestUser; // 家族 G の代表者 (F に対しては部外者)
let outsider: TestUser; // どの家族にも所属しない

let repMemberId = '';
let adultMemberId = '';
let childMemberId = ''; // 家族 F の子ども (アカウントなし)
let removedMemberId = '';
let otherRepMemberId = '';
let inviteF = '';

async function insertMember(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await srAdmin.from('family_members').insert(row).select('id').single();
  if (error || !data) throw new Error(`family_members: ${error?.message}`);
  return data.id as string;
}

beforeAll(async () => {
  [rep, adult, removed, otherRep, outsider] = await Promise.all([
    createUser('rep'),
    createUser('adult'),
    createUser('removed'),
    createUser('other-rep'),
    createUser('outsider'),
  ]);

  const { data: groups, error: groupError } = await srAdmin
    .from('family_groups')
    .insert([
      { name: `rls-family F ${TS}`, representative_id: rep.id },
      { name: `rls-family G ${TS}`, representative_id: otherRep.id },
    ])
    .select('id, name');
  if (groupError || !groups) throw new Error(`family_groups: ${groupError?.message}`);
  familyF = groups.find((g) => g.name.startsWith('rls-family F'))!.id;
  familyG = groups.find((g) => g.name.startsWith('rls-family G'))!.id;

  repMemberId = await insertMember({ family_id: familyF, user_id: rep.id, role: 'representative', status: 'active' });
  adultMemberId = await insertMember({ family_id: familyF, user_id: adult.id, role: 'adult', status: 'active' });
  childMemberId = await insertMember({
    family_id: familyF,
    user_id: null,
    role: 'child',
    display_name: `child ${TS}`,
    child_profile: { birth_year: 2018 },
    status: 'active',
  });
  removedMemberId = await insertMember({
    family_id: familyF,
    user_id: removed.id,
    role: 'adult',
    status: 'removed',
    removed_at: new Date().toISOString(),
  });
  otherRepMemberId = await insertMember({
    family_id: familyG,
    user_id: otherRep.id,
    role: 'representative',
    status: 'active',
  });

  const { data: invite, error: inviteError } = await srAdmin
    .from('family_invites')
    .insert({
      family_id: familyF,
      email: `rls-family-invitee-${TS}@homegohan.test`,
      token: `rls-family-token-${TS}`,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      invited_by: rep.id,
    })
    .select('id')
    .single();
  if (inviteError || !invite) throw new Error(`family_invites: ${inviteError?.message}`);
  inviteF = invite.id as string;
}, 60_000);

afterAll(async () => {
  // family_members / family_invites は family_groups の削除で CASCADE。
  // family_groups.representative_id は ON DELETE RESTRICT のため、家族を先に消す
  const groupIds = [familyF, familyG].filter(Boolean);
  if (groupIds.length > 0) await srAdmin.from('family_groups').delete().in('id', groupIds);
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

async function memberIdsVisibleTo(c: SupabaseClient): Promise<string[]> {
  const { data, error } = await c
    .from('family_members')
    .select('id')
    .in('id', [repMemberId, adultMemberId, childMemberId, removedMemberId, otherRepMemberId]);
  expect(error).toBeNull();
  return (data ?? []).map((r) => r.id as string).sort();
}

async function groupIdsVisibleTo(c: SupabaseClient): Promise<string[]> {
  const { data, error } = await c.from('family_groups').select('id').in('id', [familyF, familyG]);
  expect(error).toBeNull();
  return (data ?? []).map((r) => r.id as string).sort();
}

async function inviteIdsVisibleTo(c: SupabaseClient): Promise<string[]> {
  const { data, error } = await c.from('family_invites').select('id').eq('id', inviteF);
  expect(error).toBeNull();
  return (data ?? []).map((r) => r.id as string);
}

// ================================================================
// family_members
// ================================================================
describe('#1257 family_members の SELECT (無限再帰にならない)', () => {
  it('M-1: 代表者は自分の家族の active なメンバー (子ども含む) と除名済みの行を読める', async () => {
    expect(await memberIdsVisibleTo(asUser(rep.jwt))).toEqual(
      [repMemberId, adultMemberId, childMemberId, removedMemberId].sort(),
    );
  });

  it('M-2: 大人も自分の家族の行を読める', async () => {
    expect(await memberIdsVisibleTo(asUser(adult.jwt))).toEqual(
      [repMemberId, adultMemberId, childMemberId, removedMemberId].sort(),
    );
  });

  it('M-3: 除名済みのユーザーは自分の行だけ読める', async () => {
    expect(await memberIdsVisibleTo(asUser(removed.jwt))).toEqual([removedMemberId]);
  });

  it('M-4: 別の家族の代表者は自分の家族の行だけ読める', async () => {
    expect(await memberIdsVisibleTo(asUser(otherRep.jwt))).toEqual([otherRepMemberId]);
  });

  it('M-5: どの家族にも所属しないユーザーは読めない', async () => {
    expect(await memberIdsVisibleTo(asUser(outsider.jwt))).toEqual([]);
  });

  it('M-6: 未認証 (anon) は読めない', async () => {
    expect(await memberIdsVisibleTo(anon())).toEqual([]);
  });
});

describe('#1257 family_members の UPDATE', () => {
  it('MU-1: 大人は自分の家族の子どもの表示名を変えられる', async () => {
    const { data, error } = await asUser(adult.jwt)
      .from('family_members')
      .update({ display_name: `child renamed ${TS}` })
      .eq('id', childMemberId)
      .select('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([childMemberId]);
  });

  it('MU-2: 別の家族の代表者は家族 F の行を変えられない (0 行)', async () => {
    const { data, error } = await asUser(otherRep.jwt)
      .from('family_members')
      .update({ display_name: 'tampered' })
      .eq('id', childMemberId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const { data: row } = await srAdmin.from('family_members').select('display_name').eq('id', childMemberId).single();
    expect(row?.display_name).toBe(`child renamed ${TS}`);
  });
});

// ================================================================
// family_groups
// ================================================================
describe('#1257 family_groups', () => {
  it('G-1: 代表者・大人は自分の家族グループを読める', async () => {
    expect(await groupIdsVisibleTo(asUser(rep.jwt))).toEqual([familyF]);
    expect(await groupIdsVisibleTo(asUser(adult.jwt))).toEqual([familyF]);
  });

  it('G-2: 除名済み・別の家族・所属なし・未認証は家族 F を読めない', async () => {
    expect(await groupIdsVisibleTo(asUser(removed.jwt))).toEqual([]);
    expect(await groupIdsVisibleTo(asUser(otherRep.jwt))).toEqual([familyG]);
    expect(await groupIdsVisibleTo(asUser(outsider.jwt))).toEqual([]);
    expect(await groupIdsVisibleTo(anon())).toEqual([]);
  });

  it('GU-1: 大人は家族グループの名前を変えられる', async () => {
    const { data, error } = await asUser(adult.jwt)
      .from('family_groups')
      .update({ name: `rls-family F renamed ${TS}` })
      .eq('id', familyF)
      .select('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([familyF]);
  });

  it('GU-2: 別の家族の代表者は家族 F の名前を変えられない (0 行)', async () => {
    const { data, error } = await asUser(otherRep.jwt)
      .from('family_groups')
      .update({ name: 'tampered' })
      .eq('id', familyF)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ================================================================
// family_invites
// ================================================================
describe('#1257 family_invites', () => {
  it('I-1: 代表者・大人は自分の家族の招待を読める', async () => {
    expect(await inviteIdsVisibleTo(asUser(rep.jwt))).toEqual([inviteF]);
    expect(await inviteIdsVisibleTo(asUser(adult.jwt))).toEqual([inviteF]);
  });

  it('I-2: 除名済み・別の家族・所属なし・未認証は読めない', async () => {
    expect(await inviteIdsVisibleTo(asUser(removed.jwt))).toEqual([]);
    expect(await inviteIdsVisibleTo(asUser(otherRep.jwt))).toEqual([]);
    expect(await inviteIdsVisibleTo(asUser(outsider.jwt))).toEqual([]);
    expect(await inviteIdsVisibleTo(anon())).toEqual([]);
  });

  it('II-1: 代表者は自分の家族の招待を作れる', async () => {
    const { data, error } = await asUser(rep.jwt)
      .from('family_invites')
      .insert({
        family_id: familyF,
        email: `rls-family-invitee2-${TS}@homegohan.test`,
        token: `rls-family-token2-${TS}`,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        invited_by: rep.id,
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
  });

  it('II-2: 別の家族の代表者は家族 F の招待を作れない (42501)', async () => {
    const { error } = await asUser(otherRep.jwt).from('family_invites').insert({
      family_id: familyF,
      email: `rls-family-invitee3-${TS}@homegohan.test`,
      token: `rls-family-token3-${TS}`,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      invited_by: otherRep.id,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('IU-1: 別の家族の代表者は家族 F の招待を取り消せない (0 行)', async () => {
    const { data, error } = await asUser(otherRep.jwt)
      .from('family_invites')
      .update({ status: 'revoked' })
      .eq('id', inviteF)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const { data: row } = await srAdmin.from('family_invites').select('status').eq('id', inviteF).single();
    expect(row?.status).toBe('pending');
  });
});
