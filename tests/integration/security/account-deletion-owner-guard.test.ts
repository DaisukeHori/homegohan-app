/**
 * #1917 の続き (D73): 退会の途中 (findBlocker のあと〜deleteUser の前) に、運営がその人をオーナーにして組織を作ると、
 * 退会の最後の deleteUser が organizations_owner_id_fkey (ON DELETE RESTRICT) で失敗する既存の欠陥の回帰テスト (実 DB)。
 *
 * 修正前: 運営の作成 (POST /api/admin/organizations) は user_profiles.organization_id が空かだけを見て INSERT した。
 *   退会の途中の人 (所属が無い人・release_user_membership が所属を外した人) は空なので、オーナーになれた。
 * 修正後 (supabase/migrations/20261023130000_account_deletion_owner_guard.sql):
 *   - 退会の本体は findBlocker の前に退会の印 (begin_account_deletion_guard → account_deletion_guards) を付ける。
 *   - organizations の BEFORE INSERT のトリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting()) は、owner_id の人に新しい印があれば
 *     OWNER_ACCOUNT_DELETING (P0001) で止める。運営の作成 API はそれを 409 OWNER_ACCOUNT_DELETING にする。
 *   - 印と作成は、その人の id の advisory lock で直列になる (印が先なら作成が止まり、作成が先なら印は作成の commit を待ち、
 *     そのあとの findBlocker が作られた組織を読んで 409 にする)。
 *
 * 呼び出しは本物の経路 (PostgREST・Next の route)。先の処理をコミット前のまま開いておくのは、ローカルスタックの postgres-meta
 * (/pg/query、service_role キーが必要) を使う (org-transfer-toctou-release-membership.test.ts と同じ道具)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と next dev (運営の作成 API の GD-10)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/account-deletion-owner-guard.test.ts
 * 本番には接続しない。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import ws from 'ws';
import { deleteAccount } from '@/lib/account-deletion';
import { apiCall } from '../helpers/api';
import { createLockHolderKit, type Holder } from '../helpers/lock-holder';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { createTestUserWithRoles, cleanupAuditLogs, testEmail, type TestUser as OperatorUser } from '../helpers/users';

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
const HTTP_OK = 200;
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
const CLEANUP_TIMEOUT_MS = 240_000;
/** 権限が無いときの SQLSTATE */
const PG_INSUFFICIENT_PRIVILEGE = '42501';
const RAISE_CODE = 'OWNER_ACCOUNT_DELETING';

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const operatorUsers: OperatorUser[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-deletion-owner-guard-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert(
      { id: data.user.id, nickname: `deletion-owner-guard-${label}`, age_group: '30s', gender: 'other', birth_date: ADULT_BIRTH_DATE },
      { onConflict: 'id' },
    ));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signInClient = anon();
  const { data: session, error: signInError } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError || !session.session) throw new Error(`signIn ${label}: ${signInError?.message}`);
  return { id: data.user.id, email, jwt: session.session.access_token };
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

function expectRaised(outcome: Outcome, code: string): void {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
  expect(outcome.code).toBe('P0001');
  expect(outcome.message).toBe(code);
}

/** 退会の本体 (src/lib/account-deletion.ts) と同じく service_role で印を付ける */
async function beginGuard(userId: string): Promise<Outcome> {
  const { data, error } = await srAdmin.rpc('begin_account_deletion_guard', { p_user_id: userId });
  return toOutcome(data, error);
}

/** 運営の作成 API と同じく service_role で組織の行を INSERT する。作れたら id を後片付けに積む */
async function insertOrg(ownerId: string, label: string): Promise<Outcome> {
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({ name: `deletion-owner-guard ${label} ${TS}`, owner_id: ownerId })
    .select('id')
    .single();
  if (data) createdOrgIds.push((data as { id: string }).id);
  return toOutcome(data, error);
}

async function ownedOrgIds(ownerId: string): Promise<string[]> {
  const { data, error } = await srAdmin.from('organizations').select('id').eq('owner_id', ownerId);
  if (error) throw new Error(`organizations: ${error.message}`);
  return (data ?? []).map((row) => (row as { id: string }).id);
}

async function guardRows(userId: string): Promise<Array<{ user_id: string; started_at: string }>> {
  return pgQuery(`SELECT user_id::text, started_at::text FROM public.account_deletion_guards WHERE user_id = '${userId}'::uuid`);
}

/** 印の日時を minutes 分前にする (古い印・効く長さの内側の印を作る) */
async function ageGuard(userId: string, minutes: number): Promise<void> {
  await pgQuery(
    `UPDATE public.account_deletion_guards SET started_at = now() - make_interval(mins => ${minutes}) WHERE user_id = '${userId}'::uuid`,
  );
}

// ---------------------------------------------------------------------------------------------
// 先の処理をコミット前のまま開いておく接続 (tests/integration/helpers/lock-holder.ts。後から呼んだ処理が advisory lock の待ちに
// 並んだのを確かめてから放す。決まった秒数の窓で「並んだはず」と仮定しない。#1917)
// ---------------------------------------------------------------------------------------------

const holders = createLockHolderKit({ pgRequest, markerPrefix: 'deletion-owner-guard' });

/** advisory lock の待ち (pg_stat_activity の wait_event)。印と作成が同じキーで直列になっていることを、待ちそのもので確かめる */
const ADVISORY_WAIT_EVENT = 'advisory';

/** statement を流してから、コミット前のまま開いておく */
function startHolder(label: string, statement: string): Holder {
  return holders.startHolder(label, `${statement};`);
}

// テストが途中で落ちたときに残った接続を、作った順に放す (通ったテストでは全部放し終わっているので何もしない)
afterEach(() => holders.releaseOpenHolders(), CLEANUP_TIMEOUT_MS);

afterAll(async () => {
  await holders.settle();
  // pg/query の接続が作った組織も拾う (owner_id で探す)
  if (createdUserIds.length > 0) {
    const { data } = await srAdmin.from('organizations').select('id').in('owner_id', createdUserIds);
    for (const row of data ?? []) createdOrgIds.push((row as { id: string }).id);
    await srAdmin.from('user_profiles').update({ organization_id: null, org_role: null, is_active_in_org: false }).in('id', createdUserIds);
  }
  if (createdOrgIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('scope_id', createdOrgIds);
    await srAdmin.from('org_license_pools').delete().in('organization_id', createdOrgIds);
    // organizations.owner_id は ON DELETE RESTRICT なので、利用者より先に組織を消す
    await srAdmin.from('organizations').delete().in('id', createdOrgIds);
  }
  for (const operatorUser of operatorUsers) {
    await cleanupAuditLogs(operatorUser.userId).catch(() => undefined);
    createdUserIds.push(operatorUser.userId);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, CLEANUP_TIMEOUT_MS);

describe('退会の印 (account_deletion_guards・begin_account_deletion_guard) の権限', () => {
  it('GD-1: begin_account_deletion_guard は anon・authenticated から呼べない (42501)。service_role は呼べる', async () => {
    const user = await createUser('gd1');

    const asAnon = await anon().rpc('begin_account_deletion_guard', { p_user_id: user.id });
    expect(asAnon.error?.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    const asSelf = await asUser(user.jwt).rpc('begin_account_deletion_guard', { p_user_id: user.id });
    expect(asSelf.error?.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(await guardRows(user.id)).toEqual([]);

    const asService = await beginGuard(user.id);
    expect(asService.ok, JSON.stringify(asService)).toBe(true);
    expect(await guardRows(user.id)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it('GD-2: 表 account_deletion_guards は anon・authenticated・service_role から読めも書けもしない (42501)', async () => {
    const user = await createUser('gd2');
    expect((await beginGuard(user.id)).ok).toBe(true);

    for (const [label, db] of [
      ['anon', anon()],
      ['authenticated', asUser(user.jwt)],
      ['service_role', srAdmin],
    ] as const) {
      const read = await db.from('account_deletion_guards').select('user_id');
      expect(read.error?.code, `${label} の読み取り`).toBe(PG_INSUFFICIENT_PRIVILEGE);
      const removed = await db.from('account_deletion_guards').delete().eq('user_id', user.id);
      expect(removed.error?.code, `${label} の削除`).toBe(PG_INSUFFICIENT_PRIVILEGE);
    }
    expect(await guardRows(user.id)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);
});

describe('退会の印のある人をオーナーにして組織を作らない (トリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting()))', () => {
  it('GD-3: 印のある人を owner_id にした INSERT は OWNER_ACCOUNT_DELETING (P0001) で止まり、組織は作られない。印の無い人は従来どおり作れる', async () => {
    const [deleting, other] = await Promise.all([createUser('gd3-deleting'), createUser('gd3-other')]);
    expect((await beginGuard(deleting.id)).ok).toBe(true);

    expectRaised(await insertOrg(deleting.id, 'gd3-deleting'), RAISE_CODE);
    expect(await ownedOrgIds(deleting.id)).toEqual([]);

    const created = await insertOrg(other.id, 'gd3-other');
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(await ownedOrgIds(other.id)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it(`GD-4: 効く長さ (${GUARD_WINDOW_MINUTES} 分) の内側の印は止め、外側の古い印 (途中で止まった退会の残り) は止めない`, async () => {
    const user = await createUser('gd4');
    expect((await beginGuard(user.id)).ok).toBe(true);

    await ageGuard(user.id, FRESH_GUARD_AGE_MINUTES);
    expectRaised(await insertOrg(user.id, 'gd4-fresh'), RAISE_CODE);

    await ageGuard(user.id, STALE_GUARD_AGE_MINUTES);
    const created = await insertOrg(user.id, 'gd4-stale');
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(await ownedOrgIds(user.id)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it('GD-5: 印を付け直すと日時が今になり、古くなった印がまた効く (退会のやり直し)。行は 1 人 1 行のまま', async () => {
    const user = await createUser('gd5');
    expect((await beginGuard(user.id)).ok).toBe(true);
    await ageGuard(user.id, STALE_GUARD_AGE_MINUTES);
    expect((await beginGuard(user.id)).ok).toBe(true);

    expect(await guardRows(user.id)).toHaveLength(1);
    expectRaised(await insertOrg(user.id, 'gd5'), RAISE_CODE);
  }, TEST_TIMEOUT_MS);

  it('GD-6: auth.users に居ない人 (すでに消えた人の退会のやり直し) に印を付けても失敗せず、行も作らない', async () => {
    const missing = randomUUID();
    const outcome = await beginGuard(missing);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await guardRows(missing)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('GD-7: 利用者を消すと印も消える (auth.users の CASCADE)', async () => {
    const user = await createUser('gd7');
    expect((await beginGuard(user.id)).ok).toBe(true);
    const { error } = await srAdmin.auth.admin.deleteUser(user.id);
    expect(error).toBeNull();
    expect(await guardRows(user.id)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

describe('印と作成が同時に走ったとき (advisory lock で直列になる)', () => {
  it('GD-8: 印をコミット前のまま開いている間に組織を作ると、作成は印の commit を待ってから OWNER_ACCOUNT_DELETING (修正前は作られ、退会の deleteUser が RESTRICT で失敗した)', async () => {
    const user = await createUser('gd8');

    const holder = startHolder('guard-first', `SELECT public.begin_account_deletion_guard('${user.id}'::uuid)`);
    // 作成は印の advisory lock を待つ (待ちに入ったことを確かめてから印を放し、印の commit を待たせる)
    const [held, created] = await holders.runBehindHolder(holder, {
      fn: 'organizations',
      waitEvent: ADVISORY_WAIT_EVENT,
      call: () => insertOrg(user.id, 'gd8'),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(created, RAISE_CODE);
    expect(await ownedOrgIds(user.id)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('GD-9: 組織の作成をコミット前のまま開いている間に印を付けると、印は作成の commit を待ち、そのあとの findBlocker (退会の本体) が作られた組織を読んで 409', async () => {
    const user = await createUser('gd9');

    const holder = startHolder(
      'create-first',
      `INSERT INTO public.organizations (name, owner_id) VALUES ('deletion-owner-guard gd9-holder ${TS}', '${user.id}'::uuid)`,
    );
    // 印は作成のトリガーが持つ advisory lock を待つ (待ちに入ったことを確かめてから作成を放す)
    const [held, guarded] = await holders.runBehindHolder(holder, {
      fn: 'begin_account_deletion_guard',
      waitEvent: ADVISORY_WAIT_EVENT,
      call: () => beginGuard(user.id),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expect(guarded.ok, JSON.stringify(guarded)).toBe(true);
    const owned = await ownedOrgIds(user.id);
    expect(owned).toHaveLength(1);
    createdOrgIds.push(...owned);

    // 退会の本体は、印のあとの findBlocker で作られた組織を読んで 409 にする (取り消せない段へ進まない)
    const result = await deleteAccount({ userId: user.id, admin: srAdmin, requestId: `req_gd9_${TS}` });
    expect(result).toMatchObject({ ok: false, status: HTTP_CONFLICT, error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER', organization: { id: owned[0] } });
  }, TEST_TIMEOUT_MS);
});

describe('退会の本体と運営の作成 API', () => {
  it('GD-10: 退会の本体は findBlocker の前に印を付ける (409 で止まっても印は付いている)。印のある人を owner に指定した運営の作成 API は 409 OWNER_ACCOUNT_DELETING で、組織を作らない', async () => {
    const [owner, target] = await Promise.all([createUser('gd10-owner'), createUser('gd10-target')]);
    const operatorUser = await createTestUserWithRoles({ email: testEmail(`deletion-owner-guard-gd10-admin`, TS), roles: ['user', 'admin'] });
    operatorUsers.push(operatorUser);

    // 組織のオーナーの退会は 409 で止まるが、印は findBlocker の前に付いている
    const existing = await insertOrg(owner.id, 'gd10-existing');
    expect(existing.ok, JSON.stringify(existing)).toBe(true);
    const blocked = await deleteAccount({ userId: owner.id, admin: srAdmin, requestId: `req_gd10_${TS}` });
    expect(blocked).toMatchObject({ ok: false, status: HTTP_CONFLICT, error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER' });
    expect(await guardRows(owner.id)).toHaveLength(1);

    // 所属の無い人に印を付けると (退会の途中)、運営の作成 API は 409 で断り、作らない
    expect((await beginGuard(target.id)).ok).toBe(true);
    const refused = await apiCall<{ error?: { code?: string; message?: string } }>('POST', '/api/admin/organizations', operatorUser.jwt, {
      name: `deletion-owner-guard gd10 ${TS}`,
      owner_id: target.id,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(HTTP_CONFLICT);
    expect(refused.body.error).toEqual({ code: RAISE_CODE, message: '指定した owner は退会の手続き中です' });
    expect(await ownedOrgIds(target.id)).toEqual([]);

    // 印が古くなれば (途中で止まった退会の残り) 作れる
    await ageGuard(target.id, STALE_GUARD_AGE_MINUTES);
    const created = await apiCall<{ organization?: { id: string; owner_id: string } }>('POST', '/api/admin/organizations', operatorUser.jwt, {
      name: `deletion-owner-guard gd10 stale ${TS}`,
      owner_id: target.id,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(HTTP_OK);
    expect(created.body.organization?.owner_id).toBe(target.id);
    if (created.body.organization) createdOrgIds.push(created.body.organization.id);
  }, TEST_TIMEOUT_MS);
});
