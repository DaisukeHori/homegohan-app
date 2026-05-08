/**
 * GET /api/super-admin/coupons/[id]/redemptions — クーポン適用履歴
 *
 * operator/01-data-model.md §3.6 準拠
 * 権限: super_admin のみ
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { CouponRedemptionsQuerySchema } from '@/lib/super-admin/coupons-schemas';

type RouteContext = { params: { id: string } };

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    await requireRole(['super_admin']);
    const supabase = createClient();

    // クーポン ID(UUID)で取得
    const { data: coupon, error: couponErr } = await supabase
      .from('coupons')
      .select('id, code')
      .eq('id', params.id)
      .single();

    if (couponErr || !coupon) {
      return NextResponse.json(
        { error: { code: 'OP_COUPON_NOT_FOUND', message: 'クーポンが見つかりません' } },
        { status: 404 }
      );
    }

    const { searchParams } = request.nextUrl;
    const queryResult = CouponRedemptionsQuerySchema.safeParse({
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    if (!queryResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_QUERY', message: queryResult.error.message } },
        { status: 400 }
      );
    }

    const { page, per_page } = queryResult.data;
    const offset = (page - 1) * per_page;

    const { data: redemptions, error, count } = await supabase
      .from('coupon_redemptions')
      .select('*', { count: 'exact' })
      .eq('coupon_id', coupon.id)
      .order('redeemed_at', { ascending: false })
      .range(offset, offset + per_page - 1);

    if (error) {
      console.error('[super-admin/coupons/[id]/redemptions GET]', error);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: error.message } },
        { status: 500 }
      );
    }

    return NextResponse.json({
      data: redemptions,
      meta: { total: count ?? 0, page, per_page, coupon_code: coupon.code },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/coupons/[id]/redemptions GET]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
