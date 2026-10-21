/**
 * #1103 項目 10: migration 20261017100000_organizations_owner_id_not_null.sql の振る舞いを、本物の DB (ローカルの Supabase) で確かめる。
 *
 * 結合テストの DB には、この migration と #1917 の migration (20261019120000_self_dissolve.sql。owner_id を NULL 許容にし、
 * CHECK organizations_active_has_owner で active な行だけ NOT NULL) が当たっている。そこで、
 * 1 回の問い合わせ (postgres-meta の /pg/query。複数の文を 1 つの暗黙のトランザクションで流す) の中で
 *   1. owner_id の NOT NULL と CHECK organizations_active_has_owner を外し、本番と同じ形の組織 (owner_id が NULL) を作り
 *   2. migration のファイルの中身をそのまま流し
 *   3. 結果を JSON にして例外 (TEST_RESULT) で返す
 * ようにする。例外でトランザクションごと巻き戻るので、外したものも作った行も DB には残らない
 * (各テストの後に、列が NULL 許容のまま・CHECK が残っていること・作った組織が無いことも確かめる)。
 *
 * ここで確かめること:
 *   - メンバーが 0 人で owner_id が NULL の組織だけが消え、その org_license_pools の行も消える (CASCADE)
 *   - owner_id が NULL でメンバーのいる組織は、org_role = 'owner' の利用者で埋まる。owner_id がある組織は (0 人でも) 残る
 *   - 列が NOT NULL になる。2 回流しても同じ (冪等)
 *   - 止まる条件: 消す件数が上限 (4) を超える / 外部キーで参照される (departments) / 外部キーの無い列で参照される
 *     (sales_leads.converted_org_id) / org_license_pools の既知でない列に値がある / owner が 0 人・2 人
 *     (migration は 1 つの DO ブロックなので、止まれば消す・埋めるも含めて何も残らない。止まった後の状態は同じトランザクションの中で
 *     読めないので、問い合わせ全体が巻き戻って作った組織が残らないことを afterEach で確かめる)
 *   - ロールバック (supabase/rollbacks/...down.sql) で NOT NULL が外れる
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。本番には接続しない。
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/organizations-owner-id-not-null.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import ws from 'ws';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const srAdmin: SupabaseClient = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws as unknown as typeof WebSocket },
});

const ROOT = path.resolve(__dirname, '../../..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20261017100000_organizations_owner_id_not_null.sql'),
  'utf8',
);
const ROLLBACK = fs.readFileSync(
  path.join(ROOT, 'supabase/rollbacks/20261017100000_organizations_owner_id_not_null.down.sql'),
  'utf8',
);

/** migration の消す件数の上限 (c_max_deletions)。本番の読み取りで数えたメンバー 0 人の組織の数 */
const MAX_DELETIONS = 4;
/** 作る座席数の行の total_licenses (値そのものは検査に使わない) */
const FIXTURE_TOTAL_LICENSES = 10;
/** 結果を返す例外の目印 */
const RESULT_MARKER = 'TEST_RESULT ';

const RUN = randomBytes(4).toString('hex');
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
/** この実行で作った組織の id (巻き戻りの確認に使う) */
const fixtureOrgIds: string[] = [];

/** SQL の文字列リテラル (テストが作る値だけを渡す) */
const q = (value: string) => `'${value.replace(/'/g, "''")}'`;

function newOrgId(): string {
  const id = randomUUID();
  fixtureOrgIds.push(id);
  return id;
}

async function createUser(label: string): Promise<string> {
  const email = `owner-not-null-${label}-${RUN}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  const userId = data.user.id;
  createdUserIds.push(userId);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, `createUser ${label}: user_profiles の upsert`, (db) =>
    db.from('user_profiles').upsert({ id: userId, nickname: `owner-not-null-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  return userId;
}

/** postgres-meta で SQL を流す。成功なら行、失敗なら例外の本文 (文字列) を返す */
async function pgQuery(query: string): Promise<{ ok: true; rows: unknown } | { ok: false; error: string }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, rows: body };
  return { ok: false, error: findMessage(body) ?? JSON.stringify(body) };
}

/** postgres-meta の失敗の本文から、例外の文を探す (形が版で違っても拾えるように、文字列の値を順に見る) */
function findMessage(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'error', 'formattedError']) {
      const value = record[key];
      if (typeof value === 'string') return value;
      const nested = findMessage(value);
      if (nested) return nested;
    }
  }
  return null;
}

interface Outcome {
  /** 作った組織のうち残ったもの (id → owner_id) */
  orgs: Record<string, string | null>;
  /** 作った組織の org_license_pools の行数 */
  pools: number;
  /** organizations.owner_id の is_nullable ('YES' / 'NO') */
  nullable: string;
}

/**
 * NOT NULL を外して setup を流し、body (migration など) を流し、結果を返す。全部が 1 つのトランザクションで、最後に巻き戻る。
 * body が例外で止まったら、その例外の文を error に入れて返す
 */
async function runInRolledBackTransaction(setup: string, body: string): Promise<{ outcome: Outcome | null; error: string | null }> {
  const ids = fixtureOrgIds.map(q).join(', ') || 'NULL';
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${RESULT_MARKER}%', json_build_object(
    'orgs', coalesce((SELECT json_object_agg(o.id, o.owner_id) FROM public.organizations o WHERE o.id IN (${ids})), '{}'::json),
    'pools', (SELECT count(*) FROM public.org_license_pools p WHERE p.organization_id IN (${ids})),
    'nullable', (SELECT c.is_nullable FROM information_schema.columns c
                  WHERE c.table_schema = 'public' AND c.table_name = 'organizations' AND c.column_name = 'owner_id')
  )::text;
END
$report$;`;
  const result = await pgQuery(
    [
      'ALTER TABLE public.organizations ALTER COLUMN owner_id DROP NOT NULL;',
      // #1917: active な行の owner_id の NOT NULL は CHECK が持つ。旧 migration の検査のために本番と同じ形 (owner_id が NULL の active な組織) を作るので外す (トランザクションごと巻き戻る)
      'ALTER TABLE public.organizations DROP CONSTRAINT organizations_active_has_owner;',
      setup,
      body,
      report,
    ].join('\n'),
  );
  if (result.ok) throw new Error('結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)');
  const at = result.error.indexOf(RESULT_MARKER);
  if (at < 0) return { outcome: null, error: result.error };
  return { outcome: JSON.parse(result.error.slice(at + RESULT_MARKER.length)) as Outcome, error: null };
}

/** owner_id が NULL の組織を作る SQL */
const orgSql = (id: string, label: string) =>
  `INSERT INTO public.organizations (id, name, owner_id) VALUES (${q(id)}, ${q(`owner-not-null ${label} ${RUN}`)}, NULL);`;
const ownedOrgSql = (id: string, label: string, ownerId: string) =>
  `INSERT INTO public.organizations (id, name, owner_id) VALUES (${q(id)}, ${q(`owner-not-null ${label} ${RUN}`)}, ${q(ownerId)});`;
const poolSql = (orgId: string) =>
  `INSERT INTO public.org_license_pools (organization_id, total_licenses) VALUES (${q(orgId)}, ${FIXTURE_TOTAL_LICENSES});`;
const memberSql = (userId: string, orgId: string, role: 'owner' | 'admin' | 'member') =>
  `UPDATE public.user_profiles SET organization_id = ${q(orgId)}, org_role = ${q(role)}, is_active_in_org = true WHERE id = ${q(userId)};`;

let ownerA = '';
let memberA = '';
let ownerB = '';
let ownerB2 = '';
let existingOwner = '';

beforeAll(async () => {
  [ownerA, memberA, ownerB, ownerB2, existingOwner] = await Promise.all([
    createUser('owner-a'),
    createUser('member-a'),
    createUser('owner-b'),
    createUser('owner-b2'),
    createUser('existing-owner'),
  ]);
}, 60_000);

afterEach(async () => {
  // 巻き戻ったこと: 列は #1917 の形 (NULL 許容) のまま、CHECK organizations_active_has_owner は残り、作った組織は 1 つも残っていない
  const column = await pgQuery(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'owner_id'",
  );
  expect(column).toEqual({ ok: true, rows: [{ is_nullable: 'YES' }] });
  const check = await pgQuery(
    "SELECT conname FROM pg_constraint WHERE conrelid = 'public.organizations'::regclass AND conname = 'organizations_active_has_owner'",
  );
  expect(check).toEqual({ ok: true, rows: [{ conname: 'organizations_active_has_owner' }] });
  if (fixtureOrgIds.length > 0) {
    const { data: left, error } = await srAdmin.from('organizations').select('id').in('id', fixtureOrgIds);
    expect(error).toBeNull();
    expect(left ?? []).toEqual([]);
  }
});

afterAll(async () => {
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

describe('#1103 項目 10: organizations.owner_id を NOT NULL にする migration', () => {
  it('メンバー 0 人の組織だけを消し (座席数の行も)、メンバーのいる組織は owner で埋め、NOT NULL にする', async () => {
    const zero1 = newOrgId();
    const zero2 = newOrgId();
    const withOwner = newOrgId();
    const ownedEmpty = newOrgId();
    const setup = [
      orgSql(zero1, 'zero1'),
      orgSql(zero2, 'zero2'),
      poolSql(zero1),
      poolSql(zero2),
      orgSql(withOwner, 'with-owner'),
      poolSql(withOwner),
      memberSql(ownerA, withOwner, 'owner'),
      memberSql(memberA, withOwner, 'member'),
      ownedOrgSql(ownedEmpty, 'owned-empty', existingOwner),
    ].join('\n');

    const { outcome, error } = await runInRolledBackTransaction(setup, MIGRATION);

    expect(error).toBeNull();
    expect(outcome?.orgs).toEqual({ [withOwner]: ownerA, [ownedEmpty]: existingOwner });
    expect(outcome?.pools).toBe(1); // with-owner の 1 行だけ残る
    expect(outcome?.nullable).toBe('NO');
  });

  it('2 回流しても同じ (冪等)。2 回目は何も消さない', async () => {
    const zero = newOrgId();
    const withOwner = newOrgId();
    const setup = [
      orgSql(zero, 'idem-zero'),
      orgSql(withOwner, 'idem-with-owner'),
      memberSql(ownerA, withOwner, 'owner'),
    ].join('\n');

    const { outcome, error } = await runInRolledBackTransaction(setup, `${MIGRATION}\n${MIGRATION}`);

    expect(error).toBeNull();
    expect(outcome?.orgs).toEqual({ [withOwner]: ownerA });
    expect(outcome?.nullable).toBe('NO');
  });

  it(`メンバー 0 人の組織がちょうど上限 (${MAX_DELETIONS}) なら消す`, async () => {
    const zeros = Array.from({ length: MAX_DELETIONS }, () => newOrgId());
    const { outcome, error } = await runInRolledBackTransaction(
      zeros.map((id, i) => orgSql(id, `limit-${i}`)).join('\n'),
      MIGRATION,
    );

    expect(error).toBeNull();
    expect(outcome?.orgs).toEqual({});
    expect(outcome?.nullable).toBe('NO');
  });

  it(`メンバー 0 人の組織が上限 (${MAX_DELETIONS}) を超えたら、何も消さずに止める`, async () => {
    const zeros = Array.from({ length: MAX_DELETIONS + 1 }, () => newOrgId());
    const { outcome, error } = await runInRolledBackTransaction(
      zeros.map((id, i) => orgSql(id, `over-${i}`)).join('\n'),
      MIGRATION,
    );

    expect(outcome).toBeNull();
    expect(error).toContain('ORG_OWNER_NOT_NULL_TOO_MANY_DELETIONS');
  });

  it('消す組織を外部キーで参照する行 (departments) があれば止める', async () => {
    const zero = newOrgId();
    const setup = [
      orgSql(zero, 'dept'),
      `INSERT INTO public.departments (organization_id, name) VALUES (${q(zero)}, ${q(`dept ${RUN}`)});`,
    ].join('\n');

    const { outcome, error } = await runInRolledBackTransaction(setup, MIGRATION);

    expect(outcome).toBeNull();
    expect(error).toContain('ORG_OWNER_NOT_NULL_REFERENCED');
    expect(error).toContain('public.departments.organization_id');
  });

  it('消す組織を外部キーの無い列 (sales_leads.converted_org_id) で参照する行があれば止める', async () => {
    const zero = newOrgId();
    const setup = [
      orgSql(zero, 'lead'),
      `INSERT INTO public.sales_leads (company_name, converted_org_id) VALUES (${q(`lead ${RUN}`)}, ${q(zero)});`,
    ].join('\n');

    const { outcome, error } = await runInRolledBackTransaction(setup, MIGRATION);

    expect(outcome).toBeNull();
    expect(error).toContain('ORG_OWNER_NOT_NULL_REFERENCED');
    expect(error).toContain('public.sales_leads.converted_org_id');
  });

  it('org_license_pools に既知でない列 (外部の紐付け) があり、消す組織の行に値が入っていれば止める', async () => {
    const zero = newOrgId();
    const setup = [
      orgSql(zero, 'linked'),
      'ALTER TABLE public.org_license_pools ADD COLUMN stripe_subscription_id text;',
      `INSERT INTO public.org_license_pools (organization_id, total_licenses, stripe_subscription_id) VALUES (${q(zero)}, ${FIXTURE_TOTAL_LICENSES}, ${q(`sub_${RUN}`)});`,
    ].join('\n');

    const { outcome, error } = await runInRolledBackTransaction(setup, MIGRATION);

    expect(outcome).toBeNull();
    expect(error).toContain('ORG_OWNER_NOT_NULL_LICENSE_POOL_LINKED');
    expect(error).toContain('stripe_subscription_id');
  });

  it('既知でない列があっても、消す組織の行で値が空なら消す', async () => {
    const zero = newOrgId();
    const setup = [
      orgSql(zero, 'unlinked'),
      'ALTER TABLE public.org_license_pools ADD COLUMN stripe_subscription_id text;',
      poolSql(zero),
    ].join('\n');

    const { outcome, error } = await runInRolledBackTransaction(setup, MIGRATION);

    expect(error).toBeNull();
    expect(outcome?.orgs).toEqual({});
    expect(outcome?.pools).toBe(0);
  });

  it('メンバーはいるが owner (org_role = owner) が 0 人の組織があれば止める', async () => {
    const noOwner = newOrgId();
    const setup = [orgSql(noOwner, 'no-owner'), memberSql(memberA, noOwner, 'member')].join('\n');

    const { outcome, error } = await runInRolledBackTransaction(setup, MIGRATION);

    expect(outcome).toBeNull();
    expect(error).toContain('ORG_OWNER_NOT_NULL_OWNER_AMBIGUOUS');
    expect(error).toContain(noOwner);
  });

  it('owner が 2 人の組織があれば止める (誰をオーナーにするかを推測しない)', async () => {
    const twoOwners = newOrgId();
    const setup = [
      orgSql(twoOwners, 'two-owners'),
      memberSql(ownerB, twoOwners, 'owner'),
      memberSql(ownerB2, twoOwners, 'owner'),
    ].join('\n');

    const { outcome, error } = await runInRolledBackTransaction(setup, MIGRATION);

    expect(outcome).toBeNull();
    expect(error).toContain('ORG_OWNER_NOT_NULL_OWNER_AMBIGUOUS');
    expect(error).toContain(twoOwners);
  });

  it('ロールバックで NOT NULL が外れる (消した組織は戻らない)', async () => {
    const zero = newOrgId();
    const { outcome, error } = await runInRolledBackTransaction(orgSql(zero, 'rollback'), `${MIGRATION}\n${ROLLBACK}`);

    expect(error).toBeNull();
    expect(outcome?.orgs).toEqual({});
    expect(outcome?.nullable).toBe('YES');
  });
});
