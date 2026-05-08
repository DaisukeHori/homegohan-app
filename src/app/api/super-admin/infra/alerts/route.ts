/**
 * GET /api/super-admin/infra/alerts  — インフラアラート一覧
 * operator/02-api-spec.md §13 準拠
 * Sentry / Better Stack キー未設定時は infra_alerts テーブルのみ表示 (graceful)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { InfraAlertsQuerySchema } from '@/lib/super-admin/infra-schemas';

export async function GET(request: NextRequest) {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();
    const { searchParams } = new URL(request.url);

    const parsed = InfraAlertsQuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です' } },
        { status: 400 },
      );
    }

    const { resolved, page, per_page } = parsed.data;

    let query = supabase
      .from('infra_alerts')
      .select('*', { count: 'exact' })
      .order('triggered_at', { ascending: false })
      .range((page - 1) * per_page, page * per_page - 1);

    if (resolved === 'true') {
      query = query.not('resolved_at', 'is', null);
    } else if (resolved === 'false') {
      query = query.is('resolved_at', null);
    }

    const { data, error, count } = await query;

    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }

    // Sentry / Better Stack の外部情報は graceful: キー未設定時は DB データのみ返す
    const externalSources: { source: string; available: boolean }[] = [
      { source: 'sentry', available: !!process.env.SENTRY_DSN },
      { source: 'better_stack', available: !!process.env.BETTER_STACK_TOKEN },
    ];

    return NextResponse.json({
      data: data ?? [],
      meta: { total: count ?? 0, page, per_page },
      external_sources: externalSources,
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
