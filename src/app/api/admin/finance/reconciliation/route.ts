/**
 * GET /api/admin/finance/reconciliation
 * Stripe ↔ DB 整合チェック結果表示
 * operator/05-stripe-integration.md §8
 * operator/02-api-spec.md §22 (cron/stripe-reconcile 結果の参照 API)
 * 権限: admin, super_admin (finance は閲覧のみ、設計書 §11 参照)
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // reconciliation は admin / super_admin 限定
    // (finance は DB 側のみ表示)
    const user = await requireRole(['admin', 'super_admin', 'finance']);
    const isAdminOrSuperAdmin = user.roles.some((r) => ['admin', 'super_admin'].includes(r));

    const supabase = createClient();

    // admin_audit_logs から reconciliation discrepancy を取得
    const { searchParams } = new URL(request.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const page = parseInt(searchParams.get('page') ?? '1', 10);
    const perPage = parseInt(searchParams.get('per_page') ?? '50', 10);

    let logsQuery = supabase
      .from('admin_audit_logs')
      .select('*', { count: 'exact' })
      .eq('action_type', 'system.stripe.reconcile_discrepancy')
      .order('created_at', { ascending: false });

    if (from) logsQuery = logsQuery.gte('created_at', from);
    if (to) logsQuery = logsQuery.lte('created_at', to);

    const offset = (page - 1) * perPage;
    logsQuery = logsQuery.range(offset, offset + perPage - 1);

    const { data: logs, count, error: logsError } = await logsQuery;

    if (logsError) {
      throw new Error(logsError.message);
    }

    // discrepancy 統計
    const discrepancies = (logs ?? []).map((log) => {
      const details = (log.details as Record<string, unknown>) ?? {};
      return {
        id: log.id,
        type: (details.type as string) ?? 'unknown',
        stripe_subscription_id: (details.stripe_subscription_id as string) ?? null,
        stripe_status: (details.stripe_status as string) ?? null,
        db_status: (details.db_status as string) ?? null,
        stripe_amount: (details.stripe_amount as number) ?? null,
        db_amount: (details.db_amount as number) ?? null,
        user_id: log.target_id ?? null,
        detail: (details.detail as string) ?? '',
        detected_at: log.created_at,
      };
    });

    // DB 側サマリー (finance も閲覧可)
    const { data: dbSubs } = await supabase
      .from('personal_subscriptions')
      .select('id, status, stripe_subscription_id')
      .in('status', ['active', 'trialing', 'past_due', 'grace']);

    const dbSummary = {
      total_active_in_db: dbSubs?.length ?? 0,
      by_status: (dbSubs ?? []).reduce<Record<string, number>>((acc, s) => {
        acc[s.status] = (acc[s.status] ?? 0) + 1;
        return acc;
      }, {}),
    };

    // Stripe API 呼び出し (admin/super_admin のみ、Secret 未設定時は graceful)
    let stripeData: { total_active_in_stripe: number; stripe_available: boolean } | null = null;
    if (isAdminOrSuperAdmin && process.env.STRIPE_SECRET_KEY) {
      try {
        const stripeBaseUrl = 'https://api.stripe.com/v1/subscriptions?status=active&limit=1';
        const stripeRes = await fetch(stripeBaseUrl, {
          headers: {
            Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          },
        });
        if (stripeRes.ok) {
          const stripeJson = await stripeRes.json() as { data: unknown[]; has_more?: boolean };
          stripeData = {
            total_active_in_stripe: stripeJson.data?.length ?? 0,
            stripe_available: true,
          };
        } else {
          stripeData = { total_active_in_stripe: 0, stripe_available: false };
        }
      } catch {
        stripeData = { total_active_in_stripe: 0, stripe_available: false };
      }
    }

    return NextResponse.json({
      data: {
        discrepancies,
        db_summary: dbSummary,
        stripe_summary: stripeData ?? { stripe_available: false, message: 'Stripe Secret 未設定またはアクセス権限なし' },
      },
      meta: {
        total: count ?? 0,
        page,
        per_page: perPage,
        note: !isAdminOrSuperAdmin
          ? 'finance ロールは DB 側データのみ表示。Stripe API 呼び出しには admin / super_admin が必要です。'
          : undefined,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: err.message } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: err.message } },
        { status: 403 },
      );
    }
    console.error('[finance/reconciliation] unexpected error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
