/**
 * #2107 Y4・Y5: 運営の組織の作成 POST /api/admin/organizations の route のテスト (DB は使わない)。
 *
 * Y4: 修正前の route は、オーナーの所属の確認・organizations の INSERT・org_license_pools の INSERT・オーナーの user_profiles の
 *   UPDATE を別々の要求で行っていた。確認と更新の間に同じオーナーの 2 つ目の作成が通ると組織が 2 つでき、更新に失敗すると 500 を
 *   返しても組織は残った (押し直すと 2 つ目ができる)。修正後は 1 つの DB 関数 admin_create_organization (1 つのトランザクション。
 *   supabase/migrations/20261030150000_create_organization_atomic.sql) を呼ぶだけにし、route は表に直接書かない。
 *   関数がオーナーの所属を見て止めた OWNER_ALREADY_IN_ORG (P0001) は 409 に写す。実 DB での同時の作成は
 *   tests/integration/security/org-create-atomic.test.ts。
 * Y5: 409 の文は「指定したオーナー (owner_id) は既に別の組織に所属しています」だった。応答が切れたあとの押し直しでは、さっき自分が
 *   作った組織を「別の組織」と言い、英字の内部名 (owner_id) も運営に見えた。文を変え、英字を外す。同じ型の退会の手続き中の文も直す。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type DbError, type SchemaDb } from './helpers/schema-checked-db';
import { jsonRequest, makeClient, profileRow, uuid, type FakeUser } from './helpers/route-world';

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withUser: vi.fn() }),
  generateRequestId: () => 'req_test',
}));

let sessionUser: FakeUser | null = null;
/** 運営本人の client が見る DB (本人の user_profiles と監査ログ) */
let sessionDb: SchemaDb;
/** service_role の client が見る DB (route が表に直接書かないことを見る) */
let serviceDb: SchemaDb;

/** service_role の client の rpc の呼び出しの記録 */
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
/** 設定すると、rpc はこの結果を返す (DB 関数の結果の再現) */
let rpcResult: { data: unknown; error: DbError | null } = { data: null, error: null };

async function fakeRpc(name: string, args: Record<string, unknown>) {
  rpcCalls.push({ name, args });
  return rpcResult;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser),
  getSupabaseAdmin: () => makeClient(serviceDb, null, fakeRpc),
}));

const route = await import('@/app/api/admin/organizations/route');

const ACTOR_ID = uuid(1);
const OWNER_ID = uuid(2);
const ORG_ID = uuid(3);
const ORG_NAME = '株式会社テスト';
const RPC = 'admin_create_organization';
/** DB 関数・トリガーが RAISE EXCEPTION ... USING ERRCODE = 'P0001' で止めたときの SQLSTATE */
const PG_RAISE_EXCEPTION = 'P0001';
const CREATE_AUDIT_ACTION = 'admin.organization.create';
const OWNER_ALREADY_IN_ORG_MESSAGE =
  '指定したオーナーはすでに組織に所属しています (直前に作成した組織かもしれません。一覧で確かめてください)';
const OWNER_ACCOUNT_DELETING_MESSAGE = '指定したオーナーは退会の手続き中です';
const CREATE_FAILED = { error: { code: 'INTERNAL_ERROR', message: '組織の作成に失敗しました' } };
/** 英字 (運営に見せる文に、内部の項目名・コードを出さない) */
const LATIN_LETTERS = /[A-Za-z]/;

/** DB 関数が返す、作った組織 */
const createdOrg = (overrides: Record<string, unknown> = {}) => ({
  id: ORG_ID,
  name: ORG_NAME,
  plan: 'premium',
  owner_id: OWNER_ID,
  created_at: '2026-10-30T03:00:00.000000+00:00',
  updated_at: '2026-10-30T03:00:00.000000+00:00',
  ...overrides,
});

function setup() {
  sessionUser = { id: ACTOR_ID };
  sessionDb = createSchemaDb({
    tables: {
      user_profiles: [profileRow(ACTOR_ID, { roles: ['admin'] })],
      admin_audit_logs: [],
    },
  });
  serviceDb = createSchemaDb({
    tables: {
      user_profiles: [profileRow(ACTOR_ID, { roles: ['admin'] }), profileRow(OWNER_ID)],
      organizations: [],
      org_license_pools: [],
    },
  });
}

function post(body: unknown) {
  return route.POST(jsonRequest('http://localhost/api/admin/organizations', 'POST', body));
}

const json = (res: Response) => res.json() as Promise<Record<string, any>>;
const auditRows = () => sessionDb.rows('admin_audit_logs');

/** route が service_role で表に直接触っていない (読みも書きも DB 関数の中だけ) */
function expectNoDirectTableAccess() {
  for (const table of ['organizations', 'org_license_pools', 'user_profiles']) {
    expect(serviceDb.recorded(table), table).toHaveLength(0);
  }
}

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = { data: createdOrg(), error: null };
  setup();
});

describe('POST /api/admin/organizations: 作成・席の行・オーナーの所属を 1 つの DB 関数で書く (#2107 Y4)', () => {
  it('DB 関数 admin_create_organization を 1 回だけ呼び (名前・プラン・オーナー)、表には直接書かない。応答は関数が返した組織、監査 1 行', async () => {
    const res = await post({ name: ORG_NAME, plan: 'premium', owner_id: OWNER_ID });

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ organization: createdOrg() });
    expect(rpcCalls).toEqual([{ name: RPC, args: { p_name: ORG_NAME, p_plan: 'premium', p_owner_id: OWNER_ID } }]);
    expectNoDirectTableAccess();
    expect(auditRows()).toEqual([
      expect.objectContaining({ actor_id: ACTOR_ID, action_type: CREATE_AUDIT_ACTION, target_id: ORG_ID }),
    ]);
  });

  it('オーナーを省くと、呼び出した運営をオーナーにする。プランを省くと standard', async () => {
    rpcResult = { data: createdOrg({ plan: 'standard', owner_id: ACTOR_ID }), error: null };
    const res = await post({ name: ORG_NAME });

    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([{ name: RPC, args: { p_name: ORG_NAME, p_plan: 'standard', p_owner_id: ACTOR_ID } }]);
  });

  it('関数がオーナーの所属を見て止めた (OWNER_ALREADY_IN_ORG・P0001) ら 409。文は英字の項目名を含まず、直前の自分の作成かもしれないと伝える。監査を書かない', async () => {
    rpcResult = { data: null, error: { code: PG_RAISE_EXCEPTION, message: 'OWNER_ALREADY_IN_ORG' } };
    const res = await post({ name: ORG_NAME, owner_id: OWNER_ID });

    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body).toEqual({ error: { code: 'OWNER_ALREADY_IN_ORG', message: OWNER_ALREADY_IN_ORG_MESSAGE } });
    expect(body.error.message).not.toMatch(LATIN_LETTERS);
    expect(body.error.message).not.toContain('別の組織');
    expectNoDirectTableAccess();
    expect(auditRows()).toEqual([]);
  });

  it('退会の手続き中 (OWNER_ACCOUNT_DELETING・P0001) の 409 の文も、英字の項目名を含まない', async () => {
    rpcResult = { data: null, error: { code: PG_RAISE_EXCEPTION, message: 'OWNER_ACCOUNT_DELETING' } };
    const res = await post({ name: ORG_NAME, owner_id: OWNER_ID });

    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body).toEqual({ error: { code: 'OWNER_ACCOUNT_DELETING', message: OWNER_ACCOUNT_DELETING_MESSAGE } });
    expect(body.error.message).not.toMatch(LATIN_LETTERS);
    expect(auditRows()).toEqual([]);
  });

  it.each([
    ['P0001 でもほかのコード', { code: PG_RAISE_EXCEPTION, message: 'CONFLICT_RETRY' }],
    ['ほかの SQLSTATE で同じ文', { code: '23505', message: 'OWNER_ALREADY_IN_ORG' }],
    ['外部キーの違反 (auth.users に居ない人)', { code: '23503', message: 'insert or update on table "organizations" violates foreign key constraint' }],
    ['接続の失敗', { code: '08006', message: 'connection reset by peer' }],
  ])('%s の失敗は 500 INTERNAL_ERROR (409 と取り違えない)。監査を書かない', async (_label, error: DbError) => {
    rpcResult = { data: null, error };
    const res = await post({ name: ORG_NAME, owner_id: OWNER_ID });

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual(CREATE_FAILED);
    expectNoDirectTableAccess();
    expect(auditRows()).toEqual([]);
  });

  it('関数の戻りが組織の形でない (id が無い) ときは、作れたと言わずに 500。一覧で確かめさせる文にする', async () => {
    rpcResult = { data: { name: ORG_NAME }, error: null };
    const res = await post({ name: ORG_NAME, owner_id: OWNER_ID });

    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toContain('一覧で確かめてください');
    expect(body.error.message).not.toMatch(LATIN_LETTERS);
    expect(auditRows()).toEqual([]);
  });
});
