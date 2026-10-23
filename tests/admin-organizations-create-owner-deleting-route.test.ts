/**
 * #1917 の続き (D73): 運営の組織の作成 POST /api/admin/organizations が、退会の途中の人をオーナーにしない (route のテスト)。
 *
 * 退会 (src/lib/account-deletion.ts の deleteAccount) は findBlocker の前に退会の印 (begin_account_deletion_guard) を付ける。
 * 印のある人を owner_id にする organizations の INSERT は、DB のトリガー organizations_owner_not_deleting が
 * 'OWNER_ACCOUNT_DELETING' (P0001) で止める (supabase/migrations/20261023130000_account_deletion_owner_guard.sql。
 * 実 DB では tests/integration/security/account-deletion-owner-guard.test.ts)。
 * ここでは、その止めを route が 409 OWNER_ACCOUNT_DELETING (日本語の固定の文) にし、席の行・オーナーの所属・監査を書かないことを確かめる。
 *
 *  - P0001 + メッセージ 'OWNER_ACCOUNT_DELETING' → 409 OWNER_ACCOUNT_DELETING。org_license_pools・user_profiles・admin_audit_logs に書かない
 *  - P0001 でもほかのメッセージ、ほかの SQLSTATE で同じメッセージ → 従来どおり 500 INTERNAL_ERROR (取り違えない)
 *  - 止められなければ従来どおり作る (組織・席の行・オーナーの所属・監査)
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
/** service_role の client が見る DB */
let serviceDb: SchemaDb;
/** 設定すると、service_role の organizations の INSERT を DB に送らず、このエラーで返す (DB のトリガーの止めの再現) */
let organizationInsertFault: DbError | null = null;

function faultingFrom(table: string) {
  const query = serviceDb.from(table);
  if (table !== 'organizations') return query;
  const insert = query.insert.bind(query);
  query.insert = (values) => {
    const fault = organizationInsertFault;
    if (!fault) return insert(values);
    const failed = { data: null, error: fault, count: null };
    const chain = {
      select: () => chain,
      single: async () => failed,
      maybeSingle: async () => failed,
      then: (resolve: (value: typeof failed) => unknown) => Promise.resolve(failed).then(resolve),
    };
    return chain as unknown as ReturnType<typeof insert>;
  };
  return query;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser),
  getSupabaseAdmin: () => ({ ...makeClient(serviceDb, null), from: faultingFrom }),
}));

const route = await import('@/app/api/admin/organizations/route');

const ACTOR_ID = uuid(1);
const OWNER_ID = uuid(2);
const ORG_NAME = '退会の途中のテスト組織';
/** DB 関数・トリガーが RAISE EXCEPTION ... USING ERRCODE = 'P0001' で止めたときの SQLSTATE */
const PG_RAISE_EXCEPTION = 'P0001';
const OWNER_ACCOUNT_DELETING = 'OWNER_ACCOUNT_DELETING';
const CREATE_AUDIT_ACTION = 'admin.organization.create';

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
const ownerProfile = () => serviceDb.rows('user_profiles').find((row) => row.id === OWNER_ID);

beforeEach(() => {
  organizationInsertFault = null;
  setup();
});

describe('POST /api/admin/organizations: 退会の途中の人をオーナーにしない (#1917 の続き)', () => {
  it('DB が OWNER_ACCOUNT_DELETING (P0001) で止めたら 409 OWNER_ACCOUNT_DELETING。席の行・オーナーの所属・監査を書かない', async () => {
    organizationInsertFault = { code: PG_RAISE_EXCEPTION, message: OWNER_ACCOUNT_DELETING };
    const res = await post({ name: ORG_NAME, owner_id: OWNER_ID });

    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({
      error: { code: OWNER_ACCOUNT_DELETING, message: '指定した owner は退会の手続き中です' },
    });
    expect(serviceDb.rows('organizations')).toEqual([]);
    expect(serviceDb.recorded('org_license_pools')).toHaveLength(0);
    expect(serviceDb.recorded('user_profiles', 'update')).toHaveLength(0);
    expect(ownerProfile()).toMatchObject({ organization_id: null, org_role: null });
    expect(sessionDb.rows('admin_audit_logs')).toEqual([]);
  });

  it.each([
    ['P0001 でもほかのコード', { code: PG_RAISE_EXCEPTION, message: 'CONFLICT_RETRY' }],
    ['ほかの SQLSTATE で同じ文', { code: '23505', message: OWNER_ACCOUNT_DELETING }],
    ['SQLSTATE が無い', { message: OWNER_ACCOUNT_DELETING }],
  ])('%s の失敗は従来どおり 500 INTERNAL_ERROR (409 と取り違えない)', async (_label, fault: DbError) => {
    organizationInsertFault = fault;
    const res = await post({ name: ORG_NAME, owner_id: OWNER_ID });

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: { code: 'INTERNAL_ERROR', message: '組織の作成に失敗しました' } });
    expect(serviceDb.recorded('user_profiles', 'update')).toHaveLength(0);
    expect(sessionDb.rows('admin_audit_logs')).toEqual([]);
  });

  it('止められなければ従来どおり作る: 組織・席の行・オーナーの所属 (owner)・監査 1 行', async () => {
    const res = await post({ name: ORG_NAME, owner_id: OWNER_ID });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.organization).toMatchObject({ name: ORG_NAME, plan: 'standard', owner_id: OWNER_ID });
    const orgId = body.organization.id as string;
    expect(serviceDb.rows('organizations')).toEqual([expect.objectContaining({ id: orgId, owner_id: OWNER_ID })]);
    expect(serviceDb.rows('org_license_pools')).toEqual([
      expect.objectContaining({ organization_id: orgId, total_licenses: null, used_licenses: 0 }),
    ]);
    expect(ownerProfile()).toMatchObject({ organization_id: orgId, org_role: 'owner' });
    expect(sessionDb.rows('admin_audit_logs')).toEqual([
      expect.objectContaining({ actor_id: ACTOR_ID, action_type: CREATE_AUDIT_ACTION, target_id: orgId }),
    ]);
  });
});
