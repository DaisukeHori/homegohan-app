/**
 * #1707 PATCH / PUT /api/admin/users/{id}/role — 自分の id の判定が大文字小文字を区別しないこと
 *
 * auth.getUser() の id (= requireRole の戻りの id) は小文字。パスの id は利用者が大文字にして送れる。
 * Postgres の uuid は大文字小文字を区別せずに比べるので、JS の `===` のまま比べると、大文字にした自分の UUID が
 * route の自分の判定 (403 OP_SELF_MODIFY) をすり抜けて DB に届く。route はパスの id を UUID の形なら小文字にそろえ、
 * 自分の判定・対象の読み取り・RPC・監査に同じ 1 つの値を使う。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const targetSelect = vi.fn();
  const adminClient = {
    from: vi.fn((table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => ({
          single: async () => {
            targetSelect(table, columns, column, value);
            return { data: { id: value, roles: ['user'] }, error: null };
          },
        }),
      }),
    })),
  };
  const userClient = {
    // admin_set_user_roles の戻り値は 1 行 (#1917: 変える前の roles を previous_roles で返す)
    rpc: vi.fn<(fn: string, args: Record<string, unknown>) => Promise<{ data: Array<{ previous_roles: string[] }>; error: null }>>(
      async () => ({ data: [{ previous_roles: ['user'] }], error: null }),
    ),
  };
  return {
    adminClient,
    userClient,
    targetSelect,
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

/** 16 進の英字を含む実行者の id (数字だけの UUID は大文字にしても変わらないので、英字を含む値で見る) */
const ACTOR_ID = 'fedcba98-7654-4fed-8cba-9876543210fe';
const ACTOR_ID_MIXED = 'FEDcba98-7654-4FeD-8cBA-9876543210Fe';
const TARGET_ID_LOWER = 'abcdef12-3456-4abc-8def-0123456789ab';
const TARGET_ID_UPPER = TARGET_ID_LOWER.toUpperCase();
const BODY = { roles: ['user', 'admin'] };

type Handler = typeof PATCH;

async function call(handler: Handler, id: string, body: unknown = BODY) {
  const request = new Request(`http://localhost:3000/api/admin/users/${id}/role`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await handler(request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as { error?: { code: string }; data?: unknown } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({ id: ACTOR_ID, roles: ['super_admin'] });
});

describe.each([
  ['PATCH', PATCH],
  ['PUT', PUT],
] as const)('%s /api/admin/users/{id}/role (#1707)', (_method, handler) => {
  it('自分の UUID を大文字・大文字小文字の混在にしても 403 OP_SELF_MODIFY で、対象の読み取りも RPC も監査もしない', async () => {
    for (const selfId of [ACTOR_ID.toUpperCase(), ACTOR_ID_MIXED]) {
      expect(selfId).not.toBe(ACTOR_ID);
      const res = await call(handler, selfId);
      expect(res.status, selfId).toBe(403);
      expect(res.body.error?.code).toBe('OP_SELF_MODIFY');
    }
    // 小文字 (そのまま) の自分も従来どおり 403
    const res = await call(handler, ACTOR_ID);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('OP_SELF_MODIFY');

    expect(mocks.adminClient.from).not.toHaveBeenCalled();
    expect(mocks.userClient.rpc).not.toHaveBeenCalled();
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('対象の UUID が大文字なら小文字にそろえた値で、対象の読み取り・admin_set_user_roles の p_user_id・監査の targetId を扱う', async () => {
    const res = await call(handler, TARGET_ID_UPPER);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { success: true, roles: BODY.roles } });
    expect(mocks.targetSelect).toHaveBeenCalledWith('user_profiles', 'id, roles', 'id', TARGET_ID_LOWER);
    expect(mocks.userClient.rpc).toHaveBeenCalledWith('admin_set_user_roles', { p_user_id: TARGET_ID_LOWER, p_roles: BODY.roles });
    expect(mocks.recordAdminAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: ACTOR_ID, targetId: TARGET_ID_LOWER, actionType: 'admin.user.role_change' }),
    );
    expect(JSON.stringify([mocks.targetSelect.mock.calls, mocks.userClient.rpc.mock.calls, mocks.recordAdminAudit.mock.calls])).not.toContain(
      TARGET_ID_UPPER,
    );
  });
});
