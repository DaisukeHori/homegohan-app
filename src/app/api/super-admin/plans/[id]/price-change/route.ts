/**
 * POST /api/super-admin/plans/[id]/price-change — 価格変更実行
 *
 * operator/02-api-spec.md §17 / operator/04-plan-management.md §3.3 /
 * operator/05-stripe-integration.md 準拠
 *
 * 権限: super_admin のみ
 *
 * Stripe Secret Key 未設定時はモック動作 (graceful degradation)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { PriceChangeSchema } from '@/lib/super-admin/plans-schemas';

type RouteContext = { params: { id: string } };

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    const body = await request.json();
    const parseResult = PriceChangeSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_INPUT', message: parseResult.error.message, details: parseResult.error.issues } },
        { status: 400 }
      );
    }

    const input = parseResult.data;

    // プランを取得
    const { data: plan, error: planErr } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', params.id)
      .single();

    if (planErr || !plan) {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
        { status: 404 }
      );
    }

    // draft は価格変更 API を使う必要なし (PATCH で対応)
    if (plan.status === 'draft') {
      return NextResponse.json(
        { error: { code: 'OP_PLAN_DRAFT_USE_PATCH', message: 'draft プランは PATCH API で価格変更してください' } },
        { status: 422 }
      );
    }

    let newStripePriceId: string | null = null;

    // #1041 (F4-06) 修正: STRIPE_SECRET_KEY が設定されている場合は「本番で Stripe 同期が
    // 必須」という明示的な状態であり、Edge Function 呼び出しに失敗した場合はそれを
    // 偽成功 (DB のみ更新して 200 を返す) にせず 502 で失敗させる (fail-closed)。
    // STRIPE_SECRET_KEY が未設定の場合のみ、意図された dev/mock モードとして続行する。
    const stripeSyncExpected = Boolean(process.env.STRIPE_SECRET_KEY && plan.stripe_product_id);

    if (stripeSyncExpected) {
      const edgeFnUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/stripe-price-sync`;
      let edgeRes: Response;
      try {
        // Edge Function stripe-price-sync を呼ぶ (operator/04-plan-management.md §3.3 準拠)
        edgeRes = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            plan_id: params.id,
            stripe_product_id: plan.stripe_product_id,
            new_monthly_price_jpy: input.new_monthly_price_jpy,
            new_yearly_price_jpy: input.new_yearly_price_jpy,
            applies_to: input.applies_to,
            actor_id: user.id,
            reason: input.reason,
          }),
        });
      } catch (stripeErr) {
        console.error('[super-admin/price-change] Stripe Edge Function fetch failed:', stripeErr);
        return NextResponse.json(
          {
            error: {
              code: 'OP_STRIPE_SYNC_FAILED',
              message: 'Stripe との価格同期に失敗しました。DB は更新していません。',
            },
          },
          { status: 502 },
        );
      }

      if (!edgeRes.ok) {
        const errBody = await edgeRes.text().catch(() => '');
        console.error('[super-admin/price-change] Edge Function stripe-price-sync failed:', edgeRes.status, errBody);
        return NextResponse.json(
          {
            error: {
              code: 'OP_STRIPE_SYNC_FAILED',
              message: `Stripe との価格同期に失敗しました (HTTP ${edgeRes.status})。DB は更新していません。`,
            },
          },
          { status: 502 },
        );
      }

      const edgeData = (await edgeRes.json()) as { new_stripe_price_id?: string };
      newStripePriceId = edgeData.new_stripe_price_id ?? null;

      if (!newStripePriceId) {
        // Edge Function が 200 を返したのに Price ID が取得できない場合も
        // 同期未完了とみなし、偽成功にしない。
        console.error('[super-admin/price-change] Edge Function returned ok but no new_stripe_price_id');
        return NextResponse.json(
          {
            error: {
              code: 'OP_STRIPE_SYNC_FAILED',
              message: 'Stripe Price の作成結果を確認できませんでした。DB は更新していません。',
            },
          },
          { status: 502 },
        );
      }
    } else {
      console.warn('[super-admin/price-change] STRIPE_SECRET_KEY not set or stripe_product_id missing — mock mode (dev/test)');
    }

    // DB 更新: subscription_plans
    const planUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.new_monthly_price_jpy != null) planUpdate.monthly_price_jpy = input.new_monthly_price_jpy;
    if (input.new_yearly_price_jpy != null) planUpdate.yearly_price_jpy = input.new_yearly_price_jpy;
    if (newStripePriceId) planUpdate.stripe_price_id = newStripePriceId;

    const { error: updateErr } = await supabase
      .from('subscription_plans')
      .update(planUpdate)
      .eq('id', params.id);

    if (updateErr) {
      console.error('[super-admin/price-change POST]', updateErr);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: updateErr.message } },
        { status: 500 }
      );
    }

    // plan_price_history に INSERT (operator/01-data-model.md §3.4 準拠)
    const { error: historyErr } = await supabase.from('plan_price_history').insert({
      plan_id: params.id,
      old_monthly_price_jpy: plan.monthly_price_jpy,
      new_monthly_price_jpy: input.new_monthly_price_jpy ?? plan.monthly_price_jpy,
      old_yearly_price_jpy: plan.yearly_price_jpy,
      new_yearly_price_jpy: input.new_yearly_price_jpy ?? plan.yearly_price_jpy,
      old_stripe_price_id: plan.stripe_price_id,
      new_stripe_price_id: newStripePriceId,
      changed_by: user.id,
      reason: input.reason,
      effective_at: input.effective_at,
      applies_to: input.applies_to,
    });

    if (historyErr) {
      console.error('[super-admin/price-change POST] price_history INSERT failed:', historyErr);
      // 非致命的: 続行
    }

    // 監査ログ記録 (severity='warn' — 課金影響操作)
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: params.id,
        target_type: 'subscription_plan',
        action_type: 'change_price',
        details: {
          plan_key: plan.plan_key,
          old_monthly_price_jpy: plan.monthly_price_jpy,
          new_monthly_price_jpy: input.new_monthly_price_jpy,
          old_yearly_price_jpy: plan.yearly_price_jpy,
          new_yearly_price_jpy: input.new_yearly_price_jpy,
          applies_to: input.applies_to,
          reason: input.reason,
          stripe_mock: !newStripePriceId,
        },
        severity: 'warn',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/price-change POST] audit log failed (graceful):', auditErr);
    }

    return NextResponse.json({
      data: {
        plan_id: params.id,
        plan_key: plan.plan_key,
        new_monthly_price_jpy: input.new_monthly_price_jpy,
        new_yearly_price_jpy: input.new_yearly_price_jpy,
        new_stripe_price_id: newStripePriceId,
        applies_to: input.applies_to,
        stripe_mock: !newStripePriceId,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/price-change POST]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}
