/**
 * GET  /api/super-admin/coupons — クーポン一覧
 * POST /api/super-admin/coupons — クーポン新規作成
 *
 * operator/01-data-model.md §3.5 / operator/04-plan-management.md §4.1 準拠
 * 権限: super_admin のみ (sales/admin も閲覧可だが super_admin で統一)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import {
  CouponCreateSchema,
  CouponsQuerySchema,
} from '@/lib/super-admin/coupons-schemas';
import { internalError } from '@/lib/api/errors';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';
import { couponValidFromTimestamp, couponValidUntilTimestamp } from '@/lib/super-admin/coupon-validity';
import { recordAdminAudit } from '@/lib/admin/audit';
import { couponInvalidInputResponse, couponInvalidQueryResponse } from '@/lib/super-admin/coupon-errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { invalidJsonBodyResponse, readJsonBody } from '@/lib/super-admin/validation-errors';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

/** 一覧の構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/super-admin/coupons';

export async function GET(request: NextRequest) {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    const { searchParams } = request.nextUrl;
    const queryResult = CouponsQuerySchema.safeParse({
      status: searchParams.get('status') ?? undefined,
      applicable_to: searchParams.get('applicable_to') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    if (!queryResult.success) {
      // #1641: 入力の 400 と同じ形 (message は最初の issue の文・details は issues)
      return couponInvalidQueryResponse(queryResult.error.issues);
    }

    const { status, applicable_to, page, per_page } = queryResult.data;
    const offset = (page - 1) * per_page;

    // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectCoupons) から作る
    const selectCoupons = (options: { head?: boolean } = {}) => {
      let query = supabase
        .from('coupons')
        .select('*', listCountOptions(options.head));

      if (status) query = query.eq('status', status);
      if (applicable_to) query = query.eq('applicable_to', applicable_to);

      return query;
    };

    const { data, error, count } = await resolveBeyondLastPage(
      // 作った日時の新しい順。同じ値は id の順で、ページの境目でも順が変わらない (#2139 T1)
      await orderListBy(selectCoupons(), LIST_ORDERS.superAdminCoupons).range(offset, offset + per_page - 1),
      () => selectCoupons({ head: true }),
      LIST_ROUTE_NAME,
    );

    if (error) {
      return internalError(LIST_ROUTE_NAME, error, {}, { shape: 'nested' });
    }

    return NextResponse.json({
      data,
      meta: { total: count ?? 0, page, per_page },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
    }
    console.error('[super-admin/coupons GET]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      // #1654: 本文が JSON として読めないときは 400 OP_INVALID_INPUT (外側の catch の 500 に落とさない)
      return invalidJsonBodyResponse();
    }
    const body = bodyResult.body;
    const parseResult = CouponCreateSchema.safeParse(body);

    if (!parseResult.success) {
      // #1534: error.message は最初の issue の文 (PATCH と同じ形)。issues を JSON にした文字列は返さない
      return couponInvalidInputResponse(parseResult.error.issues);
    }

    const input = parseResult.data;
    // #1483: 画面で選んだ JST の暦日を、開始日の JST 0:00・期限の日の JST 23:59:59.999999 の時刻にして書く
    const validFrom = couponValidFromTimestamp(input.valid_from);
    const validUntil = couponValidUntilTimestamp(input.valid_until);

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { data: coupon, error } = await getSupabaseAdmin()
      .from('coupons')
      .insert({
        code: input.code,
        display_name: input.display_name ?? null,
        discount_type: input.discount_type,
        discount_value: input.discount_value,
        applicable_plans: input.applicable_plans ?? [],
        applicable_to: input.applicable_to ?? 'all',
        valid_from: validFrom,
        valid_until: validUntil,
        max_uses: input.max_uses ?? null,
        per_user_limit: input.per_user_limit ?? 1,
        duration_months: input.duration_months ?? null,
        gross_margin_preview_jpy: input.gross_margin_preview_jpy ?? null,
        status: 'active',
        created_by: user.id,
        uses_count: 0,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: { code: 'OP_COUPON_CODE_DUPLICATE', message: 'クーポンコードが既に存在します' } },
          { status: 409 }
        );
      }
      return internalError('POST /api/super-admin/coupons', error, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ記録 (クーポン作成は課金影響 → severity='warn')
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      targetId: coupon.id,
      targetType: 'coupon',
      actionType: 'create_coupon',
      details: {
        code: input.code,
        discount_type: input.discount_type,
        discount_value: input.discount_value,
        applicable_to: input.applicable_to,
        valid_from: validFrom,
        valid_until: validUntil,
        max_uses: input.max_uses,
      },
      severity: 'warn',
      request,
      routeName: 'api/super-admin/coupons POST',
    });

    return NextResponse.json({ data: coupon }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
    }
    console.error('[super-admin/coupons POST]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
