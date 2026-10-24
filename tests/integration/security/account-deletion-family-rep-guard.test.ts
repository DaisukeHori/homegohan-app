/**
 * #1917 の続き: 退会の途中 (findBlocker のあと〜deleteUser の前) に、その人が家族の代表者になると、退会の最後の deleteUser が
 * family_groups.representative_id の外部キー (ON DELETE RESTRICT) で失敗する既存の欠陥の回帰テスト (実 DB)。
 *
 * 修正前: 家族の作成 (create_family_group)・代表者の譲渡の承諾 (accept_family_representative_transfer)・運営の強制譲渡
 *   (operator_force_representative_transfer) は、退会の途中かを見ずに代表者を書いた。退会は家族の所属を関数で外さないので、
 *   退会の途中の人は家族の active なメンバーのままで、承諾・強制譲渡の在籍の確認を通った。
 * 修正後 (supabase/migrations/20261023150000_account_deletion_family_representative_guard.sql):
 *   - family_groups の BEFORE INSERT OR UPDATE OF representative_id のトリガー family_groups_representative_not_deleting が、
 *     新しい representative_id の人に新しい退会の印 (account_deletion_guards。20261023130000) があれば
 *     REPRESENTATIVE_ACCOUNT_DELETING (P0001) で止める。NULL (解散) と値を変えない UPDATE は止めない。
 *   - 印と代表者の変更は、その人の id の advisory lock で直列になる (印が先なら変更が止まり、変更が先なら印は変更の commit を待ち、
 *     そのあとの findBlocker が新しい代表者の家族を読んで 409 にする)。
 *
 * 呼び出しは本物の経路 (PostgREST)。先の処理をコミット前のまま開いておくのは、ローカルスタックの postgres-meta
 * (/pg/query、service_role キーが必要) を使う (account-deletion-owner-guard.test.ts・family-lock-order-race.test.ts と同じ道具)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/account-deletion-family-rep-guard.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import ws from 'ws';
import { deleteAccount, type AccountDeletionBilling, type AccountDeletionBillingReport } from '@/lib/account-deletion';
import { actAsAuthenticatedSql, createLockHolderKit, type Holder } from '../helpers/lock-holder';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { grantFamilyPlan } from '../helpers/family-plan';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kong → PostgREST の使い回しの接続の 502 (リクエストが PostgREST に届いていない) を数回だけやり直す (org-transfer-toctou.test.ts と同じ) */
const GATEWAY_RETRIES = 3;
/** 502 をやり直すまでの待ちの単位 (ミリ秒) */
const GATEWAY_RETRY_WAIT_MS = 150;
/** postgres-meta の 502 をやり直すのは、この時間 (ミリ秒) 以内に返ったときだけ (pg_sleep で待たせた後の応答ではない) */
const GATEWAY_FAST_FAIL_MS = 1500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_CONFLICT = 409;

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

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const ADULT_BIRTH_DATE = '1990-01-01';
/** 印が効く長さ (分)。migration の c_guard_window (make_interval(mins => 15)) と同じ値 */
const GUARD_WINDOW_MINUTES = 15;
/** 効く長さの内側・外側に置く印の古さ (分) */
const FRESH_GUARD_AGE_MINUTES = GUARD_WINDOW_MINUTES - 1;
const STALE_GUARD_AGE_MINUTES = GUARD_WINDOW_MINUTES + 1;
const TEST_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 240_000;
/** 後片付けを並列に流す件数 */
const CLEANUP_BATCH_SIZE = 10;
/** 権限が無いときの SQLSTATE */
const PG_INSUFFICIENT_PRIVILEGE = '42501';
const PG_RAISE_EXCEPTION = 'P0001';
const RAISE_CODE = 'REPRESENTATIVE_ACCOUNT_DELETING';
/** 特権列のガード (trg_guard_family_groups_privileged) がログインユーザーの representative_id の直接の変更を止めるときのコード */
const PRIVILEGED_COLUMN_CODE = 'CANNOT_MODIFY_PRIVILEGED_COLUMN';
const TRIGGER_FN = 'family_groups_representative_not_deleting';

const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];

/** 運営 (super_admin)。operator_force_representative_transfer はこのロールの人だけが実行できる */
let operator: TestUser;

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-deletion-family-rep-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      {
        id: data.user.id,
        nickname: `deletion-family-rep-${label}`,
        age_group: '30s',
        gender: 'other',
        birth_date: ADULT_BIRTH_DATE,
        ...(roles ? { roles } : {}),
      },
      { onConflict: 'id' },
    ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const { data: session, error: signInError } = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError || !session.session) throw new Error(`signIn ${label}: ${signInError?.message}`);
  return { id: data.user.id, email, jwt: session.session.access_token };
}

interface Outcome {
  ok: boolean;
  message: string | null;
  code: string | null;
}

function toOutcome(error: { message?: string; code?: string } | null): Outcome {
  return { ok: !error, message: error?.message ?? null, code: error?.code ?? null };
}

function expectRaised(outcome: Outcome, code: string): void {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
  expect(outcome.code).toBe(PG_RAISE_EXCEPTION);
  expect(outcome.message).toBe(code);
}

/** 退会の本体 (src/lib/account-deletion.ts) と同じく service_role で印を付ける */
async function beginGuard(userId: string): Promise<Outcome> {
  const { error } = await srAdmin.rpc('begin_account_deletion_guard', { p_user_id: userId });
  return toOutcome(error);
}

/** 印の日時を minutes 分前にする (古い印・効く長さの内側の印を作る) */
async function ageGuard(userId: string, minutes: number): Promise<void> {
  await pgQuery(
    `UPDATE public.account_deletion_guards SET started_at = now() - make_interval(mins => ${minutes}) WHERE user_id = '${userId}'::uuid`,
  );
}

/** 本人が家族を作る (家族プランの契約は呼ぶ前に入れておく)。作れたら id を後片付けに積む */
async function createFamilyAs(user: TestUser, label: string): Promise<Outcome & { familyId: string | null }> {
  const { data, error } = await asUser(user.jwt).rpc('create_family_group', { p_name: `deletion-family-rep ${label} ${TS}` });
  const familyId = data ? (data as { id: string }).id : null;
  if (familyId) createdFamilyIds.push(familyId);
  return { ...toOutcome(error), familyId };
}

interface Family {
  rep: TestUser;
  adult: TestUser;
  familyId: string;
}

/** 代表者 + 大人 1 人 (招待 → 承諾で入る) の家族を作る */
async function buildFamily(label: string): Promise<Family> {
  const [rep, adult] = await Promise.all([createUser(`${label}-rep`), createUser(`${label}-adult`)]);
  await grantFamilyPlan(srAdmin, rep.id);
  const created = await createFamilyAs(rep, label);
  if (!created.ok || !created.familyId) throw new Error(`create_family_group ${label}: ${created.message}`);
  const { data: invite, error: inviteError } = await asUser(rep.jwt).rpc('create_family_invite', {
    p_family_id: created.familyId,
    p_email: adult.email,
  });
  if (inviteError || !invite) throw new Error(`create_family_invite ${label}: ${inviteError?.message}`);
  const { error: joinError } = await asUser(adult.jwt).rpc('accept_family_invite', { p_token: (invite as { token: string }).token });
  if (joinError) throw new Error(`accept_family_invite ${label}: ${joinError.message}`);
  return { rep, adult, familyId: created.familyId };
}

async function proposeTransfer(rep: TestUser, familyId: string, toUserId: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('propose_family_representative_transfer', {
    p_family_id: familyId,
    p_to_user_id: toUserId,
  });
  if (error || !data) throw new Error(`propose_family_representative_transfer: ${error?.message}`);
  return data as string;
}

async function acceptTransfer(user: TestUser, proposalId: string): Promise<Outcome> {
  const { error } = await asUser(user.jwt).rpc('accept_family_representative_transfer', { p_proposal_id: proposalId });
  return toOutcome(error);
}

async function forceTransfer(familyId: string, newRepId: string): Promise<Outcome> {
  const { error } = await asUser(operator.jwt).rpc('operator_force_representative_transfer', {
    p_family_id: familyId,
    p_new_rep_id: newRepId,
    p_reason: 'deletion-family-rep test',
  });
  return toOutcome(error);
}

interface FamilyState {
  representative_id: string | null;
  status: string;
}

async function familyState(familyId: string): Promise<FamilyState | null> {
  const { data, error } = await srAdmin.from('family_groups').select('representative_id, status').eq('id', familyId).maybeSingle();
  if (error) throw new Error(`family_groups: ${error.message}`);
  return data as FamilyState | null;
}

async function roleOf(familyId: string, userId: string): Promise<string | null> {
  const { data, error } = await srAdmin
    .from('family_members')
    .select('role')
    .eq('family_id', familyId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(`family_members: ${error.message}`);
  return (data as { role: string } | null)?.role ?? null;
}

async function proposalStatus(proposalId: string): Promise<string> {
  const rows = await pgQuery<{ status: string }>(`SELECT status FROM public.ownership_transfer_proposals WHERE id = '${proposalId}'::uuid`);
  return rows[0]?.status ?? 'missing';
}

async function representedFamilyIds(userId: string): Promise<string[]> {
  const { data, error } = await srAdmin.from('family_groups').select('id').eq('representative_id', userId);
  if (error) throw new Error(`family_groups: ${error.message}`);
  return (data ?? []).map((row) => (row as { id: string }).id);
}

async function auditCount(familyId: string, action: string): Promise<number> {
  const rows = await pgQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.membership_audit WHERE scope_id = '${familyId}'::uuid AND action = '${action}'`,
  );
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------
// 先の処理をコミット前のまま開いておく接続 (tests/integration/helpers/lock-holder.ts。後から呼んだ処理が advisory lock の待ちに
// 並んだのを確かめてから放す。決まった秒数の窓で「並んだはず」と仮定しない。#1917)
// ---------------------------------------------------------------------------------------------

const holders = createLockHolderKit({ pgRequest, markerPrefix: 'deletion-family-rep' });

/** advisory lock の待ち (pg_stat_activity の wait_event)。印と代表者の変更が同じキーで直列になっていることを、待ちそのもので確かめる */
const ADVISORY_WAIT_EVENT = 'advisory';

/** 別の接続で、actorId になりすまして (null なら postgres のまま) statement を実行し、コミット前のまま開いておく */
function startHolder(actorId: string | null, label: string, statement: string): Holder {
  const impersonate = actorId === null ? '' : actAsAuthenticatedSql(actorId);
  return holders.startHolder(label, `${impersonate}
    ${statement};`);
}

// テストが途中で落ちたときに残った接続を、作った順に放す (通ったテストでは全部放し終わっているので何もしない)
afterEach(() => holders.releaseOpenHolders(), CLEANUP_TIMEOUT_MS);

async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += CLEANUP_BATCH_SIZE) {
    await Promise.allSettled(items.slice(i, i + CLEANUP_BATCH_SIZE).map(run));
  }
}

beforeAll(async () => {
  operator = await createUser('operator', ['super_admin']);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await holders.settle();
  // pg/query の接続が作った家族も拾う (代表者で探す)
  if (createdUserIds.length > 0) {
    const { data } = await srAdmin.from('family_groups').select('id').in('representative_id', createdUserIds);
    for (const row of data ?? []) createdFamilyIds.push((row as { id: string }).id);
  }
  // family_groups.representative_id は ON DELETE RESTRICT なので、利用者より先に家族を消す (メンバー・招待などは CASCADE)
  await inBatches([...new Set(createdFamilyIds)], async (id) => {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('family_groups').delete().eq('id', id);
  });
  await inBatches(createdUserIds, async (id) => {
    await srAdmin.auth.admin.deleteUser(id);
  });
}, CLEANUP_TIMEOUT_MS);

describe('退会の印のある人を家族の代表者にしない (トリガー family_groups_representative_not_deleting)', () => {
  it('FR-1: 家族の作成 — 印のある本人は REPRESENTATIVE_ACCOUNT_DELETING で作れず、何も書かれない。印の無い人は従来どおり作れる', async () => {
    const [deleting, other] = await Promise.all([createUser('fr1-deleting'), createUser('fr1-other')]);
    await Promise.all([grantFamilyPlan(srAdmin, deleting.id), grantFamilyPlan(srAdmin, other.id)]);
    expect((await beginGuard(deleting.id)).ok).toBe(true);

    const refused = await createFamilyAs(deleting, 'fr1-deleting');
    expectRaised(refused, RAISE_CODE);
    expect(await representedFamilyIds(deleting.id)).toEqual([]);
    const { data: profile } = await srAdmin.from('user_profiles').select('family_id').eq('id', deleting.id).single();
    expect((profile as { family_id: string | null }).family_id).toBeNull();

    const created = await createFamilyAs(other, 'fr1-other');
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(await representedFamilyIds(other.id)).toEqual([created.familyId]);
  }, TEST_TIMEOUT_MS);

  it('FR-2: 譲渡の承諾 — 印のある承諾者は REPRESENTATIVE_ACCOUNT_DELETING。提案は pending のまま、代表者・役割は変わらない', async () => {
    const { rep, adult, familyId } = await buildFamily('fr2');
    const proposalId = await proposeTransfer(rep, familyId, adult.id);
    expect((await beginGuard(adult.id)).ok).toBe(true);

    expectRaised(await acceptTransfer(adult, proposalId), RAISE_CODE);
    expect(await proposalStatus(proposalId)).toBe('pending');
    expect(await familyState(familyId)).toEqual({ representative_id: rep.id, status: 'active' });
    expect(await roleOf(familyId, rep.id)).toBe('representative');
    expect(await roleOf(familyId, adult.id)).toBe('adult');
    expect(await auditCount(familyId, 'representative_transferred')).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('FR-3: 運営の強制譲渡 — 印のある譲渡先は REPRESENTATIVE_ACCOUNT_DELETING。代表者・役割・監査は変わらない', async () => {
    const { rep, adult, familyId } = await buildFamily('fr3');
    expect((await beginGuard(adult.id)).ok).toBe(true);

    expectRaised(await forceTransfer(familyId, adult.id), RAISE_CODE);
    expect(await familyState(familyId)).toEqual({ representative_id: rep.id, status: 'active' });
    expect(await roleOf(familyId, rep.id)).toBe('representative');
    expect(await roleOf(familyId, adult.id)).toBe('adult');
    expect(await auditCount(familyId, 'operator_force_representative_transfer')).toBe(0);
  }, TEST_TIMEOUT_MS);

  it(`FR-4: 効く長さ (${GUARD_WINDOW_MINUTES} 分) の内側の印は止め、外側の古い印 (途中で止まった退会の残り) は止めない (作成・承諾・強制譲渡)`, async () => {
    const creator = await createUser('fr4-creator');
    await grantFamilyPlan(srAdmin, creator.id);
    expect((await beginGuard(creator.id)).ok).toBe(true);
    await ageGuard(creator.id, FRESH_GUARD_AGE_MINUTES);
    expectRaised(await createFamilyAs(creator, 'fr4-fresh'), RAISE_CODE);
    await ageGuard(creator.id, STALE_GUARD_AGE_MINUTES);
    const created = await createFamilyAs(creator, 'fr4-stale');
    expect(created.ok, JSON.stringify(created)).toBe(true);

    const accepted = await buildFamily('fr4-accept');
    const proposalId = await proposeTransfer(accepted.rep, accepted.familyId, accepted.adult.id);
    expect((await beginGuard(accepted.adult.id)).ok).toBe(true);
    await ageGuard(accepted.adult.id, FRESH_GUARD_AGE_MINUTES);
    expectRaised(await acceptTransfer(accepted.adult, proposalId), RAISE_CODE);
    await ageGuard(accepted.adult.id, STALE_GUARD_AGE_MINUTES);
    const acceptOutcome = await acceptTransfer(accepted.adult, proposalId);
    expect(acceptOutcome.ok, JSON.stringify(acceptOutcome)).toBe(true);
    expect((await familyState(accepted.familyId))?.representative_id).toBe(accepted.adult.id);

    const forced = await buildFamily('fr4-force');
    expect((await beginGuard(forced.adult.id)).ok).toBe(true);
    await ageGuard(forced.adult.id, FRESH_GUARD_AGE_MINUTES);
    expectRaised(await forceTransfer(forced.familyId, forced.adult.id), RAISE_CODE);
    await ageGuard(forced.adult.id, STALE_GUARD_AGE_MINUTES);
    const forceOutcome = await forceTransfer(forced.familyId, forced.adult.id);
    expect(forceOutcome.ok, JSON.stringify(forceOutcome)).toBe(true);
    expect((await familyState(forced.familyId))?.representative_id).toBe(forced.adult.id);
  }, TEST_TIMEOUT_MS);

  it('FR-5: 印の無い人への代表者の変更は今どおり通る (承諾・強制譲渡)。ほかの人の印は関係しない', async () => {
    const bystander = await createUser('fr5-bystander');
    expect((await beginGuard(bystander.id)).ok).toBe(true);

    const accepted = await buildFamily('fr5-accept');
    const proposalId = await proposeTransfer(accepted.rep, accepted.familyId, accepted.adult.id);
    const acceptOutcome = await acceptTransfer(accepted.adult, proposalId);
    expect(acceptOutcome.ok, JSON.stringify(acceptOutcome)).toBe(true);
    expect(await proposalStatus(proposalId)).toBe('accepted');
    expect((await familyState(accepted.familyId))?.representative_id).toBe(accepted.adult.id);
    expect(await roleOf(accepted.familyId, accepted.adult.id)).toBe('representative');
    expect(await roleOf(accepted.familyId, accepted.rep.id)).toBe('adult');

    const forced = await buildFamily('fr5-force');
    const forceOutcome = await forceTransfer(forced.familyId, forced.adult.id);
    expect(forceOutcome.ok, JSON.stringify(forceOutcome)).toBe(true);
    expect((await familyState(forced.familyId))?.representative_id).toBe(forced.adult.id);
    expect(await auditCount(forced.familyId, 'operator_force_representative_transfer')).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('FR-6: 退会の途中の代表者から、印の無い人への強制譲渡と、代表者自身の解散 (representative_id を NULL にする) は止めない', async () => {
    const forced = await buildFamily('fr6-force');
    expect((await beginGuard(forced.rep.id)).ok).toBe(true);
    const forceOutcome = await forceTransfer(forced.familyId, forced.adult.id);
    expect(forceOutcome.ok, JSON.stringify(forceOutcome)).toBe(true);
    expect((await familyState(forced.familyId))?.representative_id).toBe(forced.adult.id);

    // 退会が 409 (代表者) で止まった人が、家族を解散する (#1917 の「解散してから退会する」の流れ)。409 の印は返す前に消える
    // (20261024120000) ので、新しい印 (同じ人の別の退会が走っている間など) があっても解散を止めないことは、印を付け直して確かめる
    const dissolving = await buildFamily('fr6-dissolve');
    const blocked = await deleteAccount({ userId: dissolving.rep.id, admin: srAdmin, requestId: `req_fr6_${TS}` });
    expect(blocked).toMatchObject({ ok: false, status: HTTP_CONFLICT, error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE' });
    expect((await beginGuard(dissolving.rep.id)).ok).toBe(true);
    const { error: dissolveError } = await asUser(dissolving.rep.jwt).rpc('dissolve_family_by_representative', {
      p_family_id: dissolving.familyId,
    });
    expect(dissolveError).toBeNull();
    expect(await familyState(dissolving.familyId)).toEqual({ representative_id: null, status: 'dissolved' });
  }, TEST_TIMEOUT_MS);

  it('FR-7: ログインユーザーが自分の家族の行を直接 UPDATE して、退会の途中の人を代表者にしようとしても、先に特権列のガードが 42501 で止める (印の有無を探れない)', async () => {
    const { rep, adult, familyId } = await buildFamily('fr7');
    expect((await beginGuard(adult.id)).ok).toBe(true);

    const { error } = await asUser(rep.jwt).from('family_groups').update({ representative_id: adult.id }).eq('id', familyId);
    expect(error?.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(error?.message ?? '').toContain(PRIVILEGED_COLUMN_CODE);
    expect(error?.message ?? '').not.toContain(RAISE_CODE);
    expect((await familyState(familyId))?.representative_id).toBe(rep.id);
  }, TEST_TIMEOUT_MS);

  it('FR-8: トリガー関数は anon・authenticated・service_role のどれにも EXECUTE が無い', async () => {
    const rows = await pgQuery<{ role: string; allowed: boolean }>(`
      SELECT r AS role, has_function_privilege(r, 'public.${TRIGGER_FN}()', 'EXECUTE') AS allowed
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r`);
    expect(rows).toEqual([
      { role: 'anon', allowed: false },
      { role: 'authenticated', allowed: false },
      { role: 'service_role', allowed: false },
    ]);
  }, TEST_TIMEOUT_MS);
});

describe('印と代表者の変更が同時に走ったとき (advisory lock で直列になる)', () => {
  it('FR-9: 印をコミット前のまま開いている間に譲渡を承諾すると、承諾は印の commit を待ってから REPRESENTATIVE_ACCOUNT_DELETING', async () => {
    const { rep, adult, familyId } = await buildFamily('fr9');
    const proposalId = await proposeTransfer(rep, familyId, adult.id);

    const holder = startHolder(null, 'guard-first', `SELECT public.begin_account_deletion_guard('${adult.id}'::uuid)`);
    // 承諾 (家族の行の UPDATE のトリガー) は印の advisory lock を待つ (待ちに入ったのを確かめてから印を放す)
    const [held, accepted] = await holders.runBehindHolder(holder, {
      fn: 'accept_family_representative_transfer',
      waitEvent: ADVISORY_WAIT_EVENT,
      call: () => acceptTransfer(adult, proposalId),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(accepted, RAISE_CODE);
    expect(await proposalStatus(proposalId)).toBe('pending');
    expect((await familyState(familyId))?.representative_id).toBe(rep.id);
  }, TEST_TIMEOUT_MS);

  it('FR-10: 譲渡の承諾をコミット前のまま開いている間に印を付けると、印は承諾の commit を待ち、そのあとの findBlocker (退会の本体) が新しい代表者の家族を読んで 409', async () => {
    const { rep, adult, familyId } = await buildFamily('fr10');
    const proposalId = await proposeTransfer(rep, familyId, adult.id);

    const holder = startHolder(adult.id, 'accept-first', `SELECT * FROM public.accept_family_representative_transfer('${proposalId}'::uuid)`);
    // 印は承諾のトリガーが持つ advisory lock を待つ (待ちに入ったのを確かめてから承諾を放す)
    const [held, guarded] = await holders.runBehindHolder(holder, {
      fn: 'begin_account_deletion_guard',
      waitEvent: ADVISORY_WAIT_EVENT,
      call: () => beginGuard(adult.id),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(guarded.ok, JSON.stringify(guarded)).toBe(true);
    expect((await familyState(familyId))?.representative_id).toBe(adult.id);

    // 退会の本体は、印のあとの findBlocker で新しい代表者の家族を読んで 409 にする (取り消せない段へ進まない)
    const result = await deleteAccount({ userId: adult.id, admin: srAdmin, requestId: `req_fr10_${TS}` });
    expect(result).toMatchObject({
      ok: false,
      status: HTTP_CONFLICT,
      error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
      family_group: { id: familyId },
    });
  }, TEST_TIMEOUT_MS);
});

describe('退会の本体の途中に代表者にしようとしたとき', () => {
  it('FR-11: findBlocker のあと (段階 billing の間) の運営の強制譲渡は止まり、退会は最後まで済む (修正前は譲渡が通り、deleteUser が RESTRICT で失敗した)', async () => {
    const { rep, adult, familyId } = await buildFamily('fr11');
    const midDeletion: Outcome[] = [];
    const emptyReport: AccountDeletionBillingReport = { cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' };
    // 段階 billing は findBlocker のあと・取り消せない段の前に呼ばれる。ここで、退会の途中の人を運営が代表者にしようとする
    const billing: AccountDeletionBilling = {
      async cancelForAccountDeletion(_userId, _log, phase) {
        if (phase === 'billing') midDeletion.push(await forceTransfer(familyId, adult.id));
        return emptyReport;
      },
    };

    const result = await deleteAccount({ userId: adult.id, admin: srAdmin, requestId: `req_fr11_${TS}`, billing });

    expect(midDeletion).toHaveLength(1);
    expectRaised(midDeletion[0], RAISE_CODE);
    expect(result, JSON.stringify(result)).toEqual({ ok: true });
    const { data } = await srAdmin.auth.admin.getUserById(adult.id);
    expect(data.user).toBeNull();
    expect((await familyState(familyId))?.representative_id).toBe(rep.id);
  }, TEST_TIMEOUT_MS);
});
