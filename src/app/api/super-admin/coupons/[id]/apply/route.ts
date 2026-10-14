/**
 * POST /api/super-admin/coupons/[id]/apply — クーポン適用 (遡及適用、super_admin 承認)
 *
 * operator/01-data-model.md §3.6 / operator/04-plan-management.md §4.1 準拠
 * 権限: super_admin のみ
 *
 * #1041 (F4-07) 修正: クーポンは作成のみで、実際に契約へ適用して
 * coupon_redemptions を作成する処理・uses_count / per_user_limit の
 * 上限強制が存在しなかった (偽成功)。本エンドポイントで実際の適用処理を提供する。
 *
 * #1041 round-2 (E) 修正: `coupon_redemptions` は SELECT ポリシーのみで
 * INSERT/UPDATE ポリシーが無い (service_role 前提)。本 route は元々
 * user-scoped client (`createClient()`) で `applyCoupon` を呼んでおり、
 * 本番では redemption INSERT / uses_count increment / personal_subscriptions
 * 更新が RLS で拒否され 500 になる可能性があった。requireRole(['super_admin'])
 * 通過後に service-role (`getSupabaseAdmin()`) へ切り替える。
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { CouponApplySchema } from '@/lib/super-admin/coupons-schemas';
import { applyCoupon, CouponApplyError } from '@/lib/plan/coupon';

type RouteContext = { params: { id: string } };

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(['super_admin']);
    // requireRole 通過後のみ到達する (#1041 round-2 E)。coupon_redemptions
    // INSERT/UPDATE, coupons.uses_count 更新, personal_subscriptions 更新は
    // service-role が必須。admin_audit_logs への INSERT のみ user-scoped
    // client を使う (#1028 パターン)。
    const supabaseAdmin = getSupabaseAdmin();
    const supabase = await createClient();

    const body = await request.json();
    const parseResult = CouponApplySchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_INPUT', message: parseResult.error.message, details: parseResult.error.issues } },
        { status: 400 },
      );
    }

    const input = parseResult.data;

    let result;
    try {
      result = await applyCoupon(supabaseAdmin, {
        couponId: params.id,
        subscriptionTarget: input.subscription_target,
        subscriptionId: input.subscription_id,
        approvedBy: user.id,
      });
    } catch (err) {
      if (err instanceof CouponApplyError) {
        const status = err.code === 'OP_SUBSCRIPTION_NOT_FOUND' || err.code === 'OP_COUPON_NOT_FOUND' ? 404 : 422;
        return NextResponse.json({ error: { code: err.code, message: err.message } }, { status });
      }
      throw err;
    }

    // 監査ログ記録 (severity='warn' — 課金影響操作、遡及適用のため)
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: params.id,
        target_type: 'coupon',
        action_type: 'apply_coupon',
        details: {
          subscription_target: input.subscription_target,
          subscription_id: input.subscription_id,
          reason: input.reason,
          redemption_id: result.redemptionId,
          discount_amount_jpy: result.discountAmountJpy,
        },
        severity: 'warn',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/coupons/[id]/apply] audit log failed (graceful):', auditErr);
    }

    return NextResponse.json({
      data: {
        redemption_id: result.redemptionId,
        discount_amount_jpy: result.discountAmountJpy,
        duration_months: result.durationMonths,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/coupons/[id]/apply POST]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
