/**
 * #1309 家族のメンバーが自分の family_members.status を PostgREST から直接書き換えられ、
 * 退出・除名後に家族へ戻れる (人数上限も超える) 問題の回帰テスト
 *
 * 修正前、family_members の UPDATE ポリシー (family_members_update_self_or_adult) は「自分の行、または自分が
 * active な代表者・大人である家族の行」を条件に、status を含む任意の列の更新を許していた。守っていたのは
 * トリガー guard_family_members_privileged の role / family_id / user_id (と、本人以外の共有設定) だけで、
 * status と removed_at は素通しだった。そのため次のことができた。
 *   - 退出 (left)・除名 (removed) された人が、自分の行を active に戻して家族に戻る。人数の上限 (member_limit) も
 *     招待の承諾も経由しないので、上限 2 の家族で active が 3 人になる。家族の active なメンバーに見せる情報
 *     (can_view_user_meals など、status = 'active' を権限の根拠にしている RLS・関数) も再び見られる。
 *   - active なメンバーが自分を left にして、leave_family の規則 (代表者は退出できない・プロフィールの family_id を外す・
 *     監査ログを残す) を迂回する。
 *   - active な大人が、代表者を含む他のメンバーを removed にして、remove_family_member の規則を迂回する。
 *
 * 修正後 (20261008090000_family_members_status_guard.sql):
 *   - トリガー guard_family_members_privileged が、ログインユーザー (authenticated / anon) による status と removed_at の
 *     変更を拒否する (42501 CANNOT_MODIFY_PRIVILEGED_COLUMN)。値を変えない更新 (今と同じ値の送り直し) は通る。
 *   - 退出・除名・解散は SECURITY DEFINER の RPC (leave_family / remove_family_member / operator_force_dissolve_family)
 *     と service_role だけが行う。再び家族に入る正規の経路は、新しい招待の承諾 (accept_family_invite。上限を確認する) だけ。
 *   - それ以外の列 (表示名・アバター色・タグ・共有設定など) の更新と、既存の RPC の動作は変わらない。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST / RPC を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/family-member-status-guard.test.ts
 *
 * 関数・トリガーの属性の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
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

/** ローカルスタックの postgres-meta で SQL を実行する (カタログの確認だけに使う。読み取り専用) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

interface Family {
  id: string;
  rep: TestUser;
  repMemberId: string;
}

interface Adult {
  user: TestUser;
  memberId: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-status-guard-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin.from('user_profiles').upsert(
    {
      id: data.user.id,
      nickname: `status-guard-${label}`,
      age_group: '30s',
      gender: 'other',
      ...(roles ? { roles } : {}),
    },
    { onConflict: 'id' },
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

async function setMemberLimit(familyId: string, memberLimit: number): Promise<void> {
  const { error } = await srAdmin.from('family_groups').update({ member_limit: memberLimit }).eq('id', familyId);
  if (error) throw new Error(`member_limit: ${error.message}`);
}

async function memberIdOf(familyId: string, userId: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('family_members')
    .select('id')
    .eq('family_id', familyId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();
  if (error || !data) throw new Error(`family_members: ${error?.message}`);
  return (data as { id: string }).id;
}

/** 代表者 rep の家族を作る (create_family_group)。人数の上限は既定で最大の 20 にしておき、必要なら下げる */
async function createFamily(label: string, memberLimit = 20): Promise<Family> {
  const rep = await createUser(`${label}-rep`);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `#1309 ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const id = (data as { id: string }).id;
  createdFamilyIds.push(id);
  await setMemberLimit(id, memberLimit);
  return { id, rep, repMemberId: await memberIdOf(id, rep.id) };
}

/** 大人を 1 人、service_role で直接 family_members に入れる (招待の流れは L3 で本物の経路を確かめる) */
async function addAdult(family: Family, label: string): Promise<Adult> {
  const user = await createUser(`${label}`);
  const { data, error } = await srAdmin
    .from('family_members')
    .insert({ family_id: family.id, user_id: user.id, role: 'adult', display_name: `adult-${label}` })
    .select('id')
    .single();
  if (error || !data) throw new Error(`family_members insert ${label}: ${error?.message}`);
  const { error: profileError } = await srAdmin.from('user_profiles').update({ family_id: family.id }).eq('id', user.id);
  if (profileError) throw new Error(`profile family_id ${label}: ${profileError.message}`);
  return { user, memberId: (data as { id: string }).id };
}

/** 子供 (アカウントなし) を代表者の add_family_child で追加する */
async function addChild(family: Family, name: string): Promise<string> {
  const { data, error } = await asUser(family.rep.jwt).rpc('add_family_child', {
    p_family_id: family.id,
    p_display_name: name,
    p_child_profile: { note: '#1309' },
  });
  if (error || !data) throw new Error(`add_family_child ${name}: ${error?.message}`);
  return (data as { id: string }).id;
}

interface MemberRow {
  id: string;
  family_id: string;
  user_id: string | null;
  role: string;
  status: string;
  removed_at: string | null;
  display_name: string | null;
  avatar_color: string;
  tags: string[];
  share_meals: boolean;
  share_health: boolean;
  share_menu: boolean;
}

async function memberRow(memberId: string): Promise<MemberRow> {
  const { data, error } = await srAdmin
    .from('family_members')
    .select('id, family_id, user_id, role, status, removed_at, display_name, avatar_color, tags, share_meals, share_health, share_menu')
    .eq('id', memberId)
    .single();
  if (error || !data) throw new Error(`family_members: ${error?.message}`);
  return data as MemberRow;
}

async function activeCount(familyId: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('family_members')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .eq('status', 'active');
  if (error) throw new Error(`family_members count: ${error.message}`);
  return count ?? 0;
}

async function profileFamilyId(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('family_id').eq('id', userId).maybeSingle();
  if (error) throw new Error(`user_profiles: ${error.message}`);
  return data ? ((data as { family_id: string | null }).family_id ?? null) : null;
}

async function auditCount(familyId: string, action: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('membership_audit')
    .select('id', { count: 'exact', head: true })
    .eq('scope', 'family')
    .eq('scope_id', familyId)
    .eq('action', action);
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return count ?? 0;
}

interface UpdateResult {
  rows: Array<{ id: string }>;
  error: { code?: string; message?: string } | null;
}

/** 本物の経路 (PostgREST + 本人の JWT) で family_members の行を直接 UPDATE する。user を省くと anon */
async function directUpdate(
  user: TestUser | null,
  memberId: string,
  patch: Record<string, unknown>,
): Promise<UpdateResult> {
  const api = user ? asUser(user.jwt) : anon();
  const { data, error } = await api.from('family_members').update(patch).eq('id', memberId).select('id');
  return { rows: (data ?? []) as Array<{ id: string }>, error };
}

/** ガードに拒否された (42501 CANNOT_MODIFY_PRIVILEGED_COLUMN で、行は 1 件も変わっていない) */
function expectGuardBlocked(res: UpdateResult) {
  expect(res.error, '直接の UPDATE が拒否されること (修正前は通ってしまう)').not.toBeNull();
  expect(res.error!.code).toBe('42501');
  expect(res.error!.message).toContain('CANNOT_MODIFY_PRIVILEGED_COLUMN');
  expect(res.rows).toEqual([]);
}

afterAll(async () => {
  if (createdFamilyIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdFamilyIds);
    // family_members / family_invites は CASCADE。family_groups.representative_id は ON DELETE RESTRICT なので家族を先に消す
    await srAdmin.from('family_groups').delete().in('id', createdFamilyIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  }
}, 120_000);

const LONG = 120_000;

describe('#1309 退出・除名した人が、自分の行の status を active に戻して家族に戻れない', () => {
  it(
    'R1: 退出 (leave_family) した人が自分の行を active に戻そうとしても拒否される。人数の上限を超えない',
    async () => {
      // 上限 2 の家族。代表者 + 大人 X。X が退出し、子供を追加して再び満員 (2/2) にする
      const fam = await createFamily('r1');
      const x = await addAdult(fam, 'r1-x');
      const left = await asUser(x.user.jwt).rpc('leave_family');
      expect(left.error).toBeNull();
      expect(left.data).toMatchObject({ id: x.memberId, status: 'left' });
      await addChild(fam, 'r1-child');
      await setMemberLimit(fam.id, 2);
      expect(await activeCount(fam.id)).toBe(2);

      const res = await directUpdate(x.user, x.memberId, { status: 'active' });

      // 修正前: UPDATE が通り、上限 2 の家族で active が 3 人になる
      expect(await activeCount(fam.id)).toBe(2);
      expect((await memberRow(x.memberId)).status).toBe('left');
      expectGuardBlocked(res);
      // 退出時にプロフィールの family_id は NULL になっていて、戻ろうとしても変わらない
      expect(await profileFamilyId(x.user.id)).toBeNull();
    },
    LONG,
  );

  it(
    'R2: 除名 (remove_family_member) された人も、自分の行を active に戻そうとしても拒否される。人数の上限を超えない',
    async () => {
      const fam = await createFamily('r2');
      const x = await addAdult(fam, 'r2-x');
      const removed = await asUser(fam.rep.jwt).rpc('remove_family_member', {
        p_family_id: fam.id,
        p_member_id: x.memberId,
      });
      expect(removed.error).toBeNull();
      expect(removed.data).toMatchObject({ id: x.memberId, status: 'removed' });
      await addChild(fam, 'r2-child');
      await setMemberLimit(fam.id, 2);
      expect(await activeCount(fam.id)).toBe(2);

      const res = await directUpdate(x.user, x.memberId, { status: 'active' });

      expect(await activeCount(fam.id)).toBe(2);
      expect((await memberRow(x.memberId)).status).toBe('removed');
      expectGuardBlocked(res);
      expect(await profileFamilyId(x.user.id)).toBeNull();
    },
    LONG,
  );

  it(
    'R3: status と removed_at を同時に戻して痕跡ごと消そうとしても、removed_at だけを書き換えても拒否される',
    async () => {
      const fam = await createFamily('r3');
      const x = await addAdult(fam, 'r3-x');
      const left = await asUser(x.user.jwt).rpc('leave_family');
      expect(left.error).toBeNull();
      const before = await memberRow(x.memberId);
      expect(before.status).toBe('left');
      expect(before.removed_at).not.toBeNull();

      const both = await directUpdate(x.user, x.memberId, { status: 'active', removed_at: null });
      const onlyRemovedAt = await directUpdate(x.user, x.memberId, { removed_at: null });
      const futureRemovedAt = await directUpdate(x.user, x.memberId, { removed_at: new Date(Date.now() + 86_400_000).toISOString() });

      const after = await memberRow(x.memberId);
      expect(after.status).toBe('left');
      expect(after.removed_at).toBe(before.removed_at);
      expectGuardBlocked(both);
      expectGuardBlocked(onlyRemovedAt);
      expectGuardBlocked(futureRemovedAt);
    },
    LONG,
  );

  it(
    'R4: 退出済みの人は left から removed へも書き換えられない (status のどの変更も拒否される)',
    async () => {
      const fam = await createFamily('r4');
      const x = await addAdult(fam, 'r4-x');
      expect((await asUser(x.user.jwt).rpc('leave_family')).error).toBeNull();

      const res = await directUpdate(x.user, x.memberId, { status: 'removed' });

      expect((await memberRow(x.memberId)).status).toBe('left');
      expectGuardBlocked(res);
    },
    LONG,
  );

  it(
    'R5: 古い行を書き換える代わりに、自分で新しい active の行を INSERT して戻ることもできない (INSERT のポリシーが無い)',
    async () => {
      const fam = await createFamily('r5');
      const x = await addAdult(fam, 'r5-x');
      expect((await asUser(x.user.jwt).rpc('leave_family')).error).toBeNull();
      await addChild(fam, 'r5-child');
      await setMemberLimit(fam.id, 2);
      expect(await activeCount(fam.id)).toBe(2);

      const { data, error } = await asUser(x.user.jwt)
        .from('family_members')
        .insert({ family_id: fam.id, user_id: x.user.id, role: 'adult', status: 'active' })
        .select('id');

      expect(await activeCount(fam.id)).toBe(2);
      expect(error).not.toBeNull();
      expect(error!.code).toBe('42501');
      expect(data).toBeNull();
    },
    LONG,
  );
});

describe('#1309 active のメンバーも、自分や他人の status を直接変えられない', () => {
  it(
    'S1: 大人が自分を left にしようとしても拒否される (退出は leave_family 経由だけ)。プロフィールも監査ログも変わらない',
    async () => {
      const fam = await createFamily('s1');
      const a = await addAdult(fam, 's1-a');

      const res = await directUpdate(a.user, a.memberId, { status: 'left' });

      const row = await memberRow(a.memberId);
      expect(row.status).toBe('active');
      expect(row.removed_at).toBeNull();
      expect(await profileFamilyId(a.user.id)).toBe(fam.id);
      expect(await auditCount(fam.id, 'member_left')).toBe(0);
      expectGuardBlocked(res);
    },
    LONG,
  );

  it(
    'S2: 代表者が自分を left / removed にしようとしても拒否される (代表者は退出できない規則を迂回できない)',
    async () => {
      const fam = await createFamily('s2');
      await addAdult(fam, 's2-a');

      // 正規の経路は拒否される (代表者は退出できない)
      const viaRpc = await asUser(fam.rep.jwt).rpc('leave_family');
      expect(viaRpc.error?.message).toBe('IS_FAMILY_REPRESENTATIVE');

      const toLeft = await directUpdate(fam.rep, fam.repMemberId, { status: 'left' });
      const toRemoved = await directUpdate(fam.rep, fam.repMemberId, { status: 'removed' });

      // 修正前: 代表者のいない家族ができる (uniq_family_representative は active の代表者が 0 人でも許す)
      const row = await memberRow(fam.repMemberId);
      expect(row.status).toBe('active');
      expect(row.role).toBe('representative');
      expect(await profileFamilyId(fam.rep.id)).toBe(fam.id);
      expectGuardBlocked(toLeft);
      expectGuardBlocked(toRemoved);
    },
    LONG,
  );

  it(
    'S3: active の大人が、代表者・別の大人・子供を removed にしようとしても拒否される (除名は remove_family_member 経由だけ)',
    async () => {
      const fam = await createFamily('s3');
      const a = await addAdult(fam, 's3-a');
      const b = await addAdult(fam, 's3-b');
      const childId = await addChild(fam, 's3-child');

      const onRep = await directUpdate(a.user, fam.repMemberId, { status: 'removed' });
      const onAdult = await directUpdate(a.user, b.memberId, { status: 'removed' });
      const onChild = await directUpdate(a.user, childId, { status: 'removed' });

      expect(await activeCount(fam.id)).toBe(4);
      expect((await memberRow(fam.repMemberId)).status).toBe('active');
      expect((await memberRow(b.memberId)).status).toBe('active');
      expect((await memberRow(childId)).status).toBe('active');
      expectGuardBlocked(onRep);
      expectGuardBlocked(onAdult);
      expectGuardBlocked(onChild);
    },
    LONG,
  );

  it(
    'S4: active の大人が、除名済みの人の行を active に戻そうとしても拒否される (他人を勝手に戻して上限を超えさせられない)',
    async () => {
      const fam = await createFamily('s4');
      const a = await addAdult(fam, 's4-a');
      const b = await addAdult(fam, 's4-b');
      const removed = await asUser(fam.rep.jwt).rpc('remove_family_member', {
        p_family_id: fam.id,
        p_member_id: b.memberId,
      });
      expect(removed.error).toBeNull();
      await setMemberLimit(fam.id, 2);
      expect(await activeCount(fam.id)).toBe(2);

      const res = await directUpdate(a.user, b.memberId, { status: 'active' });

      expect(await activeCount(fam.id)).toBe(2);
      expect((await memberRow(b.memberId)).status).toBe('removed');
      expectGuardBlocked(res);
    },
    LONG,
  );

  it(
    'S5: 変更を伴わない更新 (status を今の値のまま送り直す) は拒否されない。ほかの列の更新と一緒でも通る',
    async () => {
      const fam = await createFamily('s5');
      const a = await addAdult(fam, 's5-a');
      const before = await memberRow(a.memberId);

      const res = await directUpdate(a.user, a.memberId, {
        status: 'active',
        removed_at: before.removed_at,
        display_name: 's5-renamed',
      });

      expect(res.error).toBeNull();
      expect(res.rows.map((r) => r.id)).toEqual([a.memberId]);
      const after = await memberRow(a.memberId);
      expect(after.status).toBe('active');
      expect(after.display_name).toBe('s5-renamed');
    },
    LONG,
  );

  it(
    'S6: 未ログイン (anon) は family_members の行を更新できない (0 件。status も変わらない)',
    async () => {
      const fam = await createFamily('s6');
      const a = await addAdult(fam, 's6-a');
      expect((await asUser(a.user.jwt).rpc('leave_family')).error).toBeNull();

      const res = await directUpdate(null, a.memberId, { status: 'active' });

      expect(res.rows).toEqual([]);
      expect((await memberRow(a.memberId)).status).toBe('left');
    },
    LONG,
  );
});

describe('#1309 修正後も、正規の経路 (RPC・service_role) は status を今までどおり変えられる', () => {
  it(
    'L1: leave_family で大人が退出すると left + removed_at になり、プロフィールの family_id は NULL、監査ログが 1 件できる',
    async () => {
      const fam = await createFamily('l1');
      const a = await addAdult(fam, 'l1-a');

      const { data, error } = await asUser(a.user.jwt).rpc('leave_family');

      expect(error).toBeNull();
      expect(data).toMatchObject({ id: a.memberId, family_id: fam.id, user_id: a.user.id, status: 'left' });
      const row = await memberRow(a.memberId);
      expect(row.status).toBe('left');
      expect(row.removed_at).not.toBeNull();
      expect(await profileFamilyId(a.user.id)).toBeNull();
      expect(await auditCount(fam.id, 'member_left')).toBe(1);
      expect(await activeCount(fam.id)).toBe(1);
    },
    LONG,
  );

  it(
    'L2: remove_family_member で代表者が大人と子供を除名すると removed + removed_at になる。大人のプロフィールの family_id は NULL',
    async () => {
      const fam = await createFamily('l2');
      const a = await addAdult(fam, 'l2-a');
      const childId = await addChild(fam, 'l2-child');

      const removeAdult = await asUser(fam.rep.jwt).rpc('remove_family_member', {
        p_family_id: fam.id,
        p_member_id: a.memberId,
      });
      const removeChild = await asUser(fam.rep.jwt).rpc('remove_family_member', {
        p_family_id: fam.id,
        p_member_id: childId,
      });

      expect(removeAdult.error).toBeNull();
      expect(removeChild.error).toBeNull();
      for (const id of [a.memberId, childId]) {
        const row = await memberRow(id);
        expect(row.status).toBe('removed');
        expect(row.removed_at).not.toBeNull();
      }
      expect(await profileFamilyId(a.user.id)).toBeNull();
      expect(await auditCount(fam.id, 'member_removed')).toBe(2);
      expect(await activeCount(fam.id)).toBe(1);
    },
    LONG,
  );

  it(
    'L3: 退出した人は、新しい招待を承諾する正規の経路で戻れる (古い行は left のまま、新しい行が active)。満員なら招待が作れない',
    async () => {
      const fam = await createFamily('l3');
      const x = await addAdult(fam, 'l3-x');
      expect((await asUser(x.user.jwt).rpc('leave_family')).error).toBeNull();
      expect(await activeCount(fam.id)).toBe(1);

      // 満員 (上限 1) の家族には、招待を作れない = 戻れない
      await setMemberLimit(fam.id, 1);
      const full = await asUser(fam.rep.jwt).rpc('create_family_invite', { p_family_id: fam.id, p_email: x.user.email });
      expect(full.error?.message).toBe('MEMBER_LIMIT_EXCEEDED');
      expect(await activeCount(fam.id)).toBe(1);

      // 空きがあれば、招待 → 承諾で戻れる
      await setMemberLimit(fam.id, 5);
      const invite = await asUser(fam.rep.jwt).rpc('create_family_invite', { p_family_id: fam.id, p_email: x.user.email });
      expect(invite.error).toBeNull();
      const token = (invite.data as { token: string }).token;
      const accepted = await asUser(x.user.jwt).rpc('accept_family_invite', { p_token: token });

      expect(accepted.error).toBeNull();
      expect(accepted.data).toMatchObject({ family_id: fam.id, user_id: x.user.id, role: 'adult', status: 'active' });
      expect((accepted.data as { id: string }).id).not.toBe(x.memberId);
      expect((await memberRow(x.memberId)).status).toBe('left');
      expect(await activeCount(fam.id)).toBe(2);
      expect(await profileFamilyId(x.user.id)).toBe(fam.id);
    },
    LONG,
  );

  it(
    'L4: 運営の強制解散 (operator_force_dissolve_family) で active 全員が left になる',
    async () => {
      const fam = await createFamily('l4');
      const a = await addAdult(fam, 'l4-a');
      const childId = await addChild(fam, 'l4-child');
      const operator = await createUser('l4-operator', ['super_admin']);

      const { error } = await asUser(operator.jwt).rpc('operator_force_dissolve_family', {
        p_family_id: fam.id,
        p_reason: '#1309 テスト',
      });

      expect(error).toBeNull();
      for (const id of [fam.repMemberId, a.memberId, childId]) {
        expect((await memberRow(id)).status).toBe('left');
      }
      expect(await activeCount(fam.id)).toBe(0);
      expect(await profileFamilyId(fam.rep.id)).toBeNull();
      expect(await profileFamilyId(a.user.id)).toBeNull();
      const { data: group } = await srAdmin.from('family_groups').select('status').eq('id', fam.id).single();
      expect((group as { status: string }).status).toBe('dissolved');
    },
    LONG,
  );

  it(
    'L5: status 以外の列は今までどおり直接更新できる (表示名・アバター色・タグ・自分の共有設定・子供の表示名)。他人の共有設定は拒否される',
    async () => {
      const fam = await createFamily('l5');
      const a = await addAdult(fam, 'l5-a');
      const b = await addAdult(fam, 'l5-b');
      const childId = await addChild(fam, 'l5-child');

      const own = await directUpdate(a.user, a.memberId, {
        display_name: 'l5-a-renamed',
        avatar_color: '#112233',
        tags: ['l5'],
        share_health: true,
      });
      const child = await directUpdate(a.user, childId, { display_name: 'l5-child-renamed' });
      const others = await directUpdate(b.user, a.memberId, { share_health: false });
      const viaRpc = await asUser(a.user.jwt).rpc('update_my_share_settings', {
        p_share_meals: true,
        p_share_health: false,
        p_share_menu: true,
      });

      expect(own.error).toBeNull();
      expect(own.rows.map((r) => r.id)).toEqual([a.memberId]);
      expect(child.error).toBeNull();
      expect(child.rows.map((r) => r.id)).toEqual([childId]);
      expect((await memberRow(childId)).display_name).toBe('l5-child-renamed');
      // 他人の共有設定の変更は今までどおり拒否される (#1015)
      expectGuardBlocked(others);
      // RPC で自分の共有設定を戻せる
      expect(viaRpc.error).toBeNull();
      const row = await memberRow(a.memberId);
      expect(row).toMatchObject({
        display_name: 'l5-a-renamed',
        avatar_color: '#112233',
        tags: ['l5'],
        share_meals: true,
        share_health: false,
        share_menu: true,
        status: 'active',
      });
    },
    LONG,
  );

  it(
    'L6: service_role (運営ツール・テストの道具) は status と removed_at を直接変えられる',
    async () => {
      const fam = await createFamily('l6');
      const a = await addAdult(fam, 'l6-a');
      const removedAt = new Date().toISOString();

      const toRemoved = await srAdmin
        .from('family_members')
        .update({ status: 'removed', removed_at: removedAt })
        .eq('id', a.memberId)
        .select('id, status');
      expect(toRemoved.error).toBeNull();
      expect(toRemoved.data).toEqual([{ id: a.memberId, status: 'removed' }]);

      const back = await srAdmin
        .from('family_members')
        .update({ status: 'active', removed_at: null })
        .eq('id', a.memberId)
        .select('id, status');
      expect(back.error).toBeNull();
      expect(back.data).toEqual([{ id: a.memberId, status: 'active' }]);
      expect((await memberRow(a.memberId)).removed_at).toBeNull();
    },
    LONG,
  );
});

describe('#1309 ガード関数の属性 (CREATE OR REPLACE で変わらない)', () => {
  it('A1: ガード関数は SECURITY INVOKER・所有者 postgres のまま。トリガーは BEFORE UPDATE の行トリガーで有効', async () => {
    // SECURITY DEFINER にすると current_user が常に postgres になり、ガードが一切効かなくなる。それを防ぐ
    const fns = await pgQuery<{ secdef: boolean; config: string[] | null; owner: string; rettype: string }>(`
      SELECT p.prosecdef AS secdef, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner,
             p.prorettype::regtype::text AS rettype
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'guard_family_members_privileged'
    `);
    expect(fns).toHaveLength(1);
    expect(fns[0]).toEqual({ secdef: false, config: null, owner: 'postgres', rettype: 'trigger' });

    // tgtype: 1 = ROW, 2 = BEFORE, 16 = UPDATE の組み合わせ (= 19)。tgenabled 'O' = 有効
    const triggers = await pgQuery<{ tgname: string; tgenabled: string; tgtype: number; fn: string }>(`
      SELECT t.tgname, t.tgenabled, t.tgtype::int AS tgtype, p.proname AS fn
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'public.family_members'::regclass AND NOT t.tgisinternal
      ORDER BY t.tgname
    `);
    expect(triggers).toEqual([
      { tgname: 'trg_guard_family_members_privileged', tgenabled: 'O', tgtype: 19, fn: 'guard_family_members_privileged' },
    ]);
  });
});
