/**
 * #1041 round-2 (E/H) 回帰防止 contract テスト
 * POST /api/super-admin/coupons/[id]/apply
 *
 * `coupon_redemptions` は SELECT ポリシーのみで INSERT/UPDATE ポリシーが無い
 * (service_role 前提)。本 route は元々 user-scoped client (`createClient()`) で
 * `applyCoupon` を呼んでおり、本番では redemption INSERT 等が RLS で拒否され
 * 500 になる可能性があった。requireRole(['super_admin']) 通過後に service-role
 * (`getSupabaseAdmin()`) へ切り替えたことを検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireRole = vi.fn();
const mockApplyCoupon = vi.fn();
const mockGetSupabaseAdmin = vi.fn();
const mockCreateClient = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

class FakeCouponApplyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CouponApplyError';
  }
}

vi.mock('@/lib/plan/coupon', () => ({
  applyCoupon: (...args: unknown[]) => mockApplyCoupon(...args),
  CouponApplyError: FakeCouponApplyError,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

const { POST } = await import('@/app/api/super-admin/coupons/[id]/apply/route');

const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };
const adminClientMarker = {
  marker: 'user-scoped-client' as const,
  from: vi.fn(() => ({ insert: vi.fn(() => Promise.resolve({ data: null, error: null })) })),
};
const serviceRoleMarker = { marker: 'service-role-client' as const };

function postRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/super-admin/coupons/coupon-1/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription_target: 'personal',
      subscription_id: '123e4567-e89b-12d3-a456-426614174000',
      ...body,
    }),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(actor);
  mockCreateClient.mockResolvedValue(adminClientMarker);
  mockGetSupabaseAdmin.mockReturnValue(serviceRoleMarker);
  mockApplyCoupon.mockResolvedValue({ redemptionId: 'redemption-1', discountAmountJpy: 300, durationMonths: null });
});

describe('POST /api/super-admin/coupons/[id]/apply (#1041 round-2 E)', () => {
  it('requireRole 通過後に service-role (getSupabaseAdmin) を取得し、applyCoupon に渡す', async () => {
    const res = await POST(postRequest({}), { params: { id: 'coupon-1' } });

    expect(res.status).toBe(200);
    expect(mockGetSupabaseAdmin).toHaveBeenCalled();
    expect(mockApplyCoupon).toHaveBeenCalledWith(
      serviceRoleMarker,
      expect.objectContaining({ couponId: 'coupon-1', approvedBy: 'sa-1' }),
    );
  });

  it('401: 未認証の場合は service-role へ切り替わらない (権限昇格穴の防止)', async () => {
    const { AuthError } = await import('@/lib/auth/errors');
    mockRequireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));

    const res = await POST(postRequest({}), { params: { id: 'coupon-1' } });

    expect(res.status).toBe(401);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockApplyCoupon).not.toHaveBeenCalled();
  });

  it('403: super_admin 以外は service-role へ切り替わらない', async () => {
    const { ForbiddenError } = await import('@/lib/auth/errors');
    mockRequireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED'));

    const res = await POST(postRequest({}), { params: { id: 'coupon-1' } });

    expect(res.status).toBe(403);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('CouponApplyError は対応する HTTP ステータスにマッピングされる', async () => {
    mockApplyCoupon.mockRejectedValue(new FakeCouponApplyError('OP_COUPON_LIMIT_REACHED', '上限到達'));

    const res = await POST(postRequest({}), { params: { id: 'coupon-1' } });

    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_COUPON_LIMIT_REACHED');
  });
});

/**
 * #1224: applyCoupon の実体を DB 関数 apply_coupon に移したが、route が返すエラーコードと
 * HTTP ステータスは変えない (従来の API の互換)。
 */
describe('POST /api/super-admin/coupons/[id]/apply (#1224 エラーコードと HTTP ステータスは従来どおり)', () => {
  it.each([
    ['OP_COUPON_NOT_FOUND', 404],
    ['OP_SUBSCRIPTION_NOT_FOUND', 404],
    ['OP_COUPON_INVALID', 422],
    ['OP_COUPON_NOT_YET_VALID', 422],
    ['OP_COUPON_EXPIRED', 422],
    ['OP_COUPON_NOT_APPLICABLE', 422],
    ['OP_PLAN_NOT_FOUND', 422],
    ['OP_COUPON_LIMIT_REACHED', 422],
  ])('%s は %i', async (code, status) => {
    mockApplyCoupon.mockRejectedValue(new FakeCouponApplyError(code, `message of ${code}`));

    const res = await POST(postRequest({}), { params: { id: 'coupon-1' } });

    expect(res.status).toBe(status);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error).toEqual({ code, message: `message of ${code}` });
  });

  it('CouponApplyError 以外 (外部キー違反など DB のエラー) は 500 OP_INTERNAL_ERROR。監査ログは書かない', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApplyCoupon.mockRejectedValue({ code: '23503', message: 'violates foreign key constraint' });

    const res = await POST(postRequest({}), { params: { id: 'coupon-1' } });

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_INTERNAL_ERROR');
    expect(adminClientMarker.from).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('400: subscription_id が UUID でなければ applyCoupon を呼ばない', async () => {
    const res = await POST(postRequest({ subscription_id: 'not-a-uuid' }), { params: { id: 'coupon-1' } });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_INVALID_INPUT');
    expect(mockApplyCoupon).not.toHaveBeenCalled();
  });

  it('成功時は redemption_id / discount_amount_jpy / duration_months を返し、監査ログ (apply_coupon) を書く', async () => {
    mockApplyCoupon.mockResolvedValue({ redemptionId: 'redemption-9', discountAmountJpy: 450, durationMonths: 6 });
    const insert = vi.fn(() => Promise.resolve({ data: null, error: null }));
    adminClientMarker.from.mockReturnValueOnce({ insert });

    const res = await POST(postRequest({ reason: '遡及適用' }), { params: { id: 'coupon-1' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { redemption_id: 'redemption-9', discount_amount_jpy: 450, duration_months: 6 },
    });
    expect(adminClientMarker.from).toHaveBeenCalledWith('admin_audit_logs');
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: 'sa-1',
        target_id: 'coupon-1',
        target_type: 'coupon',
        action_type: 'apply_coupon',
        severity: 'warn',
        details: expect.objectContaining({ redemption_id: 'redemption-9', discount_amount_jpy: 450 }),
      }),
    );
  });
});
