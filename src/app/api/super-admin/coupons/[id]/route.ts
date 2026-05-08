/**
 * GET    /api/super-admin/coupons/[id] — クーポン詳細
 * PATCH  /api/super-admin/coupons/[id] — クーポン更新
 * DELETE /api/super-admin/coupons/[id] — クーポン削除
 *
 * operator/01-data-model.md §3.5 / operator/04-plan-management.md §4.1 準拠
 * 権限: super_admin のみ
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { CouponUpdateSchema } from '@/lib/super-admin/coupons-schemas';

type RouteContext = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    const { data: coupon, error } = await supabase
      .from('coupons')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !coupon) {
      return NextResponse.json(
        { error: { code: 'OP_COUPON_NOT_FOUND', message: 'クーポンが見つかりません' } },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: coupon });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/coupons/[id] GET]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    const body = await request.json();
    const parseResult = CouponUpdateSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_INPUT', message: parseResult.error.message, details: parseResult.error.issues } },
        { status: 400 }
      );
    }

    const input = parseResult.data;
    const updateData: Record<string, unknown> = {};

    if (input.display_name !== undefined) updateData.display_name = input.display_name;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.valid_until !== undefined) updateData.valid_until = input.valid_until;
    if (input.max_uses !== undefined) updateData.max_uses = input.max_uses;
    if (input.applicable_plans !== undefined) updateData.applicable_plans = input.applicable_plans;
    if (input.applicable_to !== undefined) updateData.applicable_to = input.applicable_to;
    if (input.gross_margin_preview_jpy !== undefined) updateData.gross_margin_preview_jpy = input.gross_margin_preview_jpy;

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: { code: 'OP_NO_UPDATE', message: '更新するフィールドがありません' } },
        { status: 400 }
      );
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('coupons')
      .select('id, code')
      .eq('id', params.id)
      .single();

    if (fetchErr || !existing) {
      return NextResponse.json(
        { error: { code: 'OP_COUPON_NOT_FOUND', message: 'クーポンが見つかりません' } },
        { status: 404 }
      );
    }

    const { data: updated, error } = await supabase
      .from('coupons')
      .update(updateData)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      console.error('[super-admin/coupons/[id] PATCH]', error);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: error.message } },
        { status: 500 }
      );
    }

    // 監査ログ記録
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: params.id,
        target_type: 'coupon',
        action_type: 'update_coupon',
        details: { code: existing.code, changes: updateData },
        severity: 'info',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/coupons/[id] PATCH] audit log failed (graceful):', auditErr);
    }

    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/coupons/[id] PATCH]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    const { data: existing, error: fetchErr } = await supabase
      .from('coupons')
      .select('id, code, uses_count')
      .eq('id', params.id)
      .single();

    if (fetchErr || !existing) {
      return NextResponse.json(
        { error: { code: 'OP_COUPON_NOT_FOUND', message: 'クーポンが見つかりません' } },
        { status: 404 }
      );
    }

    // 利用中 (uses_count > 0) のクーポンは削除不可
    if (existing.uses_count > 0) {
      return NextResponse.json(
        { error: { code: 'OP_COUPON_IN_USE', message: '利用実績があるクーポンは削除できません。paused に変更してください。' } },
        { status: 409 }
      );
    }

    const { error: deleteErr } = await supabase
      .from('coupons')
      .delete()
      .eq('id', params.id);

    if (deleteErr) {
      console.error('[super-admin/coupons/[id] DELETE]', deleteErr);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: deleteErr.message } },
        { status: 500 }
      );
    }

    // 監査ログ記録
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: params.id,
        target_type: 'coupon',
        action_type: 'delete_coupon',
        details: { code: existing.code },
        severity: 'warn',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/coupons/[id] DELETE] audit log failed (graceful):', auditErr);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/coupons/[id] DELETE]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
