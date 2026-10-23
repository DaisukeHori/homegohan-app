// @vitest-environment node
/**
 * #1917 DB の運営の関数が二段階認証の判定 (OPERATOR_MFA_REQUIRED。docs/design/cross/12-operator-mfa.md §11.4 段 E) で止めたとき、
 * その RPC を呼ぶ route は汎用の 500 ではなく、ゲートが二段階認証で止めたときと同じ 403 と日本語の固定の文を返す。
 *
 * 修正前は、強制の譲渡の 2 route が TARGET_NOT_IN_* と NOT_OPERATOR だけを、ロールの更新が FORBIDDEN と
 * CANNOT_MODIFY_OWN_ROLES だけを分け、ほかの route は RPC のエラーをすべて 500 にしていた。route のゲートを通った後で
 * セッションの状態が変わると DB の判定で止まり、二段階認証の確認が要ることが伝わらずに 500 の汎用の文が出た。
 *
 * このテストが確かめること:
 *   1. 判定で止まる関数 (migration の最新の定義から数える) を呼ぶ src のファイルは、どれも operatorMfaRequiredNested を通す
 *   2. その route を全部呼び、RPC が OPERATOR_MFA_REQUIRED で失敗したら 403・route の 403 の code・二段階認証の文になり、
 *      RPC の文面を本文に入れず、監査と通知を出さない (ほかの失敗は従来どおり 500)
 *   3. operatorMfaRequiredNested は OPERATOR_MFA_REQUIRED を語として含むエラーだけを拾う
 *   4. ロールの更新の route は、ゲートが二段階認証で止めたときも同じ文を返す (DB で止まったときと文がそろう)
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import {
  API_FORBIDDEN_CODE,
  API_MFA_ENROLLMENT_REQUIRED_MESSAGE,
  API_MFA_REQUIRED_MESSAGE,
  API_OP_PERMISSION_DENIED_CODE,
  DB_OPERATOR_MFA_REQUIRED_CODE,
  operatorMfaRequiredNested,
} from '@/lib/api/error-responses';
import { INTERNAL_ERROR_CODE } from '@/lib/api/errors';
import { PG_RAISE_EXCEPTION_SQLSTATE } from '@/lib/errors/db-raised-code';

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

const mocks = vi.hoisted(() => {
  const state = { rpcResult: { data: null, error: null } as RpcResult };
  /** service_role の client の読み取り (RPC の前の控え・存在の確認)。どの形の読み取りにも行 1 つ・一覧は空で答える */
  const PRE_READ_ROW = { id: 'abcdef12-3456-4abc-8def-0123456789ab', roles: ['user'], name: '控え', owner_id: null };
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
    requireRole: vi.fn(),
    recordAdminAudit: vi.fn(async (_input: Record<string, unknown>) => undefined),
    sendEmail: vi.fn(),
  };
});

vi.mock('@/lib/auth/operator-permissions', () => ({
  requireSuperAdmin: (...args: unknown[]) => mocks.requireSuperAdmin(...args),
}));

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mocks.requireRole(...args),
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
import * as userRole from '@/app/api/admin/users/[id]/role/route';

const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const SRC_DIR = path.join(REPO_ROOT, 'src');

const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_ERROR = 500;

const ACTOR_ID = 'fedcba98-7654-4fed-8cba-9876543210fe';
const TARGET_ID = 'abcdef12-3456-4abc-8def-0123456789ab';
const NEW_OWNER_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const REASON = '連絡が取れないため';

/** RPC が判定で止めたときの PostgREST のエラー (cross/12 §11.4: P0001・文面はコードそのもの) */
const MFA_RPC_ERROR = { code: PG_RAISE_EXCEPTION_SQLSTATE, message: DB_OPERATOR_MFA_REQUIRED_CODE };
/** 分かるコードを含まない失敗 (従来どおり 500) */
const UNKNOWN_RPC_ERROR = { code: 'XX000', message: 'SOME_UNKNOWN_DB_FAILURE' };

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

interface RouteCase {
  /** src からの route のファイル */
  file: string;
  /** route が呼ぶ RPC (判定で止まる関数) */
  rpc: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  handler: Handler;
  body?: Record<string, unknown>;
  /** route がゲートの 403 に使う code (DB で止まったときも同じ code) */
  forbiddenCode: string;
}

const ROUTES: readonly RouteCase[] = [
  {
    file: 'src/app/api/operator/membership/org/[id]/transfer/route.ts',
    rpc: 'operator_force_owner_transfer',
    method: 'POST',
    handler: orgTransfer.POST as Handler,
    body: { to_user_id: NEW_OWNER_ID, reason: REASON },
    forbiddenCode: API_FORBIDDEN_CODE,
  },
  {
    file: 'src/app/api/operator/membership/family/[id]/transfer/route.ts',
    rpc: 'operator_force_representative_transfer',
    method: 'POST',
    handler: familyTransfer.POST as Handler,
    body: { to_user_id: NEW_OWNER_ID, reason: REASON },
    forbiddenCode: API_FORBIDDEN_CODE,
  },
  {
    file: 'src/app/api/operator/membership/org/[id]/dissolve/route.ts',
    rpc: 'operator_force_dissolve_org',
    method: 'POST',
    handler: orgDissolve.POST as Handler,
    body: { reason: REASON },
    forbiddenCode: API_FORBIDDEN_CODE,
  },
  {
    file: 'src/app/api/operator/membership/family/[id]/dissolve/route.ts',
    rpc: 'operator_force_dissolve_family',
    method: 'POST',
    handler: familyDissolve.POST as Handler,
    body: { reason: REASON },
    forbiddenCode: API_FORBIDDEN_CODE,
  },
  {
    file: 'src/app/api/operator/membership/orgs/inactive/route.ts',
    rpc: 'list_orgs_with_inactive_owner',
    method: 'GET',
    handler: orgsInactive.GET as unknown as Handler,
    forbiddenCode: API_FORBIDDEN_CODE,
  },
  {
    file: 'src/app/api/operator/membership/families/inactive/route.ts',
    rpc: 'list_families_with_inactive_representative',
    method: 'GET',
    handler: familiesInactive.GET as unknown as Handler,
    forbiddenCode: API_FORBIDDEN_CODE,
  },
  {
    file: 'src/app/api/admin/users/[id]/role/route.ts',
    rpc: 'admin_set_user_roles',
    method: 'PATCH',
    handler: userRole.PATCH as unknown as Handler,
    body: { roles: ['user'] },
    forbiddenCode: API_OP_PERMISSION_DENIED_CODE,
  },
  {
    file: 'src/app/api/admin/users/[id]/role/route.ts',
    rpc: 'admin_set_user_roles',
    method: 'PUT',
    handler: userRole.PUT as unknown as Handler,
    body: { roles: ['user'] },
    forbiddenCode: API_OP_PERMISSION_DENIED_CODE,
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
const MFA_RAISE = /RAISE\s+EXCEPTION\s+'OPERATOR_MFA_REQUIRED'/i;

/**
 * 関数の名前 → 最新の定義 (migration のファイル名の順で最後のもの) が判定で止めるか。
 * 戻し口 (.down.sql) は数えない
 */
function latestMfaGatedFunctions(): string[] {
  const latest = new Map<string, boolean>();
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
      latest.set(match[1], MFA_RAISE.test(sql.slice(start, end)));
    });
  }
  return [...latest.entries()].filter(([, gated]) => gated).map(([fn]) => fn).sort();
}

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...sourceFilesUnder(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const RPC_CALL = /\.rpc\(\s*['"](\w+)['"]/g;

/** src のファイル (テストを除く) → そのファイルが呼ぶ、判定で止まる関数 */
function srcCallersOf(gated: readonly string[]): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const file of sourceFilesUnder(SRC_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    const called = [...source.matchAll(RPC_CALL)].map((m) => m[1]).filter((fn) => gated.includes(fn));
    if (called.length > 0) callers.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), called);
  }
  return callers;
}

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
  mocks.requireRole.mockResolvedValue({ id: ACTOR_ID, roles: ['super_admin'] });
  mocks.state.rpcResult = { data: null, error: null };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('判定で止まる関数を呼ぶ src のファイルは、どれも operatorMfaRequiredNested を通す (#1917)', () => {
  const gated = latestMfaGatedFunctions();
  const callers = srcCallersOf(gated);

  it('migration の最新の定義で判定で止める関数は cross/12 §11.4 の 7 本 (増えたら、呼ぶ route の扱いをここで確かめる)', () => {
    expect(gated).toEqual(
      [
        'admin_set_user_roles',
        'list_families_with_inactive_representative',
        'list_orgs_with_inactive_owner',
        'operator_force_dissolve_family',
        'operator_force_dissolve_org',
        'operator_force_owner_transfer',
        'operator_force_representative_transfer',
      ].sort(),
    );
  });

  it('呼んでいる src のファイルの一覧は、下で呼んで確かめる route の一覧と同じ', () => {
    const tested = new Map<string, Set<string>>();
    for (const route of ROUTES) tested.set(route.file, (tested.get(route.file) ?? new Set()).add(route.rpc));
    expect([...callers.keys()].sort()).toEqual([...tested.keys()].sort());
    for (const [file, fns] of callers) expect([...new Set(fns)].sort()).toEqual([...(tested.get(file) ?? [])].sort());
  });

  it('呼んでいるファイルは operatorMfaRequiredNested を呼ぶ', () => {
    for (const file of callers.keys()) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, file).toMatch(/operatorMfaRequiredNested\(/);
    }
  });
});

describe.each(ROUTES.map((route) => [`${route.method} ${route.file}`, route] as const))(
  '%s: RPC が DB の二段階認証の判定で止まる',
  (_label, route) => {
    it('403・route の 403 の code・二段階認証の文を返し、RPC の文面を本文に入れず、監査と通知を出さない', async () => {
      mocks.state.rpcResult = { data: null, error: MFA_RPC_ERROR };

      const res = await call(route);

      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      expect(mocks.rpc.mock.calls[0][0]).toBe(route.rpc);
      expect(res.status).toBe(HTTP_FORBIDDEN);
      expect(res.body.error).toEqual({ code: route.forbiddenCode, message: API_MFA_REQUIRED_MESSAGE });
      expect(res.text).not.toContain(DB_OPERATOR_MFA_REQUIRED_CODE);
      expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    });

    it('前後に文が付いた文面 (ERROR: OPERATOR_MFA_REQUIRED) も同じ 403', async () => {
      mocks.state.rpcResult = { data: null, error: { message: `ERROR: ${DB_OPERATOR_MFA_REQUIRED_CODE}` } };

      const res = await call(route);

      expect(res.status).toBe(HTTP_FORBIDDEN);
      expect(res.body.error?.message).toBe(API_MFA_REQUIRED_MESSAGE);
    });

    it('分かるコードを含まない失敗は従来どおり 500 (判定は OPERATOR_MFA_REQUIRED だけを拾う)', async () => {
      mocks.state.rpcResult = { data: null, error: UNKNOWN_RPC_ERROR };

      const res = await call(route);

      expect(res.status).toBe(HTTP_INTERNAL_ERROR);
      expect(res.body.error?.message).not.toBe(API_MFA_REQUIRED_MESSAGE);
      expect(res.text).not.toContain(UNKNOWN_RPC_ERROR.message);
      expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
    });
  },
);

describe('operatorMfaRequiredNested (#1917)', () => {
  it('OPERATOR_MFA_REQUIRED を語として含むエラーだけを拾う', () => {
    expect(operatorMfaRequiredNested(null)).toBeNull();
    expect(operatorMfaRequiredNested(undefined)).toBeNull();
    expect(operatorMfaRequiredNested({ message: 'NOT_OPERATOR' })).toBeNull();
    expect(operatorMfaRequiredNested({ message: 'X_OPERATOR_MFA_REQUIRED' })).toBeNull();
    expect(operatorMfaRequiredNested({ message: null })).toBeNull();
    expect(operatorMfaRequiredNested(MFA_RPC_ERROR)?.status).toBe(HTTP_FORBIDDEN);
  });

  it.each([
    ['http', undefined, API_FORBIDDEN_CODE],
    ['error', 'error' as const, 'AUTH_2FA_REQUIRED'],
    ['fixed', { fixed: API_OP_PERMISSION_DENIED_CODE }, API_OP_PERMISSION_DENIED_CODE],
  ])('code の選び方 %s: ゲートの二段階認証の確認 (AUTH_2FA_REQUIRED) と同じ code と文', async (_name, code, expected) => {
    const res = operatorMfaRequiredNested(MFA_RPC_ERROR, code === undefined ? {} : { code });
    expect(res?.status).toBe(HTTP_FORBIDDEN);
    expect(await res?.json()).toEqual({ error: { code: expected, message: API_MFA_REQUIRED_MESSAGE } });
  });

  it('ヘッダを渡せる', () => {
    const res = operatorMfaRequiredNested(MFA_RPC_ERROR, { headers: { 'Cache-Control': 'no-store' } });
    expect(res?.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('PATCH / PUT /api/admin/users/{id}/role: ゲートが二段階認証で止めたときも同じ文 (#1917)', () => {
  const roleRoutes = ROUTES.filter((route) => route.rpc === 'admin_set_user_roles');

  it.each(
    roleRoutes.flatMap((route) => [
      [route.method, route, new MfaRequiredError('AUTH_2FA_REQUIRED', 'AAL2 required'), API_MFA_REQUIRED_MESSAGE] as const,
      [
        route.method,
        route,
        new MfaRequiredError('AUTH_2FA_ENROLLMENT_REQUIRED', 'enrollment required'),
        API_MFA_ENROLLMENT_REQUIRED_MESSAGE,
      ] as const,
      [route.method, route, new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'), '権限がありません'] as const,
    ]),
  )('%s: requireRole が %s を投げたら 403 OP_PERMISSION_DENIED と固定の文', async (_method, route, err, message) => {
    mocks.requireRole.mockRejectedValue(err);

    const res = await call(route);

    expect(res.status).toBe(HTTP_FORBIDDEN);
    expect(res.body.error).toEqual({ code: API_OP_PERMISSION_DENIED_CODE, message });
    expect(res.text).not.toContain(err.message);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('500 の code は従来のまま (route ごとの汎用の 500)', () => {
  it('運営の route の 500 は INTERNAL_ERROR の code', async () => {
    mocks.state.rpcResult = { data: null, error: UNKNOWN_RPC_ERROR };
    const res = await call(ROUTES[0]);
    expect(res.body.error?.code).toBe(INTERNAL_ERROR_CODE);
  });
});
