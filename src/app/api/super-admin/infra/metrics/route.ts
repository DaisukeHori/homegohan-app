/**
 * GET /api/super-admin/infra/metrics  — インフラメトリクス時系列
 * operator/02-api-spec.md §13 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { InfraMetricsQuerySchema } from '@/lib/super-admin/infra-schemas';
import { internalError } from '@/lib/api/errors';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

export async function GET(request: NextRequest) {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();
    const { searchParams } = new URL(request.url);

    const parsed = InfraMetricsQuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です' } },
        { status: 400 },
      );
    }

    const { metric_name, source, from, to, limit } = parsed.data;

    // 記録した日時の新しい順。同じ日時は id の順で、上限の境目でどれが入るかも決まる (#2139 T1)
    let query = orderListBy(supabase.from('infra_metrics').select('*'), LIST_ORDERS.superAdminInfraMetrics).limit(limit);

    if (metric_name) query = query.eq('metric_name', metric_name);
    if (source) query = query.eq('source', source);
    if (from) query = query.gte('recorded_at', from);
    if (to) query = query.lte('recorded_at', to);

    const { data, error } = await query;

    if (error) {
      return internalError('GET /api/super-admin/infra/metrics', error, {}, { shape: 'nested' });
    }

    return NextResponse.json({
      data: data ?? [],
      meta: { count: (data ?? []).length },
    });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/super-admin/infra/metrics', err, {}, { shape: 'nested' });
  }
}
