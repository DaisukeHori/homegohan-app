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
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { CouponApplySchema } from '@/lib/super-admin/coupons-schemas';
import { applyCoupon, CouponApplyError, couponApplyErrorMessageOf, COUPON_NOT_FOUND_MESSAGE } from '@/lib/plan/coupon';
import { isUuid } from '@/lib/http-params';
import { recordAdminAudit } from '@/lib/admin/audit';
import { couponInvalidInputResponse } from '@/lib/super-admin/coupon-errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { invalidJsonBodyResponse, readJsonBody } from '@/lib/super-admin/validation-errors';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const user = await requireRole(['super_admin']);
    // requireRole 通過後のみ到達する (#1041 round-2 E)。coupon_redemptions
    // INSERT/UPDATE, coupons.uses_count 更新, personal_subscriptions 更新は
    // service-role が必須。admin_audit_logs への INSERT のみ user-scoped
    // client を使う (#1028 パターン)。
    const supabaseAdmin = getSupabaseAdmin();
    const supabase = await createClient();

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      // #1654: 本文が JSON として読めないときは 400 OP_INVALID_INPUT (外側の catch の 500 に落とさない)
      return invalidJsonBodyResponse();
    }
    const body = bodyResult.body;
    const parseResult = CouponApplySchema.safeParse(body);

    if (!parseResult.success) {
      // #1641: POST・PATCH と同じ形 (message は最初の issue の文・details は issues)
      return couponInvalidInputResponse(parseResult.error.issues);
    }

    const input = parseResult.data;

    // UUID の形でない id は DB に渡さず、クーポンが無いときと同じ 404 OP_COUPON_NOT_FOUND (apply_coupon の p_coupon_id は uuid。
    // 渡すと 22P02 で失敗し、業務エラーでないので外側の catch の 500 に入る。#1917 の続き)
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: { code: 'OP_COUPON_NOT_FOUND', message: COUPON_NOT_FOUND_MESSAGE } }, { status: 404 });
    }

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
        // 文は業務エラーの日本語の固定の文だけ (例外の文面をそのまま本文に入れない #1917)
        return NextResponse.json({ error: { code: err.code, message: couponApplyErrorMessageOf(err) } }, { status });
      }
      throw err;
    }

    // 監査ログ記録 (severity='warn' — 課金影響操作、遡及適用のため)
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      targetId: params.id,
      targetType: 'coupon',
      actionType: 'apply_coupon',
      details: {
        subscription_target: input.subscription_target,
        subscription_id: input.subscription_id,
        reason: input.reason,
        redemption_id: result.redemptionId,
        discount_amount_jpy: result.discountAmountJpy,
      },
      severity: 'warn',
      request,
      routeName: 'api/super-admin/coupons/[id]/apply POST',
    });

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
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
    }
    console.error('[super-admin/coupons/[id]/apply POST]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
