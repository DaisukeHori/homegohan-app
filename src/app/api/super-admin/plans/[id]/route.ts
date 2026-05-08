/**
 * GET   /api/super-admin/plans/[id] — プラン詳細
 * PATCH /api/super-admin/plans/[id] — プラン編集
 * DELETE /api/super-admin/plans/[id] — プラン削除 (draft のみ)
 *
 * operator/02-api-spec.md §17 / operator/04-plan-management.md §3.1 準拠
 * 権限: super_admin のみ
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { PlanUpdateSchema } from '@/lib/super-admin/plans-schemas';

type RouteContext = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    await requireRole(['super_admin']);
    const supabase = createClient();

    const { data: plan, error } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !plan) {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
        { status: 404 }
      );
    }

    // 価格変更履歴を追加取得
    const { data: priceHistory } = await supabase
      .from('plan_price_history')
      .select('*')
      .eq('plan_id', params.id)
      .order('created_at', { ascending: false })
      .limit(20);

    return NextResponse.json({ data: { ...plan, price_history: priceHistory ?? [] } });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/plans/[id] GET]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = createClient();

    // 既存プランを取得
    const { data: existing, error: fetchErr } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', params.id)
      .single();

    if (fetchErr || !existing) {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
        { status: 404 }
      );
    }

    const body = await request.json();
    const parseResult = PlanUpdateSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_INPUT', message: parseResult.error.message, details: parseResult.error.issues } },
        { status: 400 }
      );
    }

    const input = parseResult.data;

    // status 別の更新可能フィールド制限 (operator/04-plan-management.md §3.1)
    if (existing.status === 'public' || existing.status === 'private') {
      // public/private では display_name / description / banner_url / feature_packages のみ
      const allowedKeys = ['display_name', 'description', 'banner_url', 'feature_package_ids', 'display_order'];
      const inputKeys = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
      const disallowedKeys = inputKeys.filter((k) => !allowedKeys.includes(k));
      if (disallowedKeys.length > 0) {
        return NextResponse.json(
          {
            error: {
              code: 'OP_PLAN_STATUS_LOCKED',
              message: `公開中プランでは ${disallowedKeys.join(', ')} は変更できません。価格変更は price-change API を使用してください。`,
            },
          },
          { status: 422 }
        );
      }
    }

    if (existing.status === 'deprecated') {
      // deprecated では migration_message のみ
      const allowedKeys: string[] = [];
      const inputKeys = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
      const disallowedKeys = inputKeys.filter((k) => !allowedKeys.includes(k));
      if (disallowedKeys.length > 0) {
        return NextResponse.json(
          { error: { code: 'OP_PLAN_DEPRECATED_LOCKED', message: '廃止済みプランは変更できません' } },
          { status: 422 }
        );
      }
    }

    const updateData: Record<string, unknown> = {};
    if (input.display_name !== undefined) updateData.display_name = input.display_name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.banner_url !== undefined) updateData.banner_url = input.banner_url;
    if (input.feature_package_ids !== undefined) updateData.feature_packages = input.feature_package_ids;
    if (input.display_order !== undefined) updateData.display_order = input.display_order;
    if (input.max_members !== undefined) updateData.max_members = input.max_members;
    if (input.max_family_seats !== undefined) updateData.max_family_seats = input.max_family_seats;
    if (input.trial_days !== undefined) updateData.trial_days = input.trial_days;
    if (input.min_contract_months !== undefined) updateData.min_contract_months = input.min_contract_months;
    if (input.auto_renew_default !== undefined) updateData.auto_renew_default = input.auto_renew_default;
    if (input.stripe_product_id !== undefined) updateData.stripe_product_id = input.stripe_product_id;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.ends_at !== undefined) updateData.ends_at = input.ends_at;
    updateData.updated_at = new Date().toISOString();

    const { data: updated, error: updateErr } = await supabase
      .from('subscription_plans')
      .update(updateData)
      .eq('id', params.id)
      .select()
      .single();

    if (updateErr) {
      console.error('[super-admin/plans/[id] PATCH]', updateErr);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: updateErr.message } },
        { status: 500 }
      );
    }

    // 監査ログ記録
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: params.id,
        target_type: 'subscription_plan',
        action_type: 'update_plan',
        details: { changes: updateData, plan_key: existing.plan_key },
        severity: 'info',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/plans/[id] PATCH] audit log failed (graceful):', auditErr);
    }

    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/plans/[id] PATCH]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = createClient();

    const { data: existing, error: fetchErr } = await supabase
      .from('subscription_plans')
      .select('id, status, plan_key')
      .eq('id', params.id)
      .single();

    if (fetchErr || !existing) {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
        { status: 404 }
      );
    }

    // draft のみ削除可能
    if (existing.status !== 'draft') {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_DRAFT', message: 'draft 状態のプランのみ削除できます' } },
        { status: 422 }
      );
    }

    const { error: deleteErr } = await supabase
      .from('subscription_plans')
      .delete()
      .eq('id', params.id);

    if (deleteErr) {
      console.error('[super-admin/plans/[id] DELETE]', deleteErr);
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
        target_type: 'subscription_plan',
        action_type: 'delete_plan',
        details: { plan_key: existing.plan_key },
        severity: 'warn',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/plans/[id] DELETE] audit log failed (graceful):', auditErr);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/plans/[id] DELETE]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
