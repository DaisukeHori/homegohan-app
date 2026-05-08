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
import { createClient } from '@/lib/supabase/server';
import {
  CouponCreateSchema,
  CouponsQuerySchema,
} from '@/lib/super-admin/coupons-schemas';

export async function GET(request: NextRequest) {
  try {
    await requireRole(['super_admin']);
    const supabase = createClient();

    const { searchParams } = request.nextUrl;
    const queryResult = CouponsQuerySchema.safeParse({
      status: searchParams.get('status') ?? undefined,
      applicable_to: searchParams.get('applicable_to') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    if (!queryResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_QUERY', message: queryResult.error.message } },
        { status: 400 }
      );
    }

    const { status, applicable_to, page, per_page } = queryResult.data;
    const offset = (page - 1) * per_page;

    let query = supabase
      .from('coupons')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + per_page - 1);

    if (status) query = query.eq('status', status);
    if (applicable_to) query = query.eq('applicable_to', applicable_to);

    const { data, error, count } = await query;

    if (error) {
      console.error('[super-admin/coupons GET]', error);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: error.message } },
        { status: 500 }
      );
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
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/coupons GET]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = createClient();

    const body = await request.json();
    const parseResult = CouponCreateSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_INPUT', message: parseResult.error.message, details: parseResult.error.issues } },
        { status: 400 }
      );
    }

    const input = parseResult.data;

    const { data: coupon, error } = await supabase
      .from('coupons')
      .insert({
        code: input.code,
        display_name: input.display_name ?? null,
        discount_type: input.discount_type,
        discount_value: input.discount_value,
        applicable_plans: input.applicable_plans ?? [],
        applicable_to: input.applicable_to ?? 'all',
        valid_from: input.valid_from,
        valid_until: input.valid_until,
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
      console.error('[super-admin/coupons POST]', error);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: error.message } },
        { status: 500 }
      );
    }

    // 監査ログ記録 (クーポン作成は課金影響 → severity='warn')
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: coupon.id,
        target_type: 'coupon',
        action_type: 'create_coupon',
        details: {
          code: input.code,
          discount_type: input.discount_type,
          discount_value: input.discount_value,
          applicable_to: input.applicable_to,
          valid_from: input.valid_from,
          valid_until: input.valid_until,
          max_uses: input.max_uses,
        },
        severity: 'warn',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/coupons POST] audit log failed (graceful):', auditErr);
    }

    return NextResponse.json({ data: coupon }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/coupons POST]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
