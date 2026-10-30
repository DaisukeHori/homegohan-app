/**
 * #2128 V3: 組織のメンバーの名前の一覧の並びを、実物の PostgREST で確かめる。
 *
 * GET /api/org/members と GET /api/org/owner-transfer/candidates は、service_role の問い合わせに orderOrgMemberList
 * (src/lib/membership/org-member-list-order.ts) で 3 つの order を重ねる:
 *   参加した日 (joined_org_at・date) の昇順 (空は最後) → 組織内の役割 (org_role・enum) の昇順 → id の昇順
 * 役割の昇順がオーナー → 管理者 → メンバーになるのは、PostgreSQL が enum を宣言の順で並べるから
 * (文字列の順なら admin → member → owner)。ここでは route と同じ問い合わせ (同じ列・同じ絞り込み・orderOrgMemberList) を
 * ローカルの PostgREST に送り、次を確かめる:
 *   - 同じ日に参加した人は、オーナー → 管理者 → メンバーの順で、その中は id の順
 *   - 前の日に参加した人が先で、参加した日が空の人 (承認待ちなど) は最後 (その中も id の順)
 *   - オーナーの譲渡の候補 (自分とオーナーを除く) も同じ並び
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/org-member-list-order.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { orderOrgMemberList } from '@/lib/membership/org-member-list-order';
import { ORG_MEMBER_NAME_COLUMNS, OrgMemberNameSchema } from '@/schemas/membership/organization-member-name';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);

/** 成人の生年月日 (プロフィールの行を作るための値。並びには関わらない) */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 同じ日に参加した人たちの参加した日 */
const SAME_DAY = '2026-10-20';
/** それより前の日 */
const EARLIER_DAY = '2026-10-19';
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒。利用者を 8 人と組織を 1 つ作る) */
const SETUP_TIMEOUT_MS = 180_000;

type OrgRole = 'owner' | 'admin' | 'member';

interface Seeded {
  id: string;
  role: OrgRole;
  joinedOrgAt: string | null;
}

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
let seq = 0;

async function createUser(label: string): Promise<string> {
  const email = `rls-org-member-order-${label}-${RUN}-${++seq}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      { id: data.user.id, nickname: `org-member-order-${label}`, age_group: '30s', gender: 'other', birth_date: ADULT_BIRTH_DATE },
      { onConflict: 'id' },
    ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  return data.user.id;
}

/** 組織の所属を service_role で書く (参加した日を指定する。空なら承認待ちなどの、参加した日が無い行) */
async function joinOrg(userId: string, orgId: string, role: OrgRole, joinedOrgAt: string | null): Promise<void> {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: role, is_active_in_org: joinedOrgAt !== null, joined_org_at: joinedOrgAt })
    .eq('id', userId);
  if (error) throw new Error(`membership ${userId}: ${error.message}`);
}

/** route (GET /api/org/members) と同じ問い合わせ */
async function listMembers(orgId: string) {
  const { data, error } = await orderOrgMemberList(
    srAdmin.from('user_profiles').select(ORG_MEMBER_NAME_COLUMNS).eq('organization_id', orgId),
  );
  if (error) throw new Error(`members: ${error.message}`);
  return OrgMemberNameSchema.array().parse(data ?? []);
}

/** route (GET /api/org/owner-transfer/candidates) と同じ問い合わせ */
async function listCandidates(orgId: string, ownerId: string) {
  const { data, error } = await orderOrgMemberList(
    srAdmin
      .from('user_profiles')
      .select(ORG_MEMBER_NAME_COLUMNS)
      .eq('organization_id', orgId)
      .neq('id', ownerId)
      .neq('org_role', 'owner'),
  );
  if (error) throw new Error(`candidates: ${error.message}`);
  return OrgMemberNameSchema.array().parse(data ?? []);
}

/** id の昇順 (PostgreSQL の uuid の並びは、小文字の 16 進の文字列の並びと同じ) */
function byId(a: Seeded, b: Seeded): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

let orgId: string;
let owner: Seeded;
const sameDayAdmins: Seeded[] = [];
const sameDayMembers: Seeded[] = [];
let earlierMember: Seeded;
const pending: Seeded[] = [];

beforeAll(async () => {
  owner = { id: await createUser('owner'), role: 'owner', joinedOrgAt: SAME_DAY };
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({ name: `org-member-order ${RUN}`, owner_id: owner.id })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organizations: ${error?.message}`);
  orgId = (data as { id: string }).id;
  createdOrgIds.push(orgId);

  // 作る順 (= 行の挿入の順) は、期待する並びと違うようにする: メンバー → 承認待ち → 管理者 → 前の日 → オーナー
  for (const label of ['member-1', 'member-2']) {
    sameDayMembers.push({ id: await createUser(label), role: 'member', joinedOrgAt: SAME_DAY });
  }
  for (const label of ['pending-1', 'pending-2']) {
    pending.push({ id: await createUser(label), role: 'member', joinedOrgAt: null });
  }
  for (const label of ['admin-1', 'admin-2']) {
    sameDayAdmins.push({ id: await createUser(label), role: 'admin', joinedOrgAt: SAME_DAY });
  }
  earlierMember = { id: await createUser('earlier'), role: 'member', joinedOrgAt: EARLIER_DAY };

  for (const seeded of [...sameDayMembers, ...pending, ...sameDayAdmins, earlierMember, owner]) {
    await joinOrg(seeded.id, orgId, seeded.role, seeded.joinedOrgAt);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false, joined_org_at: null })
      .in('id', createdUserIds);
  }
  if (createdOrgIds.length > 0) await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, SETUP_TIMEOUT_MS);

describe('#2128 V3 組織のメンバーの名前の一覧の並び (実物の PostgREST)', () => {
  it('メンバーの一覧: 前の日の人 → 同じ日のオーナー → 管理者 (id の順) → メンバー (id の順) → 参加した日が空の人 (id の順)', async () => {
    const members = await listMembers(orgId);

    const expected = [
      earlierMember,
      owner,
      ...[...sameDayAdmins].sort(byId),
      ...[...sameDayMembers].sort(byId),
      ...[...pending].sort(byId),
    ];
    expect(members.map((member) => member.id)).toEqual(expected.map((seeded) => seeded.id));
    expect(members.map((member) => member.org_role)).toEqual(expected.map((seeded) => seeded.role));
    expect(members.map((member) => member.joined_org_at)).toEqual(expected.map((seeded) => seeded.joinedOrgAt));
  });

  it('同じ日のオーナーは、文字列の順なら後ろの owner でも、管理者・メンバーより先 (enum の宣言の順で並ぶ)', async () => {
    const members = await listMembers(orgId);
    const sameDayRoles = members.filter((member) => member.joined_org_at === SAME_DAY).map((member) => member.org_role);

    expect(sameDayRoles).toEqual(['owner', 'admin', 'admin', 'member', 'member']);
  });

  it('2 回読んでも同じ順 (読み込みのたびに入れ替わらない)', async () => {
    const first = await listMembers(orgId);
    const second = await listMembers(orgId);

    expect(second.map((member) => member.id)).toEqual(first.map((member) => member.id));
  });

  it('オーナーの譲渡の候補: 前の日の人 → 同じ日の管理者 (id の順) → メンバー (id の順) → 参加した日が空の人 (id の順)', async () => {
    const candidates = await listCandidates(orgId, owner.id);

    const expected = [
      earlierMember,
      ...[...sameDayAdmins].sort(byId),
      ...[...sameDayMembers].sort(byId),
      ...[...pending].sort(byId),
    ];
    expect(candidates.map((candidate) => candidate.id)).toEqual(expected.map((seeded) => seeded.id));
  });
});
