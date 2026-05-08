/**
 * GET /api/admin/finance/revenue
 * 収益スナップショット一覧 + 集計
 * operator/02-api-spec.md §20
 * 権限: admin, super_admin, finance
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { RevenueQuerySchema } from '@/lib/admin/finance-schemas';

export async function GET(request: NextRequest) {
  try {
    await requireRole(['admin', 'super_admin', 'finance']);
    const supabase = createClient();

    const { searchParams } = new URL(request.url);
    const query = RevenueQuerySchema.parse({
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      granularity: searchParams.get('granularity') ?? undefined,
      segment: searchParams.get('segment') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    let dbQuery = supabase
      .from('revenue_snapshots')
      .select('*', { count: 'exact' })
      .order('date', { ascending: false });

    if (query.from) {
      dbQuery = dbQuery.gte('date', query.from);
    }
    if (query.to) {
      dbQuery = dbQuery.lte('date', query.to);
    }

    const offset = (query.page - 1) * query.per_page;
    dbQuery = dbQuery.range(offset, offset + query.per_page - 1);

    const { data: snapshots, count, error } = await dbQuery;

    if (error) {
      throw new Error(error.message);
    }

    // 集計サマリー
    const { data: summary } = await supabase
      .from('revenue_snapshots')
      .select('total_mrr_jpy, total_arr_jpy, new_signups, cancellations')
      .gte('date', query.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
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
    console.error('[finance/revenue] unexpected error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
