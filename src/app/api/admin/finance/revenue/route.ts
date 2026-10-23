/**
 * GET /api/admin/finance/revenue
 * 収益スナップショット一覧 + 集計
 * operator/02-api-spec.md §20
 * 権限: admin, super_admin, finance
 */
import { NextRequest, NextResponse } from 'next/server';
import { jstDayOffset } from '@/lib/jst-day-ranges';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED, authFailureNested } from '@/lib/api/error-responses';
import { RevenueQuerySchema } from '@/lib/admin/finance-schemas';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';

export const dynamic = 'force-dynamic';

/** 一覧の構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/admin/finance/revenue';

/** 集計サマリーの既定の期間 (from を指定しないとき、JST の今日から何日前までの revenue_snapshots.date を見るか) */
const REVENUE_SUMMARY_LOOKBACK_DAYS = 30;

export async function GET(request: NextRequest) {
  try {
    await requireRole(['admin', 'super_admin', 'finance']);
    const supabase = await createClient();

    const { searchParams } = new URL(request.url);
    const query = RevenueQuerySchema.parse({
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      granularity: searchParams.get('granularity') ?? undefined,
      segment: searchParams.get('segment') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectSnapshots) から作る
    const selectSnapshots = (options: { head?: boolean } = {}) => {
      let dbQuery = supabase
        .from('revenue_snapshots')
        .select('*', listCountOptions(options.head));

      if (query.from) {
        dbQuery = dbQuery.gte('date', query.from);
      }
      if (query.to) {
        dbQuery = dbQuery.lte('date', query.to);
      }
      return dbQuery;
    };

    const offset = (query.page - 1) * query.per_page;
    const { data: snapshots, count, error } = await resolveBeyondLastPage(
      await selectSnapshots()
        .order('date', { ascending: false })
        .range(offset, offset + query.per_page - 1),
      () => selectSnapshots({ head: true }),
      LIST_ROUTE_NAME,
    );

    if (error) {
      throw new Error(error.message);
    }

    // 集計サマリー
    const { data: summary } = await supabase
      .from('revenue_snapshots')
      .select('total_mrr_jpy, total_arr_jpy, new_signups, cancellations')
      .gte('date', query.from ?? jstDayOffset(-REVENUE_SUMMARY_LOOKBACK_DAYS))
      .order('date', { ascending: false })
      .limit(30);

    const avgMrr = summary && summary.length > 0
      ? Math.round(summary.reduce((s, r) => s + (r.total_mrr_jpy ?? 0), 0) / summary.length)
      : 0;

    return NextResponse.json({
      data: snapshots ?? [],
      meta: {
        total: count ?? 0,
        page: query.page,
        per_page: query.per_page,
        summary: {
          avg_mrr_jpy: avgMrr,
          latest_mrr_jpy: snapshots?.[0]?.total_mrr_jpy ?? 0,
          latest_arr_jpy: snapshots?.[0]?.total_arr_jpy ?? 0,
        },
      },
    });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('GET /api/admin/finance/revenue', err, { log_context: '[finance/revenue] unexpected error' }, { shape: 'nested' });
  }
}
