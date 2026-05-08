/**
 * GET  /api/super-admin/plans — プラン一覧
 * POST /api/super-admin/plans — プラン新規作成 (draft)
 *
 * operator/02-api-spec.md §17 準拠
 * 権限: super_admin のみ
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import {
  PlanCreateSchema,
  PlansQuerySchema,
} from '@/lib/super-admin/plans-schemas';

export async function GET(request: NextRequest) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = createClient();

    const { searchParams } = request.nextUrl;
    const queryResult = PlansQuerySchema.safeParse({
      type: searchParams.get('type') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    if (!queryResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_QUERY', message: queryResult.error.message } },
        { status: 400 }
      );
    }

    const { type, status, page, per_page } = queryResult.data;
    const offset = (page - 1) * per_page;

    let query = supabase
      .from('subscription_plans')
      .select('*', { count: 'exact' })
      .order('display_order', { ascending: true })
      .range(offset, offset + per_page - 1);

    if (type) query = query.eq('plan_type', type);
    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;

    if (error) {
      console.error('[super-admin/plans GET]', error);
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
    console.error('[super-admin/plans GET]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = createClient();

    const body = await request.json();
    const parseResult = PlanCreateSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_INPUT', message: parseResult.error.message, details: parseResult.error.issues } },
        { status: 400 }
      );
    }

    const input = parseResult.data;

    // feature_packages 配列を UUID[] に変換
    const featurePackageIds = input.feature_package_ids ?? [];

    const { data: plan, error } = await supabase
      .from('subscription_plans')
      .insert({
        plan_key: input.plan_key,
        display_name: input.display_name,
        plan_type: input.plan_type,
        description: input.description ?? null,
        monthly_price_jpy: input.monthly_price_jpy ?? null,
        yearly_price_jpy: input.yearly_price_jpy ?? null,
        max_members: input.max_members ?? null,
        max_family_seats: input.max_family_seats ?? null,
        feature_packages: featurePackageIds,
        display_order: input.display_order ?? 0,
        trial_days: input.trial_days ?? 0,
        min_contract_months: input.min_contract_months ?? 1,
        auto_renew_default: input.auto_renew_default ?? true,
        banner_url: input.banner_url ?? null,
        status: 'draft',
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: { code: 'OP_PLAN_KEY_DUPLICATE', message: 'plan_key が既に存在します' } },
          { status: 409 }
        );
      }
      console.error('[super-admin/plans POST]', error);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: error.message } },
        { status: 500 }
      );
    }

    // 監査ログ記録 (operator/07-audit-monitoring §3 準拠)
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: plan.id,
        target_type: 'subscription_plan',
        action_type: 'create_plan',
        details: { plan_key: input.plan_key, display_name: input.display_name, plan_type: input.plan_type },
        severity: 'info',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/plans POST] audit log failed (graceful):', auditErr);
    }

    return NextResponse.json({ data: plan }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/plans POST]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
