/**
 * #1917 の続き (D73): 運営の組織の作成 POST /api/admin/organizations が、退会の途中の人をオーナーにしない (route のテスト)。
 *
 * 退会 (src/lib/account-deletion.ts の deleteAccount) は findBlocker の前に退会の印 (begin_account_deletion_guard) を付ける。
 * 印のある人を owner_id にする organizations の INSERT は、DB のトリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting()) が
 * 'OWNER_ACCOUNT_DELETING' (P0001) で止める (supabase/migrations/20261023130000_account_deletion_owner_guard.sql。
 * 実 DB では tests/integration/security/account-deletion-owner-guard.test.ts)。
 * #2107 Y4 から、route は作成を DB 関数 admin_create_organization (1 つのトランザクション。
 * supabase/migrations/20261030150000_create_organization_atomic.sql) に任せる。トリガーの止めは関数の呼び出しの失敗として届き、
 * 関数の中の書き込み (席の行・オーナーの所属) も一緒に戻る。
 * ここでは、その止めを route が 409 OWNER_ACCOUNT_DELETING (日本語の固定の文) にし、表に直接書かず・監査を書かないことを確かめる。
 *
 *  - P0001 + メッセージ 'OWNER_ACCOUNT_DELETING' → 409 OWNER_ACCOUNT_DELETING。organizations・org_license_pools・user_profiles・admin_audit_logs に書かない
 *  - P0001 でもほかのメッセージ、ほかの SQLSTATE で同じメッセージ → 従来どおり 500 INTERNAL_ERROR (取り違えない)
 *  - 止められなければ従来どおり作る (関数を呼び、作った組織を返し、監査を書く)
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
/** 設定すると、service_role の DB 関数 admin_create_organization の呼び出しがこのエラーで返る (DB のトリガーの止めの再現) */
let createFault: DbError | null = null;
/** DB 関数の呼び出しの記録 */
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

/** DB 関数 admin_create_organization の再現: 止めがあればそのエラー、無ければ作った組織を返す */
async function fakeRpc(name: string, args: Record<string, unknown>) {
  rpcCalls.push({ name, args });
  if (createFault) return { data: null, error: createFault };
  return {
    data: {
      id: CREATED_ORG_ID,
      name: args.p_name,
      plan: args.p_plan,
      owner_id: args.p_owner_id,
      created_at: '2026-10-30T03:00:00+00:00',
      updated_at: '2026-10-30T03:00:00+00:00',
    },
    error: null,
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser),
  getSupabaseAdmin: () => makeClient(serviceDb, null, fakeRpc),
}));

const route = await import('@/app/api/admin/organizations/route');

const ACTOR_ID = uuid(1);
const OWNER_ID = uuid(2);
const ORG_NAME = '退会の途中のテスト組織';
const CREATED_ORG_ID = uuid(3);
/** DB 関数・トリガーが RAISE EXCEPTION ... USING ERRCODE = 'P0001' で止めたときの SQLSTATE */
const PG_RAISE_EXCEPTION = 'P0001';
const OWNER_ACCOUNT_DELETING = 'OWNER_ACCOUNT_DELETING';
const CREATE_AUDIT_ACTION = 'admin.organization.create';
const CREATE_RPC = 'admin_create_organization';

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
/** route が service_role で表に直接触っていない (読みも書きも DB 関数の中だけ。#2107 Y4) */
function expectNoDirectTableAccess() {
  for (const table of ['organizations', 'org_license_pools', 'user_profiles']) {
    expect(serviceDb.recorded(table), table).toHaveLength(0);
  }
}

beforeEach(() => {
  createFault = null;
  rpcCalls.length = 0;
  setup();
});

describe('POST /api/admin/organizations: 退会の途中の人をオーナーにしない (#1917 の続き)', () => {
  it('DB が OWNER_ACCOUNT_DELETING (P0001) で止めたら 409 OWNER_ACCOUNT_DELETING (英字の項目名を含まない文)。表に直接書かず、監査も書かない', async () => {
    createFault = { code: PG_RAISE_EXCEPTION, message: OWNER_ACCOUNT_DELETING };
    const res = await post({ name: ORG_NAME, owner_id: OWNER_ID });

    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({
      error: { code: OWNER_ACCOUNT_DELETING, message: '指定したオーナーは退会の手続き中です' },
    });
    expect(rpcCalls).toEqual([{ name: CREATE_RPC, args: { p_name: ORG_NAME, p_plan: 'standard', p_owner_id: OWNER_ID } }]);
    expectNoDirectTableAccess();
    expect(sessionDb.rows('admin_audit_logs')).toEqual([]);
  });

  it.each([
    ['P0001 でもほかのコード', { code: PG_RAISE_EXCEPTION, message: 'CONFLICT_RETRY' }],
    ['ほかの SQLSTATE で同じ文', { code: '23505', message: OWNER_ACCOUNT_DELETING }],
    ['SQLSTATE が無い', { message: OWNER_ACCOUNT_DELETING }],
  ])('%s の失敗は従来どおり 500 INTERNAL_ERROR (409 と取り違えない)', async (_label, fault: DbError) => {
    createFault = fault;
    const res = await post({ name: ORG_NAME, owner_id: OWNER_ID });

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: { code: 'INTERNAL_ERROR', message: '組織の作成に失敗しました' } });
    expectNoDirectTableAccess();
    expect(sessionDb.rows('admin_audit_logs')).toEqual([]);
  });

  it('止められなければ従来どおり作る: DB 関数を 1 回呼び、作った組織を返し、監査 1 行', async () => {
    const res = await post({ name: ORG_NAME, owner_id: OWNER_ID });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.organization).toMatchObject({ id: CREATED_ORG_ID, name: ORG_NAME, plan: 'standard', owner_id: OWNER_ID });
    expect(rpcCalls).toHaveLength(1);
    expectNoDirectTableAccess();
    expect(sessionDb.rows('admin_audit_logs')).toEqual([
      expect.objectContaining({ actor_id: ACTOR_ID, action_type: CREATE_AUDIT_ACTION, target_id: CREATED_ORG_ID }),
    ]);
  });
});
