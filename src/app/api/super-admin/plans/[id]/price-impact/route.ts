/**
 * GET /api/super-admin/plans/[id]/price-impact — 価格変更影響シミュレーション
 *
 * operator/02-api-spec.md §17 / operator/04-plan-management.md §3.3 準拠
 * 権限: super_admin のみ
 *
 * #1102 (オーナー判断 2026-10-08): 価格変更は新規契約だけに適用する。既存の契約者の請求額は変わらない。
 * そのため、この API が返す「既存契約への影響」は常にゼロ (新規契約のみ)。personal_subscriptions は集計しない。
 *   - applies_to は new_only だけ (省略時も new_only)。on_renewal / immediately は 400 (OP_INVALID_QUERY)
 *   - affected_subscription_count / affected_mrr_change_jpy は常に 0、affected_user_sample は空、effective_timing は 'none'
 * 返す形は従来のまま変えていない (画面の型と互換)。新しい価格が新規契約にだけ適用されることを確認するための API。
 *
 * 経緯: #1212 で、applies_to ごとに既存契約への影響 (on_renewal / immediately は対象契約数 x 価格差の MRR 変化) を切り分けていたが、
 * 既存サブスクリプションへ新価格を反映する処理は実装されていなかった (選んでも請求額は変わらない)。#1102 でその選択肢ごと外した。
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
    const supabase = await createClient();

    const { searchParams } = request.nextUrl;
    const queryResult = PriceImpactQuerySchema.safeParse({
      new_monthly_price_jpy: searchParams.get('new_monthly_price_jpy') ?? undefined,
      applies_to: searchParams.get('applies_to') ?? undefined,
    });

    if (!queryResult.success) {
      // issues 配列の生 JSON ではなく、最初の issue の message だけを返す (price-change と同じ。details には全 issues を含める)
      const firstIssueMessage = queryResult.error.issues[0]?.message ?? 'クエリが不正です';
      return NextResponse.json(
        { error: { code: 'OP_INVALID_QUERY', message: firstIssueMessage, details: queryResult.error.issues } },
        { status: 400 }
      );
    }

    // プランを取得 (存在確認と、現行の月額を返すため)
    const { data: plan, error: planErr } = await supabase
      .from('subscription_plans')
      .select('id, monthly_price_jpy')
      .eq('id', params.id)
      .single();

    if (planErr || !plan) {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
        { status: 404 }
      );
    }

    const currentMonthlyPrice = plan.monthly_price_jpy ?? 0;
    const newMonthlyPrice = queryResult.data.new_monthly_price_jpy ?? currentMonthlyPrice;

    // 新規契約のみ: 既存契約は現行価格のまま。影響する契約も、MRR の変化も無い (#1102)
    return NextResponse.json({
      data: {
        affected_subscription_count: 0,
        affected_mrr_change_jpy: 0,
        current_monthly_price_jpy: currentMonthlyPrice,
        new_monthly_price_jpy: newMonthlyPrice,
        applies_to: 'new_only',
        effective_timing: 'none',
        affected_user_sample: [],
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
