/**
 * billing/03 (有料プランの販売) 段 A: 家族の機能の門 (家族プランの契約が無いと、家族グループを作れず・メンバーを足せない) の結合テスト
 * (設計: docs/design/billing/03-paid-plans-and-iap.md §6.6・§0.5 の Q-4・§14.2 の 77〜79・105)
 *
 * migration *_billing_paid_plans_iap.sql が足すもの:
 *   - billing_has_live_family_plan(p_user_id): live な家族プラン (plan_type = family) の契約 (Stripe / ストア / 手動付与) があるか
 *   - create_family_group: ALREADY_IN_FAMILY の検査の直後に、呼んだ本人に live な家族プランが無ければ FAMILY_PLAN_REQUIRED
 *   - トリガー family_members_billing_plan_gate (BEFORE INSERT): 代表者以外の行を、plan_key = free の active なグループに足せない
 *     (招待の承諾・子供の追加・service_role の直接の INSERT のすべて)。子供の昇格 (accept_child_promotion) は、いる子供の行の UPDATE
 *     なので門に当たらない
 *
 * 家族プランの契約は、手動付与 (billing_grant_manual_subscription) で入れ、取り消し (billing_revoke_manual_subscription) で終える
 * (グループのプランは billing/01・02 の同期で family_basic / 4 ⇄ free / 4 になる)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/family-plan-gate.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { grantFamilyPlan } from '../helpers/family-plan';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ローカルスタックの Kong -> PostgREST は、使い回した最初の 1 回が 502 になることがある。データベースの結果ではないので数回やり直す */
const GATEWAY_RETRIES = 3;
/** 502 のやり直しの間隔 (ミリ秒。回数ごとに伸ばす) */
const GATEWAY_RETRY_BASE_MS = 150;
const fetchRetryingGateway502: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 502 || attempt >= GATEWAY_RETRIES) return res;
    await sleep(GATEWAY_RETRY_BASE_MS * (attempt + 1));
  }
};

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: {
      fetch: fetchRetryingGateway502,
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    },
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
const RUN = `${TS}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
let seq = 0;

/** 子供のメンバーの生年月日 (成人の placeholder。18 歳以上なので保護者の同意は要らない。#1173) */
const ADULT_PLACEHOLDER_BIRTH_DATE = '1990-01-01';
/** family_groups.member_limit の DDL の既定値 (契約の無いグループ・family_basic の人数) */
const DEFAULT_MEMBER_LIMIT = 4;

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-family-plan-gate-${label}-${RUN}-${++seq}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `gate-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

async function createFamilyGroup(rep: TestUser): Promise<{ data: { id: string; plan_key: string; member_limit: number } | null; error: { code: string; message: string } | null }> {
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', { p_name: `family-plan-gate ${RUN} ${++seq}`, p_plan_key: 'free' });
  if (data) createdFamilyIds.push((data as { id: string }).id);
  return { data: (data as { id: string; plan_key: string; member_limit: number } | null) ?? null, error: error ? { code: error.code, message: error.message } : null };
}

async function mustCreateFamily(rep: TestUser): Promise<string> {
  const { data, error } = await createFamilyGroup(rep);
  if (error || !data) throw new Error(`create_family_group: ${error?.message}`);
  return data.id;
}

/** service_role で、代表者の行だけを持つグループを直接作る (代表者に契約が無いので、作成のトリガーが free / 4 にする) */
async function insertFreeFamily(rep: TestUser): Promise<string> {
  const { data, error } = await srAdmin
    .from('family_groups')
    .insert({ name: `family-plan-gate ${RUN} ${++seq}`, representative_id: rep.id })
    .select('id')
    .single();
  if (error || !data) throw new Error(`family_groups: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  const { error: repError } = await srAdmin.from('family_members').insert({ family_id: familyId, user_id: rep.id, role: 'representative', status: 'active' });
  if (repError) throw new Error(`family_members representative: ${repError.message}`);
  const { error: profileError } = await srAdmin.from('user_profiles').update({ family_id: familyId }).eq('id', rep.id);
  if (profileError) throw new Error(`user_profiles.family_id: ${profileError.message}`);
  return familyId;
}

async function inviteToken(rep: TestUser, familyId: string, email: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: email });
  if (error || !data) throw new Error(`create_family_invite: ${error?.message}`);
  return (data as { token: string }).token;
}

async function acceptInvite(user: TestUser, token: string) {
  return asUser(user.jwt).rpc('accept_family_invite', { p_token: token });
}

async function addChild(rep: TestUser, familyId: string, name: string) {
  return asUser(rep.jwt).rpc('add_family_child', {
    p_family_id: familyId,
    p_display_name: name,
    p_child_profile: { note: 'billing/03' },
    p_birth_date: ADULT_PLACEHOLDER_BIRTH_DATE,
  });
}

async function revokePlan(userId: string): Promise<void> {
  const { error } = await srAdmin.rpc('billing_revoke_manual_subscription', { p_user_id: userId });
  if (error) throw new Error(`billing_revoke_manual_subscription: ${error.message}`);
}

async function familyOf(familyId: string): Promise<{ plan_key: string; member_limit: number; status: string }> {
  const { data, error } = await srAdmin.from('family_groups').select('plan_key, member_limit, status').eq('id', familyId).single();
  if (error || !data) throw new Error(`family_groups: ${error?.message}`);
  return data as { plan_key: string; member_limit: number; status: string };
}

async function activeMembers(familyId: string): Promise<Array<{ id: string; user_id: string | null; role: string }>> {
  const { data, error } = await srAdmin
    .from('family_members')
    .select('id, user_id, role')
    .eq('family_id', familyId)
    .eq('status', 'active')
    .order('joined_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`family_members: ${error.message}`);
  return (data ?? []) as Array<{ id: string; user_id: string | null; role: string }>;
}

afterAll(async () => {
  if (createdFamilyIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdFamilyIds);
    // family_groups.representative_id は ON DELETE RESTRICT なので、ユーザーより先に家族を消す (メンバー・招待・昇格の依頼は CASCADE)
    await srAdmin.from('family_groups').delete().in('id', createdFamilyIds);
  }
  if (createdUserIds.length > 0) await srAdmin.from('admin_audit_logs').delete().in('target_id', createdUserIds);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles・personal_subscriptions は CASCADE
  }
}, 120_000);

describe('billing/03 §6.6: 家族の機能の門', () => {
  // 77
  it('create_family_group raises FAMILY_PLAN_REQUIRED without a live family plan and succeeds with a manual family grant', async () => {
    // 契約なし
    const noPlan = await createUser('no-plan');
    expect(await createFamilyGroup(noPlan)).toEqual({ data: null, error: { code: 'P0001', message: 'FAMILY_PLAN_REQUIRED' } });
    // 家族でないプラン (個人 Pro) の契約だけ
    const pro = await createUser('pro-only');
    const { error: grantError } = await srAdmin.rpc('billing_grant_manual_subscription', { p_user_id: pro.id, p_plan_key: 'pro', p_expires_at: null });
    expect(grantError).toBeNull();
    expect(await createFamilyGroup(pro)).toEqual({ data: null, error: { code: 'P0001', message: 'FAMILY_PLAN_REQUIRED' } });
    // 断ったときは何も作らない (グループ・メンバーの行・user_profiles.family_id)
    for (const user of [noPlan, pro]) {
      const { data: groups } = await srAdmin.from('family_groups').select('id').eq('representative_id', user.id);
      expect(groups).toEqual([]);
      const { data: rows } = await srAdmin.from('family_members').select('id').eq('user_id', user.id);
      expect(rows).toEqual([]);
      const { data: profile } = await srAdmin.from('user_profiles').select('family_id').eq('id', user.id).single();
      expect((profile as { family_id: string | null }).family_id).toBeNull();
    }

    // 家族プランの手動付与のあとは作れる (グループは契約のプランと人数)
    const withPlan = await createUser('with-plan');
    await grantFamilyPlan(srAdmin, withPlan.id, 'family_pro');
    const created = await createFamilyGroup(withPlan);
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({ plan_key: 'family_pro', member_limit: 8 });

    // service_role の判定の関数も同じ答え
    for (const [user, expected] of [[noPlan, false], [pro, false], [withPlan, true]] as const) {
      const { data, error } = await srAdmin.rpc('billing_has_live_family_plan', { p_user_id: user.id });
      expect(error).toBeNull();
      expect(data).toBe(expected);
    }
    // anon / authenticated は呼べない
    expect((await anon().rpc('billing_has_live_family_plan', { p_user_id: withPlan.id })).error?.code).toBe('42501');
    expect((await asUser(withPlan.jwt).rpc('billing_has_live_family_plan', { p_user_id: withPlan.id })).error?.code).toBe('42501');
  });

  // 78
  it('family_members insert (invite accept, child add) raises FAMILY_PLAN_REQUIRED when the group is free and succeeds when the representative has a family plan', async () => {
    const rep = await createUser('free-group-rep');
    const familyId = await insertFreeFamily(rep);
    expect(await familyOf(familyId)).toMatchObject({ plan_key: 'free', member_limit: DEFAULT_MEMBER_LIMIT, status: 'active' });
    const joiner = await createUser('free-group-joiner');
    const token = await inviteToken(rep, familyId, joiner.email);

    const refusedAccept = await acceptInvite(joiner, token);
    expect(refusedAccept.data).toBeNull();
    expect(refusedAccept.error).toMatchObject({ code: 'P0001', message: 'FAMILY_PLAN_REQUIRED' });
    const refusedChild = await addChild(rep, familyId, 'gate-child-refused');
    expect(refusedChild.data).toBeNull();
    expect(refusedChild.error).toMatchObject({ code: 'P0001', message: 'FAMILY_PLAN_REQUIRED' });
    // service_role の直接の INSERT も同じ (SECURITY DEFINER の関数の中からでも、current_user を見ない)
    const other = await createUser('free-group-direct');
    const direct = await srAdmin.from('family_members').insert({ family_id: familyId, user_id: other.id, role: 'adult', status: 'active' });
    expect(direct.error).toMatchObject({ code: 'P0001', message: 'FAMILY_PLAN_REQUIRED' });
    expect((await activeMembers(familyId)).map((m) => m.role)).toEqual(['representative']);
    // 招待は使われずに残る
    const { data: invite } = await srAdmin.from('family_invites').select('status').eq('token', token).single();
    expect((invite as { status: string }).status).toBe('pending');

    // 代表者に家族プランが入ると、グループは family_basic / 4 になり、同じ招待で入れて子供も足せる
    await grantFamilyPlan(srAdmin, rep.id);
    expect(await familyOf(familyId)).toMatchObject({ plan_key: 'family_basic', member_limit: DEFAULT_MEMBER_LIMIT });
    const accepted = await acceptInvite(joiner, token);
    expect(accepted.error).toBeNull();
    const child = await addChild(rep, familyId, 'gate-child-ok');
    expect(child.error).toBeNull();
    expect((await activeMembers(familyId)).map((m) => m.role).sort()).toEqual(['adult', 'child', 'representative']);
  });

  // 79
  it('existing members stay when the plan expires; new members are refused', async () => {
    const rep = await createUser('expire-rep');
    await grantFamilyPlan(srAdmin, rep.id);
    const familyId = await mustCreateFamily(rep);
    const member = await createUser('expire-member');
    expect((await acceptInvite(member, await inviteToken(rep, familyId, member.email))).error).toBeNull();
    expect((await addChild(rep, familyId, 'expire-child')).error).toBeNull();
    const before = await activeMembers(familyId);
    expect(before).toHaveLength(3);

    // 契約が終わる (手動付与の取り消し): グループは free / 4 に戻るが、いるメンバーはそのまま
    await revokePlan(rep.id);
    expect(await familyOf(familyId)).toMatchObject({ plan_key: 'free', member_limit: DEFAULT_MEMBER_LIMIT, status: 'active' });
    expect(await activeMembers(familyId)).toEqual(before);

    // 新しいメンバーは足せない (招待の承諾・子供の追加)
    const late = await createUser('expire-late');
    const lateToken = await inviteToken(rep, familyId, late.email);
    expect((await acceptInvite(late, lateToken)).error).toMatchObject({ code: 'P0001', message: 'FAMILY_PLAN_REQUIRED' });
    expect((await addChild(rep, familyId, 'expire-late-child')).error).toMatchObject({ code: 'P0001', message: 'FAMILY_PLAN_REQUIRED' });
    expect(await activeMembers(familyId)).toEqual(before);

    // いるメンバーは外れられる (脱退は family_members の UPDATE で、門に当たらない)
    const { error: leaveError } = await asUser(member.jwt).rpc('leave_family');
    expect(leaveError).toBeNull();
    expect((await activeMembers(familyId)).map((m) => m.user_id)).not.toContain(member.id);
  });

  // 105
  it('accept_child_promotion succeeds in a free group (an UPDATE of the existing child row, not gated) and leaves the number of members unchanged', async () => {
    const rep = await createUser('promotion-rep');
    await grantFamilyPlan(srAdmin, rep.id);
    const familyId = await mustCreateFamily(rep);
    const child = await addChild(rep, familyId, 'promotion-child');
    expect(child.error).toBeNull();
    const childId = (child.data as { id: string }).id;
    const target = await createUser('promotion-target');
    const request = await asUser(rep.jwt).rpc('request_child_promotion', { p_member_id: childId, p_email: target.email });
    expect(request.error).toBeNull();
    const token = (request.data as { token: string }).token;

    // 契約が終わってグループが free になっても、昇格は通る (人数は変わらない)
    await revokePlan(rep.id);
    expect((await familyOf(familyId)).plan_key).toBe('free');
    const before = await activeMembers(familyId);
    const accepted = await asUser(target.jwt).rpc('accept_child_promotion', { p_token: token });
    expect(accepted.error).toBeNull();
    expect(accepted.data).toMatchObject({ id: childId, user_id: target.id, role: 'adult' });
    const after = await activeMembers(familyId);
    expect(after).toHaveLength(before.length);
    expect(after.find((m) => m.id === childId)).toMatchObject({ user_id: target.id, role: 'adult' });
  });
});
