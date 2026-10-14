/**
 * #1236 / #1237 オーナー・代表者の移譲承諾で、承諾時点の所属を再検証することの回帰テスト
 *
 * 修正前の accept_org_owner_transfer / accept_family_representative_transfer (20260711120000) は
 * pending proposal の宛先 (to_user_id = auth.uid()) であることしか確認せず、
 * 提案を受けた後に組織 / 家族を抜けたユーザーが古い提案を承諾すると
 * owner_id / representative_id を奪取できた (DELETE ポリシー経由で組織削除・家族の CASCADE 削除も可能)。
 *
 * 期待する挙動 (修正後):
 *   - 承諾者が今も対象組織のメンバーでなければ 403 TRANSFER_ACCEPTOR_NOT_IN_ORG
 *   - 承諾者が今も対象家族の active な representative / adult でなければ 403 TRANSFER_ACCEPTOR_NOT_IN_FAMILY
 *   - どちらの場合も owner_id / representative_id / 役割 / proposal の状態は一切変わらない
 *   - 正当なメンバーの承諾は従来どおり成立し、二重に成立しない
 *
 * API ルート (Bearer JWT) と RPC 直叩き (PostgREST) の両方で検証する。
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next dev サーバ (npm run dev) が起動済み。
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/membership-transfer-accept.test.ts
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
  const email = `sec-transfer-${label}-${TS}@homegohan.test`;
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

/** 組織の所属を service_role で設定する (特権列は本人の JWT では変更できない) */
async function setOrgMembership(userId: string, orgId: string | null, role: 'owner' | 'admin' | 'member' | null) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: role, is_active_in_org: orgId !== null })
    .eq('id', userId);
  if (error) throw new Error(`setOrgMembership: ${error.message}`);
}

async function profileOf(userId: string) {
  const { data } = await srAdmin.from('user_profiles').select('organization_id, org_role, family_id').eq('id', userId).single();
  return data!;
}

async function proposalStatus(proposalId: string): Promise<string> {
  const { data } = await srAdmin.from('ownership_transfer_proposals').select('status').eq('id', proposalId).single();
  return data!.status as string;
}

async function auditCount(action: string, proposalId: string): Promise<number> {
  const { data } = await srAdmin
    .from('membership_audit')
    .select('id')
    .eq('action', action)
    .contains('metadata', { proposal_id: proposalId });
  return (data ?? []).length;
}

type ErrorBody = { error?: { code?: string; message?: string } };

afterAll(async () => {
  // 組織の owner_id / 家族の representative_id は auth.users を RESTRICT で参照するため先に消す
  if (orgA) await srAdmin.from('organizations').delete().in('id', [orgA, orgB].filter(Boolean));
  if (familyId) await srAdmin.from('family_groups').delete().eq('id', familyId);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

// ================================================================
// #1236 組織オーナー移譲
// ================================================================
let orgA = '';
let orgB = '';

describe('#1236 accept_org_owner_transfer: 承諾時点の所属を再検証する', () => {
  let owner: TestUser;
  let leaver: TestUser; // 提案後に脱退する攻撃者
  let mover: TestUser; // 提案後に別組織へ移る攻撃者
  let expiring: TestUser;
  let legit: TestUser;

  async function propose(toUserId: string): Promise<string> {
    const { data, error } = await asUser(owner.jwt).rpc('propose_org_owner_transfer', {
      p_organization_id: orgA,
      p_to_user_id: toUserId,
    });
    if (error) throw new Error(`propose: ${error.message}`);
    return data as string;
  }

  async function orgOwnerId(orgId: string): Promise<string | null> {
    const { data } = await srAdmin.from('organizations').select('owner_id').eq('id', orgId).single();
    return (data?.owner_id as string | null) ?? null;
  }

  beforeAll(async () => {
    owner = await createUser('org-owner');
    leaver = await createUser('org-leaver');
    mover = await createUser('org-mover');
    expiring = await createUser('org-expiring');
    legit = await createUser('org-legit');

    const { data: a, error: ea } = await srAdmin
      .from('organizations')
      .insert({ name: `#1236 Org A ${TS}`, owner_id: owner.id })
      .select('id')
      .single();
    if (ea || !a) throw new Error(`org A: ${ea?.message}`);
    orgA = a.id as string;
    const { data: b, error: eb } = await srAdmin
      .from('organizations')
      .insert({ name: `#1236 Org B ${TS}` })
      .select('id')
      .single();
    if (eb || !b) throw new Error(`org B: ${eb?.message}`);
    orgB = b.id as string;

    await setOrgMembership(owner.id, orgA, 'owner');
    for (const u of [leaver, mover, expiring, legit]) {
      await setOrgMembership(u.id, orgA, 'member');
    }
  }, 120_000);

  it('E1: 提案後に leave_org で脱退したユーザーは承諾できない (API: 403 TRANSFER_ACCEPTOR_NOT_IN_ORG)', async () => {
    const proposalId = await propose(leaver.id);
    const { error: leaveError } = await asUser(leaver.jwt).rpc('leave_org');
    expect(leaveError).toBeNull();

    const res = await apiCall<ErrorBody>('POST', `/api/org/owner-transfer/${proposalId}/accept`, leaver.jwt);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('TRANSFER_ACCEPTOR_NOT_IN_ORG');
    // 生のエラーコードを画面に出さない (友好メッセージ)
    expect(res.body.error?.message).not.toContain('TRANSFER_ACCEPTOR');

    // 何も奪取されていない (★(A) を消す退行や (B) より後に置く退行で落ちる)
    expect(await orgOwnerId(orgA)).toBe(owner.id);
    expect((await profileOf(owner.id)).org_role).toBe('owner');
    expect((await profileOf(leaver.id)).org_role).toBeNull();
    expect(await proposalStatus(proposalId)).toBe('pending');

    // RPC を直接叩いても同じく拒否される
    const { error: rpcError } = await asUser(leaver.jwt).rpc('accept_org_owner_transfer', { p_proposal_id: proposalId });
    expect(rpcError?.message).toContain('TRANSFER_ACCEPTOR_NOT_IN_ORG');
    expect(await orgOwnerId(orgA)).toBe(owner.id);
    expect(await proposalStatus(proposalId)).toBe('pending');

    // 影響: 組織の削除もできない (owner_id を奪取されていないため DELETE ポリシーを通らない)
    const { data: deleted } = await asUser(leaver.jwt).from('organizations').delete().eq('id', orgA).select('id');
    expect(deleted ?? []).toEqual([]);
    expect(await orgOwnerId(orgA)).toBe(owner.id);
  });

  it('E2: 提案後に別組織へ移ったユーザーは承諾できない (403、移籍先でも owner にならない)', async () => {
    const proposalId = await propose(mover.id);
    await setOrgMembership(mover.id, orgB, 'member'); // accept_org_invite による移籍と同じ状態

    const res = await apiCall<ErrorBody>('POST', `/api/org/owner-transfer/${proposalId}/accept`, mover.jwt);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('TRANSFER_ACCEPTOR_NOT_IN_ORG');

    expect(await orgOwnerId(orgA)).toBe(owner.id);
    const moverProfile = await profileOf(mover.id);
    expect(moverProfile.organization_id).toBe(orgB);
    expect(moverProfile.org_role).toBe('member');
    expect(await proposalStatus(proposalId)).toBe('pending');
  });

  it('E5: 期限切れの提案は 410 TRANSFER_PROPOSAL_EXPIRED で、承諾は成立しない', async () => {
    const proposalId = await propose(expiring.id);
    await srAdmin.from('ownership_transfer_proposals').update({ expires_at: '2020-01-01T00:00:00Z' }).eq('id', proposalId);

    const res = await apiCall<ErrorBody>('POST', `/api/org/owner-transfer/${proposalId}/accept`, expiring.jwt);
    expect(res.status).toBe(410);
    expect(res.body.error?.code).toBe('TRANSFER_PROPOSAL_EXPIRED');
    // RPC 内の status = 'expired' 更新は直後の RAISE でロールバックされる (修正前から同じ挙動)。
    // 期限は毎回 expires_at で判定されるため、pending のままでも承諾は成立しない
    expect(await proposalStatus(proposalId)).not.toBe('accepted');
    expect(await orgOwnerId(orgA)).toBe(owner.id);
  });

  it('E6: 他人宛て・存在しない提案は 404 TRANSFER_PROPOSAL_NOT_FOUND', async () => {
    const proposalId = await propose(legit.id);
    const notMine = await apiCall<ErrorBody>('POST', `/api/org/owner-transfer/${proposalId}/accept`, expiring.jwt);
    expect(notMine.status).toBe(404);
    expect(notMine.body.error?.code).toBe('TRANSFER_PROPOSAL_NOT_FOUND');

    const missing = await apiCall<ErrorBody>(
      'POST',
      '/api/org/owner-transfer/00000000-0000-0000-0000-000000000000/accept',
      legit.jwt,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe('TRANSFER_PROPOSAL_NOT_FOUND');
    expect(await proposalStatus(proposalId)).toBe('pending');
  });

  it('P15: anon は承諾 RPC を実行できない', async () => {
    const { error } = await anon().rpc('accept_org_owner_transfer', {
      p_proposal_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('E3: 現メンバーの承諾は成立する (200、owner 入れ替え)', async () => {
    const proposalId = await propose(legit.id);
    const res = await apiCall<{ ok?: boolean }>('POST', `/api/org/owner-transfer/${proposalId}/accept`, legit.jwt);
    expect(res.status).toBe(200);

    expect(await orgOwnerId(orgA)).toBe(legit.id);
    expect((await profileOf(legit.id)).org_role).toBe('owner');
    expect((await profileOf(owner.id)).org_role).toBe('admin');
    expect(await proposalStatus(proposalId)).toBe('accepted');
    expect(await auditCount('owner_transferred', proposalId)).toBe(1);

    // E4: 同じ提案を続けて承諾しても二重には成立しない (pending でないため 404)
    const again = await apiCall<ErrorBody>('POST', `/api/org/owner-transfer/${proposalId}/accept`, legit.jwt);
    expect(again.status).toBe(404);
    expect(again.body.error?.code).toBe('TRANSFER_PROPOSAL_NOT_FOUND');
    expect(await auditCount('owner_transferred', proposalId)).toBe(1);
  });

  it('E4: 同時に何度承諾されても成立は 1 回だけ (TOCTOU)', async () => {
    // 現 owner (legit) から元 owner (admin) へ移譲を提案し、元 owner が並列で承諾する
    const { data: proposalId, error } = await asUser(legit.jwt).rpc('propose_org_owner_transfer', {
      p_organization_id: orgA,
      p_to_user_id: owner.id,
    });
    expect(error).toBeNull();

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        asUser(owner.jwt).rpc('accept_org_owner_transfer', { p_proposal_id: proposalId }),
      ),
    );
    const ok = results.filter((r) => !r.error);
    expect(ok).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) {
      expect(r.error!.message).toMatch(/TRANSFER_PROPOSAL_NOT_FOUND|TRANSFER_NOT_PENDING/);
    }
    expect(await auditCount('owner_transferred', proposalId as string)).toBe(1);
    expect(await orgOwnerId(orgA)).toBe(owner.id);
  });
});

// ================================================================
// #1237 家族代表者移譲
// ================================================================
let familyId = '';

describe('#1237 accept_family_representative_transfer: 承諾時点の所属を再検証する', () => {
  let rep: TestUser;
  let leaver: TestUser;
  let demoted: TestUser;
  let expiring: TestUser;
  let legit: TestUser;

  async function addAdult(userId: string, label: string) {
    const { error } = await srAdmin
      .from('family_members')
      .insert({ family_id: familyId, user_id: userId, role: 'adult', status: 'active', display_name: label });
    if (error) throw new Error(`addAdult ${label}: ${error.message}`);
    await srAdmin.from('user_profiles').update({ family_id: familyId }).eq('id', userId);
  }

  async function propose(toUserId: string): Promise<string> {
    const { data, error } = await asUser(rep.jwt).rpc('propose_family_representative_transfer', {
      p_family_id: familyId,
      p_to_user_id: toUserId,
    });
    if (error) throw new Error(`propose: ${error.message}`);
    return data as string;
  }

  async function representativeId(): Promise<string | null> {
    const { data } = await srAdmin.from('family_groups').select('representative_id').eq('id', familyId).single();
    return (data?.representative_id as string | null) ?? null;
  }

  async function memberRole(userId: string): Promise<string | null> {
    const { data } = await srAdmin
      .from('family_members')
      .select('role')
      .eq('family_id', familyId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();
    return (data?.role as string | undefined) ?? null;
  }

  beforeAll(async () => {
    rep = await createUser('fam-rep');
    leaver = await createUser('fam-leaver');
    demoted = await createUser('fam-demoted');
    expiring = await createUser('fam-expiring');
    legit = await createUser('fam-legit');

    const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
      p_name: `#1237 Family ${TS}`,
      p_plan_key: 'free',
    });
    if (error || !data) throw new Error(`create_family_group: ${error?.message}`);
    familyId = (data as { id: string }).id;

    await addAdult(leaver.id, 'leaver');
    await addAdult(demoted.id, 'demoted');
    await addAdult(expiring.id, 'expiring');
    await addAdult(legit.id, 'legit');
  }, 120_000);

  it('E1: 提案後に leave_family で脱退したユーザーは承諾できない (API: 403 TRANSFER_ACCEPTOR_NOT_IN_FAMILY)', async () => {
    const proposalId = await propose(leaver.id);
    const { error: leaveError } = await asUser(leaver.jwt).rpc('leave_family');
    expect(leaveError).toBeNull();

    const res = await apiCall<ErrorBody>(
      'POST',
      `/api/family/representative-transfer/${proposalId}/accept`,
      leaver.jwt,
    );
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('TRANSFER_ACCEPTOR_NOT_IN_FAMILY');
    expect(res.body.error?.message).not.toContain('TRANSFER_ACCEPTOR');

    // 何も奪取されていない (representative_id が奪われると DELETE CASCADE で家族ごと消せる)
    expect(await representativeId()).toBe(rep.id);
    expect(await memberRole(rep.id)).toBe('representative');
    expect(await proposalStatus(proposalId)).toBe('pending');

    const { error: rpcError } = await asUser(leaver.jwt).rpc('accept_family_representative_transfer', {
      p_proposal_id: proposalId,
    });
    expect(rpcError?.message).toContain('TRANSFER_ACCEPTOR_NOT_IN_FAMILY');
    expect(await representativeId()).toBe(rep.id);

    // 影響: 家族グループを削除できない
    const { data: deleted } = await asUser(leaver.jwt).from('family_groups').delete().eq('id', familyId).select('id');
    expect(deleted ?? []).toEqual([]);
    expect(await representativeId()).toBe(rep.id);
  });

  it('E2: 提案後に child になったユーザーは承諾できない (403)', async () => {
    const proposalId = await propose(demoted.id);
    await srAdmin.from('family_members').update({ role: 'child' }).eq('family_id', familyId).eq('user_id', demoted.id);

    const res = await apiCall<ErrorBody>(
      'POST',
      `/api/family/representative-transfer/${proposalId}/accept`,
      demoted.jwt,
    );
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('TRANSFER_ACCEPTOR_NOT_IN_FAMILY');
    expect(await representativeId()).toBe(rep.id);
    expect(await proposalStatus(proposalId)).toBe('pending');
  });

  it('E5: 期限切れの提案は 410 TRANSFER_PROPOSAL_EXPIRED で、承諾は成立しない', async () => {
    const proposalId = await propose(expiring.id);
    await srAdmin.from('ownership_transfer_proposals').update({ expires_at: '2020-01-01T00:00:00Z' }).eq('id', proposalId);

    const res = await apiCall<ErrorBody>(
      'POST',
      `/api/family/representative-transfer/${proposalId}/accept`,
      expiring.jwt,
    );
    expect(res.status).toBe(410);
    expect(res.body.error?.code).toBe('TRANSFER_PROPOSAL_EXPIRED');
    // status = 'expired' 更新は RAISE でロールバックされる (組織側 E5 と同じ)
    expect(await proposalStatus(proposalId)).not.toBe('accepted');
    expect(await representativeId()).toBe(rep.id);
  });

  it('E6: 他人宛て・存在しない提案は 404 TRANSFER_PROPOSAL_NOT_FOUND', async () => {
    const proposalId = await propose(legit.id);
    const notMine = await apiCall<ErrorBody>(
      'POST',
      `/api/family/representative-transfer/${proposalId}/accept`,
      expiring.jwt,
    );
    expect(notMine.status).toBe(404);
    expect(notMine.body.error?.code).toBe('TRANSFER_PROPOSAL_NOT_FOUND');
    expect(await proposalStatus(proposalId)).toBe('pending');
  });

  it('P15: anon は承諾 RPC を実行できない', async () => {
    const { error } = await anon().rpc('accept_family_representative_transfer', {
      p_proposal_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('E3: 現メンバー (adult) の承諾は成立する (200、代表者入れ替え) / E4: 二重には成立しない', async () => {
    const proposalId = await propose(legit.id);
    const res = await apiCall('POST', `/api/family/representative-transfer/${proposalId}/accept`, legit.jwt);
    expect(res.status).toBe(200);

    expect(await representativeId()).toBe(legit.id);
    expect(await memberRole(legit.id)).toBe('representative');
    expect(await memberRole(rep.id)).toBe('adult');
    expect(await proposalStatus(proposalId)).toBe('accepted');
    expect(await auditCount('representative_transferred', proposalId)).toBe(1);

    const again = await apiCall<ErrorBody>(
      'POST',
      `/api/family/representative-transfer/${proposalId}/accept`,
      legit.jwt,
    );
    expect(again.status).toBe(404);
    expect(again.body.error?.code).toBe('TRANSFER_PROPOSAL_NOT_FOUND');
    expect(await auditCount('representative_transferred', proposalId)).toBe(1);
  });
});
