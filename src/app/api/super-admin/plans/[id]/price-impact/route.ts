/**
 * GET /api/super-admin/plans/[id]/price-impact — 価格変更影響シミュレーション
 *
 * operator/02-api-spec.md §17 / operator/04-plan-management.md §3.3 準拠
 * 権限: super_admin のみ
 *
 * #1212 修正: 従来は applies_to をパースしてレスポンスにエコーバックするだけで集計に
 * 使っておらず、new_only (新規契約のみ。既存契約は不変) を選んでも「全既存契約者 x 価格差」を
 * MRR 影響として返していた (super_admin が収益への影響を見誤る)。
 * 適用範囲ごとに既存契約への影響を切り分ける:
 *   - new_only    : 既存契約は現行価格のまま。personal_subscriptions を集計せず 0 件 / 0 円
 *   - on_renewal  : 既存契約は次回更新時から新価格 (effective_timing = 'next_renewal')
 *   - immediately : 既存契約へ即時に新価格 (effective_timing = 'immediate')
 *
 * 注意: on_renewal / immediately を実際に既存サブスクリプションへ反映する処理は未実装
 * (stripe-price-sync は applies_to を受け取るだけ。#1102)。この API が返すのは「反映された場合」の
 * 概算であり、personal_subscriptions に interval 列が無いため年額契約も月額差で計算する。
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { PriceImpactQuerySchema, type PriceImpactQueryInput } from '@/lib/super-admin/plans-schemas';

type RouteContext = { params: { id: string } };

type AppliesTo = NonNullable<PriceImpactQueryInput['applies_to']>;

/** 既存契約へ新価格が反映されるタイミング (new_only は既存契約に反映されない) */
const EFFECTIVE_TIMING: Record<AppliesTo, 'none' | 'next_renewal' | 'immediate'> = {
  new_only: 'none',
  on_renewal: 'next_renewal',
  immediately: 'immediate',
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

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

    // applies_to 省略時は new_only (UI の既定値・従来のエコーバック値と同じ)
    const appliesTo: AppliesTo = queryResult.data.applies_to ?? 'new_only';

    const currentMonthlyPrice = plan.monthly_price_jpy ?? 0;
    const newMonthlyPrice = queryResult.data.new_monthly_price_jpy ?? currentMonthlyPrice;

    // new_only は既存契約に一切影響しない (operator/04-plan-management.md §3.3 の表) ため、
    // personal_subscriptions を集計せず 0 件 / 0 円のまま返す (#1212)
    let affectedSubscriptionCount = 0;
    let affectedUserSample: Array<{ user_id: string }> = [];

    if (appliesTo !== 'new_only') {
      // 影響する personal_subscriptions を集計 (operator/04-plan-management.md §3.3 SQL 準拠)。
      // count は limit に関わらず条件に合う全件数、data は先頭 5 件のサンプル。
      const { data: impactData, count, error: impactErr } = await supabase
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

      affectedSubscriptionCount = count ?? 0;
      affectedUserSample = (impactData ?? []).map((s) => ({ user_id: s.user_id }));
    }

    const affectedMrrChange = (newMonthlyPrice - currentMonthlyPrice) * affectedSubscriptionCount;

    return NextResponse.json({
      data: {
        affected_subscription_count: affectedSubscriptionCount,
        affected_mrr_change_jpy: affectedMrrChange,
        current_monthly_price_jpy: currentMonthlyPrice,
        new_monthly_price_jpy: newMonthlyPrice,
        applies_to: appliesTo,
        effective_timing: EFFECTIVE_TIMING[appliesTo],
        affected_user_sample: affectedUserSample,
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
