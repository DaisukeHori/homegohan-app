// @vitest-environment node
/**
 * #1917 の続き: 運営の membership の route が、RPC の既知のエラー (RAISE EXCEPTION '<コード>') を汎用の 500 で返さない
 *
 * 修正前は、運営の強制解散と放置の一覧の route が、二段階認証の判定 (OPERATOR_MFA_REQUIRED) 以外の RPC のエラーをすべて
 * internalError の 500 にしていた。解散済みの組織をもう一度解散しようとすると 409 でなく 500 になり、運営の画面
 * (本文の error.message をそのまま出す) に理由が出なかった。
 *
 * このテストが確かめること:
 *   1. src/lib/membership/operator-rpc-errors.ts の表 (RPC → RAISE するコード) が、migration の最新の定義の RAISE と一致する
 *   2. 運営の membership の route が呼ぶ RPC の最新の定義が RAISE するコードは、どれも 4xx になる (500 にならない)。
 *      RPC にコードが増えたら、ここが赤くなる
 *   3. 強制解散の組織の route: ORG_ALREADY_DISSOLVED は 409・ORG_NOT_FOUND は 404・権限の判定は 403。本文は日本語の固定の文で、
 *      RPC の文面を入れず、監査と通知を出さない
 *   4. 分からない失敗は従来どおり 500
 *   5. operatorMembershipRpcErrorNested は、RPC の表に載ったコードだけを語として拾う
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_FORBIDDEN_CODE, API_FORBIDDEN_MESSAGE, DB_OPERATOR_MFA_REQUIRED_CODE } from '@/lib/api/error-responses';
import { INTERNAL_ERROR_CODE } from '@/lib/api/errors';
import { PG_RAISE_EXCEPTION_SQLSTATE } from '@/lib/errors/db-raised-code';
import { ErrorStatusMap, MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';
import {
  OPERATOR_MEMBERSHIP_RPC_RAISED_CODES,
  operatorMembershipRpcErrorNested,
  type OperatorMembershipRpcName,
} from '@/lib/membership/operator-rpc-errors';

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

const mocks = vi.hoisted(() => {
  const state = { rpcResult: { data: null, error: null } as RpcResult };
  /** service_role の client の読み取り (RPC の前の控え)。どの形の読み取りにも行 1 つ・一覧は空で答える */
  const PRE_READ_ROW = { id: 'abcdef12-3456-4abc-8def-0123456789ab', name: '控え', owner_id: null };
  function query(): Record<string, unknown> {
    const q: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'neq', 'is', 'order', 'limit']) q[method] = () => q;
    q.single = async () => ({ data: PRE_READ_ROW, error: null });
    q.maybeSingle = async () => ({ data: PRE_READ_ROW, error: null });
    q.then = (resolve: (value: { data: unknown[]; error: null }) => unknown) => resolve({ data: [], error: null });
    return q;
  }
  return {
    state,
    rpc: vi.fn(async (_fn: string, _args?: Record<string, unknown>) => state.rpcResult),
    adminFrom: vi.fn((_table: string) => query()),
    requireSuperAdmin: vi.fn(),
    recordAdminAudit: vi.fn(async (_input: Record<string, unknown>) => undefined),
    sendEmail: vi.fn(),
  };
});

vi.mock('@/lib/auth/operator-permissions', () => ({
  requireSuperAdmin: (...args: unknown[]) => mocks.requireSuperAdmin(...args),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      throw new Error(`本人の client で表を読んだ (RPC が失敗した後は何も読まない): ${table}`);
    },
  }),
  getSupabaseAdmin: () => ({ from: mocks.adminFrom }),
}));

vi.mock('@/lib/admin/audit', () => ({
  recordAdminAudit: (input: Record<string, unknown>) => mocks.recordAdminAudit(input),
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: (...args: unknown[]) => mocks.sendEmail(...args),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withUser: () => logger };
  return { createLogger: () => logger, generateRequestId: () => 'req_test' };
});

import * as orgTransfer from '@/app/api/operator/membership/org/[id]/transfer/route';
import * as familyTransfer from '@/app/api/operator/membership/family/[id]/transfer/route';
import * as orgDissolve from '@/app/api/operator/membership/org/[id]/dissolve/route';
import * as familyDissolve from '@/app/api/operator/membership/family/[id]/dissolve/route';
import * as orgsInactive from '@/app/api/operator/membership/orgs/inactive/route';
import * as familiesInactive from '@/app/api/operator/membership/families/inactive/route';

const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const OPERATOR_MEMBERSHIP_API_DIR = path.join(REPO_ROOT, 'src', 'app', 'api', 'operator', 'membership');

const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_INTERNAL_ERROR = 500;

const ACTOR_ID = 'fedcba98-7654-4fed-8cba-9876543210fe';
const TARGET_ID = 'abcdef12-3456-4abc-8def-0123456789ab';
const NEW_OWNER_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const REASON = '連絡が取れないため';

/** RPC が RAISE EXCEPTION '<コード>' USING ERRCODE = 'P0001' で止めたときの PostgREST のエラー */
function raised(code: string): { code: string; message: string } {
  return { code: PG_RAISE_EXCEPTION_SQLSTATE, message: code };
}
/** 分かるコードを含まない失敗 (従来どおり 500) */
const UNKNOWN_RPC_ERROR = { code: 'XX000', message: 'SOME_UNKNOWN_DB_FAILURE' };

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

interface RouteCase {
  /** リポジトリからの route のファイル */
  file: string;
  /** route が呼ぶ RPC */
  rpc: string;
  method: 'GET' | 'POST';
  handler: Handler;
  body?: Record<string, unknown>;
}

const ROUTES: readonly RouteCase[] = [
  {
    file: 'src/app/api/operator/membership/org/[id]/transfer/route.ts',
    rpc: 'operator_force_owner_transfer',
    method: 'POST',
    handler: orgTransfer.POST as Handler,
    body: { to_user_id: NEW_OWNER_ID, reason: REASON },
  },
  {
    file: 'src/app/api/operator/membership/family/[id]/transfer/route.ts',
    rpc: 'operator_force_representative_transfer',
    method: 'POST',
    handler: familyTransfer.POST as Handler,
    body: { to_user_id: NEW_OWNER_ID, reason: REASON },
  },
  {
    file: 'src/app/api/operator/membership/org/[id]/dissolve/route.ts',
    rpc: 'operator_force_dissolve_org',
    method: 'POST',
    handler: orgDissolve.POST as Handler,
    body: { reason: REASON },
  },
  {
    file: 'src/app/api/operator/membership/family/[id]/dissolve/route.ts',
    rpc: 'operator_force_dissolve_family',
    method: 'POST',
    handler: familyDissolve.POST as Handler,
    body: { reason: REASON },
  },
  {
    file: 'src/app/api/operator/membership/orgs/inactive/route.ts',
    rpc: 'list_orgs_with_inactive_owner',
    method: 'GET',
    handler: orgsInactive.GET as unknown as Handler,
  },
  {
    file: 'src/app/api/operator/membership/families/inactive/route.ts',
    rpc: 'list_families_with_inactive_representative',
    method: 'GET',
    handler: familiesInactive.GET as unknown as Handler,
  },
];

/** SQL の `-- ...` の行のコメントを取り除く (コメントの中の RAISE の例を数えない) */
function stripSqlLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const FUNCTION_HEADER = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"?public"?\."?(\w+)"?\s*\(/gi;
/** 業務のコードの RAISE (文面がコードの語だけのもの。'claim_email_outbox: invalid ...' のような説明の文は数えない) */
const CODE_RAISE = /RAISE\s+EXCEPTION\s+'([A-Z][A-Z0-9_]*)'/g;

/** 関数の名前 → 最新の定義 (migration のファイル名の順で最後のもの) が RAISE する業務のコード。戻し口 (.down.sql) は数えない */
function latestRaisedCodes(): Map<string, Set<string>> {
  const latest = new Map<string, Set<string>>();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
  for (const name of files) {
    const sql = stripSqlLineComments(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
    const headers = [...sql.matchAll(FUNCTION_HEADER)];
    headers.forEach((match, i) => {
      const start = match.index ?? 0;
      const end = i + 1 < headers.length ? (headers[i + 1].index ?? sql.length) : sql.length;
      latest.set(match[1], new Set([...sql.slice(start, end).matchAll(CODE_RAISE)].map((m) => m[1])));
    });
  }
  return latest;
}

function routeFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFilesUnder(full));
    else if (entry.name === 'route.ts') out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

const RPC_CALL = /\.rpc\(\s*['"](\w+)['"]/g;

async function call(route: RouteCase) {
  const url = `http://localhost:3000/api/test/${TARGET_ID}`;
  const init: { method: string; headers?: Record<string, string>; body?: string } = { method: route.method };
  if (route.body) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(route.body);
  }
  const res = await route.handler(new NextRequest(url, init), { params: Promise.resolve({ id: TARGET_ID }) });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as { error?: { code?: string; message?: string } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSuperAdmin.mockResolvedValue({ userId: ACTOR_ID });
  mocks.state.rpcResult = { data: null, error: null };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const RAISED = latestRaisedCodes();

describe('RPC が RAISE するコードの表は migration の最新の定義と一致する', () => {
  it.each(Object.keys(OPERATOR_MEMBERSHIP_RPC_RAISED_CODES) as OperatorMembershipRpcName[])('%s', (rpc) => {
    const known = OPERATOR_MEMBERSHIP_RPC_RAISED_CODES[rpc];
    const expected = [known.permission, DB_OPERATOR_MFA_REQUIRED_CODE, ...known.membership].sort();
    expect(RAISED.has(rpc)).toBe(true);
    expect([...(RAISED.get(rpc) ?? [])].sort()).toEqual(expected);
  });

  it('表の業務のコードは、どれも membership-errors の表で 4xx', () => {
    for (const known of Object.values(OPERATOR_MEMBERSHIP_RPC_RAISED_CODES)) {
      for (const code of known.membership) {
        expect(ErrorStatusMap[code]).toBeGreaterThanOrEqual(HTTP_CLIENT_ERROR_MIN);
        expect(ErrorStatusMap[code]).toBeLessThan(HTTP_SERVER_ERROR_MIN);
      }
    }
  });
});

describe('運営の membership の route が呼ぶ RPC の既知のコードは、どれも 500 にならない', () => {
  it('RPC を呼ぶ route の一覧は、下で呼んで確かめる route の一覧と同じ', () => {
    const callers = new Map<string, string[]>();
    for (const file of routeFilesUnder(OPERATOR_MEMBERSHIP_API_DIR)) {
      const called = [...fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').matchAll(RPC_CALL)].map((m) => m[1]);
      if (called.length > 0) callers.set(file, called);
    }
    expect([...callers.keys()].sort()).toEqual(ROUTES.map((route) => route.file).sort());
    for (const route of ROUTES) expect(callers.get(route.file)).toEqual([route.rpc]);
  });

  const cases = ROUTES.flatMap((route) =>
    [...(RAISED.get(route.rpc) ?? [])].sort().map((code) => [`${route.method} ${route.file}`, code, route] as const),
  );

  it('どの route の RPC も、RAISE するコードが 1 つ以上ある (migration の読み取りが空になっていない)', () => {
    for (const route of ROUTES) expect((RAISED.get(route.rpc)?.size ?? 0) > 0, route.rpc).toBe(true);
  });

  it.each(cases)('%s: %s は 4xx・日本語の文・RPC の文面を本文に入れず、監査と通知を出さない', async (_label, code, route) => {
    mocks.state.rpcResult = { data: null, error: raised(code) };

    const res = await call(route);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(res.status).toBeGreaterThanOrEqual(HTTP_CLIENT_ERROR_MIN);
    expect(res.status).toBeLessThan(HTTP_SERVER_ERROR_MIN);
    expect(res.body.error?.code).not.toBe(INTERNAL_ERROR_CODE);
    expect(res.body.error?.message).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/operator/membership/org/{id}/dissolve: RPC の既知のエラー', () => {
  const route = ROUTES.find((r) => r.rpc === 'operator_force_dissolve_org') as RouteCase;

  it.each([
    [MembershipErrorCode.ORG_ALREADY_DISSOLVED, HTTP_CONFLICT],
    [MembershipErrorCode.ORG_NOT_FOUND, HTTP_NOT_FOUND],
  ])('%s は %i・code はそのまま・membership-errors の日本語の固定の文', async (code, status) => {
    mocks.state.rpcResult = { data: null, error: raised(code) };

    const res = await call(route);

    expect(res.status).toBe(status);
    expect(res.body.error).toEqual({ code, message: MEMBERSHIP_ERROR_MESSAGES[code] });
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('解散済みの組織の 409 の文は「すでに解散しています」(運営の画面にそのまま出る)', async () => {
    mocks.state.rpcResult = { data: null, error: raised(MembershipErrorCode.ORG_ALREADY_DISSOLVED) };

    const res = await call(route);

    expect(res.body.error?.message).toBe('この組織はすでに解散しています。');
  });

  it('前後に文が付いた文面 (ERROR: ORG_ALREADY_DISSOLVED) も 409', async () => {
    mocks.state.rpcResult = { data: null, error: { message: `ERROR: ${MembershipErrorCode.ORG_ALREADY_DISSOLVED}` } };

    const res = await call(route);

    expect(res.status).toBe(HTTP_CONFLICT);
    expect(res.body.error?.code).toBe(MembershipErrorCode.ORG_ALREADY_DISSOLVED);
  });

  it('権限の判定 (OPERATOR_PERMISSION_REQUIRED) は 403 FORBIDDEN とゲートと同じ文', async () => {
    mocks.state.rpcResult = { data: null, error: raised('OPERATOR_PERMISSION_REQUIRED') };

    const res = await call(route);

    expect(res.status).toBe(HTTP_FORBIDDEN);
    expect(res.body.error).toEqual({ code: API_FORBIDDEN_CODE, message: API_FORBIDDEN_MESSAGE });
    expect(res.text).not.toContain('OPERATOR_PERMISSION_REQUIRED');
  });
});

describe.each([
  ['POST', 'operator_force_dissolve_family', 'NOT_OPERATOR'],
  ['GET', 'list_orgs_with_inactive_owner', 'INSUFFICIENT_PERMISSION'],
  ['GET', 'list_families_with_inactive_representative', 'INSUFFICIENT_PERMISSION'],
] as const)('%s (%s): 権限の判定', (_method, rpc, permissionCode) => {
  const route = ROUTES.find((r) => r.rpc === rpc) as RouteCase;

  it(`${permissionCode} は 403 FORBIDDEN とゲートと同じ文 (RPC の文面を本文に入れない)`, async () => {
    mocks.state.rpcResult = { data: null, error: raised(permissionCode) };

    const res = await call(route);

    expect(res.status).toBe(HTTP_FORBIDDEN);
    expect(res.body.error).toEqual({ code: API_FORBIDDEN_CODE, message: API_FORBIDDEN_MESSAGE });
    expect(res.text).not.toContain(permissionCode);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe.each(ROUTES.map((route) => [`${route.method} ${route.file}`, route] as const))('%s: 分からない失敗', (_label, route) => {
  it('従来どおり 500 INTERNAL_ERROR で、RPC の文面を本文に入れない', async () => {
    mocks.state.rpcResult = { data: null, error: UNKNOWN_RPC_ERROR };

    const res = await call(route);

    expect(res.status).toBe(HTTP_INTERNAL_ERROR);
    expect(res.body.error?.code).toBe(INTERNAL_ERROR_CODE);
    expect(res.text).not.toContain(UNKNOWN_RPC_ERROR.message);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe('operatorMembershipRpcErrorNested', () => {
  it('エラーが無ければ null', () => {
    expect(operatorMembershipRpcErrorNested('operator_force_dissolve_org', null)).toBeNull();
    expect(operatorMembershipRpcErrorNested('operator_force_dissolve_org', undefined)).toBeNull();
    expect(operatorMembershipRpcErrorNested('operator_force_dissolve_org', { message: null })).toBeNull();
  });

  it('その RPC の表に無いコードは拾わない (ほかの RPC の権限の語・業務のコード・MFA)', () => {
    // 家族の強制解散の RPC は ORG_ALREADY_DISSOLVED も OPERATOR_PERMISSION_REQUIRED も RAISE しない
    expect(operatorMembershipRpcErrorNested('operator_force_dissolve_family', raised('ORG_ALREADY_DISSOLVED'))).toBeNull();
    expect(operatorMembershipRpcErrorNested('operator_force_dissolve_family', raised('OPERATOR_PERMISSION_REQUIRED'))).toBeNull();
    expect(operatorMembershipRpcErrorNested('operator_force_dissolve_org', raised('NOT_OPERATOR'))).toBeNull();
    expect(operatorMembershipRpcErrorNested('list_orgs_with_inactive_owner', raised('ORG_NOT_FOUND'))).toBeNull();
    // 二段階認証の判定は route が operatorMfaRequiredNested で先に拾う
    expect(operatorMembershipRpcErrorNested('operator_force_dissolve_org', raised(DB_OPERATOR_MFA_REQUIRED_CODE))).toBeNull();
  });

  it('コードは語の境界で照合する (部分文字列では拾わない)', () => {
    expect(operatorMembershipRpcErrorNested('operator_force_dissolve_org', raised('X_ORG_NOT_FOUND'))).toBeNull();
    expect(operatorMembershipRpcErrorNested('operator_force_dissolve_org', raised('ORG_ALREADY_DISSOLVED_X'))).toBeNull();
    expect(operatorMembershipRpcErrorNested('operator_force_dissolve_family', raised('NOT_OPERATOR_X'))).toBeNull();
  });

  it('既知のコードは status と本文を返す', async () => {
    const res = operatorMembershipRpcErrorNested('operator_force_dissolve_org', raised('ORG_ALREADY_DISSOLVED'));
    expect(res?.status).toBe(HTTP_CONFLICT);
    expect(await res?.json()).toEqual({
      error: {
        code: MembershipErrorCode.ORG_ALREADY_DISSOLVED,
        message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.ORG_ALREADY_DISSOLVED],
      },
    });
  });
});
