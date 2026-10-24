/**
 * #1917 PATCH / PUT /api/admin/users/{id}/role — 監査 admin.user.role_change の details.previous_roles は、
 * admin_set_user_roles が対象の行をロックして読んだ変える前の roles (戻り値の previous_roles) であること。
 *
 * 修正前は route が RPC の前にロックを取らずに読んだ user_profiles.roles を previous_roles に残していた。
 * super_admin 2 人がほぼ同時に同じ利用者のロールを変えると、後の変更の監査に、先の変更より前の値が残った。
 * ここでは「先に読んだ値」と「RPC の戻り値」を別の値にして、監査がどちらを残すかを見る。
 * 実 DB での並び (ロックで待ち、先の変更の後の値を返す) は tests/integration/security/admin-set-user-roles-previous-roles.test.ts。
 */
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

type RpcResult = { data: unknown; error: { message: string } | null };

const mocks = vi.hoisted(() => {
  const state = {
    /** route が RPC の前に service_role で読む roles (ロックの外で読んだ値) */
    preReadRoles: ['user'] as string[] | null,
    rpcResult: { data: null, error: null } as RpcResult,
  };
  const adminClient = {
    from: vi.fn(() => ({
      select: () => ({
        eq: (...args: [string, string]) => ({
          single: async () => ({ data: { id: args[1], roles: state.preReadRoles }, error: null }),
        }),
      }),
    })),
  };
  const userClient = {
    rpc: vi.fn<(fn: string, args: Record<string, unknown>) => Promise<RpcResult>>(async () => state.rpcResult),
  };
  return {
    state,
    adminClient,
    userClient,
    requireRole: vi.fn(),
    recordAdminAudit: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => undefined),
  };
});

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mocks.requireRole(...args),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => mocks.userClient,
  getSupabaseAdmin: () => mocks.adminClient,
}));

vi.mock('@/lib/admin/audit', () => ({
  recordAdminAudit: (input: Record<string, unknown>) => mocks.recordAdminAudit(input),
}));

import { PATCH, PUT } from '@/app/api/admin/users/[id]/role/route';

const ACTOR_ID = 'fedcba98-7654-4fed-8cba-9876543210fe';
const TARGET_ID = 'abcdef12-3456-4abc-8def-0123456789ab';
const NEW_ROLES = ['user', 'finance'];

async function call(handler: typeof PATCH) {
  const request = new Request(`http://localhost:3000/api/admin/users/${TARGET_ID}/role`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roles: NEW_ROLES }),
  });
  const response = await handler(request, { params: Promise.resolve({ id: TARGET_ID }) });
  return { status: response.status, body: (await response.json()) as { data?: unknown; error?: { code: string } } };
}

function auditDetails(): Record<string, unknown> {
  expect(mocks.recordAdminAudit).toHaveBeenCalledTimes(1);
  const input = mocks.recordAdminAudit.mock.calls[0][0];
  expect(input).toMatchObject({ actionType: 'admin.user.role_change', targetId: TARGET_ID, actorId: ACTOR_ID });
  return input.details as Record<string, unknown>;
}

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({ id: ACTOR_ID, roles: ['super_admin'] });
  mocks.state.preReadRoles = ['user'];
  mocks.state.rpcResult = { data: null, error: null };
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe.each([
  ['PATCH', PATCH],
  ['PUT', PUT],
] as const)('%s /api/admin/users/{id}/role の監査の previous_roles (#1917)', (_method, handler) => {
  it('RPC の戻り値の previous_roles を残す (先に読んだ roles と違っても、先に読んだ値は使わない)', async () => {
    // 先に読んだときは ['user'] だったが、RPC がロックを取るまでに別の super_admin が ['user', 'admin'] に変えていた
    mocks.state.preReadRoles = ['user'];
    mocks.state.rpcResult = {
      data: [{ id: TARGET_ID, roles: NEW_ROLES, previous_roles: ['user', 'admin'] }],
      error: null,
    };

    const res = await call(handler);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { success: true, roles: NEW_ROLES } });
    expect(mocks.userClient.rpc).toHaveBeenCalledWith('admin_set_user_roles', { p_user_id: TARGET_ID, p_roles: NEW_ROLES });
    expect(auditDetails()).toEqual({ previous_roles: ['user', 'admin'], new_roles: NEW_ROLES });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('RPC が previous_roles を NULL で返したら NULL を残す (対象の roles が NULL だった)', async () => {
    mocks.state.preReadRoles = ['user'];
    mocks.state.rpcResult = { data: [{ id: TARGET_ID, roles: NEW_ROLES, previous_roles: null }], error: null };

    const res = await call(handler);

    expect(res.status).toBe(200);
    expect(auditDetails()).toEqual({ previous_roles: null, new_roles: NEW_ROLES });
  });

  it.each([
    ['戻り値が null', null],
    ['previous_roles の無い行 (#1917 の migration の前の定義)', [{ id: TARGET_ID, roles: NEW_ROLES }]],
    ['行が 0 件', []],
    ['行が 2 件', [{ previous_roles: ['user'] }, { previous_roles: ['admin'] }]],
  ])('戻り値の形が違う (%s) ときは、先に読んだ roles を残してログに出し、応答は 200 のまま', async (_label, data) => {
    mocks.state.preReadRoles = ['user', 'support'];
    mocks.state.rpcResult = { data, error: null };

    const res = await call(handler);

    expect(res.status).toBe(200);
    expect(auditDetails()).toEqual({ previous_roles: ['user', 'support'], new_roles: NEW_ROLES });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('previous_roles');
  });

  it('RPC が失敗したら監査を残さない (USER_NOT_FOUND は 404)', async () => {
    mocks.state.rpcResult = { data: null, error: { message: 'USER_NOT_FOUND' } };

    const res = await call(handler);

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  // RPC が RAISE EXCEPTION したコードの判定は src/lib/errors/db-raised-code.ts の dbErrorMentionsCode で行う (#1917)
  it.each([
    ['FORBIDDEN', 403, 'OP_PERMISSION_DENIED'],
    ['CANNOT_MODIFY_OWN_ROLES', 403, 'OP_PERMISSION_DENIED'],
    ['ERROR: USER_NOT_FOUND', 404, 'NOT_FOUND'],
    // DB の二段階認証の判定 (OPERATOR_MFA_REQUIRED) は、ゲートの二段階認証と同じ 403 (code は OP_PERMISSION_DENIED。文は
    // tests/operator-mfa-db-gate-routes-403.test.ts が確かめる)。汎用の 500 にしない
    ['OPERATOR_MFA_REQUIRED', 403, 'OP_PERMISSION_DENIED'],
    // 分かるコードを含まない RAISE は、汎用の 500
    ['SOME_UNKNOWN_DB_FAILURE', 500, 'INTERNAL_ERROR'],
  ])('RPC が %s で失敗: %i %s を返し、RPC の文面を本文に入れず、監査を残さない', async (message, status, code) => {
    mocks.state.rpcResult = { data: null, error: { message } };

    const res = await call(handler);

    expect(res.status).toBe(status);
    expect(res.body.error?.code).toBe(code);
    expect(JSON.stringify(res.body)).not.toContain(message);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });
});
