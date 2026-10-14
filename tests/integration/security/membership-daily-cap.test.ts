/**
 * #1163 招待・子供メンバーの昇格リクエスト (参加リクエスト)・譲渡提案の作成に、DB で数える 24 時間の上限 (実 DB と実際の API での回帰テスト)
 *
 * アプリ層の上限 (src/lib/rate-limit.ts / invite-throttle.ts) は、本番で Upstash が未設定だと in-memory (サーバーインスタンスごと) で
 * 数えるため、日次の上限は概算にしかならない。そこで 5 つの作成 RPC は、public.membership_audit の件数を数える
 * enforce_membership_daily_cap (migration 20261008100000) で、直近 24 時間の上限を DB でも確かめる。
 *   - 家族の招待       : 招待者ごと 20 / 同じ家族から同じ宛先へ 3
 *   - 組織の招待       : 招待者ごと 200 / 組織ごと 500 / 同じ組織から同じ宛先へ 3
 *   - 昇格リクエスト   : 依頼者ごと 10 / 同じ家族から同じ宛先へ 3
 *   - 譲渡提案         : 提案者ごと 10 (家族の代表者譲渡と組織のオーナー譲渡の合計)
 * 超過は RAISE 'RATE_LIMITED' (SQLSTATE P0001、DETAIL = 上限名、HINT = 'retry_after_sec=<秒>')。
 * Web の route は、これをアプリ層の上限と同じ 429 { error: { code: 'RATE_LIMITED', message, retryAfter } } + Retry-After にする。
 *
 * 確かめること:
 *   A. 各上限: 上限ちょうど (N 件目) までは成功し、N+1 件目は RATE_LIMITED。失敗した呼び出しは行も監査行も残さない。
 *      上限の手前までは service role で membership_audit に種まきして積む (数百回の RPC を呼ばない)。
 *   B. 数えた元を消しても戻らない: 組織の招待を物理削除しても、家族を消して作り直しても、監査行は残るので上限は戻らない。
 *      組織の招待は create_org_invite が監査行を書かない (SECURITY INVOKER) ため、トリガーが 'invite_created' を書く。
 *   C. 24 時間のローリングウィンドウ: 24 時間より前の作成は数えない。Retry-After は最古の対象行が窓から出るまでの秒数。
 *   D. 同時実行: 上限の 1 つ手前で複数の呼び出しが同時に来ても、通るのはちょうど 1 件 (23505 などの別のエラーも出ない)。
 *      タイミングに頼らない確かめ方も置く: 別の接続で先の処理を「上限を数えて記録を書いた後・コミット前」で止め (pg_sleep)、
 *      その間に来た後の処理が、ロックで待たされてコミット後に数え直し、拒否されること (ロックを外すと必ず落ちる)。
 *   E. テナント分離: 別の家族・組織・利用者の件数は影響しない。helper を /rpc で直接呼んでも他テナントの件数は覗けず、書き込みもしない。
 *   F. 既存の挙動: 認可・人数/席数の上限・対象の確認が、上限の判定より先に評価される。
 *   G. API: POST /api/family/invites ほか 6 本が、DB の上限に達したときにアプリ層と同じ 429 (本文 + Retry-After) を返す。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/membership-daily-cap.test.ts
 */

import { randomBytes } from 'node:crypto';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
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
// 同じ JWT のクライアントは使い回す。同時実行のテストで、クライアントの生成にかかる時間で呼び出しがずれて
// 順番に実行されてしまうと、ロックが無くても通ってしまう (競合を検出できない) ため
const userClients = new Map<string, SupabaseClient>();
const asUser = (jwt: string): SupabaseClient => {
  let c = userClients.get(jwt);
  if (!c) {
    c = client(anonKey, jwt);
    userClients.set(jwt, c);
  }
  return c;
};

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

interface TestFamily {
  familyId: string;
  rep: TestUser;
  adult: TestUser | null;
}

interface TestOrg {
  orgId: string;
  owner: TestUser;
  admin: TestUser;
  member: TestUser | null;
}

type RpcResult = { data: unknown; error: PostgrestError | null };

const TS = Date.now();
/** 種まきした監査行の印 (後片付けで使う) */
const SEED_TAG = `#1163-db-cap-${TS}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const HOUR_MS = 60 * 60 * 1000;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdFamilyIds: string[] = [];

/** 宛先ごとに一意なメールアドレス (実行ごとに変わるので、前回の実行の監査行とも混ざらない) */
const target = (label: string) => `dbcap-${label}-${TS}@homegohan.test`;

// ────────────────────────────────────────────────────────────────
// 準備 (利用者・家族・組織)
// ────────────────────────────────────────────────────────────────
async function createUser(label: string): Promise<TestUser> {
  const email = `sec-dbcap-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `dbcap-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

/** 家族を作る (代表者は create_family_group、大人は service role で family_members に追加) */
async function createFamily(
  label: string,
  options: { adult?: boolean; memberLimit?: number } = {},
): Promise<TestFamily> {
  const rep = await createUser(`rep-${label}`);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `#1163 db-cap ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);

  if (options.memberLimit !== undefined) {
    const { error: limitError } = await srAdmin
      .from('family_groups')
      .update({ member_limit: options.memberLimit })
      .eq('id', familyId);
    if (limitError) throw new Error(`member_limit ${label}: ${limitError.message}`);
  }

  let adult: TestUser | null = null;
  if (options.adult) {
    adult = await createUser(`adult-${label}`);
    const { error: memberError } = await srAdmin
      .from('family_members')
      .insert({ family_id: familyId, user_id: adult.id, role: 'adult', status: 'active' });
    if (memberError) throw new Error(`family_members ${label}: ${memberError.message}`);
    // 招待の承諾 (accept_family_invite) と同じ状態にする。API は user_profiles.family_id で所属を確かめる
    const { error: familyIdError } = await srAdmin.from('user_profiles').update({ family_id: familyId }).eq('id', adult.id);
    if (familyIdError) throw new Error(`user_profiles.family_id ${label}: ${familyIdError.message}`);
  }
  return { familyId, rep, adult };
}

async function addChild(family: TestFamily, name: string): Promise<string> {
  const { data, error } = await asUser(family.rep.jwt).rpc('add_family_child', {
    p_family_id: family.familyId,
    p_display_name: name,
    p_child_profile: { age: 11 },
  });
  if (error || !data) throw new Error(`add_family_child ${name}: ${error?.message}`);
  return (data as { id: string }).id;
}

/** 組織の所属を service role で設定する (特権列は本人の JWT では変更できない) */
async function setOrgMembership(userId: string, orgId: string | null, role: 'owner' | 'admin' | 'member' | null) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: role, is_active_in_org: orgId !== null })
    .eq('id', userId);
  if (error) throw new Error(`setOrgMembership: ${error.message}`);
}

async function createOrg(label: string, options: { member?: boolean } = {}): Promise<TestOrg> {
  const { data: org, error } = await srAdmin
    .from('organizations')
    .insert({ name: `#1163 db-cap ${label} ${TS}` })
    .select('id')
    .single();
  if (error || !org) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = org.id as string;
  createdOrgIds.push(orgId);

  const [owner, admin] = await Promise.all([createUser(`owner-${label}`), createUser(`admin-${label}`)]);
  await setOrgMembership(owner.id, orgId, 'owner');
  await setOrgMembership(admin.id, orgId, 'admin');
  let member: TestUser | null = null;
  if (options.member) {
    member = await createUser(`member-${label}`);
    await setOrgMembership(member.id, orgId, 'member');
  }
  return { orgId, owner, admin, member };
}

/**
 * 家族の代表者であり、組織のオーナーでもある利用者の家族と組織 (家族の代表者譲渡と組織のオーナー譲渡を、同じ提案者が出せる)。
 * user_profiles の family_id と organization_id / org_role は独立している。元のオーナーは組織から外す。
 */
async function createDualOwner(label: string): Promise<{ family: TestFamily; org: TestOrg }> {
  const family = await createFamily(label, { adult: true });
  const org = await createOrg(label, { member: true });
  await setOrgMembership(org.owner.id, null, null);
  await setOrgMembership(family.rep.id, org.orgId, 'owner');
  return { family, org: { ...org, owner: family.rep } };
}

// ────────────────────────────────────────────────────────────────
// 監査行の種まきと集計 (service role)
// ────────────────────────────────────────────────────────────────
let seedSerial = 0;

interface AuditSeed {
  scope: 'family' | 'organization';
  scopeId: string;
  action: 'invite_created' | 'child_promotion_requested' | 'owner_transfer_proposed' | 'representative_transfer_proposed';
  /** null は「アカウントを消した人の行」 (actor_id は ON DELETE SET NULL) */
  actorId: string | null;
  count: number;
  /** 宛先。省略すると行ごとに別の宛先にする (宛先の上限に数えさせない) */
  email?: string;
  /** 作成時刻を何 ms 前にするか。既定は 1 時間前 (24 時間の窓の中) */
  ageMs?: number;
}

async function seedAudit(spec: AuditSeed): Promise<void> {
  const createdAt = new Date(Date.now() - (spec.ageMs ?? HOUR_MS)).toISOString();
  const serial = ++seedSerial;
  const rows = Array.from({ length: spec.count }, (_, i) => ({
    scope: spec.scope,
    scope_id: spec.scopeId,
    action: spec.action,
    actor_id: spec.actorId,
    metadata: { seed: SEED_TAG, n: i, email: (spec.email ?? target(`seed-${serial}-${i}`)).toLowerCase() },
    created_at: createdAt,
  }));
  for (let from = 0; from < rows.length; from += 250) {
    const { error } = await srAdmin.from('membership_audit').insert(rows.slice(from, from + 250));
    if (error) throw new Error(`seedAudit: ${error.message}`);
  }
}

interface AuditFilter {
  action: string;
  scopeId?: string;
  actorId?: string;
  email?: string;
}

async function auditCount(filter: AuditFilter): Promise<number> {
  let query = srAdmin.from('membership_audit').select('id', { count: 'exact', head: true }).eq('action', filter.action);
  if (filter.scopeId) query = query.eq('scope_id', filter.scopeId);
  if (filter.actorId) query = query.eq('actor_id', filter.actorId);
  if (filter.email) query = query.contains('metadata', { email: filter.email.toLowerCase() });
  const { count, error } = await query;
  if (error) throw new Error(`auditCount: ${error.message}`);
  return count ?? 0;
}

async function familyInviteRows(familyId: string, email: string) {
  const { data, error } = await srAdmin
    .from('family_invites')
    .select('id, status')
    .eq('family_id', familyId)
    .eq('email', email.toLowerCase());
  if (error) throw new Error(`family_invites: ${error.message}`);
  return (data ?? []) as Array<{ id: string; status: string }>;
}

async function orgInviteRows(orgId: string, email: string) {
  const { data, error } = await srAdmin
    .from('organization_invites')
    .select('id, status')
    .eq('organization_id', orgId)
    .eq('email', email.toLowerCase());
  if (error) throw new Error(`organization_invites: ${error.message}`);
  return (data ?? []) as Array<{ id: string; status: string }>;
}

async function promotionRows(memberId: string, email: string) {
  const { data, error } = await srAdmin
    .from('family_promotion_requests')
    .select('id, status')
    .eq('member_id', memberId)
    .eq('email', email.toLowerCase());
  if (error) throw new Error(`family_promotion_requests: ${error.message}`);
  return (data ?? []) as Array<{ id: string; status: string }>;
}

async function proposalRows(scopeId: string, fromUserId: string) {
  const { data, error } = await srAdmin
    .from('ownership_transfer_proposals')
    .select('id, status')
    .eq('scope_id', scopeId)
    .eq('from_user_id', fromUserId);
  if (error) throw new Error(`ownership_transfer_proposals: ${error.message}`);
  return (data ?? []) as Array<{ id: string; status: string }>;
}

// ────────────────────────────────────────────────────────────────
// RPC の呼び出し
// ────────────────────────────────────────────────────────────────
/**
 * ローカルスタックの Kong が、上流 (PostgREST) との接続のリセットで返す一過性の 502
 * ("An invalid response was received from the upstream server") だけ、1 回やり直す。
 * DDL (migration の適用) の直後や、使われていない keep-alive の接続が閉じられた瞬間に再利用されたときに、まれに起きる。
 * 上限の判定が失敗したのではなく、応答が返らなかっただけ。やり直しで二重に実行されても、件数を確かめる expect が失敗するので見逃さない。
 */
const TRANSIENT_GATEWAY_ERROR = /invalid response was received from the upstream|bad gateway|ECONNRESET|socket hang up|fetch failed/i;

async function retryOnceIfTransient(call: () => PromiseLike<RpcResult>): Promise<RpcResult> {
  const first = await call();
  if (!first.error || !TRANSIENT_GATEWAY_ERROR.test(`${first.error.message} ${first.error.details ?? ''}`)) return first;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return call();
}

const inviteToFamily = (user: TestUser, familyId: string, email: string): Promise<RpcResult> =>
  retryOnceIfTransient(() => asUser(user.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: email }));

const inviteToOrg = (user: TestUser, orgId: string, email: string): Promise<RpcResult> =>
  retryOnceIfTransient(() =>
    asUser(user.jwt).rpc('create_org_invite', { p_organization_id: orgId, p_email: email, p_role: 'member' }),
  );

const requestPromotion = (user: TestUser, memberId: string, email: string): Promise<RpcResult> =>
  retryOnceIfTransient(() => asUser(user.jwt).rpc('request_child_promotion', { p_member_id: memberId, p_email: email }));

const proposeFamilyTransfer = (user: TestUser, familyId: string, toUserId: string): Promise<RpcResult> =>
  retryOnceIfTransient(() =>
    asUser(user.jwt).rpc('propose_family_representative_transfer', { p_family_id: familyId, p_to_user_id: toUserId }),
  );

const proposeOrgTransfer = (user: TestUser, orgId: string, toUserId: string): Promise<RpcResult> =>
  retryOnceIfTransient(() =>
    asUser(user.jwt).rpc('propose_org_owner_transfer', { p_organization_id: orgId, p_to_user_id: toUserId }),
  );

const callHelper = (
  who: 'anon' | 'service' | TestUser,
  args: { p_kind: string; p_scope_id: string | null; p_email?: string | null },
): Promise<RpcResult> => {
  const c = who === 'anon' ? anon() : who === 'service' ? client(serviceKey) : asUser(who.jwt);
  return retryOnceIfTransient(() => c.rpc('enforce_membership_daily_cap', args));
};

// ────────────────────────────────────────────────────────────────
// 競合の確定的な再現 (タイミングに頼らない。family-member-limit-race.test.ts と同じ方法)
// ────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 開いたままにしている接続。後片付けの前にすべて終わらせる */
const pendingHolders: Array<Promise<unknown>> = [];

/** ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で SQL を実行する。複数の文は 1 つのトランザクションで実行される */
async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

/** 競合の観測 (pg_stat_activity の読み取り) だけに使う */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

interface HeldOutcome {
  ok: boolean;
  message: string | null;
}

/**
 * 別の接続で、user になりすまして RPC (rpcSql) を呼び、そのあと holdSeconds 秒 pg_sleep してトランザクションを開いたままにする。
 * sleeping は「RPC の実行が済み、pg_sleep に入った」(= 上限を数えて記録を書いたが、まだコミットしていない) 状態になると解決する。
 * done はトランザクションが終わった (コミットされた) ときに解決する。
 */
function holdOpen(user: TestUser, rpcSql: string, holdSeconds: number): { sleeping: Promise<void>; done: Promise<HeldOutcome> } {
  const marker = `dbcap-holder-${randomBytes(6).toString('hex')}`;
  const claims = JSON.stringify({ sub: user.id, role: 'authenticated' });
  const sql = `/* ${marker} */
    SELECT set_config('request.jwt.claims', '${claims}', true);
    SET LOCAL ROLE authenticated;
    SELECT * FROM ${rpcSql};
    SELECT pg_sleep(${holdSeconds});
    SELECT 'held' AS result;`;

  const state: { outcome: HeldOutcome | null } = { outcome: null };
  const done = pgRequest(sql).then((res): HeldOutcome => {
    const body = res.body as { error?: unknown } | null;
    const outcome: HeldOutcome = res.ok
      ? { ok: true, message: null }
      : { ok: false, message: typeof body?.error === 'string' ? body.error : JSON.stringify(body) };
    state.outcome = outcome;
    return outcome;
  });
  pendingHolders.push(done);

  const sleeping = (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (state.outcome) {
        // pg_sleep に入る前に終わった = 先の RPC が失敗している (競合の再現にならないので、理由を示して止める)
        throw new Error(`先に呼んだ接続が pg_sleep に入る前に終わりました: ${JSON.stringify(state.outcome)}`);
      }
      const rows = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event = 'PgSleep' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
      if (rows[0]?.n === 1) return;
      await sleep(50);
    }
    throw new Error('先に呼んだ接続が pg_sleep に入りませんでした (遅すぎます)');
  })();

  return { sleeping, done };
}

/** 先に first を呼んでトランザクションを開いたままにし、その間に second を本物の経路 (PostgREST + 本人の JWT) で呼ぶ */
async function raceAfterHold(
  first: { user: TestUser; rpcSql: string },
  second: () => Promise<RpcResult>,
  holdSeconds = 3,
): Promise<{ first: HeldOutcome; second: RpcResult; secondMs: number }> {
  const holder = holdOpen(first.user, first.rpcSql, holdSeconds);
  await holder.sleeping;
  const startedAt = Date.now();
  const secondResult = await second();
  const secondMs = Date.now() - startedAt;
  return { first: await holder.done, second: secondResult, secondMs };
}

/**
 * RATE_LIMITED の形を確かめる: message はコード 1 語、SQLSTATE は P0001、DETAIL に上限名、HINT に再試行までの秒数。
 * approxSec を渡すと、秒数が「最古の対象行 + 24 時間 − 今」付近 (誤差 ±120 秒) であることも確かめる。
 */
function expectRateLimited(error: PostgrestError | null, rule: string, approxSec?: number) {
  expect(error, `RATE_LIMITED になるはず (${rule})`).not.toBeNull();
  expect(error!.message).toBe('RATE_LIMITED');
  expect(error!.code).toBe('P0001');
  expect(error!.details).toBe(rule);
  expect(error!.hint).toMatch(/^retry_after_sec=\d+$/);
  const sec = Number(error!.hint!.split('=')[1]);
  expect(sec).toBeGreaterThanOrEqual(1);
  expect(sec).toBeLessThanOrEqual(24 * 3600);
  if (approxSec !== undefined) {
    expect(Math.abs(sec - approxSec)).toBeLessThanOrEqual(120);
  }
}

/** 上限と無関係の既存エラーで失敗したこと (RATE_LIMITED ではないこと) を確かめる */
function expectNotRateLimited(error: PostgrestError | null, code: string) {
  expect(error, `${code} で失敗するはず`).not.toBeNull();
  expect(error!.message).toBe(code);
  expect(error!.message).not.toBe('RATE_LIMITED');
}

const rateLimited = (r: RpcResult) => r.error?.message === 'RATE_LIMITED';

// ────────────────────────────────────────────────────────────────
// 後片付け
// ────────────────────────────────────────────────────────────────
afterAll(async () => {
  await Promise.allSettled(pendingHolders);
  // 監査行: 種まき分 (印) / 作った家族・組織の分 / 作った利用者が操作者の分
  await srAdmin.from('membership_audit').delete().contains('metadata', { seed: SEED_TAG });
  if (createdFamilyIds.length > 0) await srAdmin.from('membership_audit').delete().in('scope_id', createdFamilyIds);
  if (createdOrgIds.length > 0) await srAdmin.from('membership_audit').delete().in('scope_id', createdOrgIds);
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin.from('ownership_transfer_proposals').delete().in('from_user_id', createdUserIds);
  }
  for (const id of createdOrgIds) {
    await srAdmin.from('organization_invites').delete().eq('organization_id', id);
    await srAdmin.from('org_license_pools').delete().eq('organization_id', id);
  }
  if (createdUserIds.length > 0) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false, family_id: null })
      .in('id', createdUserIds);
  }
  // family_groups.representative_id は auth.users を RESTRICT で参照するので、利用者より先に家族を消す
  // (family_members / family_invites / family_promotion_requests は CASCADE)
  for (const id of createdOrgIds) {
    await srAdmin.from('organizations').delete().eq('id', id);
  }
  for (const id of createdFamilyIds) {
    await srAdmin.from('family_groups').delete().eq('id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 180_000);

// ================================================================
// A-1. 家族の招待
// ================================================================
describe('#1163 家族の招待 (create_family_invite): 招待者ごと 20 / 同じ家族から同じ宛先へ 3', () => {
  let famActor: TestFamily;
  let famTarget: TestFamily;
  let famOther: TestFamily;
  let famWindow: TestFamily;

  beforeAll(async () => {
    [famActor, famTarget, famOther, famWindow] = await Promise.all([
      createFamily('fi-actor', { adult: true }),
      createFamily('fi-target', { adult: true }),
      createFamily('fi-other'),
      createFamily('fi-window'),
    ]);
  }, 120_000);

  it('FI-1: 招待者ごと 20 件目まで成功し、21 件目は RATE_LIMITED (family_invite:per_actor)。失敗した呼び出しは行も監査行も残さない', async () => {
    const { rep, familyId } = famActor;
    await seedAudit({ scope: 'family', scopeId: familyId, action: 'invite_created', actorId: rep.id, count: 19 });

    const twentieth = await inviteToFamily(rep, familyId, target('fi-20th'));
    expect(twentieth.error).toBeNull();
    expect(await auditCount({ action: 'invite_created', scopeId: familyId, actorId: rep.id })).toBe(20);

    const over = await inviteToFamily(rep, familyId, target('fi-21st'));
    // 種まきは 1 時間前 → 最古の行が窓から出るまで約 23 時間
    expectRateLimited(over.error, 'family_invite:per_actor', 23 * 3600);
    expect(await familyInviteRows(familyId, target('fi-21st'))).toHaveLength(0);
    expect(await auditCount({ action: 'invite_created', scopeId: familyId, actorId: rep.id })).toBe(20);
  });

  it('FI-2: 上限に達した代表者がいても、同じ家族の別の大人と別の家族の代表者は影響を受けない', async () => {
    const adult = await inviteToFamily(famActor.adult!, famActor.familyId, target('fi-adult'));
    expect(adult.error).toBeNull();

    const other = await inviteToFamily(famOther.rep, famOther.familyId, target('fi-other'));
    expect(other.error).toBeNull();
  });

  it('FI-3: 同じ家族から同じ宛先へは 3 件まで。4 件目は family_invite:per_target (大文字小文字は区別しない)', async () => {
    const { rep, adult, familyId } = famTarget;
    const email = target('fi-same');
    for (let i = 0; i < 3; i++) {
      expect((await inviteToFamily(rep, familyId, email)).error, `${i + 1} 件目`).toBeNull();
    }

    const fourth = await inviteToFamily(rep, familyId, email.toUpperCase());
    expectRateLimited(fourth.error, 'family_invite:per_target', 24 * 3600);

    // 再送のたびに前の招待は取り消され、有効 (pending) なのは最後の 1 件だけ。失敗した 4 件目は行を増やさない
    const rows = await familyInviteRows(familyId, email);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'revoked')).toHaveLength(2);
    expect(await auditCount({ action: 'invite_created', scopeId: familyId, email })).toBe(3);

    // 同じ家族の別の大人も、同じ宛先は拒否される (宛先の上限は家族単位)。別の宛先は通る
    const sameTargetByAdult = await inviteToFamily(adult!, familyId, email);
    expectRateLimited(sameTargetByAdult.error, 'family_invite:per_target');
    expect((await inviteToFamily(adult!, familyId, target('fi-other-target'))).error).toBeNull();

    // 別の家族は、同じ宛先へ送れる (他の家族の件数は影響しない)
    expect((await inviteToFamily(famOther.rep, famOther.familyId, email)).error).toBeNull();
  });

  it('FI-4: 24 時間より前の作成は数えない。窓の中の件数で判定し、Retry-After は最古の対象行が窓から出るまで', async () => {
    const { rep, familyId } = famWindow;
    // 24 時間 5 分前の 20 件は、もう数えない
    await seedAudit({ scope: 'family', scopeId: familyId, action: 'invite_created', actorId: rep.id, count: 20, ageMs: 24 * HOUR_MS + 5 * 60_000 });
    expect((await inviteToFamily(rep, familyId, target('fi-win-1'))).error).toBeNull();

    // 23 時間 55 分前の 18 件 + さっきの 1 件 = 窓の中は 19 件 → 次の 1 件は通り、その次は拒否される
    await seedAudit({ scope: 'family', scopeId: familyId, action: 'invite_created', actorId: rep.id, count: 18, ageMs: 23 * HOUR_MS + 55 * 60_000 });
    expect((await inviteToFamily(rep, familyId, target('fi-win-2'))).error).toBeNull();

    const over = await inviteToFamily(rep, familyId, target('fi-win-3'));
    // 窓の中で最古の行は 23 時間 55 分前 → あと約 5 分
    expectRateLimited(over.error, 'family_invite:per_actor', 5 * 60);
  });

  it('FI-5: 家族を消して作り直しても上限は戻らない (監査行は家族と無関係に残り、招待者ごとに数える)', async () => {
    const rep = await createUser('rep-fi-recreate');
    const created = await asUser(rep.jwt).rpc('create_family_group', { p_name: `#1163 recreate-1 ${TS}`, p_plan_key: 'free' });
    const firstFamilyId = (created.data as { id: string }).id;
    createdFamilyIds.push(firstFamilyId);
    await seedAudit({ scope: 'family', scopeId: firstFamilyId, action: 'invite_created', actorId: rep.id, count: 20 });
    expectRateLimited((await inviteToFamily(rep, firstFamilyId, target('fi-re-1'))).error, 'family_invite:per_actor');

    // 代表者は家族を丸ごと削除できる (family_groups_delete_representative)。招待の行は CASCADE で消える
    const deleted = await asUser(rep.jwt).from('family_groups').delete().eq('id', firstFamilyId).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toHaveLength(1);

    const recreated = await asUser(rep.jwt).rpc('create_family_group', { p_name: `#1163 recreate-2 ${TS}`, p_plan_key: 'free' });
    expect(recreated.error).toBeNull();
    const secondFamilyId = (recreated.data as { id: string }).id;
    createdFamilyIds.push(secondFamilyId);

    expectRateLimited((await inviteToFamily(rep, secondFamilyId, target('fi-re-2'))).error, 'family_invite:per_actor');
    expect(await familyInviteRows(secondFamilyId, target('fi-re-2'))).toHaveLength(0);
  });
});

// ================================================================
// A-2. 組織の招待 (+ B. トリガーが書く監査行)
// ================================================================
describe('#1163 組織の招待 (create_org_invite): 招待者ごと 200 / 組織ごと 500 / 同じ組織から同じ宛先へ 3', () => {
  let orgActor: TestOrg;
  let orgBig: TestOrg;
  let orgTarget: TestOrg;
  let orgOther: TestOrg;

  beforeAll(async () => {
    [orgActor, orgBig, orgTarget, orgOther] = await Promise.all([
      createOrg('oi-actor'),
      createOrg('oi-big'),
      createOrg('oi-target'),
      createOrg('oi-other'),
    ]);
  }, 120_000);

  it('OI-1: 招待者ごと 200 件目まで成功し、201 件目は RATE_LIMITED (org_invite:per_actor)。同じ組織の別の admin は影響を受けない', async () => {
    const { orgId, owner, admin } = orgActor;
    await seedAudit({ scope: 'organization', scopeId: orgId, action: 'invite_created', actorId: owner.id, count: 199 });

    expect((await inviteToOrg(owner, orgId, target('oi-200th'))).error).toBeNull();
    expect(await auditCount({ action: 'invite_created', scopeId: orgId, actorId: owner.id })).toBe(200);

    const over = await inviteToOrg(owner, orgId, target('oi-201st'));
    expectRateLimited(over.error, 'org_invite:per_actor', 23 * 3600);
    expect(await orgInviteRows(orgId, target('oi-201st'))).toHaveLength(0);
    expect(await auditCount({ action: 'invite_created', scopeId: orgId, actorId: owner.id })).toBe(200);

    // 組織の合計はまだ 200 件 (< 500)。admin 自身の件数は 0
    expect((await inviteToOrg(admin, orgId, target('oi-admin'))).error).toBeNull();
  });

  it('OI-2: 組織ごと 500 件目まで成功し、501 件目は owner も admin も RATE_LIMITED (org_invite:per_org)。別の組織は影響を受けない', async () => {
    const { orgId, owner, admin } = orgBig;
    // 操作者が分散している (アカウントを消した人の行 = actor_id が NULL) ので、招待者ごとの上限には掛からない
    await seedAudit({ scope: 'organization', scopeId: orgId, action: 'invite_created', actorId: null, count: 499 });

    expect((await inviteToOrg(owner, orgId, target('oi-500th'))).error).toBeNull();
    expect(await auditCount({ action: 'invite_created', scopeId: orgId })).toBe(500);

    expectRateLimited((await inviteToOrg(owner, orgId, target('oi-501st-owner'))).error, 'org_invite:per_org', 23 * 3600);
    expectRateLimited((await inviteToOrg(admin, orgId, target('oi-501st-admin'))).error, 'org_invite:per_org');
    expect(await orgInviteRows(orgId, target('oi-501st-owner'))).toHaveLength(0);
    expect(await orgInviteRows(orgId, target('oi-501st-admin'))).toHaveLength(0);

    expect((await inviteToOrg(orgOther.owner, orgOther.orgId, target('oi-other-org'))).error).toBeNull();
  });

  it('OI-3: 同じ組織から同じ宛先へは 3 件まで。管理者が招待を物理削除しても、監査行が残るので戻らない', async () => {
    const { orgId, owner, admin } = orgTarget;
    const email = target('oi-same');
    for (let i = 0; i < 3; i++) {
      expect((await inviteToOrg(owner, orgId, email)).error, `${i + 1} 件目`).toBeNull();
    }
    expect(await orgInviteRows(orgId, email)).toHaveLength(3);

    // 組織の管理者は招待を DELETE できる (ポリシー "Org admins can manage invites"。DELETE /api/org/invites と同じ)
    const deleted = await asUser(admin.jwt).from('organization_invites').delete().eq('organization_id', orgId).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toHaveLength(3);
    expect(await orgInviteRows(orgId, email)).toHaveLength(0);

    // 監査行は管理者でも消せない・書き換えられない (RLS は SELECT のポリシーだけ)
    const auditDelete = await asUser(admin.jwt).from('membership_audit').delete().eq('scope_id', orgId).select('id');
    expect(auditDelete.data ?? []).toHaveLength(0);
    const auditUpdate = await asUser(admin.jwt)
      .from('membership_audit')
      .update({ created_at: new Date(Date.now() - 48 * HOUR_MS).toISOString() })
      .eq('scope_id', orgId)
      .select('id');
    expect(auditUpdate.data ?? []).toHaveLength(0);
    expect(await auditCount({ action: 'invite_created', scopeId: orgId, email })).toBe(3);

    // 招待が 0 件でも、4 件目は拒否される。失敗した呼び出しは招待の行も監査行も残さない
    const fourth = await inviteToOrg(owner, orgId, email);
    expectRateLimited(fourth.error, 'org_invite:per_target', 24 * 3600);
    expect(await orgInviteRows(orgId, email)).toHaveLength(0);
    expect(await auditCount({ action: 'invite_created', scopeId: orgId, email })).toBe(3);

    // 別の宛先は通る。別の組織は同じ宛先へ送れる
    expect((await inviteToOrg(admin, orgId, target('oi-same-other'))).error).toBeNull();
    expect((await inviteToOrg(orgOther.owner, orgOther.orgId, email)).error).toBeNull();
  });

  it('OI-4: create_org_invite 1 回で監査行がちょうど 1 件 (トリガー)。操作者・招待 ID・小文字の宛先が入る', async () => {
    const { orgId, owner } = orgOther;
    const mixed = `DbCap-Mixed-${TS}@HomeGohan.TEST`;
    const created = await inviteToOrg(owner, orgId, mixed);
    expect(created.error).toBeNull();
    const invite = created.data as { id: string; email: string };
    expect(invite.email).toBe(mixed.toLowerCase());

    const { data, error } = await srAdmin
      .from('membership_audit')
      .select('scope, scope_id, action, actor_id, target_user_id, metadata')
      .eq('action', 'invite_created')
      .contains('metadata', { invite_id: invite.id });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      scope: 'organization',
      scope_id: orgId,
      action: 'invite_created',
      actor_id: owner.id,
      target_user_id: null,
      metadata: { invite_id: invite.id, email: mixed.toLowerCase() },
    });
  });

  it('OI-5: 管理者が organization_invites へ直接 INSERT しても監査行ができ、上限に数えられる (RPC を通さない回避を許さない)', async () => {
    const { orgId, admin } = orgActor;
    const email = target('oi-direct');
    const inserted = await asUser(admin.jwt)
      .from('organization_invites')
      .insert({
        organization_id: orgId,
        email,
        token: randomBytes(32).toString('hex'),
        expires_at: new Date(Date.now() + 14 * 24 * HOUR_MS).toISOString(),
        invited_by: admin.id,
        invited_role: 'member',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(inserted.error).toBeNull();

    const { data } = await srAdmin
      .from('membership_audit')
      .select('actor_id, scope, scope_id')
      .eq('action', 'invite_created')
      .contains('metadata', { invite_id: (inserted.data as { id: string }).id });
    expect(data).toEqual([{ actor_id: admin.id, scope: 'organization', scope_id: orgId }]);
  });

  it('OI-6: service role が INSERT した招待 (auth.uid() が無い) は、invited_by を操作者にして監査行を書く', async () => {
    const { orgId, admin } = orgOther;
    const inserted = await srAdmin
      .from('organization_invites')
      .insert({
        organization_id: orgId,
        email: target('oi-service'),
        token: randomBytes(32).toString('hex'),
        expires_at: new Date(Date.now() + 14 * 24 * HOUR_MS).toISOString(),
        invited_by: admin.id,
        invited_role: 'member',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(inserted.error).toBeNull();

    const { data } = await srAdmin
      .from('membership_audit')
      .select('actor_id')
      .eq('action', 'invite_created')
      .contains('metadata', { invite_id: (inserted.data as { id: string }).id });
    expect(data).toEqual([{ actor_id: admin.id }]);
  });
});

// ================================================================
// A-3. 子供メンバーの昇格リクエスト (参加リクエスト)
// ================================================================
describe('#1163 子供メンバーの昇格リクエスト (request_child_promotion): 依頼者ごと 10 / 同じ家族から同じ宛先へ 3', () => {
  let famActor: TestFamily;
  let childA1 = '';
  let childA2 = '';
  let childA3 = '';
  let famTarget: TestFamily;
  let childT1 = '';
  let famOther: TestFamily;
  let childO1 = '';

  beforeAll(async () => {
    [famActor, famTarget, famOther] = await Promise.all([
      createFamily('cp-actor', { adult: true, memberLimit: 10 }),
      createFamily('cp-target', { adult: true }),
      createFamily('cp-other'),
    ]);
    childA1 = await addChild(famActor, 'A1');
    childA2 = await addChild(famActor, 'A2');
    childA3 = await addChild(famActor, 'A3');
    childT1 = await addChild(famTarget, 'T1');
    childO1 = await addChild(famOther, 'O1');
  }, 120_000);

  it('CP-1: 依頼者ごと 10 件目まで成功し、11 件目は RATE_LIMITED (child_promotion:per_actor)。同じ家族の別の大人は影響を受けない', async () => {
    const { rep, adult, familyId } = famActor;
    await seedAudit({ scope: 'family', scopeId: familyId, action: 'child_promotion_requested', actorId: rep.id, count: 9 });

    expect((await requestPromotion(rep, childA1, target('cp-10th'))).error).toBeNull();
    expect(await auditCount({ action: 'child_promotion_requested', scopeId: familyId, actorId: rep.id })).toBe(10);

    const over = await requestPromotion(rep, childA2, target('cp-11th'));
    expectRateLimited(over.error, 'child_promotion:per_actor', 23 * 3600);
    expect(await promotionRows(childA2, target('cp-11th'))).toHaveLength(0);
    expect(await auditCount({ action: 'child_promotion_requested', scopeId: familyId, actorId: rep.id })).toBe(10);

    expect((await requestPromotion(adult!, childA2, target('cp-adult'))).error).toBeNull();
  });

  it('CP-2: 上限に達していても、認可・対象の状態の確認が先に評価される (NOT_FAMILY_ADULT / ALREADY_PROMOTED / PROMOTION_MEMBER_UNAVAILABLE)', async () => {
    const { rep, adult, familyId } = famActor;
    // 代表者は上限に達している (CP-1)。他の家族の子供 → 認可で NOT_FAMILY_ADULT
    expectNotRateLimited((await requestPromotion(rep, childO1, target('cp-order-1'))).error, 'NOT_FAMILY_ADULT');

    // 既に本人のアカウントを持つメンバー (大人) → ALREADY_PROMOTED
    const { data: adultMember } = await srAdmin
      .from('family_members')
      .select('id')
      .eq('family_id', familyId)
      .eq('user_id', adult!.id)
      .single();
    expectNotRateLimited((await requestPromotion(rep, (adultMember as { id: string }).id, target('cp-order-2'))).error, 'ALREADY_PROMOTED');

    // 外されたメンバー → PROMOTION_MEMBER_UNAVAILABLE
    const { error: removeError } = await srAdmin.from('family_members').update({ status: 'removed' }).eq('id', childA3);
    expect(removeError).toBeNull();
    expectNotRateLimited((await requestPromotion(rep, childA3, target('cp-order-3'))).error, 'PROMOTION_MEMBER_UNAVAILABLE');
  });

  it('CP-3: 同じ家族から同じ宛先へは 3 件まで。4 件目は child_promotion:per_target。同じ家族の別の大人も拒否、別の家族は通る', async () => {
    const { rep, adult, familyId } = famTarget;
    const email = target('cp-same');
    for (let i = 0; i < 3; i++) {
      expect((await requestPromotion(rep, childT1, email)).error, `${i + 1} 件目`).toBeNull();
    }

    expectRateLimited((await requestPromotion(rep, childT1, email)).error, 'child_promotion:per_target', 24 * 3600);
    const rows = await promotionRows(childT1, email);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(await auditCount({ action: 'child_promotion_requested', scopeId: familyId, email })).toBe(3);

    expectRateLimited((await requestPromotion(adult!, childT1, email)).error, 'child_promotion:per_target');
    expect((await requestPromotion(adult!, childT1, target('cp-other-target'))).error).toBeNull();

    expect((await requestPromotion(famOther.rep, childO1, email)).error).toBeNull();
  });
});

// ================================================================
// A-4. 譲渡提案 (家族の代表者譲渡 + 組織のオーナー譲渡の合計)
// ================================================================
describe('#1163 譲渡提案 (propose_family_representative_transfer / propose_org_owner_transfer): 提案者ごと 10 (合計)', () => {
  let fam: TestFamily;
  let org: TestOrg;
  let famOther: TestFamily;
  let orgOther: TestOrg;

  beforeAll(async () => {
    const a = await createDualOwner('xf-a');
    fam = a.family;
    org = a.org;
    const b = await createDualOwner('xf-b');
    famOther = b.family;
    orgOther = b.org;
  }, 180_000);

  it('XF-1: 家族 5 + 組織 4 件の提案があるとき、10 件目 (家族) は成功し、11 件目は家族も組織も RATE_LIMITED (transfer_propose:per_actor)', async () => {
    const x = fam.rep;
    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'representative_transfer_proposed', actorId: x.id, count: 5 });
    await seedAudit({ scope: 'organization', scopeId: org.orgId, action: 'owner_transfer_proposed', actorId: x.id, count: 4 });

    expect((await proposeFamilyTransfer(x, fam.familyId, fam.adult!.id)).error).toBeNull();

    const familyOver = await proposeFamilyTransfer(x, fam.familyId, fam.adult!.id);
    expectRateLimited(familyOver.error, 'transfer_propose:per_actor', 23 * 3600);
    const orgOver = await proposeOrgTransfer(x, org.orgId, org.member!.id);
    expectRateLimited(orgOver.error, 'transfer_propose:per_actor', 23 * 3600);

    // 失敗した呼び出しは提案も監査行も残さない (提案は成功した 1 件だけ)
    expect(await proposalRows(fam.familyId, x.id)).toHaveLength(1);
    expect(await proposalRows(org.orgId, x.id)).toHaveLength(0);
    expect(
      (await auditCount({ action: 'representative_transfer_proposed', actorId: x.id })) +
        (await auditCount({ action: 'owner_transfer_proposed', actorId: x.id })),
    ).toBe(10);
  });

  it('XF-2: 別の提案者 (別の家族・別の組織) は影響を受けない', async () => {
    const y = famOther.rep;
    expect((await proposeFamilyTransfer(y, famOther.familyId, famOther.adult!.id)).error).toBeNull();
    expect((await proposeOrgTransfer(y, orgOther.orgId, orgOther.member!.id)).error).toBeNull();
  });

  it('XF-3: 上限に達していても、認可・対象の確認が先に評価される (NOT_FAMILY_REPRESENTATIVE / NOT_ORG_OWNER / MEMBER_NOT_FOUND / TARGET_NOT_IN_ORG)', async () => {
    const x = fam.rep; // XF-1 で上限に達している
    // 他の家族・他の組織の提案 → 認可で拒否
    expectNotRateLimited((await proposeFamilyTransfer(x, famOther.familyId, famOther.adult!.id)).error, 'NOT_FAMILY_REPRESENTATIVE');
    expectNotRateLimited((await proposeOrgTransfer(x, orgOther.orgId, orgOther.member!.id)).error, 'NOT_ORG_OWNER');
    // 自分の家族・組織でも、宛先がメンバーでない → 対象の確認で拒否
    const stranger = '00000000-0000-4000-8000-000000000001';
    expectNotRateLimited((await proposeFamilyTransfer(x, fam.familyId, stranger)).error, 'MEMBER_NOT_FOUND');
    expectNotRateLimited((await proposeOrgTransfer(x, org.orgId, stranger)).error, 'TARGET_NOT_IN_ORG');
  });
});

// ================================================================
// D. 同時実行: 上限の 1 つ手前で複数の呼び出しが同時に来ても、通るのはちょうど 1 件
// ================================================================
describe('#1163 同時実行: 上限の 1 つ手前で同時に来た呼び出しは、ちょうど 1 件だけ成功する', () => {
  // 同時に呼ぶ本数。多いほど、ロックが無いときに複数が通り抜ける確率が高くなる (変異テストで確認済み)
  const PARALLEL = 10;

  // このグループ (RACE-*) は、同時に来た呼び出しが実際に重なるかが時間次第なので、確率的な確認。ロックを外した変異版では、
  // 通り抜ける本数が実行ごとに 2〜9 本と変わり、まれに 1 本で済んでしまうこともある。確定的な確認は次の「同時実行 (確定的)」のグループ (DR-*)。
  // PostgREST は DB への接続を必要になった分だけ開く。最初の同時呼び出しが接続の確立待ちで実質的に順番に実行されないよう、
  // 先に安い問い合わせを同時に投げて、接続を開かせておく。
  beforeAll(async () => {
    const warmups = Array.from({ length: PARALLEL * 2 }, () =>
      Promise.resolve(srAdmin.from('membership_audit').select('id').limit(1)),
    );
    await Promise.all(warmups);
  }, 60_000);

  /** 結果を「成功」「RATE_LIMITED」「それ以外のエラー」に分ける */
  function tally(results: RpcResult[]) {
    return {
      ok: results.filter((r) => !r.error).length,
      limited: results.filter(rateLimited).length,
      others: results.filter((r) => r.error && !rateLimited(r)).map((r) => `${r.error!.code}: ${r.error!.message}`),
    };
  }

  it('RACE-1: 家族の招待 (招待者ごと 20 の 1 つ手前) を 10 本同時 → 成功 1 / RATE_LIMITED 9。監査行は 20 件', async () => {
    const fam = await createFamily('race-fi');
    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'invite_created', actorId: fam.rep.id, count: 19 });

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => inviteToFamily(fam.rep, fam.familyId, target(`race-fi-${i}`))),
    );

    expect(tally(results)).toEqual({ ok: 1, limited: PARALLEL - 1, others: [] });
    expect(await auditCount({ action: 'invite_created', scopeId: fam.familyId, actorId: fam.rep.id })).toBe(20);
  });

  it('RACE-2: 家族の同じ宛先 (3 の 1 つ手前) を、代表者と大人の別々の招待者から 10 本同時 → 成功 1 / RATE_LIMITED 9。23505 (一意制約違反) にならない', async () => {
    const fam = await createFamily('race-fi-target', { adult: true });
    const email = target('race-fi-same');
    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'invite_created', actorId: null, count: 2, email });

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => inviteToFamily(i % 2 === 0 ? fam.rep : fam.adult!, fam.familyId, email)),
    );

    expect(tally(results)).toEqual({ ok: 1, limited: PARALLEL - 1, others: [] });
    expect(await auditCount({ action: 'invite_created', scopeId: fam.familyId, email })).toBe(3);
    expect((await familyInviteRows(fam.familyId, email)).filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('RACE-3: 組織の招待 (組織ごと 500 の 1 つ手前) を、owner と admin から 10 本同時 → 成功 1 / org_invite:per_org 9', async () => {
    const org = await createOrg('race-oi');
    await seedAudit({ scope: 'organization', scopeId: org.orgId, action: 'invite_created', actorId: null, count: 499 });

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        inviteToOrg(i % 2 === 0 ? org.owner : org.admin, org.orgId, target(`race-oi-${i}`)),
      ),
    );

    expect(tally(results)).toEqual({ ok: 1, limited: PARALLEL - 1, others: [] });
    for (const r of results.filter(rateLimited)) expect(r.error!.details).toBe('org_invite:per_org');
    expect(await auditCount({ action: 'invite_created', scopeId: org.orgId })).toBe(500);
  });

  it('RACE-4: 組織の同じ宛先 (3 の 1 つ手前) を 10 本同時 → 成功 1 / RATE_LIMITED 9。23505 (一意制約違反) にならない', async () => {
    const org = await createOrg('race-oi-target');
    const email = target('race-oi-same');
    await seedAudit({ scope: 'organization', scopeId: org.orgId, action: 'invite_created', actorId: null, count: 2, email });

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => inviteToOrg(i % 2 === 0 ? org.owner : org.admin, org.orgId, email)),
    );

    expect(tally(results)).toEqual({ ok: 1, limited: PARALLEL - 1, others: [] });
    expect((await orgInviteRows(org.orgId, email)).filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('RACE-5: 昇格リクエスト (依頼者ごと 10 の 1 つ手前) を、別々の子供に 6 本同時 → 成功 1 / RATE_LIMITED 5', async () => {
    const fam = await createFamily('race-cp', { memberLimit: 10 });
    const children = await Promise.all(['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map((name) => addChild(fam, name)));
    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'child_promotion_requested', actorId: fam.rep.id, count: 9 });

    const results = await Promise.all(children.map((childId, i) => requestPromotion(fam.rep, childId, target(`race-cp-${i}`))));

    expect(tally(results)).toEqual({ ok: 1, limited: children.length - 1, others: [] });
    expect(await auditCount({ action: 'child_promotion_requested', scopeId: fam.familyId, actorId: fam.rep.id })).toBe(10);
  });

  it('RACE-6: 譲渡提案 (提案者ごと 10 の 1 つ手前) を、家族 5 本 + 組織 5 本 同時 → 成功 1 / RATE_LIMITED 9 (合算の枠を守る)', async () => {
    const { family, org } = await createDualOwner('race-xf');
    await seedAudit({ scope: 'family', scopeId: family.familyId, action: 'representative_transfer_proposed', actorId: family.rep.id, count: 5 });
    await seedAudit({ scope: 'organization', scopeId: org.orgId, action: 'owner_transfer_proposed', actorId: family.rep.id, count: 4 });

    const results = await Promise.all([
      ...Array.from({ length: PARALLEL / 2 }, () => proposeFamilyTransfer(family.rep, family.familyId, family.adult!.id)),
      ...Array.from({ length: PARALLEL / 2 }, () => proposeOrgTransfer(family.rep, org.orgId, org.member!.id)),
    ]);

    expect(tally(results)).toEqual({ ok: 1, limited: PARALLEL - 1, others: [] });
    expect(
      (await auditCount({ action: 'representative_transfer_proposed', actorId: family.rep.id })) +
        (await auditCount({ action: 'owner_transfer_proposed', actorId: family.rep.id })),
    ).toBe(10);
  });
});

// ================================================================
// D'. 同時実行 (確定的): 先の処理がコミット前でも、後の処理は待たされて、コミット後に数え直す
// ================================================================
describe('#1163 同時実行 (確定的): 先の処理が上限を数えて記録を書いた後・コミット前でも、後の処理は待たされて上限を超えて通らない', () => {
  // 別の接続で先の RPC を実行して pg_sleep でトランザクションを開いたままにし (= 記録を書いたがコミット前)、
  // pg_sleep に入ったのを確かめてから、もう 1 件を本物の経路で呼ぶ。
  // ロックが無いと、後の処理は先の記録が見えないまま数えて通ってしまう (両方成功する)。ロックがあれば先のコミットを待ち、拒否される。
  const HOLD_SECONDS = 3;
  const waitedForCommit = (ms: number) =>
    expect(ms, '先の処理のコミットを待っているはず').toBeGreaterThanOrEqual(HOLD_SECONDS * 500);

  it('DR-1: 家族の招待 (招待者ごと 20 の 1 つ手前): 同じ招待者の 2 件目は待たされ、family_invite:per_actor で拒否される', async () => {
    const fam = await createFamily('dr-fi');
    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'invite_created', actorId: fam.rep.id, count: 19 });

    const r = await raceAfterHold(
      { user: fam.rep, rpcSql: `public.create_family_invite('${fam.familyId}'::uuid, '${target('dr-fi-1')}')` },
      () => inviteToFamily(fam.rep, fam.familyId, target('dr-fi-2')),
      HOLD_SECONDS,
    );

    expect(r.first.ok, JSON.stringify(r.first)).toBe(true);
    expectRateLimited(r.second.error, 'family_invite:per_actor');
    waitedForCommit(r.secondMs);
    expect(await auditCount({ action: 'invite_created', scopeId: fam.familyId, actorId: fam.rep.id })).toBe(20);
    expect(await familyInviteRows(fam.familyId, target('dr-fi-2'))).toHaveLength(0);
  }, 60_000);

  it('DR-2: 家族の同じ宛先 (3 の 1 つ手前): 別の招待者 (大人) の同じ宛先は待たされ、family_invite:per_target で拒否される (23505 にならない)', async () => {
    const fam = await createFamily('dr-fi-target', { adult: true });
    const email = target('dr-fi-same');
    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'invite_created', actorId: null, count: 2, email });

    const r = await raceAfterHold(
      { user: fam.rep, rpcSql: `public.create_family_invite('${fam.familyId}'::uuid, '${email}')` },
      () => inviteToFamily(fam.adult!, fam.familyId, email),
      HOLD_SECONDS,
    );

    expect(r.first.ok, JSON.stringify(r.first)).toBe(true);
    expectRateLimited(r.second.error, 'family_invite:per_target');
    waitedForCommit(r.secondMs);
    expect(await auditCount({ action: 'invite_created', scopeId: fam.familyId, email })).toBe(3);
  }, 60_000);

  it('DR-3: 組織の招待 (組織ごと 500 の 1 つ手前): 別の管理者の招待は待たされ、org_invite:per_org で拒否される', async () => {
    const org = await createOrg('dr-oi');
    await seedAudit({ scope: 'organization', scopeId: org.orgId, action: 'invite_created', actorId: null, count: 499 });

    const r = await raceAfterHold(
      {
        user: org.owner,
        rpcSql: `public.create_org_invite('${org.orgId}'::uuid, '${target('dr-oi-1')}', 'member'::public.org_role_enum)`,
      },
      () => inviteToOrg(org.admin, org.orgId, target('dr-oi-2')),
      HOLD_SECONDS,
    );

    expect(r.first.ok, JSON.stringify(r.first)).toBe(true);
    expectRateLimited(r.second.error, 'org_invite:per_org');
    waitedForCommit(r.secondMs);
    expect(await auditCount({ action: 'invite_created', scopeId: org.orgId })).toBe(500);
  }, 60_000);

  it('DR-4: 昇格リクエスト (依頼者ごと 10 の 1 つ手前): 同じ依頼者の別の子供への 2 件目は待たされ、child_promotion:per_actor で拒否される', async () => {
    const fam = await createFamily('dr-cp', { memberLimit: 6 });
    const child1 = await addChild(fam, 'D1');
    const child2 = await addChild(fam, 'D2');
    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'child_promotion_requested', actorId: fam.rep.id, count: 9 });

    const r = await raceAfterHold(
      { user: fam.rep, rpcSql: `public.request_child_promotion('${child1}'::uuid, '${target('dr-cp-1')}')` },
      () => requestPromotion(fam.rep, child2, target('dr-cp-2')),
      HOLD_SECONDS,
    );

    expect(r.first.ok, JSON.stringify(r.first)).toBe(true);
    expectRateLimited(r.second.error, 'child_promotion:per_actor');
    waitedForCommit(r.secondMs);
    expect(await promotionRows(child2, target('dr-cp-2'))).toHaveLength(0);
  }, 60_000);

  it('DR-5: 譲渡提案 (提案者ごと 10 の 1 つ手前): 家族の提案の途中で来た組織の提案は待たされ、transfer_propose:per_actor で拒否される (合算の枠)', async () => {
    const { family, org } = await createDualOwner('dr-xf');
    await seedAudit({ scope: 'family', scopeId: family.familyId, action: 'representative_transfer_proposed', actorId: family.rep.id, count: 5 });
    await seedAudit({ scope: 'organization', scopeId: org.orgId, action: 'owner_transfer_proposed', actorId: family.rep.id, count: 4 });

    const r = await raceAfterHold(
      {
        user: family.rep,
        rpcSql: `public.propose_family_representative_transfer('${family.familyId}'::uuid, '${family.adult!.id}'::uuid)`,
      },
      () => proposeOrgTransfer(family.rep, org.orgId, org.member!.id),
      HOLD_SECONDS,
    );

    expect(r.first.ok, JSON.stringify(r.first)).toBe(true);
    expectRateLimited(r.second.error, 'transfer_propose:per_actor');
    waitedForCommit(r.secondMs);
    expect(await proposalRows(org.orgId, family.rep.id)).toHaveLength(0);
  }, 60_000);

  it('DR-6: ロックは招待者・家族ごと。無関係の家族の招待は、先の処理のコミットを待たずに通る', async () => {
    const [famA, famB] = await Promise.all([createFamily('dr-iso-a'), createFamily('dr-iso-b')]);
    const holdSeconds = 4;

    const r = await raceAfterHold(
      { user: famA.rep, rpcSql: `public.create_family_invite('${famA.familyId}'::uuid, '${target('dr-iso-a')}')` },
      () => inviteToFamily(famB.rep, famB.familyId, target('dr-iso-b')),
      holdSeconds,
    );

    expect(r.first.ok, JSON.stringify(r.first)).toBe(true);
    expect(r.second.error).toBeNull();
    expect(r.secondMs, '別の家族の処理は待たされないはず').toBeLessThan(holdSeconds * 750);
  }, 60_000);
});

// ================================================================
// E. helper を /rpc で直接呼ばれても、他テナントの件数は覗けず、書き込みもしない
// ================================================================
describe('#1163 enforce_membership_daily_cap を直接呼ぶ: 認可・テナント分離・書き込みなし', () => {
  let famX: TestFamily; // 同じ宛先 3 件で上限に達している家族
  let famY: TestFamily; // 何も送っていない別の家族
  let org: TestOrg;
  let outsider: TestUser;

  beforeAll(async () => {
    [famX, famY, org, outsider] = await Promise.all([
      createFamily('helper-x', { adult: true }),
      createFamily('helper-y'),
      createOrg('helper', { member: true }),
      createUser('helper-outsider'),
    ]);
    await seedAudit({ scope: 'family', scopeId: famX.familyId, action: 'invite_created', actorId: null, count: 3, email: target('helper-same') });
    await seedAudit({ scope: 'organization', scopeId: org.orgId, action: 'invite_created', actorId: null, count: 3, email: target('helper-same') });
  }, 120_000);

  it('H-1: anon も service role も実行できない (permission denied)。authenticated だけが呼べる', async () => {
    const args = { p_kind: 'transfer_propose', p_scope_id: null };

    const asAnon = await callHelper('anon', args);
    expect(asAnon.error?.code).toBe('42501');
    const asService = await callHelper('service', args);
    expect(asService.error?.code).toBe('42501');

    const asAuthenticated = await callHelper(outsider, args);
    expect(asAuthenticated.error).toBeNull();
  });

  it('H-2: 他の家族・他の組織の ID を指定しても、認可で拒否され、件数も分からない', async () => {
    // 上限に達している家族 X を、家族に入っていない人が指定 → 件数ではなく認可のエラー
    const family = await callHelper(outsider, { p_kind: 'family_invite', p_scope_id: famX.familyId, p_email: target('helper-same') });
    expect(family.error?.message).toBe('NOT_FAMILY_ADULT');
    // 別の家族の代表者が指定しても同じ
    const crossFamily = await callHelper(famY.rep, { p_kind: 'family_invite', p_scope_id: famX.familyId, p_email: target('helper-same') });
    expect(crossFamily.error?.message).toBe('NOT_FAMILY_ADULT');
    const promotion = await callHelper(famY.rep, { p_kind: 'child_promotion', p_scope_id: famX.familyId, p_email: target('helper-same') });
    expect(promotion.error?.message).toBe('NOT_FAMILY_ADULT');
    // 組織の外の人・組織の一般メンバー
    const orgOutsider = await callHelper(outsider, { p_kind: 'org_invite', p_scope_id: org.orgId, p_email: target('helper-same') });
    expect(orgOutsider.error?.message).toBe('NOT_ORG_ADMIN');
    const orgMember = await callHelper(org.member!, { p_kind: 'org_invite', p_scope_id: org.orgId, p_email: target('helper-same') });
    expect(orgMember.error?.message).toBe('NOT_ORG_ADMIN');
  });

  it('H-3: 別の家族の代表者が、上限に達した宛先を自分の家族で指定しても、他の家族の件数は影響しない (エラーにならない)', async () => {
    const own = await callHelper(famY.rep, { p_kind: 'family_invite', p_scope_id: famY.familyId, p_email: target('helper-same') });
    expect(own.error).toBeNull();
    // 同じ宛先を、上限に達している家族 X の代表者が自分の家族で指定すると、自分の家族の件数なので RATE_LIMITED
    const sameFamily = await callHelper(famX.rep, { p_kind: 'family_invite', p_scope_id: famX.familyId, p_email: target('helper-same') });
    expectRateLimited(sameFamily.error, 'family_invite:per_target');
  });

  it('H-4: 認可された直接呼び出しは何も書き込まない (監査行の件数が変わらない)', async () => {
    const before = await auditCount({ action: 'invite_created', scopeId: famY.familyId });
    const result = await callHelper(famY.rep, { p_kind: 'family_invite', p_scope_id: famY.familyId, p_email: target('helper-write') });
    expect(result.error).toBeNull();
    expect(await auditCount({ action: 'invite_created', scopeId: famY.familyId })).toBe(before);
    expect(await auditCount({ action: 'invite_created', email: target('helper-write') })).toBe(0);
  });

  it('H-5: 未知の p_kind は SQLSTATE 22023 (INVALID_DAILY_CAP_KIND)', async () => {
    const result = await callHelper(famY.rep, { p_kind: 'unknown_kind', p_scope_id: famY.familyId });
    expect(result.error?.code).toBe('22023');
    expect(result.error?.message).toBe('INVALID_DAILY_CAP_KIND');
  });
});

// ================================================================
// F. 既存の挙動: 認可・人数/席数の上限が、上限の判定より先に評価される
// ================================================================
describe('#1163 既存の挙動 (退行確認): 認可と既存の上限確認が先、24 時間の上限は最後', () => {
  it('R-1: create_org_invite を anon で呼ぶと、従来どおり NOT_ORG_ADMIN (helper の権限エラーにならない)', async () => {
    const org = await createOrg('reg-anon');
    const result = await Promise.resolve(
      anon().rpc('create_org_invite', { p_organization_id: org.orgId, p_email: target('reg-anon'), p_role: 'member' }),
    );
    expectNotRateLimited(result.error, 'NOT_ORG_ADMIN');
  });

  it('R-2: 家族の人数上限に達していて、かつ招待者の上限にも達しているとき、MEMBER_LIMIT_EXCEEDED が先に返る', async () => {
    const fam = await createFamily('reg-limit', { memberLimit: 1 });
    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'invite_created', actorId: fam.rep.id, count: 20 });

    expectNotRateLimited((await inviteToFamily(fam.rep, fam.familyId, target('reg-limit'))).error, 'MEMBER_LIMIT_EXCEEDED');
  });

  it('R-3: 組織の席数上限に達していて、かつ招待者の上限にも達しているとき、SEAT_LIMIT_EXCEEDED が先に返る', async () => {
    const org = await createOrg('reg-seat');
    const { error: poolError } = await srAdmin
      .from('org_license_pools')
      .insert({ organization_id: org.orgId, total_licenses: 1, used_licenses: 1 });
    expect(poolError).toBeNull();
    await seedAudit({ scope: 'organization', scopeId: org.orgId, action: 'invite_created', actorId: org.owner.id, count: 200 });

    expectNotRateLimited((await inviteToOrg(org.owner, org.orgId, target('reg-seat'))).error, 'SEAT_LIMIT_EXCEEDED');
  });

  it('R-4: 組織の一般メンバーは、上限に達していなくても従来どおり NOT_ORG_ADMIN。家族の外の人は NOT_FAMILY_ADULT', async () => {
    const org = await createOrg('reg-role', { member: true });
    const fam = await createFamily('reg-role');
    expectNotRateLimited((await inviteToOrg(org.member!, org.orgId, target('reg-role-org'))).error, 'NOT_ORG_ADMIN');
    expectNotRateLimited((await inviteToFamily(org.member!, fam.familyId, target('reg-role-fam'))).error, 'NOT_FAMILY_ADULT');
  });
});

// ================================================================
// G. API: DB の上限に達したときも、アプリ層の上限と同じ 429 (本文 + Retry-After) を返す
// ================================================================
describe('#1163 API: DB の 24 時間上限に達したら 429 { error: { code: RATE_LIMITED, message, retryAfter } } + Retry-After', () => {
  interface RateLimitedBody {
    error?: { code?: string; message?: string; retryAfter?: number };
  }

  let fam: TestFamily; // 代表者が、家族の招待・昇格リクエスト・譲渡提案のすべてで上限に達している
  let org: TestOrg; // 同じ代表者が owner の組織。組織の招待と譲渡提案でも上限に達している
  let childId = '';
  let apiUser: TestUser;

  /** 429 の応答が、UI が読む入れ子の本文と Retry-After ヘッダーを持ち、秒数が DB の HINT (約 23 時間) に基づくこと */
  function expectApiRateLimited(res: { status: number; body: unknown; headers: Record<string, string> }) {
    expect(res.status, JSON.stringify(res.body)).toBe(429);
    const body = res.body as RateLimitedBody;
    expect(body.error?.code).toBe('RATE_LIMITED');
    expect(typeof body.error?.message).toBe('string');
    expect(body.error!.message!.length).toBeGreaterThan(0);
    // DB が返す生の文字列や内部の上限名は見せない
    expect(body.error!.message).not.toBe('RATE_LIMITED');
    expect(JSON.stringify(body)).not.toMatch(/per_actor|per_org|per_target|P0001/);
    expect(Number.isInteger(body.error?.retryAfter)).toBe(true);
    expect(Math.abs(body.error!.retryAfter! - 23 * 3600)).toBeLessThanOrEqual(300);
    expect(res.headers['retry-after']).toBe(String(body.error!.retryAfter));
  }

  beforeAll(async () => {
    // 代表者 = 組織のオーナー (1 人のユーザーで、6 本の API の上限を一度に用意する)
    const dual = await createDualOwner('api');
    fam = dual.family;
    org = dual.org;
    apiUser = fam.rep;
    childId = await addChild(fam, 'API1');

    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'invite_created', actorId: apiUser.id, count: 20 });
    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'child_promotion_requested', actorId: apiUser.id, count: 10 });
    await seedAudit({ scope: 'family', scopeId: fam.familyId, action: 'representative_transfer_proposed', actorId: apiUser.id, count: 5 });
    await seedAudit({ scope: 'organization', scopeId: org.orgId, action: 'owner_transfer_proposed', actorId: apiUser.id, count: 5 });
    await seedAudit({ scope: 'organization', scopeId: org.orgId, action: 'invite_created', actorId: apiUser.id, count: 200 });

    // dev サーバーが各 route を初めてコンパイルする時間で、テストの時間切れにならないよう、先に未認証で 1 回ずつ叩いておく
    // (401 は上限の判定より前に返るので、カウンタは進まない)
    for (const path of [
      '/api/family/invites',
      '/api/org/invites',
      '/api/org/members',
      `/api/family/members/${childId}/promote`,
      '/api/family/representative-transfer/propose',
      '/api/org/owner-transfer/propose',
    ]) {
      await apiCall('POST', path, null, { email: target('warmup') });
    }
  }, 300_000);

  it('API-1: POST /api/family/invites → 429。招待の行は作られない (修正前は 500 RPC_FAILED)', async () => {
    const email = target('api-fi');
    const res = await apiCall('POST', '/api/family/invites', apiUser.jwt, { family_id: fam.familyId, email });

    expectApiRateLimited(res);
    expect(await familyInviteRows(fam.familyId, email)).toHaveLength(0);
  }, 60_000);

  it('API-2: 同じ家族の別の大人は影響を受けず、招待を作れる (201)', async () => {
    const email = target('api-fi-adult');
    const res = await apiCall('POST', '/api/family/invites', fam.adult!.jwt, { family_id: fam.familyId, email });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await familyInviteRows(fam.familyId, email)).toHaveLength(1);
  }, 60_000);

  it('API-3: POST /api/org/invites → 429。招待の行は作られない', async () => {
    const email = target('api-oi');
    const res = await apiCall('POST', '/api/org/invites', apiUser.jwt, { email, role: 'member' });

    expectApiRateLimited(res);
    expect(await orgInviteRows(org.orgId, email)).toHaveLength(0);
  }, 60_000);

  it('API-4: POST /api/org/members (招待メール方式) → 429。招待の行は作られない', async () => {
    const email = target('api-om');
    const res = await apiCall('POST', '/api/org/members', apiUser.jwt, { email });

    expectApiRateLimited(res);
    expect(await orgInviteRows(org.orgId, email)).toHaveLength(0);
  }, 60_000);

  it('API-5: POST /api/family/members/[member_id]/promote → 429。リクエストの行は作られない', async () => {
    const email = target('api-cp');
    const res = await apiCall('POST', `/api/family/members/${childId}/promote`, apiUser.jwt, { email });

    expectApiRateLimited(res);
    expect(await promotionRows(childId, email)).toHaveLength(0);
  }, 60_000);

  it('API-6: POST /api/family/representative-transfer/propose → 429 (家族 5 + 組織 5 = 提案者ごと 10 の合計)。提案は作られない', async () => {
    // 先の 10 件 (家族 5 + 組織 5) に達しているので、この 1 件目で拒否される
    const res = await apiCall('POST', '/api/family/representative-transfer/propose', apiUser.jwt, {
      family_id: fam.familyId,
      to_user_id: fam.adult!.id,
    });

    expectApiRateLimited(res);
    expect(await proposalRows(fam.familyId, apiUser.id)).toHaveLength(0);
  }, 60_000);

  it('API-7: POST /api/org/owner-transfer/propose → 429。提案は作られない', async () => {
    const res = await apiCall('POST', '/api/org/owner-transfer/propose', apiUser.jwt, {
      organization_id: org.orgId,
      to_user_id: org.member!.id,
    });

    expectApiRateLimited(res);
    expect(await proposalRows(org.orgId, apiUser.id)).toHaveLength(0);
  }, 60_000);

  it('API-8: 組織の別の admin は影響を受けず、POST /api/org/invites で招待を作れる (200)', async () => {
    const email = target('api-oi-admin');
    const res = await apiCall('POST', '/api/org/invites', org.admin.jwt, { email, role: 'member' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await orgInviteRows(org.orgId, email)).toHaveLength(1);
  }, 60_000);
});
