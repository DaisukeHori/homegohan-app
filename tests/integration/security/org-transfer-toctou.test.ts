/**
 * 組織のオーナーの譲渡の承諾が解散と同時に走ると、生の DB のエラー (CHECK user_profiles_org_consistency・23514) が API に届く
 * 既存の欠陥の回帰テスト (実 DB)。docs/design/family/11-self-dissolve.md の S-18・§11.3。
 *
 * 修正前 (accept_org_owner_transfer の最新の定義は 20261017030000_parental_consent_and_birth_date.sql):
 *   - 承諾者の在籍の判定をロックの外で行い、提案の行 → 旧オーナーの user_profiles → 新オーナーの user_profiles → organizations の順に書いた。
 *     オーナーの解散・運営の強制解散が先にオーナーの行を取って後始末をしている間に承諾が判定を通ると、承諾は旧オーナーの行の UPDATE で
 *     解散の commit を待ち、所属の外れた行に org_role = 'admin' を書いて 23514 で止まった (API は 500)。
 *   - 運営の強制譲渡 (operator_force_owner_transfer) も新オーナーの在籍の判定をロックの外で行い、解散と同時に走ると同じ 23514 で止まった。
 *   - 脱退 (leave_org)・除名 (remove_org_member) は本人・対象の org_role をロックの外で判定し、譲渡の承諾が先に commit して
 *     オーナーになった人の所属を外した (organizations.owner_id が所属の無い人を指す)。
 *   - 運営の強制譲渡のあとに残った提案を承諾すると、オーナーの役割の人が 2 人になった。
 *   - オーナーの解散 (dissolve_org_by_owner。最新の定義は 20261019120000_self_dissolve.sql) は呼び出した本人の行 → 組織の行の順に取ったので、
 *     オーナーでない人が呼ぶと、組織の行のあとにその人の行を取る関数 (譲渡の承諾・運営の強制譲渡・招待の承諾・ほかの解散の後始末) と
 *     逆向きになり、同時に走るとデッドロック (40P01) した。
 *
 * 修正後 (supabase/migrations/20261022140000_org_transfer_toctou.sql。組織の所属・役割・解散を変える関数は、組織の行を最初に取る):
 *   - 承諾は 提案の行 → 組織の行 → 承諾者の user_profiles → 旧オーナーの user_profiles をロックしてから判定し直す。
 *     解散した組織なら ORG_ALREADY_DISSOLVED、所属が外れていれば TRANSFER_ACCEPTOR_NOT_IN_ORG、提案者がもうオーナーでなければ NOT_ORG_OWNER。
 *   - 運営の強制譲渡は 組織の行 → 新オーナーの user_profiles をロックしてから TARGET_NOT_IN_ORG を判定する。
 *   - 脱退・除名は、判定に使う行 (本人 / 対象) を FOR NO KEY UPDATE で読む。
 *   - 解散 (dissolve_org_by_owner・operator_force_dissolve_org) は、組織の行を最初に取る (呼び出した本人の行・オーナーの行を先に取らない)
 *     (OT-18〜OT-23。組織の行だけを持つ接続 holdOrgRow の手前に 2 本を決まった順に並ばせ、修正前の待ちの輪ができる順を作る)。
 *   - 組織の行を取ったあとに読んだ owner_id は commit まで変わらないので、オーナーの行の取り直しのループは無い
 *     (OT-25。ループが古いオーナーの行を持ったまま新しいオーナーの行を待つ待ちの輪を、決まった順で作る)。
 *
 * 呼び出しは本物の経路 (PostgREST + 本人の JWT)。先の処理をコミット前のまま開いておくのは、ローカルスタックの
 * postgres-meta (/pg/query、service_role キーが必要) を使う (org-invite-dissolved.test.ts・self-dissolve.test.ts と同じ道具)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。OT-16・OT-17 (承諾の API) だけは Next の開発サーバーも要る
 * (tests/integration/helpers/api.ts の apiCall。INTEGRATION_BASE_URL。scripts/local-ci.sh の integration は立てる)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-transfer-toctou.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';
import { promoteToAal2 } from '../helpers/mfa';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kong → PostgREST の使い回しの接続の 502 (リクエストが PostgREST に届いていない) を数回だけやり直す (org-invite-dissolved.test.ts と同じ) */
const GATEWAY_RETRIES = 3;
/** 502 をやり直すまでの待ちの単位 (ミリ秒) */
const GATEWAY_RETRY_WAIT_MS = 150;
/** postgres-meta の 502 をやり直すのは、この時間 (ミリ秒) 以内に返ったときだけ (pg_sleep で待たせた後の応答ではない) */
const GATEWAY_FAST_FAIL_MS = 1500;
const HTTP_BAD_GATEWAY = 502;

const fetchRetryingGateway502: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== HTTP_BAD_GATEWAY || attempt >= GATEWAY_RETRIES) return res;
    await sleep(GATEWAY_RETRY_WAIT_MS * (attempt + 1));
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

async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === HTTP_BAD_GATEWAY && attempt < GATEWAY_RETRIES && Date.now() - startedAt < GATEWAY_FAST_FAIL_MS) {
      await sleep(GATEWAY_RETRY_WAIT_MS * (attempt + 1));
      continue;
    }
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  }
}

async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

type OrgRole = 'owner' | 'admin' | 'member';

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
/** 成人の生年月日 (18 歳未満は譲渡を引き受けられない。#1173) */
const ADULT_BIRTH_DATE = '1990-01-01';
/** 組織の席数 (テストで足りる数。席数の上限で断られる経路と混ざらないように) */
const ORG_TOTAL_LICENSES = 20;
/** 組織にすでにいるメンバーの数として置く席数 */
const SEEDED_USED_LICENSES = 2;
/** 本物の経路で同時に呼ぶ回数 (org-invite-dissolved.test.ts・self-dissolve.test.ts と同じ) */
const ITERATIONS = 8;
/** 先の処理をコミット前のまま開いておく秒数 */
const HOLD_SECONDS = 3;
/**
 * 組織の行だけを持つ接続 (holdOrgRow) が行を持つ秒数。そのあいだに 2 本の呼び出しを本物の経路 (Kong → PostgREST) で投げ、
 * どちらも行のロックの待ちに並ぶまで待つので HOLD_SECONDS より長く取る。並んだ呼び出しは放すまで待つので、
 * authenticated の文の時間切れ (Supabase の既定の statement_timeout 8 秒) より短くする
 */
const ORDER_HOLD_SECONDS = 5;
/** 招待のトークンのバイト数 (hex で 64 文字。create_org_invite と同じ形。org-invite-dissolved.test.ts と同じ) */
const TOKEN_BYTES = 32;
/** 招待の期限 (14 日。create_org_invite と同じ) */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** pg_sleep に入るのを待つ上限 (ミリ秒) と確かめる間隔 */
const HOLDER_DEADLINE_MS = 20_000;
const HOLDER_POLL_MS = 50;
const TEST_TIMEOUT_MS = 120_000;
const RACE_TIMEOUT_MS = 240_000;
/** CHECK 違反の SQLSTATE (修正前の承諾・強制譲渡が返していたもの) */
const PG_CHECK_VIOLATION = '23514';

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const pendingHolders: Array<Promise<unknown>> = [];

async function signIn(email: string): Promise<{ client: SupabaseClient; jwt: string }> {
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signInClient = anon();
  const { data, error } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: signInClient, jwt: data.session.access_token };
}

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-org-transfer-toctou-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      {
        id: data.user.id,
        nickname: `org-transfer-toctou-${label}`,
        age_group: '30s',
        gender: 'other',
        birth_date: ADULT_BIRTH_DATE,
        ...(roles ? { roles } : {}),
      },
      { onConflict: 'id' },
    ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const { jwt } = await signIn(email);
  return { id: data.user.id, email, jwt };
}

async function createUsers(prefix: string, count: number): Promise<TestUser[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => createUser(`${prefix}-${i + 1}`)));
}

async function setOrgMembership(user: TestUser, orgId: string, role: OrgRole): Promise<void> {
  const roles = role === 'member' ? ['user'] : ['user', 'org_admin'];
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: role, is_active_in_org: true, joined_org_at: new Date().toISOString(), roles })
    .eq('id', user.id);
  if (error) throw new Error(`membership: ${error.message}`);
}

/** 組織を作り、オーナーを owner・admin を admin として所属させる (席数は SEEDED_USED_LICENSES) */
async function createOrg(owner: TestUser, admin: TestUser, label: string): Promise<string> {
  const { data, error } = await srAdmin.from('organizations').insert({ name: `toctou ${label} ${TS}`, owner_id: owner.id }).select('id').single();
  if (error || !data) throw new Error(`organizations ${label}: ${error?.message}`);
  const orgId = data.id as string;
  createdOrgIds.push(orgId);
  const { error: poolError } = await retryIdempotentSetup(srAdmin, 'createOrg: org_license_pools の upsert', (db) =>
    db.from('org_license_pools').upsert(
      { organization_id: orgId, total_licenses: ORG_TOTAL_LICENSES, used_licenses: SEEDED_USED_LICENSES },
      { onConflict: 'organization_id' },
    ));
  if (poolError) throw new Error(`org_license_pools ${label}: ${poolError.message}`);
  await setOrgMembership(owner, orgId, 'owner');
  await setOrgMembership(admin, orgId, 'admin');
  return orgId;
}

async function proposeOrgTransfer(owner: TestUser, orgId: string, toUserId: string): Promise<string> {
  const { data, error } = await asUser(owner.jwt).rpc('propose_org_owner_transfer', { p_organization_id: orgId, p_to_user_id: toUserId });
  if (error || !data) throw new Error(`propose_org_owner_transfer: ${error?.message}`);
  return data as string;
}

/** 組織の pending の招待を service_role で入れる (create_org_invite の 24 時間の上限に当たらないように。org-invite-dissolved.test.ts と同じ) */
async function insertPendingOrgInvite(orgId: string, email: string, invitedBy: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const { error } = await srAdmin.from('organization_invites').insert({
    organization_id: orgId,
    email: email.toLowerCase(),
    token,
    invited_role: 'member',
    status: 'pending',
    expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    invited_by: invitedBy,
  });
  if (error) throw new Error(`organization_invites: ${error.message}`);
  return token;
}

/** オーナー・admin・提案 (オーナー → admin) をそろえる */
async function setupTransfer(label: string): Promise<{ owner: TestUser; admin: TestUser; orgId: string; proposalId: string }> {
  const [owner, admin] = await createUsers(label, 2);
  const orgId = await createOrg(owner, admin, label);
  const proposalId = await proposeOrgTransfer(owner, orgId, admin.id);
  return { owner, admin, orgId, proposalId };
}

interface OrgProfile {
  organization_id: string | null;
  org_role: string | null;
}

async function orgProfile(userId: string): Promise<OrgProfile> {
  const { data, error } = await srAdmin.from('user_profiles').select('organization_id, org_role').eq('id', userId).single();
  if (error || !data) throw new Error(`user_profiles: ${error?.message}`);
  return data as OrgProfile;
}

async function orgRow(orgId: string): Promise<{ status: string; owner_id: string | null } | null> {
  const { data, error } = await srAdmin.from('organizations').select('status, owner_id').eq('id', orgId).maybeSingle();
  if (error) throw new Error(`organizations: ${error.message}`);
  return data as { status: string; owner_id: string | null } | null;
}

async function orgMemberCount(orgId: string): Promise<number> {
  const { count, error } = await srAdmin.from('user_profiles').select('id', { count: 'exact', head: true }).eq('organization_id', orgId);
  if (error) throw new Error(`user_profiles count: ${error.message}`);
  return count ?? 0;
}

/** 組織の org_role = 'owner' の人 (オーナーの役割の人は、active な組織ならちょうど 1 人で owner_id と同じ人) */
async function ownerRoleHolders(orgId: string): Promise<string[]> {
  const { data, error } = await srAdmin.from('user_profiles').select('id').eq('organization_id', orgId).eq('org_role', 'owner');
  if (error) throw new Error(`user_profiles owners: ${error.message}`);
  return (data ?? []).map((row) => (row as { id: string }).id);
}

async function proposalStatus(proposalId: string): Promise<string> {
  const { data, error } = await srAdmin.from('ownership_transfer_proposals').select('status').eq('id', proposalId).single();
  if (error || !data) throw new Error(`ownership_transfer_proposals: ${error?.message}`);
  return (data as { status: string }).status;
}

async function transferredAudits(orgId: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('membership_audit')
    .select('id', { count: 'exact', head: true })
    .eq('scope', 'organization')
    .eq('scope_id', orgId)
    .eq('action', 'owner_transferred');
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return count ?? 0;
}

interface Outcome {
  ok: boolean;
  data: unknown;
  message: string | null;
  code: string | null;
}

function toOutcome(data: unknown, error: { message?: string; code?: string } | null): Outcome {
  return { ok: !error, data: error ? null : data, message: error?.message ?? null, code: error?.code ?? null };
}

function isDeadlock(outcome: Outcome): boolean {
  return outcome.code === '40P01' || /deadlock detected|CONFLICT_RETRY/i.test(outcome.message ?? '');
}

async function acceptTransfer(user: TestUser, proposalId: string): Promise<Outcome> {
  const { data, error } = await asUser(user.jwt).rpc('accept_org_owner_transfer', { p_proposal_id: proposalId });
  return toOutcome(data, error);
}

async function dissolveOrg(user: TestUser, orgId: string): Promise<Outcome> {
  const { data, error } = await asUser(user.jwt).rpc('dissolve_org_by_owner', { p_organization_id: orgId });
  return toOutcome(data, error);
}

async function acceptInvite(user: TestUser, token: string): Promise<Outcome> {
  const { data, error } = await asUser(user.jwt).rpc('accept_org_invite', { p_token: token });
  return toOutcome(data, error);
}

async function operatorDissolveOrg(operatorJwt: string, orgId: string): Promise<Outcome> {
  const { data, error } = await asUser(operatorJwt).rpc('operator_force_dissolve_org', { p_organization_id: orgId, p_reason: 'toctou' });
  return toOutcome(data, error);
}

async function operatorTransfer(operatorJwt: string, orgId: string, newOwnerId: string): Promise<Outcome> {
  const { data, error } = await asUser(operatorJwt).rpc('operator_force_owner_transfer', {
    p_organization_id: orgId,
    p_new_owner_id: newOwnerId,
    p_reason: 'toctou',
  });
  return toOutcome(data, error);
}

/** RPC が RAISE した P0001 のコード (例外の文がそのコード) */
function expectRaised(outcome: Outcome, code: string): void {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
  expect(outcome.code).toBe('P0001');
  expect(outcome.message).toBe(code);
}

/** 失敗していれば、それが決まった P0001 のコードのどれかであること (23514・40P01 などの生の DB のエラーでない) */
function failedOnlyWith(outcome: Outcome, allowed: readonly string[]): boolean {
  return outcome.ok || (outcome.code === 'P0001' && allowed.includes(outcome.message ?? ''));
}

/** 運営 (super_admin・aal2) */
interface Operator {
  user: TestUser;
  jwt: string;
}
let operatorCache: Operator | null = null;
async function operator(): Promise<Operator> {
  if (operatorCache) return operatorCache;
  const user = await createUser('operator', ['user', 'super_admin']);
  const { client: sessionClient } = await signIn(user.email);
  operatorCache = { user, jwt: await promoteToAal2(sessionClient) };
  return operatorCache;
}

// ---------------------------------------------------------------------------------------------
// 先の処理をコミット前のまま開いておく接続 (org-invite-dissolved.test.ts と同じ形。運営の呼び出しは aal2 のクレームを足す)
// ---------------------------------------------------------------------------------------------

interface Holder {
  /** その接続の SQL に埋めた目印 (pg_stat_activity.query で見分ける) */
  marker: string;
  sleeping: Promise<void>;
  done: Promise<Outcome>;
  /** 先の接続がもう終わったか (pg_sleep を抜けて、持っていた行を放したか) */
  finished: () => boolean;
}

function holdCall(actor: TestUser, callSql: string, extraClaims: Record<string, string> = {}): Holder {
  const marker = `org-transfer-toctou-holder-${randomBytes(6).toString('hex')}`;
  const claims = JSON.stringify({ sub: actor.id, role: 'authenticated', ...extraClaims });
  return startHolder(
    marker,
    `/* ${marker} */
    SELECT set_config('request.jwt.claims', '${claims}', true);
    SET LOCAL ROLE authenticated;
    SELECT * FROM ${callSql};
    SELECT pg_sleep(${HOLD_SECONDS});
    SELECT 'held' AS result;`,
  );
}

/**
 * 組織の行だけを FOR NO KEY UPDATE で ORDER_HOLD_SECONDS 秒持つ接続 (pg/query の権限。user_profiles の行は 1 つも持たない)。
 * そのあとに呼んだ関数を組織の行の手前 (またはその前のロック) で待たせ、呼んだ順に並ばせる
 */
function holdOrgRow(orgId: string): Holder {
  const marker = `org-transfer-toctou-org-row-${randomBytes(6).toString('hex')}`;
  return startHolder(
    marker,
    `/* ${marker} */
    SELECT 1 FROM public.organizations WHERE id = '${orgId}'::uuid FOR NO KEY UPDATE;
    SELECT pg_sleep(${ORDER_HOLD_SECONDS});
    SELECT 'held' AS result;`,
  );
}

/**
 * user_profiles の 1 行だけを FOR NO KEY UPDATE で取り、取れてから HOLD_SECONDS 秒持つ接続 (pg/query の権限。組織の行は持たない)。
 * 組織の行を取らずに user_profiles の行を 1 つ取る処理 (脱退・除名・release_user_membership) の代わり。
 * 行が持たれていれば、放されるまで待ってから取る (待っている間は pg_stat_activity の wait_event_type = 'Lock')
 */
function holdProfileRow(userId: string): Holder {
  const marker = `org-transfer-toctou-profile-row-${randomBytes(6).toString('hex')}`;
  return startHolder(
    marker,
    `/* ${marker} */
    SELECT 1 FROM public.user_profiles WHERE id = '${userId}'::uuid FOR NO KEY UPDATE;
    SELECT pg_sleep(${HOLD_SECONDS});
    SELECT 'held' AS result;`,
  );
}

/** marker を含む sql を pg/query に投げ (終わりを待たない)、その接続が pg_sleep に入るまでを sleeping で待てるようにする */
function startHolder(marker: string, sql: string): Holder {
  const state: { outcome: Outcome | null } = { outcome: null };
  const done = pgRequest(sql).then((res): Outcome => {
    const body = res.body as { error?: unknown; code?: unknown } | null;
    const outcome: Outcome = res.ok
      ? { ok: true, data: null, message: null, code: null }
      : {
          ok: false,
          data: null,
          message: typeof body?.error === 'string' ? body.error : JSON.stringify(body),
          code: typeof body?.code === 'string' ? body.code : null,
        };
    state.outcome = outcome;
    return outcome;
  });
  pendingHolders.push(done);

  const sleeping = (async () => {
    const deadline = Date.now() + HOLDER_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (state.outcome) throw new Error(`先に呼んだ接続が pg_sleep に入る前に終わりました: ${JSON.stringify(state.outcome)}`);
      const rows = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event = 'PgSleep' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
      if (rows[0]?.n === 1) return;
      await sleep(HOLDER_POLL_MS);
    }
    throw new Error('先に呼んだ接続が pg_sleep に入りませんでした (遅すぎます)');
  })();

  return { marker, sleeping, done, finished: () => state.outcome !== null };
}

/** 関数 fnName を本物の経路で呼んだ接続が、行のロックの待ち (pg_stat_activity の wait_event_type = 'Lock') に count 本以上入るまで待つ */
async function waitForLockWaiters(fnName: string, count: number): Promise<void> {
  const deadline = Date.now() + HOLDER_DEADLINE_MS;
  while (Date.now() < deadline) {
    const rows = await pgQuery<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query LIKE '%${fnName}%' AND pid <> pg_backend_pid()`);
    if ((rows[0]?.n ?? 0) >= count) return;
    await sleep(HOLDER_POLL_MS);
  }
  throw new Error(`${fnName} の呼び出しが行のロックの待ちに入りませんでした (遅すぎます)`);
}

const AAL2_CLAIMS = { aal: 'aal2' } as const;

afterAll(async () => {
  await Promise.allSettled(pendingHolders);
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('ownership_transfer_proposals').delete().in('from_user_id', createdUserIds);
    await srAdmin.from('user_profiles').update({ organization_id: null, org_role: null, is_active_in_org: false }).in('id', createdUserIds);
  }
  if (createdOrgIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdOrgIds);
    await srAdmin.from('organization_invites').delete().in('organization_id', createdOrgIds);
    await srAdmin.from('org_license_pools').delete().in('organization_id', createdOrgIds);
    // organizations.owner_id は ON DELETE RESTRICT なので、利用者より先に組織を消す
    await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, RACE_TIMEOUT_MS);

// ---------------------------------------------------------------------------------------------
// 解散した組織の提案の承諾 (順番に呼ぶ)
// ---------------------------------------------------------------------------------------------

describe('解散した組織のオーナーの譲渡の提案は承諾できない (accept_org_owner_transfer)', () => {
  it('OT-1: オーナーが解散した組織の pending の提案を承諾すると ORG_ALREADY_DISSOLVED。所属・提案 (pending のまま)・監査ログは変わらない', async () => {
    const { owner, admin, orgId, proposalId } = await setupTransfer('ot1');
    expect((await dissolveOrg(owner, orgId)).ok).toBe(true);

    expectRaised(await acceptTransfer(admin, proposalId), 'ORG_ALREADY_DISSOLVED');

    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgProfile(admin.id)).toMatchObject({ organization_id: null, org_role: null });
    expect(await orgProfile(owner.id)).toMatchObject({ organization_id: null, org_role: null });
    expect(await proposalStatus(proposalId)).toBe('pending');
    expect(await transferredAudits(orgId)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('OT-2: 運営が強制解散した組織の pending の提案も ORG_ALREADY_DISSOLVED', async () => {
    const op = await operator();
    const { admin, orgId, proposalId } = await setupTransfer('ot2');
    const dissolved = await operatorDissolveOrg(op.jwt, orgId);
    expect(dissolved.ok, JSON.stringify(dissolved)).toBe(true);

    expectRaised(await acceptTransfer(admin, proposalId), 'ORG_ALREADY_DISSOLVED');
    expect(await orgProfile(admin.id)).toMatchObject({ organization_id: null, org_role: null });
    expect(await proposalStatus(proposalId)).toBe('pending');
  }, TEST_TIMEOUT_MS);

  it('OT-3: 運営の強制譲渡のあとに残った提案は NOT_ORG_OWNER で、オーナーの役割の人は 1 人のまま (強制譲渡で決まったオーナー)', async () => {
    const op = await operator();
    const { owner, admin, orgId, proposalId } = await setupTransfer('ot3');
    const [member] = await createUsers('ot3-member', 1);
    await setOrgMembership(member, orgId, 'member');
    const forced = await operatorTransfer(op.jwt, orgId, member.id);
    expect(forced.ok, JSON.stringify(forced)).toBe(true);

    expectRaised(await acceptTransfer(admin, proposalId), 'NOT_ORG_OWNER');

    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: member.id });
    expect(await ownerRoleHolders(orgId)).toEqual([member.id]);
    expect(await orgProfile(owner.id)).toMatchObject({ organization_id: orgId, org_role: 'admin' });
    expect(await orgProfile(admin.id)).toMatchObject({ organization_id: orgId, org_role: 'admin' });
    expect(await proposalStatus(proposalId)).toBe('pending');
    expect(await transferredAudits(orgId)).toBe(0);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 解散と承諾の同時の実行
// ---------------------------------------------------------------------------------------------

describe('解散と譲渡の承諾が同時に走っても、23514 にならず、デッドロックしない', () => {
  it('OT-4: オーナーの解散をコミット前のまま開いている間に承諾すると、承諾は解散の commit を待ってから ORG_ALREADY_DISSOLVED (修正前は 23514)', async () => {
    const { owner, admin, orgId, proposalId } = await setupTransfer('ot4');

    const holder = holdCall(owner, `public.dissolve_org_by_owner('${orgId}'::uuid)`);
    await holder.sleeping;
    const accept = await acceptTransfer(admin, proposalId);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(accept.code, JSON.stringify(accept)).not.toBe(PG_CHECK_VIOLATION);
    expectRaised(accept, 'ORG_ALREADY_DISSOLVED');
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgMemberCount(orgId)).toBe(0);
    expect(await proposalStatus(proposalId)).toBe('pending');
  }, TEST_TIMEOUT_MS);

  it('OT-5: 運営の強制解散をコミット前のまま開いている間に承諾しても、承諾は ORG_ALREADY_DISSOLVED (修正前は 23514)', async () => {
    const op = await operator();
    const { admin, orgId, proposalId } = await setupTransfer('ot5');

    const holder = holdCall(op.user, `public.operator_force_dissolve_org('${orgId}'::uuid, 'toctou')`, AAL2_CLAIMS);
    await holder.sleeping;
    const accept = await acceptTransfer(admin, proposalId);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(accept, 'ORG_ALREADY_DISSOLVED');
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgMemberCount(orgId)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('OT-6: 承諾をコミット前のまま開いている間にオーナーが解散すると、解散は承諾の commit を待ってから NOT_ORG_OWNER。組織は新オーナーで active', async () => {
    const { owner, admin, orgId, proposalId } = await setupTransfer('ot6');

    const holder = holdCall(admin, `public.accept_org_owner_transfer('${proposalId}'::uuid)`);
    await holder.sleeping;
    const dissolve = await dissolveOrg(owner, orgId);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(dissolve, 'NOT_ORG_OWNER');
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: admin.id });
    expect(await ownerRoleHolders(orgId)).toEqual([admin.id]);
    expect(await orgProfile(owner.id)).toMatchObject({ organization_id: orgId, org_role: 'admin' });
  }, TEST_TIMEOUT_MS);

  it('OT-7: 承諾をコミット前のまま開いている間に運営が強制解散すると、強制解散は承諾の commit を待ってから組織の行を取り、新しいオーナーの組織として解散する (所属 0 人)', async () => {
    const op = await operator();
    const { admin, orgId, proposalId } = await setupTransfer('ot7');

    const holder = holdCall(admin, `public.accept_org_owner_transfer('${proposalId}'::uuid)`);
    await holder.sleeping;
    const dissolve = await operatorDissolveOrg(op.jwt, orgId);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(dissolve.ok, JSON.stringify(dissolve)).toBe(true);
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgMemberCount(orgId)).toBe(0);
    expect(await proposalStatus(proposalId)).toBe('accepted');
  }, TEST_TIMEOUT_MS);

  it('OT-8: オーナーの解散と承諾を本物の経路で 8 回ずつ同時に呼んでも、デッドロック・23514 にならず、決まったエラーか成功で、終わったあとは「dissolved で所属 0 人」か「active で owner が新オーナー」', async () => {
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const { owner, admin, orgId, proposalId } = await setupTransfer(`ot8-${i}`);

      const [dissolve, accept] = await Promise.all([dissolveOrg(owner, orgId), acceptTransfer(admin, proposalId)]);

      if (isDeadlock(dissolve) || isDeadlock(accept)) problems.push(`#${i} デッドロック: ${JSON.stringify({ dissolve, accept })}`);
      if (!failedOnlyWith(dissolve, ['NOT_ORG_OWNER'])) problems.push(`#${i} 解散が決まったエラー以外で失敗: ${JSON.stringify(dissolve)}`);
      if (!failedOnlyWith(accept, ['ORG_ALREADY_DISSOLVED'])) problems.push(`#${i} 承諾が決まったエラー以外で失敗: ${JSON.stringify(accept)}`);
      if (dissolve.ok === accept.ok) problems.push(`#${i} どちらか一方だけが成功するはず: ${JSON.stringify({ dissolve, accept })}`);
      const row = await orgRow(orgId);
      const members = await orgMemberCount(orgId);
      const owners = await ownerRoleHolders(orgId);
      const dissolvedEnd = row?.status === 'dissolved' && row.owner_id === null && members === 0;
      const transferredEnd = row?.status === 'active' && row.owner_id === admin.id && owners.length === 1 && owners[0] === admin.id;
      if (!dissolvedEnd && !transferredEnd) problems.push(`#${i} 中間の状態: ${JSON.stringify({ row, members, owners, dissolve, accept })}`);
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);

  it('OT-9: 運営の強制解散と承諾を本物の経路で 8 回ずつ同時に呼んでも、デッドロック・23514 にならず、強制解散は成功し、承諾は成功か ORG_ALREADY_DISSOLVED', async () => {
    const op = await operator();
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const { admin, orgId, proposalId } = await setupTransfer(`ot9-${i}`);

      const [dissolve, accept] = await Promise.all([operatorDissolveOrg(op.jwt, orgId), acceptTransfer(admin, proposalId)]);

      if (isDeadlock(dissolve) || isDeadlock(accept)) problems.push(`#${i} デッドロック: ${JSON.stringify({ dissolve, accept })}`);
      if (!dissolve.ok) problems.push(`#${i} 強制解散が失敗: ${JSON.stringify(dissolve)}`);
      if (!failedOnlyWith(accept, ['ORG_ALREADY_DISSOLVED'])) problems.push(`#${i} 承諾が決まったエラー以外で失敗: ${JSON.stringify(accept)}`);
      const row = await orgRow(orgId);
      const members = await orgMemberCount(orgId);
      if (row?.status !== 'dissolved' || row.owner_id !== null || members !== 0) {
        problems.push(`#${i} 中間の状態: ${JSON.stringify({ row, members, dissolve, accept })}`);
      }
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 運営の強制譲渡と解散の同時の実行 (同じ型: 在籍の判定をロックの外で行っていた)
// ---------------------------------------------------------------------------------------------

describe('運営の強制譲渡 (operator_force_owner_transfer) と解散が同時に走っても、23514 にならない', () => {
  it('OT-10: オーナーの解散をコミット前のまま開いている間に強制譲渡すると、強制譲渡は解散の commit を待ってから TARGET_NOT_IN_ORG (修正前は 23514)', async () => {
    const op = await operator();
    const [owner, admin] = await createUsers('ot10', 2);
    const orgId = await createOrg(owner, admin, 'ot10');

    const holder = holdCall(owner, `public.dissolve_org_by_owner('${orgId}'::uuid)`);
    await holder.sleeping;
    const forced = await operatorTransfer(op.jwt, orgId, admin.id);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(forced, 'TARGET_NOT_IN_ORG');
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgMemberCount(orgId)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('OT-11: オーナーの解散と強制譲渡を本物の経路で 8 回ずつ同時に呼んでも、デッドロック・23514 にならず、終わったあとは「dissolved で所属 0 人」か「active で owner が強制譲渡の相手」', async () => {
    const op = await operator();
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const [owner, admin] = await createUsers(`ot11-${i}`, 2);
      const orgId = await createOrg(owner, admin, `ot11-${i}`);

      const [dissolve, forced] = await Promise.all([dissolveOrg(owner, orgId), operatorTransfer(op.jwt, orgId, admin.id)]);

      if (isDeadlock(dissolve) || isDeadlock(forced)) problems.push(`#${i} デッドロック: ${JSON.stringify({ dissolve, forced })}`);
      if (!failedOnlyWith(dissolve, ['NOT_ORG_OWNER'])) problems.push(`#${i} 解散が決まったエラー以外で失敗: ${JSON.stringify(dissolve)}`);
      if (!failedOnlyWith(forced, ['TARGET_NOT_IN_ORG'])) problems.push(`#${i} 強制譲渡が決まったエラー以外で失敗: ${JSON.stringify(forced)}`);
      const row = await orgRow(orgId);
      const members = await orgMemberCount(orgId);
      const owners = await ownerRoleHolders(orgId);
      const dissolvedEnd = row?.status === 'dissolved' && row.owner_id === null && members === 0;
      const transferredEnd = row?.status === 'active' && row.owner_id === admin.id && owners.length === 1 && owners[0] === admin.id;
      if (!dissolvedEnd && !transferredEnd) problems.push(`#${i} 中間の状態: ${JSON.stringify({ row, members, owners, dissolve, forced })}`);
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 脱退・除名と承諾の同時の実行 (同じ型: 判定をロックの外で行っていた)
// ---------------------------------------------------------------------------------------------

describe('脱退・除名と譲渡の承諾が同時に走っても、オーナーの所属が外れない', () => {
  it('OT-12: 承諾をコミット前のまま開いている間に承諾者が脱退すると、脱退は承諾の commit を待ってから IS_ORG_OWNER (修正前は所属が外れ、owner_id が所属の無い人を指した)', async () => {
    const { admin, orgId, proposalId } = await setupTransfer('ot12');

    const holder = holdCall(admin, `public.accept_org_owner_transfer('${proposalId}'::uuid)`);
    await holder.sleeping;
    const { data, error } = await asUser(admin.jwt).rpc('leave_org');
    const left = toOutcome(data, error);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(left, 'IS_ORG_OWNER');
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: admin.id });
    expect(await orgProfile(admin.id)).toMatchObject({ organization_id: orgId, org_role: 'owner' });
  }, TEST_TIMEOUT_MS);

  it('OT-13: 承諾者の脱退をコミット前のまま開いている間に承諾すると、承諾は脱退の commit を待ってから TRANSFER_ACCEPTOR_NOT_IN_ORG (修正前は 23514)', async () => {
    const { owner, admin, orgId, proposalId } = await setupTransfer('ot13');

    const holder = holdCall(admin, 'public.leave_org()');
    await holder.sleeping;
    const accept = await acceptTransfer(admin, proposalId);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(accept, 'TRANSFER_ACCEPTOR_NOT_IN_ORG');
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: owner.id });
    expect(await ownerRoleHolders(orgId)).toEqual([owner.id]);
    expect(await proposalStatus(proposalId)).toBe('pending');
  }, TEST_TIMEOUT_MS);

  it('OT-14: 承諾をコミット前のまま開いている間に旧オーナーが承諾者を除名すると、除名は承諾の commit を待ってから CANNOT_REMOVE_OWNER', async () => {
    const { owner, admin, orgId, proposalId } = await setupTransfer('ot14');

    const holder = holdCall(admin, `public.accept_org_owner_transfer('${proposalId}'::uuid)`);
    await holder.sleeping;
    const { data, error } = await asUser(owner.jwt).rpc('remove_org_member', { p_organization_id: orgId, p_user_id: admin.id });
    const removed = toOutcome(data, error);
    const held = await holder.done;

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(removed, 'CANNOT_REMOVE_OWNER');
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: admin.id });
    expect(await orgProfile(admin.id)).toMatchObject({ organization_id: orgId, org_role: 'owner' });
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// オーナーでない人の解散 (dissolve_org_by_owner) と、組織の行のあとにその人の行を取る関数
// (修正前は解散が呼び出した本人の行 → 組織の行 の順に取り、逆向きになってデッドロック (40P01) した)
// ---------------------------------------------------------------------------------------------

/** 呼び出し 1 本 (待ちを見分けるための関数名と、本物の経路での呼び出し) */
interface QueuedCall {
  fn: string;
  call: () => Promise<Outcome>;
}

/**
 * 組織の行を holdOrgRow で持っている間に first → second の順に呼び、2 本とも行のロックの待ちに並んでから組織の行を放す。
 * first は組織の行の手前で待ち (それより前の行 (提案・招待の行) は取ったまま)、先に組織の行を取る。修正前は second の解散が
 * 呼び出した本人の行を持ったまま組織の行を待ち、組織の行を取った first がその本人の行を待って 40P01 になった。修正後は second の
 * 解散も組織の行を最初に取る (user_profiles の行を 1 つも持たずに組織の行を待つ) ので、待ちの輪ができない
 */
async function runQueuedBehindOrgRow(orgId: string, first: QueuedCall, second: QueuedCall): Promise<[Outcome, Outcome]> {
  const holder = holdOrgRow(orgId);
  await holder.sleeping;
  const firstDone = first.call();
  await waitForLockWaiters(first.fn, 1);
  const secondDone = second.call();
  await waitForLockWaiters(second.fn, first.fn === second.fn ? 2 : 1);
  // 2 本が並んだ時点で組織の行はまだ持たれている (並べた順で結果が決まる。放したあとに並んだのでは、この順を確かめていない)
  expect(holder.finished(), '組織の行を放す前に 2 本が並びませんでした (遅すぎます)').toBe(false);
  const [held, firstOutcome, secondOutcome] = await Promise.all([holder.done, firstDone, secondDone]);
  expect(held.ok, JSON.stringify(held)).toBe(true);
  return [firstOutcome, secondOutcome];
}

describe('オーナーでない人が解散を呼んでも、解散は組織の行を最初に取るので、組織の行のあとにその人の行を取る関数と逆向きにならない (デッドロックしない)', () => {
  it('OT-18: 提案を受けた admin が、自分の承諾と同時に解散の RPC を呼んでも (呼び出した時点ではオーナーでない) デッドロックせず、承諾が通り、解散は新しいオーナーとして通る (修正前は 承諾: 組織の行 → 承諾者の行 と 解散: 本人の行 → 組織の行 が逆向きで 40P01)', async () => {
    const { admin, orgId, proposalId } = await setupTransfer('ot18');

    const [accept, dissolve] = await runQueuedBehindOrgRow(
      orgId,
      { fn: 'accept_org_owner_transfer', call: () => acceptTransfer(admin, proposalId) },
      { fn: 'dissolve_org_by_owner', call: () => dissolveOrg(admin, orgId) },
    );

    expect(isDeadlock(accept) || isDeadlock(dissolve), JSON.stringify({ accept, dissolve })).toBe(false);
    expect(accept.ok, JSON.stringify(accept)).toBe(true);
    expect(dissolve.ok, JSON.stringify(dissolve)).toBe(true);
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgMemberCount(orgId)).toBe(0);
    expect(await proposalStatus(proposalId)).toBe('accepted');
  }, TEST_TIMEOUT_MS);

  it('OT-19: 運営が admin へ強制譲渡するのと同時に、その admin が解散の RPC を呼んでも、デッドロックせず、強制譲渡が通り、解散は新しいオーナーとして通る (修正前は 強制譲渡: 組織の行 → 新オーナーの行 と逆向きで 40P01)', async () => {
    const op = await operator();
    const [owner, admin] = await createUsers('ot19', 2);
    const orgId = await createOrg(owner, admin, 'ot19');

    const [forced, dissolve] = await runQueuedBehindOrgRow(
      orgId,
      { fn: 'operator_force_owner_transfer', call: () => operatorTransfer(op.jwt, orgId, admin.id) },
      { fn: 'dissolve_org_by_owner', call: () => dissolveOrg(admin, orgId) },
    );

    expect(isDeadlock(forced) || isDeadlock(dissolve), JSON.stringify({ forced, dissolve })).toBe(false);
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expect(dissolve.ok, JSON.stringify(dissolve)).toBe(true);
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgMemberCount(orgId)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('OT-20: オーナーの解散と同時に admin が解散の RPC を呼んでも、デッドロックせず、オーナーの解散が通り、admin は ORG_ALREADY_DISSOLVED (修正前は 後始末: 組織の行 → 全員の行 と逆向きで 40P01)', async () => {
    const [owner, admin] = await createUsers('ot20', 2);
    const orgId = await createOrg(owner, admin, 'ot20');

    const [ownerDissolve, adminDissolve] = await runQueuedBehindOrgRow(
      orgId,
      { fn: 'dissolve_org_by_owner', call: () => dissolveOrg(owner, orgId) },
      { fn: 'dissolve_org_by_owner', call: () => dissolveOrg(admin, orgId) },
    );

    expect(isDeadlock(ownerDissolve) || isDeadlock(adminDissolve), JSON.stringify({ ownerDissolve, adminDissolve })).toBe(false);
    expect(ownerDissolve.ok, JSON.stringify(ownerDissolve)).toBe(true);
    expectRaised(adminDissolve, 'ORG_ALREADY_DISSOLVED');
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgMemberCount(orgId)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('OT-21: 運営の強制解散と同時に admin が解散の RPC を呼んでも、デッドロックせず、強制解散が通り、admin は ORG_ALREADY_DISSOLVED (修正前は 後始末: 組織の行 → 全員の行 と逆向きで 40P01)', async () => {
    const op = await operator();
    const [owner, admin] = await createUsers('ot21', 2);
    const orgId = await createOrg(owner, admin, 'ot21');

    const [forcedDissolve, adminDissolve] = await runQueuedBehindOrgRow(
      orgId,
      { fn: 'operator_force_dissolve_org', call: () => operatorDissolveOrg(op.jwt, orgId) },
      { fn: 'dissolve_org_by_owner', call: () => dissolveOrg(admin, orgId) },
    );

    expect(isDeadlock(forcedDissolve) || isDeadlock(adminDissolve), JSON.stringify({ forcedDissolve, adminDissolve })).toBe(false);
    expect(forcedDissolve.ok, JSON.stringify(forcedDissolve)).toBe(true);
    expectRaised(adminDissolve, 'ORG_ALREADY_DISSOLVED');
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgMemberCount(orgId)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('OT-22: 招待された人が招待の承諾と同時にその組織の解散の RPC を呼んでも、デッドロックせず、承諾が通り、解散は NOT_ORG_OWNER (修正前は 招待の承諾: 組織の行 → 承諾者の行 と逆向きで 40P01)', async () => {
    const [owner, admin, invitee] = await createUsers('ot22', 3);
    const orgId = await createOrg(owner, admin, 'ot22');
    const token = await insertPendingOrgInvite(orgId, invitee.email, owner.id);

    const [accept, dissolve] = await runQueuedBehindOrgRow(
      orgId,
      { fn: 'accept_org_invite', call: () => acceptInvite(invitee, token) },
      { fn: 'dissolve_org_by_owner', call: () => dissolveOrg(invitee, orgId) },
    );

    expect(isDeadlock(accept) || isDeadlock(dissolve), JSON.stringify({ accept, dissolve })).toBe(false);
    expect(accept.ok, JSON.stringify(accept)).toBe(true);
    expectRaised(dissolve, 'NOT_ORG_OWNER');
    expect(await orgRow(orgId)).toMatchObject({ status: 'active', owner_id: owner.id });
    expect(await orgProfile(invitee.id)).toMatchObject({ organization_id: orgId, org_role: 'member' });
  }, TEST_TIMEOUT_MS);

  it('OT-23: 提案を受けた admin の承諾と解散を本物の経路で 8 回ずつ同時に呼んでも、デッドロック・23514 にならず、承諾は成功し、解散は成功か NOT_ORG_OWNER。終わったあとは「dissolved で所属 0 人」か「active で owner が admin」', async () => {
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const { admin, orgId, proposalId } = await setupTransfer(`ot23-${i}`);

      const [accept, dissolve] = await Promise.all([acceptTransfer(admin, proposalId), dissolveOrg(admin, orgId)]);

      if (isDeadlock(accept) || isDeadlock(dissolve)) problems.push(`#${i} デッドロック: ${JSON.stringify({ accept, dissolve })}`);
      if (!accept.ok) problems.push(`#${i} 承諾が失敗: ${JSON.stringify(accept)}`);
      if (!failedOnlyWith(dissolve, ['NOT_ORG_OWNER'])) problems.push(`#${i} 解散が決まったエラー以外で失敗: ${JSON.stringify(dissolve)}`);
      const row = await orgRow(orgId);
      const members = await orgMemberCount(orgId);
      const owners = await ownerRoleHolders(orgId);
      const dissolvedEnd = dissolve.ok && row?.status === 'dissolved' && row.owner_id === null && members === 0;
      const transferredEnd = !dissolve.ok && row?.status === 'active' && row.owner_id === admin.id && owners.length === 1 && owners[0] === admin.id;
      if (!dissolvedEnd && !transferredEnd) problems.push(`#${i} 中間の状態: ${JSON.stringify({ row, members, owners, accept, dissolve })}`);
    }
    expect(problems).toEqual([]);
  }, RACE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 取り直しのループが無いこと (組織の行を取ったあとに読んだ owner_id は commit まで変わらない。待ちの順は組織の行に並んだ順)
// (修正前の運営の強制解散 (20261022100000_org_invite_dissolved.sql) と、この修正の途中の形の解散・譲渡は、組織の行から読んだ
//  オーナーの行を最初に取り、読んだ後にオーナーが変わっていたら取り直すループを持っていた。そのため待ちの順が組織の行で決まらず、
//  下の並びを取り直しのループの形 (途中の形の migration) で流すと、先に並んだ強制解散が古いオーナー X の行で待つ間に、後から呼んだ
//  新しいオーナー Y の解散が先に通り、強制解散が ORG_ALREADY_DISSOLVED になった (変異の実行で確かめた)。途中の形の見出しは、
//  ループが X の行を持ったまま Y の行を待ち、Y の行を先に取った処理が X の行を待つ順のデッドロック (40P01) も既知として書いていた)
// ---------------------------------------------------------------------------------------------

describe('譲渡の commit をまたいで運営の強制解散と新しいオーナーの解散が重なっても、デッドロックせず、組織の行に並んだ順に通る', () => {
  it('OT-25: 旧オーナー X → admin Y の承諾をコミット前のまま開き、X の行だけを持つ処理と運営の強制解散をその後ろに並ばせ、承諾の commit のあとに Y が解散を呼んでも、デッドロックせず、先に並んだ強制解散が通り、Y は ORG_ALREADY_DISSOLVED (取り直しのループの形では、強制解散が X の行で待つ間に Y の解散が追い越して通り、強制解散が ORG_ALREADY_DISSOLVED になった)', async () => {
    const op = await operator();
    const { owner, admin, orgId, proposalId } = await setupTransfer('ot25');

    // (1) 承諾 (X → Y) をコミット前のまま開く (提案の行・組織の行・Y の行・X の行を持つ)
    const accept = holdCall(admin, `public.accept_org_owner_transfer('${proposalId}'::uuid)`);
    await accept.sleeping;
    // (2) X の行だけを取る処理を、承諾の後ろに並ばせる (承諾の commit のあとは、この接続が X の行を HOLD_SECONDS 秒持つ)
    const ownerRow = holdProfileRow(owner.id);
    await waitForLockWaiters(ownerRow.marker, 1);
    // (3) 運営の強制解散を並ばせる (組織の行で待つ。取り直しのループなら、ループの最初の X の行で (2) の後ろに待つ)
    const forcedDone = operatorDissolveOrg(op.jwt, orgId);
    await waitForLockWaiters('operator_force_dissolve_org', 1);
    // (4) 承諾が commit する (オーナーは Y)。X の行は (2) の接続が取る
    const accepted = await accept.done;
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    await ownerRow.sleeping;
    // (5) 新しいオーナー Y が解散を呼ぶ (組織の行で (3) の後ろに待つ。取り直しのループの形なら、(3) はまだ組織の行を取っていない
    //     ので、Y の解散は Y の行と組織の行を先に取れ、(3) を追い越す)
    const dissolveDone = dissolveOrg(admin, orgId);
    await waitForLockWaiters('dissolve_org_by_owner', 1);
    expect(ownerRow.finished(), 'X の行を放す前に Y の解散が並びませんでした (遅すぎます)').toBe(false);

    const [held, forced, dissolve] = await Promise.all([ownerRow.done, forcedDone, dissolveDone]);
    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(isDeadlock(forced) || isDeadlock(dissolve), JSON.stringify({ forced, dissolve })).toBe(false);
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expectRaised(dissolve, 'ORG_ALREADY_DISSOLVED');
    expect(await orgRow(orgId)).toMatchObject({ status: 'dissolved', owner_id: null });
    expect(await orgMemberCount(orgId)).toBe(0);
    expect(await proposalStatus(proposalId)).toBe('accepted');
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 承諾の API (POST /api/org/owner-transfer/[id]/accept) の文
// ---------------------------------------------------------------------------------------------

interface ErrorBody {
  error?: { code?: string; message?: string };
}

describe('承諾の API は新しく返りうるエラーを利用者向けの文にし、生の DB のエラーを出さない', () => {
  it('OT-16: 解散した組織の提案を API で承諾すると 409 ORG_ALREADY_DISSOLVED と利用者向けの文 (コードの文字列や DB の語を本文に出さない)', async () => {
    const { owner, admin, orgId, proposalId } = await setupTransfer('ot16');
    expect((await dissolveOrg(owner, orgId)).ok).toBe(true);

    const res = await apiCall<ErrorBody>('POST', `/api/org/owner-transfer/${proposalId}/accept`, admin.jwt);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'ORG_ALREADY_DISSOLVED',
      message: 'この組織は解散しているため、オーナー権限を引き継げません。',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/user_profiles|23514|check constraint/i);
    expect(await proposalStatus(proposalId)).toBe('pending');
  }, TEST_TIMEOUT_MS);

  it('OT-17: 運営の強制譲渡のあとに残った提案を API で承諾すると 403 NOT_ORG_OWNER と利用者向けの文', async () => {
    const op = await operator();
    const { admin, orgId, proposalId } = await setupTransfer('ot17');
    const [member] = await createUsers('ot17-member', 1);
    await setOrgMembership(member, orgId, 'member');
    expect((await operatorTransfer(op.jwt, orgId, member.id)).ok).toBe(true);

    const res = await apiCall<ErrorBody>('POST', `/api/org/owner-transfer/${proposalId}/accept`, admin.jwt);

    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({
      code: 'NOT_ORG_OWNER',
      message: '譲渡を申し出た人が今はこの組織のオーナーではないため、オーナー権限を引き継げません。',
    });
    expect(await ownerRoleHolders(orgId)).toEqual([member.id]);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// 関数の属性・権限 (CREATE OR REPLACE で変えていない)
// ---------------------------------------------------------------------------------------------

describe('関数の属性と権限は変えていない', () => {
  it('OT-15: accept_org_owner_transfer / operator_force_owner_transfer / operator_force_dissolve_org / leave_org / remove_org_member は SECURITY DEFINER・search_path=public のまま、anon は呼べず authenticated は呼べる', async () => {
    const names = ['accept_org_owner_transfer', 'leave_org', 'operator_force_dissolve_org', 'operator_force_owner_transfer', 'remove_org_member'];
    const rows = await pgQuery<{ proname: string; prosecdef: boolean; proconfig: string[] | null; anon_exec: boolean; auth_exec: boolean }>(`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN (${names.map((name) => `'${name}'`).join(', ')})
       ORDER BY p.proname`);
    expect(rows.map((r) => r.proname)).toEqual(names);
    for (const row of rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.proconfig ?? [], row.proname).toContain('search_path=public');
      expect(row.anon_exec, row.proname).toBe(false);
      expect(row.auth_exec, row.proname).toBe(true);
    }
    const anonAccept = await anon().rpc('accept_org_owner_transfer', { p_proposal_id: '00000000-0000-0000-0000-000000000000' });
    expect(anonAccept.error?.code).toBe('42501');
  }, TEST_TIMEOUT_MS);

  it("OT-24: dissolve_org_by_owner は作り直したあとも SECURITY DEFINER・search_path='' のまま、anon は呼べず authenticated は呼べる", async () => {
    const rows = await pgQuery<{ prosecdef: boolean; proconfig: string[] | null; anon_exec: boolean; auth_exec: boolean }>(`
      SELECT p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'dissolve_org_by_owner'`);
    expect(rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'], anon_exec: false, auth_exec: true }]);
    const anonDissolve = await anon().rpc('dissolve_org_by_owner', { p_organization_id: '00000000-0000-0000-0000-000000000000' });
    expect(anonDissolve.error?.code).toBe('42501');
  }, TEST_TIMEOUT_MS);
});
