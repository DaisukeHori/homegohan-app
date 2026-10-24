/**
 * #1917 の続き: 退会が取り消せない段 (auth.admin.deleteUser) の前に止まったら、その場で退会の印 (account_deletion_guards) を消す
 * (supabase/migrations/20261024120000_account_deletion_guard_release.sql・src/lib/account-deletion.ts の deleteAccount) の回帰テスト (実 DB)。
 *
 * 修正前: 退会が findBlocker の 409 (組織のオーナー・家族の代表者) や途中の失敗で止まっても、印は 15 分 (c_guard_window) 効き続け、
 *   その間、本人の家族の作成・代表者の譲渡の承諾は REPRESENTATIVE_ACCOUNT_DELETING で、運営のその人をオーナーにした組織の作成は
 *   OWNER_ACCOUNT_DELETING で断られた (本人は退会が止まったと理解しているので文が合わなかった)。
 * 修正後:
 *   - deleteAccount は deleteUser を呼ぶ前に止まったら (409・どの段の失敗でも)、返す前に end_account_deletion_guard で印を消す。
 *   - deleteUser を呼んだあとに止まったときは消さない (トリガーが止め続ける)。
 *   - end_account_deletion_guard は印を付けるときと同じキーの advisory lock を取ってから消す。EXECUTE は service_role だけ。
 *
 * 呼び出しは本物の経路 (PostgREST)。先の処理をコミット前のまま開いておくのは、ローカルスタックの postgres-meta
 * (/pg/query、service_role キーが必要) を使う (account-deletion-family-rep-guard.test.ts と同じ道具)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/account-deletion-guard-release.test.ts
 * 本番には接続しない。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import ws from 'ws';
import {
  deleteAccount,
  type AccountDeletionAdmin,
  type AccountDeletionBilling,
  type AccountDeletionBillingReport,
} from '@/lib/account-deletion';
import { createLockHolderKit, type Holder } from '../helpers/lock-holder';
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
const HTTP_INTERNAL_SERVER_ERROR = 500;

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
const TEST_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 240_000;
/** 後片付けを並列に流す件数 */
const CLEANUP_BATCH_SIZE = 10;
/** 権限が無いときの SQLSTATE */
const PG_INSUFFICIENT_PRIVILEGE = '42501';
const PG_RAISE_EXCEPTION = 'P0001';
const REPRESENTATIVE_DELETING = 'REPRESENTATIVE_ACCOUNT_DELETING';
const OWNER_DELETING = 'OWNER_ACCOUNT_DELETING';
const END_GUARD_FN = 'end_account_deletion_guard';

const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
const createdOrgIds: string[] = [];

/** 運営 (super_admin)。operator_force_representative_transfer はこのロールの人だけが実行できる */
let operator: TestUser;

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-deletion-guard-release-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      {
        id: data.user.id,
        nickname: `deletion-guard-release-${label}`,
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

function expectOk(outcome: Outcome): void {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
}

/** 退会の本体と同じく service_role で印を付ける */
async function beginGuard(userId: string): Promise<Outcome> {
  const { error } = await srAdmin.rpc('begin_account_deletion_guard', { p_user_id: userId });
  return toOutcome(error);
}

async function guardRows(userId: string): Promise<Array<{ user_id: string }>> {
  return pgQuery(`SELECT user_id::text FROM public.account_deletion_guards WHERE user_id = '${userId}'::uuid`);
}

/** 本人が家族を作る (家族プランの契約は呼ぶ前に入れておく)。作れたら id を後片付けに積む */
async function createFamilyAs(user: TestUser, label: string): Promise<Outcome & { familyId: string | null }> {
  const { data, error } = await asUser(user.jwt).rpc('create_family_group', { p_name: `deletion-guard-release ${label} ${TS}` });
  const familyId = data ? (data as { id: string }).id : null;
  if (familyId) createdFamilyIds.push(familyId);
  return { ...toOutcome(error), familyId };
}

/** 運営の作成 API と同じく service_role で組織の行を INSERT する (トリガーはどの経路の INSERT にも効く)。作れたら id を後片付けに積む */
async function insertOrg(ownerId: string, label: string): Promise<Outcome & { orgId: string | null }> {
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({ name: `deletion-guard-release ${label} ${TS}`, owner_id: ownerId })
    .select('id')
    .single();
  const orgId = data ? (data as { id: string }).id : null;
  if (orgId) createdOrgIds.push(orgId);
  return { ...toOutcome(error), orgId };
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
    p_reason: 'deletion-guard-release test',
  });
  return toOutcome(error);
}

async function representativeOf(familyId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('family_groups').select('representative_id').eq('id', familyId).maybeSingle();
  if (error) throw new Error(`family_groups: ${error.message}`);
  return (data as { representative_id: string | null } | null)?.representative_id ?? null;
}

const EMPTY_BILLING_REPORT: AccountDeletionBillingReport = { cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' };

/** Stripe に繋がない段階 billing / billing_recheck (failAt の段階だけ投げる) */
function fakeBilling(failAt?: 'billing' | 'billing_recheck'): AccountDeletionBilling {
  return {
    async cancelForAccountDeletion(_userId, _log, phase) {
      if (phase === failAt) throw new Error(`simulated ${phase} failure`);
      return EMPTY_BILLING_REPORT;
    },
  };
}

/**
 * service_role の client のうち、auth.admin.deleteUser だけが「呼ばれたが失敗した」を返すもの (アカウントは消さない)。
 * deleteUser を呼んだあとに止まった退会 (取り消せない段のあと) を作るため。
 * ほかのプロパティは元のオブジェクトから読み、関数は元のオブジェクトに bind する (getter・メソッドの this をプロキシにしない)
 */
function adminWithFailingDeleteUser(base: SupabaseClient): AccountDeletionAdmin {
  const adminApi = new Proxy(base.auth.admin, {
    get(target, property) {
      if (property === 'deleteUser') {
        return async () => ({
          data: { user: null },
          error: { name: 'AuthApiError', message: 'simulated deleteUser failure', status: HTTP_INTERNAL_SERVER_ERROR, code: 'unexpected_failure' },
        });
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const auth = new Proxy(base.auth, {
    get(target, property) {
      if (property === 'admin') return adminApi;
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(base, {
    get(target, property) {
      if (property === 'auth') return auth;
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// 先の処理をコミット前のまま開いておく接続 (tests/integration/helpers/lock-holder.ts。後から呼んだ処理が advisory lock の待ちに
// 並んだのを確かめてから放す。決まった秒数の窓で「並んだはず」と仮定しない)
// ---------------------------------------------------------------------------------------------

const holders = createLockHolderKit({ pgRequest, markerPrefix: 'deletion-guard-release' });

/** advisory lock の待ち (pg_stat_activity の wait_event) */
const ADVISORY_WAIT_EVENT = 'advisory';

function startHolder(label: string, statement: string): Holder {
  return holders.startHolder(label, `${statement};`);
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
  if (createdUserIds.length > 0) {
    // pg/query の接続が作った家族・組織も拾う (代表者・オーナーで探す)
    const { data: families } = await srAdmin.from('family_groups').select('id').in('representative_id', createdUserIds);
    for (const row of families ?? []) createdFamilyIds.push((row as { id: string }).id);
    const { data: orgs } = await srAdmin.from('organizations').select('id').in('owner_id', createdUserIds);
    for (const row of orgs ?? []) createdOrgIds.push((row as { id: string }).id);
  }
  // family_groups.representative_id・organizations.owner_id は ON DELETE RESTRICT なので、利用者より先に消す
  await inBatches([...new Set(createdFamilyIds)], async (id) => {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('family_groups').delete().eq('id', id);
  });
  await inBatches([...new Set(createdOrgIds)], async (id) => {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('org_license_pools').delete().eq('organization_id', id);
    await srAdmin.from('organizations').delete().eq('id', id);
  });
  await inBatches(createdUserIds, async (id) => {
    await srAdmin.auth.admin.deleteUser(id);
  });
}, CLEANUP_TIMEOUT_MS);

describe(`退会の印を消す関数 (${END_GUARD_FN})`, () => {
  it('GR-1: anon・authenticated からは呼べない (42501・印は残る)。service_role は呼べて、印を消す。印の無い人・auth.users に居ない人にはエラーにせず何もしない', async () => {
    const user = await createUser('gr1');
    expectOk(await beginGuard(user.id));

    const asAnon = await anon().rpc(END_GUARD_FN, { p_user_id: user.id });
    expect(asAnon.error?.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    const asSelf = await asUser(user.jwt).rpc(END_GUARD_FN, { p_user_id: user.id });
    expect(asSelf.error?.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(await guardRows(user.id)).toHaveLength(1);

    const asService = await srAdmin.rpc(END_GUARD_FN, { p_user_id: user.id });
    expect(asService.error).toBeNull();
    expect(await guardRows(user.id)).toEqual([]);

    // 2 回目 (印が無い) と、居ない人
    expect((await srAdmin.rpc(END_GUARD_FN, { p_user_id: user.id })).error).toBeNull();
    expect((await srAdmin.rpc(END_GUARD_FN, { p_user_id: randomUUID() })).error).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('GR-2: ほかの人の印は消さない', async () => {
    const [mine, other] = await Promise.all([createUser('gr2-mine'), createUser('gr2-other')]);
    expectOk(await beginGuard(mine.id));
    expectOk(await beginGuard(other.id));

    expect((await srAdmin.rpc(END_GUARD_FN, { p_user_id: mine.id })).error).toBeNull();
    expect(await guardRows(mine.id)).toEqual([]);
    expect(await guardRows(other.id)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);
});

describe('退会が 409 で止まった直後は、印で止めない (修正前は 15 分 *_ACCOUNT_DELETING で断られた)', () => {
  it('GR-3: 組織のオーナーの退会が 409 で止まった直後に、本人が家族を作れる', async () => {
    const user = await createUser('gr3');
    expectOk(await insertOrg(user.id, 'gr3-owned'));
    await grantFamilyPlan(srAdmin, user.id);

    const blocked = await deleteAccount({ userId: user.id, admin: srAdmin, requestId: `req_gr3_${TS}` });
    expect(blocked).toMatchObject({ ok: false, status: HTTP_CONFLICT, error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER' });
    expect(await guardRows(user.id)).toEqual([]);

    const created = await createFamilyAs(user, 'gr3');
    expectOk(created);
    expect(await representativeOf(created.familyId!)).toBe(user.id);
  }, TEST_TIMEOUT_MS);

  it('GR-4: 組織のオーナーの退会が 409 で止まった直後に、本人が家族の代表者の譲渡を承諾できる', async () => {
    const { rep, adult, familyId } = await buildFamily('gr4');
    expectOk(await insertOrg(adult.id, 'gr4-owned'));

    const blocked = await deleteAccount({ userId: adult.id, admin: srAdmin, requestId: `req_gr4_${TS}` });
    expect(blocked).toMatchObject({ ok: false, status: HTTP_CONFLICT, error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER' });
    expect(await guardRows(adult.id)).toEqual([]);

    const proposalId = await proposeTransfer(rep, familyId, adult.id);
    expectOk(await acceptTransfer(adult, proposalId));
    expect(await representativeOf(familyId)).toBe(adult.id);
  }, TEST_TIMEOUT_MS);

  it('GR-5: 家族の代表者の退会が 409 で止まった直後に、運営がその人をオーナーにして組織を作れる', async () => {
    const { rep } = await buildFamily('gr5');

    const blocked = await deleteAccount({ userId: rep.id, admin: srAdmin, requestId: `req_gr5_${TS}` });
    expect(blocked).toMatchObject({ ok: false, status: HTTP_CONFLICT, error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE' });
    expect(await guardRows(rep.id)).toEqual([]);

    expectOk(await insertOrg(rep.id, 'gr5'));
  }, TEST_TIMEOUT_MS);

  it('GR-6: 組織のオーナーの退会が 409 で止まった直後に、運営がその人へ家族の代表者を強制譲渡できる', async () => {
    const { adult, familyId } = await buildFamily('gr6');
    expectOk(await insertOrg(adult.id, 'gr6-owned'));

    const blocked = await deleteAccount({ userId: adult.id, admin: srAdmin, requestId: `req_gr6_${TS}` });
    expect(blocked).toMatchObject({ ok: false, status: HTTP_CONFLICT, error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER' });
    expect(await guardRows(adult.id)).toEqual([]);

    expectOk(await forceTransfer(familyId, adult.id));
    expect(await representativeOf(familyId)).toBe(adult.id);
  }, TEST_TIMEOUT_MS);
});

describe('退会が途中の失敗で止まったとき', () => {
  it('GR-7: deleteUser の前の段 (記録を伏せる・所属を外す・ファイルを消す・記録を始めるのあとの billing_recheck) で止まっても印を消す。アカウントは残り、本人は家族を作れる', async () => {
    const user = await createUser('gr7');
    await grantFamilyPlan(srAdmin, user.id);

    const failed = await deleteAccount({ userId: user.id, admin: srAdmin, requestId: `req_gr7_${TS}`, billing: fakeBilling('billing_recheck') });
    expect(failed).toMatchObject({ ok: false, status: HTTP_INTERNAL_SERVER_ERROR, error: 'ACCOUNT_DELETE_FAILED', step: 'billing_recheck' });
    expect(await guardRows(user.id)).toEqual([]);
    const { data } = await srAdmin.auth.admin.getUserById(user.id);
    expect(data.user?.id).toBe(user.id);

    expectOk(await createFamilyAs(user, 'gr7'));
  }, TEST_TIMEOUT_MS);

  it('GR-8: deleteUser を呼んだあとに止まったら (取り消せない段のあと) 印を消さない。家族の作成・組織の作成は止め続ける', async () => {
    const user = await createUser('gr8');
    await grantFamilyPlan(srAdmin, user.id);

    const failed = await deleteAccount({
      userId: user.id,
      admin: adminWithFailingDeleteUser(srAdmin),
      requestId: `req_gr8_${TS}`,
      billing: fakeBilling(),
    });
    expect(failed).toMatchObject({ ok: false, status: HTTP_INTERNAL_SERVER_ERROR, error: 'ACCOUNT_DELETE_FAILED', step: 'delete_user' });
    expect(await guardRows(user.id)).toHaveLength(1);

    expectRaised(await createFamilyAs(user, 'gr8'), REPRESENTATIVE_DELETING);
    expectRaised(await insertOrg(user.id, 'gr8'), OWNER_DELETING);
  }, TEST_TIMEOUT_MS);
});

describe('印を消すのと家族の作成が同時に走ったとき (advisory lock で直列になる)', () => {
  it('GR-9: 印を消すのをコミット前のまま開いている間に本人が家族を作ると、作成は消した commit を待ってから印を読み、通る', async () => {
    const user = await createUser('gr9');
    await grantFamilyPlan(srAdmin, user.id);
    expectOk(await beginGuard(user.id));

    const holder = startHolder('end-first', `SELECT public.${END_GUARD_FN}('${user.id}'::uuid)`);
    // 作成 (family_groups の INSERT のトリガー) は印の advisory lock を待つ (待ちに入ったのを確かめてから放す)。
    // 消す関数が lock を取らなければ、作成は commit 前の印を読んで REPRESENTATIVE_ACCOUNT_DELETING で止まる
    const [held, created] = await holders.runBehindHolder(holder, {
      fn: 'create_family_group',
      waitEvent: ADVISORY_WAIT_EVENT,
      call: () => createFamilyAs(user, 'gr9'),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectOk(created);
    expect(await guardRows(user.id)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
