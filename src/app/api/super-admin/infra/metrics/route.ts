/**
 * GET /api/super-admin/infra/metrics  — インフラメトリクス時系列
 * operator/02-api-spec.md §13 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { InfraMetricsQuerySchema } from '@/lib/super-admin/infra-schemas';

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

    let query = supabase
      .from('infra_metrics')
      .select('*')
      .order('recorded_at', { ascending: false })
      .limit(limit);

    if (metric_name) query = query.eq('metric_name', metric_name);
    if (source) query = query.eq('source', source);
    if (from) query = query.gte('recorded_at', from);
    if (to) query = query.lte('recorded_at', to);

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }

    return NextResponse.json({
      data: data ?? [],
      meta: { count: (data ?? []).length },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
  }
}
