/**
 * #2107 Y4: 運営の組織の作成 (POST /api/admin/organizations) で、同じオーナーの組織が 2 つできうる既存の欠陥の回帰テスト (実 DB)。
 *
 * 修正前: route が (1) オーナーの user_profiles の所属を読む → (2) organizations の行を INSERT → (3) org_license_pools の行を INSERT →
 *   (4) オーナーの user_profiles を UPDATE を、別々の要求で行っていた。(1) と (4) の間に同じオーナーの 2 つ目の作成が (1) を通ると、
 *   組織が 2 つでき、user_profiles.organization_id は後の方を指す (先の組織は孤立する)。(4) が失敗すると 500 を返すが
 *   (2) の組織は残り、運営が押し直すと確実に 2 つ目ができた。organizations.owner_id に一意の制約は無い。
 * 修正後 (supabase/migrations/20261030150000_create_organization_atomic.sql): 作成・席の行・オーナーの所属を 1 つの関数
 *   admin_create_organization (1 つのトランザクション) で書く。新しい組織の行の INSERT のあと、オーナーの user_profiles の行を
 *   FOR NO KEY UPDATE で読んで所属を確かめ、すでに所属していれば OWNER_ALREADY_IN_ORG (P0001) で止める (組織の行の INSERT も戻る)。
 *   同じオーナーの同時の作成は、オーナーの行のロック (と、organizations の INSERT のトリガーが取るオーナーの advisory lock) で
 *   直列になり、後の方は先の方の commit を待ってから所属を読んで止まる。
 *
 * #2112 Z2 (同じ API の続き): auth.users に居ないオーナーの作成は、理由を言わない 500 ではなく 422 OWNER_NOT_FOUND (OC-9)。
 *   一覧 (GET) は行のオーナーの id を返し、組織名の検索の % と _ を文字どおりに一致させる (OC-10)。一覧は service_role で読む
 *   (organizations の SELECT のポリシーは所属している人の行だけで、運営の client では、運営が所属していない組織が一覧に出なかった)。
 *
 * 呼び出しは本物の経路 (PostgREST・Next の route)。先の作成をコミット前のまま開いておくのは、ローカルスタックの postgres-meta
 * (/pg/query、service_role キーが必要) を使う (tests/integration/helpers/lock-holder.ts)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と next dev (運営の作成 API の OC-8)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/org-create-atomic.test.ts
 * 本番には接続しない。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import ws from 'ws';
import { PROFILE_NAME_PLACEHOLDER } from '@homegohan/shared';
import { apiCall } from '../helpers/api';
import { createLockHolderKit } from '../helpers/lock-holder';
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

/** Kong → PostgREST の使い回しの接続の 502 (リクエストが PostgREST に届いていない) を数回だけやり直す (account-deletion-owner-guard.test.ts と同じ) */
const GATEWAY_RETRIES = 3;
/** 502 をやり直すまでの待ちの単位 (ミリ秒) */
const GATEWAY_RETRY_WAIT_MS = 150;
/** postgres-meta の 502 をやり直すのは、この時間 (ミリ秒) 以内に返ったときだけ (pg_sleep で待たせた後の応答ではない) */
const GATEWAY_FAST_FAIL_MS = 1500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;

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

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const ADULT_BIRTH_DATE = '1990-01-01';
const TEST_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 240_000;
/** 権限が無いときの SQLSTATE */
const PG_INSUFFICIENT_PRIVILEGE = '42501';
/** 外部キーの違反の SQLSTATE */
const PG_FOREIGN_KEY_VIOLATION = '23503';
const RPC = 'admin_create_organization';
const OWNER_ALREADY_IN_ORG = 'OWNER_ALREADY_IN_ORG';
const OWNER_ACCOUNT_DELETING = 'OWNER_ACCOUNT_DELETING';
/** 運営の作成 API が 409 OWNER_ALREADY_IN_ORG で返す文 (src/app/api/admin/organizations/route.ts。#2107 Y5) */
const OWNER_ALREADY_IN_ORG_MESSAGE =
  '指定したオーナーはすでに組織に所属しています (直前に作成した組織かもしれません。一覧で確かめてください)';
/** 運営の作成 API が 422 OWNER_NOT_FOUND で返す文 (オーナーにする人が auth.users に居ない。#2112 Z2) */
const OWNER_NOT_FOUND_MESSAGE = '指定したオーナーのユーザーが見つかりません';
/** advisory lock の待ち (pg_stat_activity の wait_event)。organizations の INSERT のトリガーがオーナーの id で取る */
const ADVISORY_WAIT_EVENT = 'advisory';
/** 同時に送る作成の数 */
const CONCURRENT_CREATES = 2;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const operatorUsers: OperatorUser[] = [];

/** auth.users の利用者を作る。withProfile が false なら user_profiles の行を作らない (初期設定より前の人) */
async function createUser(label: string, withProfile = true): Promise<TestUser> {
  const email = `sec-org-create-atomic-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  if (withProfile) {
    const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
      db.from('user_profiles').upsert(
        { id: data.user.id, nickname: `org-create-atomic-${label}`, age_group: '30s', gender: 'other', birth_date: ADULT_BIRTH_DATE },
        { onConflict: 'id' },
      ));
    if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  }
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

const orgName = (label: string) => `org-create-atomic ${label} ${TS}`;

/** 運営の作成 API と同じく service_role で関数を呼ぶ。作れたら id を後片付けに積む */
async function createOrg(ownerId: string, label: string, db: SupabaseClient = srAdmin): Promise<Outcome> {
  const { data, error } = await db.rpc(RPC, { p_name: orgName(label), p_plan: 'standard', p_owner_id: ownerId });
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id === 'string') createdOrgIds.push(id);
  return toOutcome(data, error);
}

async function ownedOrgs(ownerId: string): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await srAdmin.from('organizations').select('id, name').eq('owner_id', ownerId);
  if (error) throw new Error(`organizations: ${error.message}`);
  return (data ?? []) as Array<{ id: string; name: string }>;
}

async function orgsNamed(name: string): Promise<string[]> {
  const { data, error } = await srAdmin.from('organizations').select('id').eq('name', name);
  if (error) throw new Error(`organizations: ${error.message}`);
  return (data ?? []).map((row) => (row as { id: string }).id);
}

async function profileOf(userId: string): Promise<{ nickname: string | null; organization_id: string | null; org_role: string | null } | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('nickname, organization_id, org_role').eq('id', userId).maybeSingle();
  if (error) throw new Error(`user_profiles: ${error.message}`);
  return data as { nickname: string | null; organization_id: string | null; org_role: string | null } | null;
}

async function poolOf(orgId: string): Promise<Array<{ total_licenses: number | null; used_licenses: number }>> {
  const { data, error } = await srAdmin.from('org_license_pools').select('total_licenses, used_licenses').eq('organization_id', orgId);
  if (error) throw new Error(`org_license_pools: ${error.message}`);
  return (data ?? []) as Array<{ total_licenses: number | null; used_licenses: number }>;
}

const holders = createLockHolderKit({ pgRequest, markerPrefix: 'org-create-atomic' });

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

describe('admin_create_organization の権限と 1 回の作成', () => {
  it('OC-1: anon・authenticated からは呼べない (42501)。何も作らない', async () => {
    const owner = await createUser('oc1');

    for (const [label, db] of [
      ['anon', anon()],
      ['authenticated', asUser(owner.jwt)],
    ] as const) {
      const outcome = await createOrg(owner.id, `oc1-${label}`, db);
      expect(outcome.code, `${label}: ${JSON.stringify(outcome)}`).toBe(PG_INSUFFICIENT_PRIVILEGE);
    }
    expect(await ownedOrgs(owner.id)).toEqual([]);
    expect(await profileOf(owner.id)).toMatchObject({ organization_id: null, org_role: null });
  }, TEST_TIMEOUT_MS);

  it('OC-2: service_role の 1 回の呼び出しで、組織・席の行 (上限なし・使用 0)・オーナーの所属 (owner) を書き、作った組織を返す', async () => {
    const owner = await createUser('oc2');

    const created = await createOrg(owner.id, 'oc2');
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const org = created.data as { id: string; name: string; plan: string; owner_id: string; created_at: string; updated_at: string };
    expect(org).toMatchObject({ name: orgName('oc2'), plan: 'standard', owner_id: owner.id });
    expect(Object.keys(org).sort()).toEqual(['created_at', 'id', 'name', 'owner_id', 'plan', 'updated_at']);
    expect(Number.isNaN(Date.parse(org.created_at))).toBe(false);

    expect(await ownedOrgs(owner.id)).toEqual([{ id: org.id, name: orgName('oc2') }]);
    expect(await poolOf(org.id)).toEqual([{ total_licenses: null, used_licenses: 0 }]);
    expect(await profileOf(owner.id)).toMatchObject({ organization_id: org.id, org_role: 'owner' });
  }, TEST_TIMEOUT_MS);

  it('OC-3: オーナーがすでに組織に所属していれば OWNER_ALREADY_IN_ORG (P0001) で止まり、組織の行・席の行も残さない (押し直しで 2 つ目を作らない)', async () => {
    const owner = await createUser('oc3');
    const first = await createOrg(owner.id, 'oc3-first');
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const firstId = (first.data as { id: string }).id;

    // 応答が切れたあとの押し直し (同じ内容) も、別の名前の作成も止まる
    expectRaised(await createOrg(owner.id, 'oc3-first'), OWNER_ALREADY_IN_ORG);
    expectRaised(await createOrg(owner.id, 'oc3-second'), OWNER_ALREADY_IN_ORG);

    expect(await orgsNamed(orgName('oc3-first'))).toEqual([firstId]);
    expect(await orgsNamed(orgName('oc3-second'))).toEqual([]);
    expect(await profileOf(owner.id)).toMatchObject({ organization_id: firstId, org_role: 'owner' });
  }, TEST_TIMEOUT_MS);

  it('OC-4: プロフィールの行がまだ無い人 (初期設定の前) は、仮置きの行を作って所属を入れる。2 回目は OWNER_ALREADY_IN_ORG (修正前は所属が入らず、何度でも作れた)', async () => {
    const owner = await createUser('oc4', false);
    expect(await profileOf(owner.id)).toBeNull();

    const created = await createOrg(owner.id, 'oc4');
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const orgId = (created.data as { id: string }).id;
    expect(await profileOf(owner.id)).toEqual({ nickname: PROFILE_NAME_PLACEHOLDER, organization_id: orgId, org_role: 'owner' });

    expectRaised(await createOrg(owner.id, 'oc4-again'), OWNER_ALREADY_IN_ORG);
    expect(await ownedOrgs(owner.id)).toEqual([{ id: orgId, name: orgName('oc4') }]);
  }, TEST_TIMEOUT_MS);

  it('OC-5: 退会の手続き中の人は従来どおり OWNER_ACCOUNT_DELETING で止まり、プロフィールの行も作らない。auth.users に居ない人は外部キーの違反で何も作らない', async () => {
    const deleting = await createUser('oc5', false);
    const guard = await srAdmin.rpc('begin_account_deletion_guard', { p_user_id: deleting.id });
    expect(guard.error).toBeNull();

    expectRaised(await createOrg(deleting.id, 'oc5'), OWNER_ACCOUNT_DELETING);
    expect(await ownedOrgs(deleting.id)).toEqual([]);
    expect(await profileOf(deleting.id)).toBeNull();

    const missing = randomUUID();
    const outcome = await createOrg(missing, 'oc5-missing');
    expect(outcome.code, JSON.stringify(outcome)).toBe(PG_FOREIGN_KEY_VIOLATION);
    expect(await orgsNamed(orgName('oc5-missing'))).toEqual([]);
    expect(await profileOf(missing)).toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('同じオーナーの作成が同時に走ったとき', () => {
  it('OC-6: 先の作成をコミット前のまま開いている間に同じオーナーで作ると、後の作成は先の commit を待ってから OWNER_ALREADY_IN_ORG (修正前は 2 つできた)', async () => {
    const owner = await createUser('oc6');

    const holder = holders.startHolder(
      'create-first',
      `SELECT public.${RPC}('${orgName('oc6-holder')}', 'standard', '${owner.id}'::uuid);`,
    );
    const [held, second] = await holders.runBehindHolder(holder, {
      fn: RPC,
      waitEvent: ADVISORY_WAIT_EVENT,
      call: () => createOrg(owner.id, 'oc6-second'),
    });

    expect(held.ok, JSON.stringify(held)).toBe(true);
    expectRaised(second, OWNER_ALREADY_IN_ORG);
    const owned = await ownedOrgs(owner.id);
    expect(owned.map((row) => row.name)).toEqual([orgName('oc6-holder')]);
    createdOrgIds.push(...owned.map((row) => row.id));
    expect(await profileOf(owner.id)).toMatchObject({ organization_id: owned[0].id, org_role: 'owner' });
  }, TEST_TIMEOUT_MS);

  it('OC-7: 同じオーナーで同時に送った作成は 1 つだけ通り、残りは OWNER_ALREADY_IN_ORG。組織は 1 つで、所属はその組織を指す (プロフィールの行が無い人でも)', async () => {
    for (const withProfile of [true, false]) {
      const owner = await createUser(`oc7-${withProfile ? 'profile' : 'no-profile'}`, withProfile);

      const outcomes = await Promise.all(
        Array.from({ length: CONCURRENT_CREATES }, (_, i) => createOrg(owner.id, `oc7-${withProfile}-${i}`)),
      );

      const succeeded = outcomes.filter((outcome) => outcome.ok);
      expect(succeeded, JSON.stringify(outcomes)).toHaveLength(1);
      for (const failed of outcomes.filter((outcome) => !outcome.ok)) expectRaised(failed, OWNER_ALREADY_IN_ORG);
      const orgId = (succeeded[0].data as { id: string }).id;
      expect((await ownedOrgs(owner.id)).map((row) => row.id)).toEqual([orgId]);
      expect(await profileOf(owner.id)).toMatchObject({ organization_id: orgId, org_role: 'owner' });
    }
  }, TEST_TIMEOUT_MS);

  it('OC-8: 運営の作成 API に同じオーナーで同時に 2 回送ると、1 つは 200・もう 1 つは 409 OWNER_ALREADY_IN_ORG (英字の項目名の無い文) で、組織は 1 つ', async () => {
    const owner = await createUser('oc8');
    const operatorUser = await createTestUserWithRoles({ email: testEmail('org-create-atomic-oc8-admin', TS), roles: ['user', 'admin'] });
    operatorUsers.push(operatorUser);

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_CREATES }, () =>
        apiCall<{ organization?: { id: string }; error?: { code?: string; message?: string } }>(
          'POST',
          '/api/admin/organizations',
          operatorUser.jwt,
          { name: orgName('oc8'), owner_id: owner.id },
        ),
      ),
    );

    const statuses = responses.map((res) => res.status).sort();
    expect(statuses, JSON.stringify(responses.map((res) => res.body))).toEqual([HTTP_OK, HTTP_CONFLICT]);
    const conflict = responses.find((res) => res.status === HTTP_CONFLICT)!;
    expect(conflict.body.error).toEqual({ code: OWNER_ALREADY_IN_ORG, message: OWNER_ALREADY_IN_ORG_MESSAGE });
    const created = responses.find((res) => res.status === HTTP_OK)!;
    const orgId = created.body.organization?.id;
    expect(typeof orgId).toBe('string');
    expect((await ownedOrgs(owner.id)).map((row) => row.id)).toEqual([orgId]);
    expect(await orgsNamed(orgName('oc8'))).toEqual([orgId]);
    expect(await poolOf(orgId!)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);
});

describe('運営の作成 API の居ないオーナーと、一覧の検索 (#2112 Z2)', () => {
  it('OC-9: auth.users に居ないオーナーを指定すると 422 OWNER_NOT_FOUND (理由の分かる文。修正前は 500「組織の作成に失敗しました」) で、組織を作らない', async () => {
    const operatorUser = await createTestUserWithRoles({ email: testEmail('org-create-atomic-oc9-admin', TS), roles: ['user', 'admin'] });
    operatorUsers.push(operatorUser);
    const missing = randomUUID();

    const res = await apiCall<{ error?: { code?: string; message?: string } }>('POST', '/api/admin/organizations', operatorUser.jwt, {
      name: orgName('oc9'),
      owner_id: missing,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(HTTP_UNPROCESSABLE);
    expect(res.body.error).toEqual({ code: 'OWNER_NOT_FOUND', message: OWNER_NOT_FOUND_MESSAGE });
    expect(await orgsNamed(orgName('oc9'))).toEqual([]);
    expect(await profileOf(missing)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('OC-10: 一覧は運営が所属していない組織も返し (行のオーナーの id つき)、組織名の検索の % と _ は文字どおりに一致する (「100%」で「100x」の組織に当てない)', async () => {
    const operatorUser = await createTestUserWithRoles({ email: testEmail('org-create-atomic-oc10-admin', TS), roles: ['user', 'admin'] });
    operatorUsers.push(operatorUser);
    const labels = ['oc10 100%', 'oc10 100x', 'oc10 a_b', 'oc10 axb'] as const;
    const ids = new Map<string, { orgId: string; ownerId: string }>();
    for (const [index, label] of labels.entries()) {
      const owner = await createUser(`oc10-${index}`);
      const created = await createOrg(owner.id, label);
      expect(created.ok, JSON.stringify(created)).toBe(true);
      ids.set(label, { orgId: (created.data as { id: string }).id, ownerId: owner.id });
    }

    type ListBody = { organizations?: Array<{ id: string; name: string; owner_id: string | null }> };
    const search = async (q: string) => {
      const res = await apiCall<ListBody>('GET', `/api/admin/organizations?${new URLSearchParams({ q }).toString()}`, operatorUser.jwt);
      expect(res.status, JSON.stringify(res.body)).toBe(HTTP_OK);
      return res.body.organizations ?? [];
    };

    const percent = await search(`oc10 100% ${TS}`);
    expect(percent.map((row) => row.id)).toEqual([ids.get('oc10 100%')!.orgId]);
    expect(percent[0].owner_id).toBe(ids.get('oc10 100%')!.ownerId);

    const underscore = await search(`oc10 a_b ${TS}`);
    expect(underscore.map((row) => row.id)).toEqual([ids.get('oc10 a_b')!.orgId]);

    // q=% は全部の組織にならず、名前に % を含む組織だけ
    const onlyPercent = await search('%');
    expect(onlyPercent.every((row) => row.name.includes('%')), JSON.stringify(onlyPercent.map((row) => row.name))).toBe(true);
    expect(onlyPercent.map((row) => row.id)).not.toContain(ids.get('oc10 100x')!.orgId);
  }, TEST_TIMEOUT_MS);
});
