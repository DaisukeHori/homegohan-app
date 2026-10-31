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
import { internalError } from '@/lib/api/errors';
import { AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED, authFailureNested } from '@/lib/api/error-responses';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';
import { ReconciliationQuerySchema } from '@/lib/admin/finance-schemas';
import { financeInvalidQueryResponse } from '@/lib/admin/finance-query-errors';

export const dynamic = 'force-dynamic';

/** 一覧の構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/admin/finance/reconciliation';

export async function GET(request: NextRequest) {
  try {
    // reconciliation は admin / super_admin 限定
    // (finance は DB 側のみ表示)
    const user = await requireRole(['admin', 'super_admin', 'finance']);
    const isAdminOrSuperAdmin = user.roles.some((r) => ['admin', 'super_admin'].includes(r));

    const supabase = await createClient();

    // admin_audit_logs から reconciliation discrepancy を取得
    const { searchParams } = new URL(request.url);
    // page / per_page が 1 以上の整数でない・per_page が上限より大きいときは、DB に触れずに 400 (#2101 X6。
    // 以前は parseInt だけで読み、?page=abc の NaN を .range に渡して 500・?page=0 で負の offset にしていた)
    const queryResult = ReconciliationQuerySchema.safeParse({
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });
    if (!queryResult.success) {
      return financeInvalidQueryResponse(queryResult.error.issues);
    }
    const { from, to, page, per_page: perPage } = queryResult.data;

    // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectDiscrepancyLogs) から作る
    const selectDiscrepancyLogs = (options: { head?: boolean } = {}) => {
      let logsQuery = supabase
        .from('admin_audit_logs')
        .select('*', listCountOptions(options.head))
        .eq('action_type', 'system.stripe.reconcile_discrepancy');

      if (from) logsQuery = logsQuery.gte('created_at', from);
      if (to) logsQuery = logsQuery.lte('created_at', to);
      return logsQuery;
    };

    const offset = (page - 1) * perPage;
    const { data: logs, count, error: logsError } = await resolveBeyondLastPage(
      await selectDiscrepancyLogs()
        .order('created_at', { ascending: false })
        .range(offset, offset + perPage - 1),
      () => selectDiscrepancyLogs({ head: true }),
      LIST_ROUTE_NAME,
    );

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
    // 読めなかった (DB の失敗) ときは 500。0 件にしない (#1917 の続き。以前は失敗を捨て、DB の契約が 0 件 = Stripe との食い違いのように見えていた)
    const { data: dbSubs, error: dbSubsError } = await supabase
      .from('personal_subscriptions')
      .select('id, status, stripe_subscription_id')
      .in('status', ['active', 'trialing', 'past_due', 'grace']);
    if (dbSubsError) {
      return internalError(LIST_ROUTE_NAME, dbSubsError, { userId: user.id, table: 'personal_subscriptions' }, { shape: 'nested' });
    }

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
    const authFailure = authFailureNested(err, { code: AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('GET /api/admin/finance/reconciliation', err, { log_context: '[finance/reconciliation] unexpected error' }, { shape: 'nested' });
  }
}
