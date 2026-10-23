/**
 * #1912 (C36): family_invites への利用者 (anon / authenticated) からの直接の書き込みを外し、招待の作成・取り消しを RPC だけにする
 * (migration 20261022150000_family_invites_rpc_only_writes.sql)。
 *
 * 修正前は、ポリシー family_invites_insert_adult / family_invites_update_adult と anon / authenticated の書き込みの権限により、
 * その家族の active な代表者・大人が PostgREST の直接の INSERT で招待の行を作れ (家族プランの無いグループでも)、
 * create_family_invite の門 (FAMILY_PLAN_REQUIRED・MEMBER_LIMIT_EXCEEDED・RATE_LIMITED・作成の監査ログ) を通らなかった。
 * 招待のどの列も直接 UPDATE できた。
 *
 * 確かめること:
 *   - 直接の INSERT / UPDATE / DELETE は、代表者・大人・別の家族・未認証のだれでも 42501 で止まり、行は作られず・変わらない
 *     (家族プランの無いグループでも、あるグループでも)
 *   - RPC 経由の作成 (create_family_invite)・取り消し (revoke_family_invite)・拒否 (reject_family_invite)・承諾 (accept_family_invite) は
 *     今までどおり通る。家族プランの無いグループでの RPC の作成は FAMILY_PLAN_REQUIRED のまま
 *   - SELECT (招待の一覧の画面が読む) は今までどおり代表者・大人だけが読める
 *   - 家族の行の DELETE (#1917 から service_role と解散から 90 日の purge だけ) の外部キーの CASCADE は、招待の行も一緒に消す
 *     (利用者から family_invites の DELETE の権限を外しても、CASCADE は表の所有者の権限で動く)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/family-invites-rpc-only-writes.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { grantFamilyPlan } from '../helpers/family-plan';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
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

/** 権限が無い書き込み (permission denied) と、RLS の WITH CHECK 違反の SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 直接の INSERT で入れようとする招待の期限 (create_family_invite と同じ 14 日。値そのものは判定に関わらない) */
const DIRECT_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** 直接の UPDATE で書こうとする、先へ延ばした期限 (今から 1 年) */
const EXTENDED_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒。利用者・家族を複数作る) */
const SETUP_TIMEOUT_MS = 120_000;

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

interface InviteRow {
  id: string;
  family_id: string;
  email: string;
  token: string;
  status: string;
  expires_at: string;
  invited_role: string;
  revoked_by: string | null;
}

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
let seq = 0;

const recipient = (label: string) => `rls-fam-inv-rpc-only-${label}-${RUN}-${++seq}@homegohan.test`;

async function createUser(label: string): Promise<TestUser> {
  const email = recipient(`user-${label}`);
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `inv-rpc-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

/** 家族プランを付与した代表者が create_family_group で作るグループ (plan_key = family_basic) */
async function createPaidFamily(rep: TestUser): Promise<string> {
  await grantFamilyPlan(srAdmin, rep.id);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', { p_name: `inv-rpc-only paid ${RUN} ${++seq}`, p_plan_key: 'free' });
  if (error || !data) throw new Error(`create_family_group: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  return familyId;
}

/** 家族プランの無い代表者のグループを service_role で直接作る (作成のトリガーが plan_key = free にする。#1912 の再現の形) */
async function createFreeFamily(rep: TestUser): Promise<string> {
  const { data, error } = await srAdmin
    .from('family_groups')
    .insert({ name: `inv-rpc-only free ${RUN} ${++seq}`, representative_id: rep.id })
    .select('id, plan_key')
    .single();
  if (error || !data) throw new Error(`family_groups: ${error?.message}`);
  const row = data as { id: string; plan_key: string };
  if (row.plan_key !== 'free') throw new Error(`前提: 契約の無い代表者のグループは free になる (実際は ${row.plan_key})`);
  createdFamilyIds.push(row.id);
  const { error: repError } = await srAdmin.from('family_members').insert({ family_id: row.id, user_id: rep.id, role: 'representative', status: 'active' });
  if (repError) throw new Error(`family_members representative: ${repError.message}`);
  const { error: profileError } = await srAdmin.from('user_profiles').update({ family_id: row.id }).eq('id', rep.id);
  if (profileError) throw new Error(`user_profiles.family_id: ${profileError.message}`);
  return row.id;
}

async function inviteViaRpc(inviter: TestUser, familyId: string, email: string): Promise<InviteRow> {
  const { data, error } = await asUser(inviter.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: email });
  if (error || !data) throw new Error(`create_family_invite: ${error?.message}`);
  return data as InviteRow;
}

async function inviteRowById(id: string): Promise<InviteRow | null> {
  const { data, error } = await srAdmin.from('family_invites').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`family_invites: ${error.message}`);
  return (data as InviteRow | null) ?? null;
}

async function inviteRowsFor(familyId: string, email: string): Promise<InviteRow[]> {
  const { data, error } = await srAdmin.from('family_invites').select('*').eq('family_id', familyId).eq('email', email.toLowerCase());
  if (error) throw new Error(`family_invites: ${error.message}`);
  return (data ?? []) as InviteRow[];
}

/** PostgREST に直接送る招待の行 (RPC を通らない作成。token・status・期限を呼び出し元が決める) */
function directInviteRow(familyId: string, inviter: TestUser, email: string) {
  return {
    family_id: familyId,
    email,
    token: `rls-fam-inv-rpc-only-${RUN}-${++seq}`,
    invited_role: 'adult',
    status: 'pending',
    expires_at: new Date(Date.now() + DIRECT_INVITE_TTL_MS).toISOString(),
    invited_by: inviter.id,
  };
}

let paidRep: TestUser;
let adult: TestUser;
let otherRep: TestUser;
let freeRep: TestUser;
let paidFamily: string;
let otherFamily: string;
let freeFamily: string;
/** 家族 paidFamily の pending の招待 (RPC で作る。直接の UPDATE / DELETE の対象) */
let pendingInvite: InviteRow;

beforeAll(async () => {
  paidRep = await createUser('paid-rep');
  adult = await createUser('adult');
  otherRep = await createUser('other-rep');
  freeRep = await createUser('free-rep');
  paidFamily = await createPaidFamily(paidRep);
  otherFamily = await createPaidFamily(otherRep);
  freeFamily = await createFreeFamily(freeRep);

  // 大人のメンバーは、RPC の招待の作成 → 承諾で入れる (今までどおりの経路)
  const adultInvite = await inviteViaRpc(paidRep, paidFamily, adult.email);
  const { error: acceptError } = await asUser(adult.jwt).rpc('accept_family_invite', { p_token: adultInvite.token });
  if (acceptError) throw new Error(`accept_family_invite (adult): ${acceptError.message}`);

  pendingInvite = await inviteViaRpc(paidRep, paidFamily, recipient('pending'));
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin.from('user_profiles').update({ family_id: null }).in('id', createdUserIds);
  }
  // family_members / family_invites は family_groups の削除で CASCADE。representative_id は RESTRICT のため家族を先に消す
  if (createdFamilyIds.length > 0) await srAdmin.from('family_groups').delete().in('id', createdFamilyIds);
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, SETUP_TIMEOUT_MS);

describe('#1912 family_invites の直接の INSERT は、だれでも 42501 で止まり、行は作られない', () => {
  it('D-1: 家族プランの無いグループの代表者 (#1912 の再現の形) は直接作れない。RPC も FAMILY_PLAN_REQUIRED のまま', async () => {
    const email = recipient('d1');
    const { data, error } = await asUser(freeRep.jwt).from('family_invites').insert(directInviteRow(freeFamily, freeRep, email)).select('id');
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(data).toBeNull();
    expect(await inviteRowsFor(freeFamily, email)).toEqual([]);

    const viaRpc = await asUser(freeRep.jwt).rpc('create_family_invite', { p_family_id: freeFamily, p_email: email });
    expect(viaRpc.error?.message).toBe('FAMILY_PLAN_REQUIRED');
    expect(await inviteRowsFor(freeFamily, email)).toEqual([]);
  });

  it('D-2: 家族プランのあるグループの代表者も直接は作れない', async () => {
    const email = recipient('d2');
    const { data, error } = await asUser(paidRep.jwt).from('family_invites').insert(directInviteRow(paidFamily, paidRep, email)).select('id');
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(data).toBeNull();
    expect(await inviteRowsFor(paidFamily, email)).toEqual([]);
  });

  it('D-3: 大人のメンバーも直接は作れない', async () => {
    const email = recipient('d3');
    const { data, error } = await asUser(adult.jwt).from('family_invites').insert(directInviteRow(paidFamily, adult, email)).select('id');
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(data).toBeNull();
    expect(await inviteRowsFor(paidFamily, email)).toEqual([]);
  });

  it('D-4: 別の家族の代表者・未認証 (anon) も作れない', async () => {
    const email = recipient('d4');
    const fromOther = await asUser(otherRep.jwt).from('family_invites').insert(directInviteRow(paidFamily, otherRep, email));
    expect(fromOther.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const fromAnon = await anon().from('family_invites').insert(directInviteRow(paidFamily, paidRep, email));
    expect(fromAnon.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await inviteRowsFor(paidFamily, email)).toEqual([]);
  });
});

describe('#1912 family_invites の直接の UPDATE / DELETE は、だれでも 42501 で止まり、行は変わらない', () => {
  it('D-5: 代表者・大人は、自分の家族の招待の status・期限・宛先・役割を直接は書き換えられない', async () => {
    const extended = new Date(Date.now() + EXTENDED_EXPIRY_MS).toISOString();
    const changes = [
      { status: 'revoked' },
      { expires_at: extended },
      { email: recipient('d5-redirect') },
      { token: `rls-fam-inv-rpc-only-d5-${RUN}` },
    ];
    for (const user of [paidRep, adult]) {
      for (const change of changes) {
        const { data, error } = await asUser(user.jwt).from('family_invites').update(change).eq('id', pendingInvite.id).select('id');
        expect(error?.code, `${JSON.stringify(change)}`).toBe(INSUFFICIENT_PRIVILEGE);
        expect(data).toBeNull();
      }
    }
    expect(await inviteRowById(pendingInvite.id)).toEqual(pendingInvite);
  });

  it('D-6: 別の家族の代表者・未認証 (anon) も書き換えられない', async () => {
    const fromOther = await asUser(otherRep.jwt).from('family_invites').update({ status: 'revoked' }).eq('id', pendingInvite.id);
    expect(fromOther.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const fromAnon = await anon().from('family_invites').update({ status: 'revoked' }).eq('id', pendingInvite.id);
    expect(fromAnon.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await inviteRowById(pendingInvite.id)).toEqual(pendingInvite);
  });

  it('D-7: 代表者・大人・未認証は招待の行を直接は消せない', async () => {
    for (const c of [asUser(paidRep.jwt), asUser(adult.jwt), anon()]) {
      const { error } = await c.from('family_invites').delete().eq('id', pendingInvite.id);
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await inviteRowById(pendingInvite.id)).toEqual(pendingInvite);
  });
});

describe('#1912 RPC 経由の作成・取り消し・拒否・承諾と、一覧の SELECT は今までどおり', () => {
  it('R-1: 代表者・大人は create_family_invite で招待を作れ、作成の監査ログが残る', async () => {
    for (const inviter of [paidRep, adult]) {
      const email = recipient('r1');
      const invite = await inviteViaRpc(inviter, paidFamily, email);
      expect(invite).toMatchObject({ family_id: paidFamily, email: email.toLowerCase(), status: 'pending', invited_role: 'adult' });
      expect(await inviteRowsFor(paidFamily, email)).toEqual([invite]);
      const { data: audit, error } = await srAdmin
        .from('membership_audit')
        .select('actor_id')
        .eq('action', 'invite_created')
        .eq('scope_id', paidFamily)
        .contains('metadata', { invite_id: invite.id });
      expect(error).toBeNull();
      expect(audit).toEqual([{ actor_id: inviter.id }]);
    }
  });

  it('R-2: 同じ宛先への再招待は、RPC の中で前の pending の招待を revoked にする (RPC の UPDATE は権限を外した後も動く)', async () => {
    const email = recipient('r2');
    const first = await inviteViaRpc(paidRep, paidFamily, email);
    const second = await inviteViaRpc(paidRep, paidFamily, email);
    expect(second.id).not.toBe(first.id);
    expect(await inviteRowById(first.id)).toMatchObject({ status: 'revoked', revoked_by: paidRep.id });
    expect(await inviteRowById(second.id)).toMatchObject({ status: 'pending' });
  });

  it('R-3: 大人は revoke_family_invite で招待を取り消せる', async () => {
    const invite = await inviteViaRpc(paidRep, paidFamily, recipient('r3'));
    const { data, error } = await asUser(adult.jwt).rpc('revoke_family_invite', { p_invite_id: invite.id });
    expect(error).toBeNull();
    expect(data).toMatchObject({ id: invite.id, status: 'revoked', revoked_by: adult.id });
    expect(await inviteRowById(invite.id)).toMatchObject({ status: 'revoked', revoked_by: adult.id });
  });

  it('R-4: 招待された本人は reject_family_invite で拒否でき、accept_family_invite で承諾できる', async () => {
    const rejecter = await createUser('rejecter');
    const rejectInvite = await inviteViaRpc(paidRep, paidFamily, rejecter.email);
    const rejected = await asUser(rejecter.jwt).rpc('reject_family_invite', { p_token: rejectInvite.token });
    expect(rejected.error).toBeNull();
    expect(await inviteRowById(rejectInvite.id)).toMatchObject({ status: 'rejected' });

    const joiner = await createUser('joiner');
    const joinInvite = await inviteViaRpc(paidRep, paidFamily, joiner.email);
    const accepted = await asUser(joiner.jwt).rpc('accept_family_invite', { p_token: joinInvite.token });
    expect(accepted.error).toBeNull();
    expect(await inviteRowById(joinInvite.id)).toMatchObject({ status: 'accepted' });
    const { data: member } = await srAdmin
      .from('family_members')
      .select('role, status')
      .eq('family_id', paidFamily)
      .eq('user_id', joiner.id)
      .single();
    expect(member).toEqual({ role: 'adult', status: 'active' });
  });

  it('R-5: 代表者・大人は自分の家族の招待を読め、別の家族の代表者・未認証は読めない (SELECT のポリシーは変えていない)', async () => {
    const visibleTo = async (c: SupabaseClient) => {
      const { data, error } = await c.from('family_invites').select('id').eq('id', pendingInvite.id);
      expect(error).toBeNull();
      return (data ?? []).map((r) => (r as { id: string }).id);
    };
    expect(await visibleTo(asUser(paidRep.jwt))).toEqual([pendingInvite.id]);
    expect(await visibleTo(asUser(adult.jwt))).toEqual([pendingInvite.id]);
    expect(await visibleTo(asUser(otherRep.jwt))).toEqual([]);
    expect(await visibleTo(anon())).toEqual([]);
  });
});

describe('#1912 家族の行の DELETE は、招待の行も CASCADE で消す', () => {
  it('C-1: 利用者から family_invites の DELETE の権限を外しても、家族の行の DELETE の CASCADE は招待を消す (#1917 から代表者は家族の行を直接消せず、消すのは service_role)', async () => {
    const invite = await inviteViaRpc(otherRep, otherFamily, recipient('c1'));
    expect(await inviteRowById(invite.id)).not.toBeNull();

    // #1917: 代表者の直接の DELETE は 42501 で止まり、家族の行と招待は残る
    const denied = await asUser(otherRep.jwt).from('family_groups').delete().eq('id', otherFamily).select('id');
    expect(denied.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await inviteRowById(invite.id)).not.toBeNull();

    const { data, error } = await srAdmin.from('family_groups').delete().eq('id', otherFamily).select('id');
    expect(error).toBeNull();
    expect(data).toEqual([{ id: otherFamily }]);
    expect(await inviteRowById(invite.id)).toBeNull();
  });
});
