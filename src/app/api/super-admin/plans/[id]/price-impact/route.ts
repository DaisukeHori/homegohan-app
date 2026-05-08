/**
 * GET /api/super-admin/plans/[id]/price-impact — 価格変更影響シミュレーション
 *
 * operator/02-api-spec.md §17 / operator/04-plan-management.md §3.3 準拠
 * 権限: super_admin のみ
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { PriceImpactQuerySchema } from '@/lib/super-admin/plans-schemas';

type RouteContext = { params: { id: string } };

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    await requireRole(['super_admin']);
    const supabase = createClient();

    const { searchParams } = request.nextUrl;
    const queryResult = PriceImpactQuerySchema.safeParse({
      new_monthly_price_jpy: searchParams.get('new_monthly_price_jpy') ?? undefined,
      applies_to: searchParams.get('applies_to') ?? undefined,
    });

    if (!queryResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_QUERY', message: queryResult.error.message } },
        { status: 400 }
      );
    }

    // プランを取得
    const { data: plan, error: planErr } = await supabase
      .from('subscription_plans')
      .select('id, plan_key, monthly_price_jpy, plan_type')
      .eq('id', params.id)
      .single();

    if (planErr || !plan) {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
        { status: 404 }
      );
    }

    // 影響する personal_subscriptions 数を計算 (operator/04-plan-management.md §3.3 SQL 準拠)
    const { data: impactData, error: impactErr } = await supabase
      .from('personal_subscriptions')
      .select('id, user_id', { count: 'exact' })
      .eq('plan_key', plan.plan_key)
      .in('status', ['active', 'trialing', 'paused'])
      .not('stripe_subscription_id', 'is', null)
      .limit(5);

    if (impactErr) {
      console.error('[super-admin/plans/[id]/price-impact GET]', impactErr);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: impactErr.message } },
        { status: 500 }
      );
    }

    const { count: affectedCount } = await supabase
      .from('personal_subscriptions')
      .select('*', { count: 'exact', head: true })
      .eq('plan_key', plan.plan_key)
      .in('status', ['active', 'trialing', 'paused'])
      .not('stripe_subscription_id', 'is', null);

    const currentMonthlyPrice = plan.monthly_price_jpy ?? 0;
    const newMonthlyPrice = queryResult.data.new_monthly_price_jpy ?? currentMonthlyPrice;
    const affectedSubscriptionCount = affectedCount ?? 0;
    const affectedMrrChange = (newMonthlyPrice - currentMonthlyPrice) * affectedSubscriptionCount;

    return NextResponse.json({
      data: {
        affected_subscription_count: affectedSubscriptionCount,
        affected_mrr_change_jpy: affectedMrrChange,
        current_monthly_price_jpy: currentMonthlyPrice,
        new_monthly_price_jpy: newMonthlyPrice,
        applies_to: queryResult.data.applies_to ?? 'new_only',
        affected_user_sample: (impactData ?? []).map((s) => ({ user_id: s.user_id })),
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/plans/[id]/price-impact GET]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
