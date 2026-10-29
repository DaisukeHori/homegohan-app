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

vi.mock('@/lib/plan/coupon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/plan/coupon')>();
  return {
    applyCoupon: (...args: unknown[]) => mockApplyCoupon(...args),
    CouponApplyError: FakeCouponApplyError,
    // 本文の文の選び方は実物を使う (#1917。業務エラーの日本語の固定の文だけを本文に出す)
    couponApplyErrorMessageOf: actual.couponApplyErrorMessageOf,
    COUPON_APPLY_FAILED_MESSAGE: actual.COUPON_APPLY_FAILED_MESSAGE,
    COUPON_NOT_FOUND_MESSAGE: actual.COUPON_NOT_FOUND_MESSAGE,
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

const { POST } = await import('@/app/api/super-admin/coupons/[id]/apply/route');

const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };
/** クーポンの id (apply_coupon の p_coupon_id は uuid なので、UUID の形の値) */
const COUPON_ID = 'c0a90000-0000-4000-8000-000000000001';
const adminClientMarker = {
  marker: 'user-scoped-client' as const,
  from: vi.fn(() => ({ insert: vi.fn(() => Promise.resolve({ data: null, error: null })) })),
};
const serviceRoleMarker = { marker: 'service-role-client' as const };

function postRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/super-admin/coupons/${COUPON_ID}/apply`, {
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
    const res = await POST(postRequest({}), { params: { id: COUPON_ID } });

    expect(res.status).toBe(200);
    expect(mockGetSupabaseAdmin).toHaveBeenCalled();
    expect(mockApplyCoupon).toHaveBeenCalledWith(
      serviceRoleMarker,
      expect.objectContaining({ couponId: COUPON_ID, approvedBy: 'sa-1' }),
    );
  });

  it('401: 未認証の場合は service-role へ切り替わらない (権限昇格穴の防止)', async () => {
    const { AuthError } = await import('@/lib/auth/errors');
    mockRequireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));

    const res = await POST(postRequest({}), { params: { id: COUPON_ID } });

    expect(res.status).toBe(401);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockApplyCoupon).not.toHaveBeenCalled();
  });

  it('403: super_admin 以外は service-role へ切り替わらない', async () => {
    const { ForbiddenError } = await import('@/lib/auth/errors');
    mockRequireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED'));

    const res = await POST(postRequest({}), { params: { id: COUPON_ID } });

    expect(res.status).toBe(403);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('CouponApplyError は対応する HTTP ステータスにマッピングされる', async () => {
    mockApplyCoupon.mockRejectedValue(new FakeCouponApplyError('OP_COUPON_LIMIT_REACHED', '上限到達'));

    const res = await POST(postRequest({}), { params: { id: COUPON_ID } });

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
    ['OP_COUPON_NOT_FOUND', 404, 'クーポンが見つかりません'],
    ['OP_SUBSCRIPTION_NOT_FOUND', 404, '契約 (組織) が見つかりません'],
    ['OP_COUPON_INVALID', 422, 'クーポンが有効な状態ではありません'],
    ['OP_COUPON_NOT_YET_VALID', 422, 'クーポンの有効開始日前です'],
    ['OP_COUPON_EXPIRED', 422, 'クーポンの有効期限が切れています'],
    ['OP_COUPON_NOT_APPLICABLE', 422, 'このクーポンは対象プランに適用できません'],
    ['OP_PLAN_NOT_FOUND', 422, '組織に契約プランが設定されていません'],
    ['OP_COUPON_LIMIT_REACHED', 422, 'この組織はクーポンの利用上限に達しています'],
  ])('%s は %i (文は業務エラーの日本語の固定の文のまま)', async (code, status, message) => {
    mockApplyCoupon.mockRejectedValue(new FakeCouponApplyError(code, message));

    const res = await POST(postRequest({}), { params: { id: COUPON_ID } });

    expect(res.status).toBe(status);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error).toEqual({ code, message });
  });

  it('#1917: CouponApplyError の文面が業務エラーの表の外 (英語の文など) なら、本文には日本語の固定の文だけを出す', async () => {
    const { COUPON_APPLY_FAILED_MESSAGE } = await import('@/lib/plan/coupon');
    mockApplyCoupon.mockRejectedValue(new FakeCouponApplyError('OP_COUPON_INVALID', 'Coupon is not active'));

    const res = await POST(postRequest({}), { params: { id: COUPON_ID } });

    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'OP_COUPON_INVALID', message: COUPON_APPLY_FAILED_MESSAGE } });
    expect(COUPON_APPLY_FAILED_MESSAGE).toBe('クーポンを適用できませんでした');
    expect(text).not.toContain('Coupon is not active');
  });

  it('CouponApplyError 以外 (外部キー違反など DB のエラー) は 500 OP_INTERNAL_ERROR。監査ログは書かない', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApplyCoupon.mockRejectedValue({ code: '23503', message: 'violates foreign key constraint' });

    const res = await POST(postRequest({}), { params: { id: COUPON_ID } });

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_INTERNAL_ERROR');
    expect(adminClientMarker.from).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('#1917 の続き: パスの id が UUID の形でなければ、クーポンが無いときと同じ 404 OP_COUPON_NOT_FOUND。applyCoupon (DB) を呼ばず、監査ログも書かない', async () => {
    const res = await POST(postRequest({}), { params: { id: 'not-a-uuid' } });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'OP_COUPON_NOT_FOUND', message: 'クーポンが見つかりません' } });
    expect(mockApplyCoupon).not.toHaveBeenCalled();
    expect(adminClientMarker.from).not.toHaveBeenCalled();
  });

  it('#1917 の続き: パスの id が UUID の形でなくても、本文の誤りは今までどおり 400 (クーポンが無いときと同じ順)', async () => {
    const res = await POST(postRequest({ subscription_target: 'team' }), { params: { id: 'not-a-uuid' } });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OP_INVALID_INPUT');
    expect(mockApplyCoupon).not.toHaveBeenCalled();
  });

  it('400: subscription_id が UUID でなければ applyCoupon を呼ばない', async () => {
    const res = await POST(postRequest({ subscription_id: 'not-a-uuid' }), { params: { id: COUPON_ID } });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_INVALID_INPUT');
    expect(mockApplyCoupon).not.toHaveBeenCalled();
  });

  /**
   * #1641: apply の 400 も POST・PATCH (couponInvalidInputResponse) と同じ形。
   * 以前は message が Zod の issues を JSON にした文字列 ('[' で始まる) だった。
   */
  it.each([
    ['subscription_id が UUID でない', { subscription_id: 'not-a-uuid' }, ['subscription_id']],
    ['subscription_target が範囲外', { subscription_target: 'team' }, ['subscription_target']],
  ] as const)('400 の本文 (%s): message は最初の issue の文で、details に issues が入る (#1641)', async (_label, body, path) => {
    const res = await POST(postRequest(body), { params: { id: COUPON_ID } });

    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: { code: string; message: string; details: { path: (string | number)[]; message: string }[] };
    };
    expect(json.error.code).toBe('OP_INVALID_INPUT');
    expect(json.error.details).toHaveLength(1);
    expect(json.error.details[0].path).toEqual(path);
    expect(json.error.message).toBe(json.error.details[0].message);
    expect(json.error.message.trimStart().startsWith('[')).toBe(false);
    expect(mockApplyCoupon).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).toHaveBeenCalledTimes(1);
  });

  it('成功時は redemption_id / discount_amount_jpy / duration_months を返し、監査ログ (apply_coupon) を書く', async () => {
    mockApplyCoupon.mockResolvedValue({ redemptionId: 'redemption-9', discountAmountJpy: 450, durationMonths: 6 });
    const insert = vi.fn(() => Promise.resolve({ data: null, error: null }));
    adminClientMarker.from.mockReturnValueOnce({ insert });

    const res = await POST(postRequest({ reason: '遡及適用' }), { params: { id: COUPON_ID } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { redemption_id: 'redemption-9', discount_amount_jpy: 450, duration_months: 6 },
    });
    expect(adminClientMarker.from).toHaveBeenCalledWith('admin_audit_logs');
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: 'sa-1',
        target_id: COUPON_ID,
        target_type: 'coupon',
        action_type: 'apply_coupon',
        severity: 'warn',
        details: expect.objectContaining({ redemption_id: 'redemption-9', discount_amount_jpy: 450 }),
      }),
    );
  });
});
