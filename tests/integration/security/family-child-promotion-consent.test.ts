/**
 * #1232 子供メンバー昇格 (promote) の本人同意フローの回帰テスト
 *
 * 修正前の promote_child_to_user(p_member_id, p_email) は、呼び出し者が家族の代表者・大人であることだけを確かめ、
 * p_email の持ち主本人の同意を確かめずに family_members.user_id と user_profiles.family_id を書き換えていた。
 * 家族を作って子供の枠を足すだけで、未所属の既存ユーザーを家族へ強制編入でき、
 * 編入された人のそれまでの食事記録が家族全員に見えるようになっていた (critical / definer-rpc-idor)。
 *
 * 修正後 (Issue #1232 実装設計 v2 + v3):
 *   - 代表者・大人は「参加リクエスト」(family_promotion_requests の pending 行) を作るだけ。家族も本人のプロフィールも変わらない
 *   - 宛先メールアドレスの本人が、自分のログインでトークン付きの承認 (accept_child_promotion) をしたときだけ編入する
 *   - 旧 promote_child_to_user は両方の引数の版とも編入しない (PROMOTION_DIRECT_DISABLED / 削除)
 *   - メールアドレスの登録・所属の有無で応答が変わらない (USER_NOT_FOUND を返さない)
 *   - token 列は家族側からも読めない (列単位 GRANT)。API の応答にも含めない
 *   - 4 本の書き込み RPC は family_members → family_promotion_requests の順で行ロックし、
 *     deadlock (40P01) は CONFLICT_RETRY (409) に置き換える
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next の開発サーバー。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/family-child-promotion-consent.test.ts
 *
 * 関数定義・権限の確認 (pg_get_functiondef / has_function_privilege など) は、ローカルスタックの
 * postgres-meta (/pg/query、service_role キーが必要) で読み取りだけ行う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
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

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
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

interface TestFamily {
  rep: TestUser;
  familyId: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
const TOKEN_RE = /^[a-f0-9]{64}$/;

async function createUser(label: string, options: { withProfile?: boolean } = {}): Promise<TestUser> {
  const email = `sec-promotion-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  // withProfile: false は「新規登録しただけで初期設定 (オンボーディング) 前」の人 (プロフィール行が無い)
  if (options.withProfile !== false) {
    const { error: profileError } = await srAdmin
      .from('user_profiles')
      .upsert({ id: data.user.id, nickname: `promo-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
    if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  }
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

async function createFamily(label: string): Promise<TestFamily> {
  const rep = await createUser(`rep-${label}`);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `#1232 family ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  return { rep, familyId };
}

async function addChild(family: TestFamily, name: string): Promise<string> {
  const { data, error } = await asUser(family.rep.jwt).rpc('add_family_child', {
    p_family_id: family.familyId,
    p_display_name: name,
    p_child_profile: { age: 12 },
  });
  if (error || !data) throw new Error(`add_family_child ${name}: ${error?.message}`);
  return (data as { id: string }).id;
}

async function getMember(memberId: string) {
  const { data, error } = await srAdmin
    .from('family_members')
    .select('id, family_id, user_id, role, child_profile, status, share_meals, share_health, share_menu')
    .eq('id', memberId)
    .single();
  if (error) throw new Error(`getMember: ${error.message}`);
  return data as {
    id: string;
    family_id: string;
    user_id: string | null;
    role: string;
    child_profile: unknown;
    status: string;
    share_meals: boolean;
    share_health: boolean;
    share_menu: boolean;
  };
}

async function getProfileFamilyId(userId: string): Promise<string | null> {
  const { data } = await srAdmin.from('user_profiles').select('family_id').eq('id', userId).single();
  return (data as { family_id: string | null } | null)?.family_id ?? null;
}

async function activeMembershipCount(userId: string): Promise<number> {
  const { count } = await srAdmin
    .from('family_members')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'active');
  return count ?? 0;
}

/** service_role でリクエスト行を読む (token を含む。テストでメールの代わりに使う) */
async function getRequests(memberId: string) {
  const { data, error } = await srAdmin
    .from('family_promotion_requests')
    .select('id, family_id, member_id, email, token, status, requested_by, expires_at, resolved_at, resolved_by')
    .eq('member_id', memberId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`getRequests: ${error.message}`);
  return (data ?? []) as Array<{
    id: string;
    family_id: string;
    member_id: string;
    email: string;
    token: string;
    status: string;
    requested_by: string;
    expires_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
  }>;
}

async function pendingToken(memberId: string): Promise<string> {
  const pending = (await getRequests(memberId)).filter((r) => r.status === 'pending');
  expect(pending).toHaveLength(1);
  return pending[0].token;
}

async function auditActions(familyId: string, action: string) {
  const { data, error } = await srAdmin
    .from('membership_audit')
    .select('action, actor_id, target_user_id, metadata')
    .eq('scope', 'family')
    .eq('scope_id', familyId)
    .eq('action', action);
  if (error) throw new Error(`audit: ${error.message}`);
  return (data ?? []) as Array<{
    action: string;
    actor_id: string | null;
    target_user_id: string | null;
    metadata: Record<string, unknown>;
  }>;
}

// 家族 A: 攻撃・本人同意・列挙オラクル / 家族 B: 二重所属・再送 / 家族 C: 期限切れ・取消・RLS / 家族 D: API
// 家族 E: プロフィール行が無い新規ユーザーの承認
let famA: TestFamily;
let famB: TestFamily;
let famC: TestFamily;
let famD: TestFamily;
let famE: TestFamily;
let newcomer: TestUser;
let childE1 = '';
let victim: TestUser;
let victim2: TestUser;
let victim3: TestUser;
let victim4: TestUser;
let victim5: TestUser;
let outsider: TestUser;
let childA1 = '';
let childA2 = '';
let childA3 = '';
let childB1 = '';
let childB2 = '';
let childB3 = '';
let childC1 = '';
let childC2 = '';
let childC3 = '';
let childD1 = '';
let childD2 = '';
let childD3 = '';

beforeAll(async () => {
  famA = await createFamily('a');
  famB = await createFamily('b');
  famC = await createFamily('c');
  famD = await createFamily('d');
  famE = await createFamily('e');
  newcomer = await createUser('newcomer', { withProfile: false });
  victim = await createUser('victim');
  victim2 = await createUser('victim2');
  victim3 = await createUser('victim3');
  victim4 = await createUser('victim4');
  victim5 = await createUser('victim5');
  outsider = await createUser('outsider');

  // 子供の枠は無料プランの上限 (代表者込みで 4 人) に収まるよう、1 家族 3 人まで
  childA1 = await addChild(famA, 'A1 たろう');
  childA2 = await addChild(famA, 'A2');
  childA3 = await addChild(famA, 'A3');
  childB1 = await addChild(famB, 'B1');
  childB2 = await addChild(famB, 'B2');
  childB3 = await addChild(famB, 'B3');
  childC1 = await addChild(famC, 'C1');
  childC2 = await addChild(famC, 'C2');
  childC3 = await addChild(famC, 'C3');
  childD1 = await addChild(famD, 'D1');
  childD2 = await addChild(famD, 'D2');
  childD3 = await addChild(famD, 'D3');
  childE1 = await addChild(famE, 'E1');
}, 120_000);

afterAll(async () => {
  for (const id of createdFamilyIds) {
    await srAdmin.from('family_groups').delete().eq('id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

describe('#1232 攻撃の再現: 本人の同意なしに家族へ編入できない', () => {
  it('★旧 promote_child_to_user(uuid, text) を直接呼んでも編入されない (PROMOTION_DIRECT_DISABLED)', async () => {
    const { error } = await asUser(famA.rep.jwt).rpc('promote_child_to_user', {
      p_member_id: childA1,
      p_email: victim.email,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('PROMOTION_DIRECT_DISABLED');

    expect(await getProfileFamilyId(victim.id)).toBeNull();
    expect(await activeMembershipCount(victim.id)).toBe(0);
    const child = await getMember(childA1);
    expect(child.user_id).toBeNull();
    expect(child.role).toBe('child');
  });

  it('anon は旧 promote_child_to_user(uuid, text) を実行できない', async () => {
    const { error } = await anon().rpc('promote_child_to_user', {
      p_member_id: childA1,
      p_email: victim.email,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('★request_child_promotion は pending のリクエストを作るだけで、被害者を編入しない', async () => {
    const { data, error } = await asUser(famA.rep.jwt).rpc('request_child_promotion', {
      p_member_id: childA1,
      p_email: victim.email.toUpperCase(),
    });
    expect(error).toBeNull();
    const req = data as { id: string; status: string; token: string; email: string; member_display_name: string };
    expect(req.status).toBe('pending');
    expect(req.token).toMatch(TOKEN_RE);
    // メールアドレスは小文字で保存する
    expect(req.email).toBe(victim.email.toLowerCase());
    expect(req.member_display_name).toBe('A1 たろう');

    const rows = await getRequests(childA1);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].requested_by).toBe(famA.rep.id);

    // 家族も被害者のプロフィールも変わらない
    expect(await getProfileFamilyId(victim.id)).toBeNull();
    expect(await activeMembershipCount(victim.id)).toBe(0);
    expect((await getMember(childA1)).user_id).toBeNull();

    const audit = await auditActions(famA.familyId, 'child_promotion_requested');
    expect(audit.some((a) => a.metadata.request_id === req.id && a.actor_id === famA.rep.id)).toBe(true);
  });

  it('★列挙オラクルが無い: 未登録・他の家族に所属済みのメールでも同じ形の成功応答になる', async () => {
    const unregistered = await asUser(famA.rep.jwt).rpc('request_child_promotion', {
      p_member_id: childA2,
      p_email: `nobody-${TS}@homegohan.test`,
    });
    expect(unregistered.error).toBeNull();
    const belongs = await asUser(famA.rep.jwt).rpc('request_child_promotion', {
      p_member_id: childA3,
      p_email: famB.rep.email,
    });
    expect(belongs.error).toBeNull();

    const keysA = Object.keys(unregistered.data as object).sort();
    const keysB = Object.keys(belongs.data as object).sort();
    expect(keysA).toEqual(keysB);
    expect((unregistered.data as { status: string }).status).toBe('pending');
    expect((belongs.data as { status: string }).status).toBe('pending');
  });
});

describe('#1232 本人同意 (accept / reject)', () => {
  it('★宛先と違うアカウントで accept すると PROMOTION_EMAIL_MISMATCH で、何も変わらない', async () => {
    const token = await pendingToken(childA1);
    const { error } = await asUser(outsider.jwt).rpc('accept_child_promotion', { p_token: token });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('PROMOTION_EMAIL_MISMATCH');

    expect((await getMember(childA1)).user_id).toBeNull();
    expect(await getProfileFamilyId(outsider.id)).toBeNull();
    expect((await getRequests(childA1))[0].status).toBe('pending');
  });

  it('★宛先の本人が accept したときだけ編入され、共有設定は本人の選択になる', async () => {
    const token = await pendingToken(childA1);
    const { data, error } = await asUser(victim.jwt).rpc('accept_child_promotion', {
      p_token: token,
      p_share_meals: false,
      p_share_health: true,
      p_share_menu: false,
    });
    expect(error).toBeNull();
    expect((data as { id: string }).id).toBe(childA1);

    const child = await getMember(childA1);
    expect(child.user_id).toBe(victim.id);
    expect(child.role).toBe('adult');
    expect(child.child_profile).toBeNull();
    expect(child.share_meals).toBe(false);
    expect(child.share_health).toBe(true);
    expect(child.share_menu).toBe(false);
    expect(await getProfileFamilyId(victim.id)).toBe(famA.familyId);

    const [row] = await getRequests(childA1);
    expect(row.status).toBe('accepted');
    expect(row.resolved_by).toBe(victim.id);

    const audit = await auditActions(famA.familyId, 'child_promoted');
    expect(audit.some((a) => a.metadata.request_id === row.id && a.target_user_id === victim.id)).toBe(true);
  });

  it('同じトークンで 2 回目の accept は PROMOTION_REQUEST_ALREADY_USED', async () => {
    const [row] = await getRequests(childA1);
    const { error } = await asUser(victim.jwt).rpc('accept_child_promotion', { p_token: row.token });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('PROMOTION_REQUEST_ALREADY_USED');
  });

  it('編入済みの枠へ新しいリクエストは作れない (ALREADY_PROMOTED)', async () => {
    const { error } = await asUser(famA.rep.jwt).rpc('request_child_promotion', {
      p_member_id: childA1,
      p_email: victim2.email,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('ALREADY_PROMOTED');
  });

  it('存在しないトークンは PROMOTION_REQUEST_NOT_FOUND', async () => {
    const { error } = await asUser(victim2.jwt).rpc('accept_child_promotion', { p_token: 'f'.repeat(64) });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('PROMOTION_REQUEST_NOT_FOUND');
  });

  it('anon は accept / reject / request / revoke を実行できない', async () => {
    const token = await pendingToken(childA2);
    const calls = [
      anon().rpc('accept_child_promotion', { p_token: token }),
      anon().rpc('reject_child_promotion', { p_token: token }),
      anon().rpc('request_child_promotion', { p_member_id: childA2, p_email: victim2.email }),
      anon().rpc('revoke_child_promotion', { p_member_id: childA2 }),
    ];
    for (const { error } of await Promise.all(calls)) {
      expect(error).not.toBeNull();
      expect(error!.code).toBe('42501');
    }
    expect((await getRequests(childA2)).filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('依頼後に枠が外された (removed) 場合、accept は PROMOTION_MEMBER_UNAVAILABLE', async () => {
    const token = await pendingToken(childA3);
    const { error: updError } = await srAdmin.from('family_members').update({ status: 'removed' }).eq('id', childA3);
    expect(updError).toBeNull();
    const { error } = await asUser(famB.rep.jwt).rpc('accept_child_promotion', { p_token: token });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('PROMOTION_MEMBER_UNAVAILABLE');
    expect(await getProfileFamilyId(famB.rep.id)).toBe(famB.familyId);
  });

  it('外された枠へのリクエストは PROMOTION_MEMBER_UNAVAILABLE', async () => {
    const { error } = await asUser(famA.rep.jwt).rpc('request_child_promotion', {
      p_member_id: childA3,
      p_email: victim2.email,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('PROMOTION_MEMBER_UNAVAILABLE');
  });
});

describe('#1232 二重所属・再送', () => {
  it('★既に家族に入っている本人の accept は ALREADY_IN_FAMILY', async () => {
    await asUser(famB.rep.jwt).rpc('request_child_promotion', { p_member_id: childB1, p_email: victim.email });
    const token = await pendingToken(childB1);
    const { error } = await asUser(victim.jwt).rpc('accept_child_promotion', { p_token: token });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('ALREADY_IN_FAMILY');
    expect((await getMember(childB1)).user_id).toBeNull();
    expect(await getProfileFamilyId(victim.id)).toBe(famA.familyId);
  });

  it('★2 つの家族から同じ本人へ: 1 本目の accept は成功し、2 本目は ALREADY_IN_FAMILY', async () => {
    await asUser(famC.rep.jwt).rpc('request_child_promotion', { p_member_id: childC1, p_email: victim2.email });
    await asUser(famB.rep.jwt).rpc('request_child_promotion', { p_member_id: childB2, p_email: victim2.email });
    const tokenC = await pendingToken(childC1);
    const tokenB = await pendingToken(childB2);

    const first = await asUser(victim2.jwt).rpc('accept_child_promotion', { p_token: tokenC });
    expect(first.error).toBeNull();
    const second = await asUser(victim2.jwt).rpc('accept_child_promotion', { p_token: tokenB });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toContain('ALREADY_IN_FAMILY');

    expect(await activeMembershipCount(victim2.id)).toBe(1);
    expect(await getProfileFamilyId(victim2.id)).toBe(famC.familyId);
    expect((await getMember(childB2)).user_id).toBeNull();
  });

  it('★v3 (E9): 再送すると旧トークンは revoked になり ALREADY_USED、新トークンで編入できる', async () => {
    const r1 = await asUser(famB.rep.jwt).rpc('request_child_promotion', { p_member_id: childB3, p_email: victim3.email });
    expect(r1.error).toBeNull();
    const oldToken = (r1.data as { token: string }).token;
    const r2 = await asUser(famB.rep.jwt).rpc('request_child_promotion', { p_member_id: childB3, p_email: victim3.email });
    expect(r2.error).toBeNull();
    const newToken = (r2.data as { token: string }).token;
    expect(newToken).not.toBe(oldToken);

    const rows = await getRequests(childB3);
    expect(rows.map((r) => r.status)).toEqual(['revoked', 'pending']);
    expect(rows[0].resolved_by).toBe(famB.rep.id);

    const stale = await asUser(victim3.jwt).rpc('accept_child_promotion', { p_token: oldToken });
    expect(stale.error).not.toBeNull();
    expect(stale.error!.message).toContain('PROMOTION_REQUEST_ALREADY_USED');

    const fresh = await asUser(victim3.jwt).rpc('accept_child_promotion', { p_token: newToken });
    expect(fresh.error).toBeNull();
    expect((await getMember(childB3)).user_id).toBe(victim3.id);
  });
});

describe('#1232 期限切れ・拒否・取消', () => {
  it('期限切れの accept は PROMOTION_REQUEST_EXPIRED (status は pending のまま)', async () => {
    await asUser(famC.rep.jwt).rpc('request_child_promotion', { p_member_id: childC2, p_email: victim4.email });
    const token = await pendingToken(childC2);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { error: updError } = await srAdmin
      .from('family_promotion_requests')
      .update({ expires_at: past })
      .eq('token', token);
    expect(updError).toBeNull();

    const { error } = await asUser(victim4.jwt).rpc('accept_child_promotion', { p_token: token });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('PROMOTION_REQUEST_EXPIRED');
    expect((await getMember(childC2)).user_id).toBeNull();
    expect((await getRequests(childC2))[0].status).toBe('pending');
  });

  it('期限切れでも本人は拒否できる (E7)。拒否は rejected になり監査に残る', async () => {
    const token = await pendingToken(childC2);
    const other = await asUser(outsider.jwt).rpc('reject_child_promotion', { p_token: token });
    expect(other.error).not.toBeNull();
    expect(other.error!.message).toContain('PROMOTION_EMAIL_MISMATCH');

    const { data, error } = await asUser(victim4.jwt).rpc('reject_child_promotion', { p_token: token });
    expect(error).toBeNull();
    expect((data as { status: string }).status).toBe('rejected');
    const [row] = await getRequests(childC2);
    expect(row.status).toBe('rejected');
    expect(row.resolved_by).toBe(victim4.id);
    expect((await getMember(childC2)).user_id).toBeNull();

    const audit = await auditActions(famC.familyId, 'child_promotion_rejected');
    expect(audit.some((a) => a.metadata.request_id === row.id)).toBe(true);

    const again = await asUser(victim4.jwt).rpc('reject_child_promotion', { p_token: token });
    expect(again.error).not.toBeNull();
    expect(again.error!.message).toContain('PROMOTION_REQUEST_ALREADY_USED');
  });

  it('代表者・大人は取消でき、家族の外の人は取消できない', async () => {
    await asUser(famC.rep.jwt).rpc('request_child_promotion', { p_member_id: childC3, p_email: victim5.email });
    const token = await pendingToken(childC3);

    const byOutsider = await asUser(outsider.jwt).rpc('revoke_child_promotion', { p_member_id: childC3 });
    expect(byOutsider.error).not.toBeNull();
    expect(byOutsider.error!.message).toContain('NOT_FAMILY_ADULT');

    const byOtherRep = await asUser(famA.rep.jwt).rpc('revoke_child_promotion', { p_member_id: childC3 });
    expect(byOtherRep.error).not.toBeNull();
    expect(byOtherRep.error!.message).toContain('NOT_FAMILY_ADULT');

    const { data, error } = await asUser(famC.rep.jwt).rpc('revoke_child_promotion', { p_member_id: childC3 });
    expect(error).toBeNull();
    expect((data as { status: string }).status).toBe('revoked');
    expect((await getRequests(childC3))[0].status).toBe('revoked');

    const audit = await auditActions(famC.familyId, 'child_promotion_revoked');
    expect(audit.some((a) => a.metadata.member_id === childC3)).toBe(true);

    const accept = await asUser(victim5.jwt).rpc('accept_child_promotion', { p_token: token });
    expect(accept.error).not.toBeNull();
    expect(accept.error!.message).toContain('PROMOTION_REQUEST_ALREADY_USED');

    const again = await asUser(famC.rep.jwt).rpc('revoke_child_promotion', { p_member_id: childC3 });
    expect(again.error).not.toBeNull();
    expect(again.error!.message).toContain('PROMOTION_REQUEST_NOT_FOUND');
  });

  it('★IDOR: 他の家族の枠・存在しない枠へのリクエストは NOT_FAMILY_ADULT (枠の有無を漏らさない)', async () => {
    const otherFamily = await asUser(famA.rep.jwt).rpc('request_child_promotion', {
      p_member_id: childC3,
      p_email: victim5.email,
    });
    expect(otherFamily.error).not.toBeNull();
    expect(otherFamily.error!.message).toContain('NOT_FAMILY_ADULT');

    const missing = await asUser(famA.rep.jwt).rpc('request_child_promotion', {
      p_member_id: '00000000-0000-4000-8000-000000000000',
      p_email: victim5.email,
    });
    expect(missing.error).not.toBeNull();
    expect(missing.error!.message).toContain('NOT_FAMILY_ADULT');

    const noFamily = await asUser(outsider.jwt).rpc('request_child_promotion', {
      p_member_id: childC3,
      p_email: victim5.email,
    });
    expect(noFamily.error).not.toBeNull();
    expect(noFamily.error!.message).toContain('NOT_FAMILY_ADULT');
  });
});

describe('#1232 RLS・列単位 GRANT・承認ページ用 RPC', () => {
  it('同じ家族の代表者は明示した列で読めるが、token 列と SELECT * は permission denied', async () => {
    const visible = await asUser(famC.rep.jwt)
      .from('family_promotion_requests')
      .select('id, email, status, expires_at')
      .eq('family_id', famC.familyId);
    expect(visible.error).toBeNull();
    expect((visible.data ?? []).length).toBeGreaterThanOrEqual(3);

    const tokenCol = await asUser(famC.rep.jwt).from('family_promotion_requests').select('token');
    expect(tokenCol.error).not.toBeNull();
    expect(tokenCol.error!.code).toBe('42501');

    const star = await asUser(famC.rep.jwt).from('family_promotion_requests').select('*');
    expect(star.error).not.toBeNull();
    expect(star.error!.code).toBe('42501');
  });

  it('他の家族の人・宛先の本人・anon はテーブルから読めない', async () => {
    const otherFamily = await asUser(famA.rep.jwt)
      .from('family_promotion_requests')
      .select('id, email, status')
      .eq('family_id', famC.familyId);
    expect(otherFamily.error).toBeNull();
    expect(otherFamily.data).toEqual([]);

    // 宛先の本人向けのポリシーは作らない (get_promotion_details 経由で読む)
    const target = await asUser(victim5.jwt).from('family_promotion_requests').select('id, email, status');
    expect(target.error).toBeNull();
    expect(target.data).toEqual([]);

    const anonRead = await anon().from('family_promotion_requests').select('id');
    expect(anonRead.error).not.toBeNull();
    expect(anonRead.error!.code).toBe('42501');
  });

  it('get_promotion_details: anon でもトークンで内容を確認でき、token や ID は返さない', async () => {
    await asUser(famD.rep.jwt).rpc('request_child_promotion', { p_member_id: childD3, p_email: victim5.email });
    const token = await pendingToken(childD3);

    const { data, error } = await anon().rpc('get_promotion_details', { p_token: token });
    expect(error).toBeNull();
    const details = data as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual([
      'current_user_email_matches',
      'email',
      'expires_at',
      'family_name',
      'member_display_name',
      'requested_by_name',
      'status',
    ]);
    expect(details.family_name).toBe(`#1232 family d ${TS}`);
    expect(details.member_display_name).toBe('D3');
    expect(details.requested_by_name).toBe('promo-rep-d');
    expect(details.email).toBe(victim5.email.toLowerCase());
    expect(details.status).toBe('pending');
    expect(details.current_user_email_matches).toBe(false);
    expect(JSON.stringify(details)).not.toContain(token);

    const asTarget = await asUser(victim5.jwt).rpc('get_promotion_details', { p_token: token });
    expect((asTarget.data as Record<string, unknown>).current_user_email_matches).toBe(true);
    const asOther = await asUser(outsider.jwt).rpc('get_promotion_details', { p_token: token });
    expect((asOther.data as Record<string, unknown>).current_user_email_matches).toBe(false);

    const missing = await anon().rpc('get_promotion_details', { p_token: 'e'.repeat(64) });
    expect(missing.error).toBeNull();
    expect(missing.data).toBeNull();
  });
});

describe('#1232 プロフィール行が無い新規ユーザーの承認 (2026-10-07 オーナー判断)', () => {
  it('初期設定前 (プロフィール行なし) に承認しても所属家族が入り、初期設定の保存のあとも残る', async () => {
    const { data: before } = await srAdmin.from('user_profiles').select('id').eq('id', newcomer.id).maybeSingle();
    expect(before).toBeNull();

    await asUser(famE.rep.jwt).rpc('request_child_promotion', { p_member_id: childE1, p_email: newcomer.email });
    const token = await pendingToken(childE1);
    const { error } = await asUser(newcomer.jwt).rpc('accept_child_promotion', { p_token: token });
    expect(error).toBeNull();
    expect((await getMember(childE1)).user_id).toBe(newcomer.id);

    // 承認でプロフィール行ができ、所属家族が入る。初期設定は未開始のまま (オンボーディングの導線は変わらない)
    const { data: created } = await srAdmin
      .from('user_profiles')
      .select('family_id, nickname, age_group, gender, onboarding_started_at, onboarding_completed_at')
      .eq('id', newcomer.id)
      .single();
    expect(created).toEqual({
      family_id: famE.familyId,
      nickname: 'Guest',
      age_group: 'unspecified',
      gender: 'unspecified',
      onboarding_started_at: null,
      onboarding_completed_at: null,
    });

    // 初期設定の保存 (/api/onboarding/progress と同じく本人のセッションで upsert。family_id は送らない)
    const saved = await asUser(newcomer.jwt)
      .from('user_profiles')
      .upsert({ id: newcomer.id, nickname: 'はなこ', age_group: '10s', gender: 'female' })
      .select('family_id, nickname')
      .single();
    expect(saved.error).toBeNull();
    expect(saved.data).toEqual({ family_id: famE.familyId, nickname: 'はなこ' });
  });
});

describe('#1232 API ルート (Bearer JWT。応答に token を含めない)', () => {
  it('★POST /promote は pending を返すだけで編入せず、応答に token が無い', async () => {
    const res = await apiCall<{ data?: { request?: Record<string, unknown> } }>(
      'POST',
      `/api/family/members/${childD1}/promote`,
      famD.rep.jwt,
      { email: outsider.email },
    );
    expect(res.status).toBe(200);
    const request = res.body.data!.request!;
    expect(Object.keys(request).sort()).toEqual(['email', 'expires_at', 'id', 'member_id', 'status']);
    expect(request.status).toBe('pending');
    expect(request.member_id).toBe(childD1);

    const token = await pendingToken(childD1);
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect((await getMember(childD1)).user_id).toBeNull();
    expect(await getProfileFamilyId(outsider.id)).toBeNull();
  });

  it('POST /promote: 他の家族の代表者は 403 NOT_FAMILY_ADULT、メール形式不正は 400', async () => {
    const other = await apiCall<{ error?: { code?: string } }>(
      'POST',
      `/api/family/members/${childD1}/promote`,
      famA.rep.jwt,
      { email: victim4.email },
    );
    expect(other.status).toBe(403);
    expect(other.body.error?.code).toBe('NOT_FAMILY_ADULT');

    const invalid = await apiCall<{ error?: { code?: string } }>(
      'POST',
      `/api/family/members/${childD1}/promote`,
      famD.rep.jwt,
      { email: 'not-an-email' },
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('POST /promotions/[token]/accept: 他人は 403、本人は 200 で最小の JSON だけを返す', async () => {
    const token = await pendingToken(childD1);
    const other = await apiCall<{ error?: { code?: string } }>(
      'POST',
      `/api/family/promotions/${token}/accept`,
      victim4.jwt,
      {},
    );
    expect(other.status).toBe(403);
    expect(other.body.error?.code).toBe('PROMOTION_EMAIL_MISMATCH');

    const res = await apiCall<{ data?: Record<string, unknown> }>(
      'POST',
      `/api/family/promotions/${token}/accept`,
      outsider.jwt,
      {},
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data!).sort()).toEqual(['family_id', 'member_id', 'role']);
    expect(res.body.data).toEqual({ family_id: famD.familyId, member_id: childD1, role: 'adult' });

    // body 省略時の共有設定は 食事=共有 / 健康=非共有 / 献立=共有
    const child = await getMember(childD1);
    expect(child.user_id).toBe(outsider.id);
    expect([child.share_meals, child.share_health, child.share_menu]).toEqual([true, false, true]);
  });

  it('POST /promotions/[token]/accept: トークン形式が不正なら 400', async () => {
    const res = await apiCall<{ error?: { code?: string } }>(
      'POST',
      `/api/family/promotions/${'A'.repeat(64)}/accept`,
      victim4.jwt,
      {},
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('DELETE /promote は取消して {request_id, status} だけを返す (token を含まない)', async () => {
    const created = await apiCall('POST', `/api/family/members/${childD2}/promote`, famD.rep.jwt, {
      email: victim4.email,
    });
    expect(created.status).toBe(200);
    const token = await pendingToken(childD2);

    const res = await apiCall<{ data?: Record<string, unknown> }>(
      'DELETE',
      `/api/family/members/${childD2}/promote`,
      famD.rep.jwt,
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data!).sort()).toEqual(['request_id', 'status']);
    expect(res.body.data!.status).toBe('revoked');
    expect(JSON.stringify(res.body)).not.toContain(token);

    const none = await apiCall<{ error?: { code?: string } }>(
      'DELETE',
      `/api/family/members/${childD2}/promote`,
      famD.rep.jwt,
    );
    expect(none.status).toBe(404);
    expect(none.body.error?.code).toBe('PROMOTION_REQUEST_NOT_FOUND');
  });

  it('POST /promotions/[token]/reject は本人だけが拒否でき、{request_id, status} だけを返す', async () => {
    const token = await pendingToken(childD3);
    const res = await apiCall<{ data?: Record<string, unknown> }>(
      'POST',
      `/api/family/promotions/${token}/reject`,
      victim5.jwt,
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data!).sort()).toEqual(['request_id', 'status']);
    expect(res.body.data!.status).toBe('rejected');
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect((await getMember(childD3)).user_id).toBeNull();

    const again = await apiCall<{ error?: { code?: string } }>(
      'POST',
      `/api/family/promotions/${token}/reject`,
      victim5.jwt,
    );
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('PROMOTION_REQUEST_ALREADY_USED');
  });
});

describe('#1232 DB 定義 (関数・権限・CHECK 制約)', () => {
  it('★CHECK 制約: 譲渡辞退 2 値と新しい 3 値を INSERT でき、未知の値は 23514', async () => {
    const actions = [
      'owner_transfer_declined',
      'representative_transfer_declined',
      'child_promotion_requested',
      'child_promotion_rejected',
      'child_promotion_revoked',
    ];
    for (const action of actions) {
      const { data, error } = await srAdmin
        .from('membership_audit')
        .insert({ scope: 'family', scope_id: famA.familyId, action, metadata: { test: '#1232' } })
        .select('id')
        .single();
      expect(error, action).toBeNull();
      await srAdmin.from('membership_audit').delete().eq('id', (data as { id: string }).id);
    }

    const bogus = await srAdmin
      .from('membership_audit')
      .insert({ scope: 'family', scope_id: famA.familyId, action: 'bogus_action', metadata: {} });
    expect(bogus.error).not.toBeNull();
    expect(bogus.error!.code).toBe('23514');
  });

  it('★v3 (G10): 4 本の書き込み RPC がロック順 family_members → family_promotion_requests と 40P01 の置き換えを持つ', async () => {
    const rows = await pgQuery<{
      proname: string;
      lock_order_marker: boolean;
      deadlock_handler: boolean;
      conflict_retry_mapped: boolean;
      lock_order_ok: boolean;
    }>(`
      WITH defs AS (
        SELECT p.proname, pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('request_child_promotion','accept_child_promotion',
                            'reject_child_promotion','revoke_child_promotion')
      )
      SELECT proname,
        def LIKE '%LOCK-ORDER: family_members -> family_promotion_requests%' AS lock_order_marker,
        def LIKE '%deadlock_detected%' AS deadlock_handler,
        def LIKE '%CONFLICT_RETRY%' AS conflict_retry_mapped,
        CASE proname
          WHEN 'accept_child_promotion' THEN
            position('FROM family_members WHERE id = v_request.member_id FOR UPDATE' IN def) > 0
            AND position('FROM family_members WHERE id = v_request.member_id FOR UPDATE' IN def)
              < position('FROM family_promotion_requests WHERE token = p_token FOR UPDATE' IN def)
          WHEN 'reject_child_promotion' THEN
            position('FROM family_members WHERE id = v_request.member_id FOR UPDATE' IN def) > 0
            AND position('FROM family_members WHERE id = v_request.member_id FOR UPDATE' IN def)
              < position('FROM family_promotion_requests WHERE token = p_token FOR UPDATE' IN def)
          WHEN 'request_child_promotion' THEN
            position('FROM family_members WHERE id = p_member_id FOR UPDATE' IN def) > 0
            AND position('FROM family_members WHERE id = p_member_id FOR UPDATE' IN def)
              < position('UPDATE family_promotion_requests' IN def)
          WHEN 'revoke_child_promotion' THEN
            position('FROM family_members WHERE id = p_member_id FOR UPDATE' IN def) > 0
            AND position('FROM family_members WHERE id = p_member_id FOR UPDATE' IN def)
              < position('FROM family_promotion_requests' IN def)
        END AS lock_order_ok
      FROM defs
      ORDER BY proname
    `);
    expect(rows.map((r) => r.proname)).toEqual([
      'accept_child_promotion',
      'reject_child_promotion',
      'request_child_promotion',
      'revoke_child_promotion',
    ]);
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({
        lock_order_marker: true,
        deadlock_handler: true,
        conflict_retry_mapped: true,
        lock_order_ok: true,
      });
    }
  });

  it('accept は uniq_family_members_user の一意制約違反を ALREADY_IN_FAMILY に置き換え、トークンは gen_random_bytes を使わない', async () => {
    const [row] = await pgQuery<{ accept_def: string; request_def: string }>(`
      SELECT pg_get_functiondef('public.accept_child_promotion(text, boolean, boolean, boolean)'::regprocedure) AS accept_def,
             pg_get_functiondef('public.request_child_promotion(uuid, text)'::regprocedure) AS request_def
    `);
    expect(row.accept_def).toContain('uniq_family_members_user');
    expect(row.accept_def).toContain('unique_violation');
    expect(row.request_def).toContain('gen_random_uuid');
    // 関数本体のコメントに「gen_random_bytes は使用禁止」とあるため、呼び出しの有無で確かめる
    expect(row.request_def).not.toMatch(/gen_random_bytes\s*\(/);
  });

  it('★実行権限: 書き込み 4 本は authenticated のみ、get_promotion_details は anon も可。旧版は anon 不可・(uuid,uuid) は無い', async () => {
    const rows = await pgQuery<{ sig: string; anon_exec: boolean; auth_exec: boolean }>(`
      SELECT p.oid::regprocedure::text AS sig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('request_child_promotion','accept_child_promotion','reject_child_promotion',
                          'revoke_child_promotion','get_promotion_details','promote_child_to_user')
      ORDER BY 1
    `);
    expect(rows).toEqual([
      { sig: 'accept_child_promotion(text,boolean,boolean,boolean)', anon_exec: false, auth_exec: true },
      { sig: 'get_promotion_details(text)', anon_exec: true, auth_exec: true },
      { sig: 'promote_child_to_user(uuid,text)', anon_exec: false, auth_exec: true },
      { sig: 'reject_child_promotion(text)', anon_exec: false, auth_exec: true },
      { sig: 'request_child_promotion(uuid,text)', anon_exec: false, auth_exec: true },
      { sig: 'revoke_child_promotion(uuid)', anon_exec: false, auth_exec: true },
    ]);

    const [legacy] = await pgQuery<{ def: string }>(
      `SELECT pg_get_functiondef('public.promote_child_to_user(uuid, text)'::regprocedure) AS def`,
    );
    expect(legacy.def).toContain('PROMOTION_DIRECT_DISABLED');
    expect(legacy.def).not.toContain('UPDATE family_members');
  });

  it('★token 列は authenticated から読めず、テーブルのポリシーは auth.users を参照しない', async () => {
    const [priv] = await pgQuery<{ token_readable: boolean; id_readable: boolean; anon_any: boolean }>(`
      SELECT has_column_privilege('authenticated', 'public.family_promotion_requests', 'token', 'SELECT') AS token_readable,
             has_column_privilege('authenticated', 'public.family_promotion_requests', 'id', 'SELECT') AS id_readable,
             has_table_privilege('anon', 'public.family_promotion_requests', 'SELECT') AS anon_any
    `);
    expect(priv).toEqual({ token_readable: false, id_readable: true, anon_any: false });

    const policies = await pgQuery<{ policyname: string; cmd: string; qual: string | null }>(`
      SELECT policyname, cmd, qual FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'family_promotion_requests'
    `);
    expect(policies.map((p) => `${p.policyname}:${p.cmd}`)).toEqual(['family_promotion_requests_select_family:SELECT']);
    for (const p of policies) {
      expect(p.qual ?? '').not.toContain('auth.users');
    }
  });

  it('退行ガード: can_view_user_meals の anon 実行権限は変えていない', async () => {
    const [row] = await pgQuery<{ anon_exec: boolean }>(
      `SELECT has_function_privilege('anon', 'public.can_view_user_meals(uuid)', 'EXECUTE') AS anon_exec`,
    );
    expect(row.anon_exec).toBe(true);
  });
});
