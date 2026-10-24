/**
 * GET /api/super-admin/coupons/[id]/redemptions — クーポン適用履歴
 *
 * operator/01-data-model.md §3.6 準拠
 * 権限: super_admin のみ
 *
 * #1326: 適用履歴は利用者のサブスクリプションと値引き額を返すため、1 件以上返したとき、
 * 1 回の取得 = 1 行で super_admin.coupon.view_redemptions を監査ログに残す (対象はクーポン。条件と件数だけ)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { CouponRedemptionsQuerySchema } from '@/lib/super-admin/coupons-schemas';
import { internalError } from '@/lib/api/errors';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';
import { isUuid } from '@/lib/http-params';
import { buildListViewDetails, recordAdminAudit } from '@/lib/admin/audit';
import { couponInvalidQueryResponse } from '@/lib/super-admin/coupon-errors';

type RouteContext = { params: Promise<{ id: string }> };

/** 構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/super-admin/coupons/[id]/redemptions';

/** クーポンが無い (UUID の形でない id を含む) */
const COUPON_NOT_FOUND_RESPONSE = { error: { code: 'OP_COUPON_NOT_FOUND', message: 'クーポンが見つかりません' } } as const;

export async function GET(request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    const actor = await requireRole(['super_admin']);
    const supabase = await createClient();

    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(COUPON_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // クーポン ID(UUID)で取得。読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗でクーポンが消えたように見せない)
    const { data: coupon, error: couponErr } = await supabase
      .from('coupons')
      .select('id, code')
      .eq('id', params.id)
      .maybeSingle();

    if (couponErr) {
      return internalError(LIST_ROUTE_NAME, couponErr, { userId: actor.id, table: 'coupons' }, { shape: 'nested' });
    }
    if (!coupon) {
      return NextResponse.json(COUPON_NOT_FOUND_RESPONSE, { status: 404 });
    }

    const { searchParams } = request.nextUrl;
    const queryResult = CouponRedemptionsQuerySchema.safeParse({
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    if (!queryResult.success) {
      // #1641: 入力の 400 と同じ形 (message は最初の issue の文・details は issues)
      return couponInvalidQueryResponse(queryResult.error.issues);
    }

    const { page, per_page } = queryResult.data;
    const offset = (page - 1) * per_page;

    // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectRedemptions) から作る
    const couponId = coupon.id;
    const selectRedemptions = (options: { head?: boolean } = {}) =>
      supabase
        .from('coupon_redemptions')
        .select('*', listCountOptions(options.head))
        .eq('coupon_id', couponId);

    const { data: redemptions, error, count } = await resolveBeyondLastPage(
      await selectRedemptions()
        .order('redeemed_at', { ascending: false })
        .range(offset, offset + per_page - 1),
      () => selectRedemptions({ head: true }),
      LIST_ROUTE_NAME,
    );

    if (error) {
      return internalError(LIST_ROUTE_NAME, error, {}, { shape: 'nested' });
    }

    const rows = redemptions ?? [];
    // #1326: 0 件のときは情報を返していないので記録しない。記録に失敗しても一覧は返す (失敗は db-logger に残る)
    if (rows.length > 0) {
      await recordAdminAudit({
        supabase,
        actorId: actor.id,
        actionType: 'super_admin.coupon.view_redemptions',
        targetId: coupon.id,
        targetType: 'coupon',
        details: buildListViewDetails({ page, per_page }, rows.length, count ?? null),
        request,
        routeName: 'api/super-admin/coupons/[id]/redemptions GET',
      });
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
