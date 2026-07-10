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
