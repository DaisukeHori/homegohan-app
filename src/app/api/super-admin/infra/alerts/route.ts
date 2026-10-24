/**
 * GET /api/super-admin/infra/alerts  — インフラアラート一覧
 * operator/02-api-spec.md §13 準拠
 *
 * #1180: infra_alerts に書き込む処理 (監視データの収集) はまだ無く、この一覧は常に空になる。
 * 以前の応答にあった external_sources (SENTRY_DSN / BETTER_STACK_TOKEN の環境変数が設定されているか) は、
 * 画面で「Sentry / Better Stack が接続済み」に見えるが、Sentry / Better Stack を使う処理はリポジトリのどこにも無く、
 * 環境変数があっても接続はされていない。誤解を招くため、応答から取り除いた。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { InfraAlertsQuerySchema } from '@/lib/super-admin/infra-schemas';
import { internalError } from '@/lib/api/errors';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';

/** 一覧の構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/super-admin/infra/alerts';

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

    // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectAlerts) から作る
    const selectAlerts = (options: { head?: boolean } = {}) => {
      let query = supabase
        .from('infra_alerts')
        .select('*', listCountOptions(options.head));

      if (resolved === 'true') {
        query = query.not('resolved_at', 'is', null);
      } else if (resolved === 'false') {
        query = query.is('resolved_at', null);
      }

      return query;
    };

    const { data, error, count } = await resolveBeyondLastPage(
      await selectAlerts()
        .order('triggered_at', { ascending: false })
        .range((page - 1) * per_page, page * per_page - 1),
      () => selectAlerts({ head: true }),
      LIST_ROUTE_NAME,
    );

    if (error) {
      return internalError(LIST_ROUTE_NAME, error, {}, { shape: 'nested' });
    }

    return NextResponse.json({
      data: data ?? [],
      meta: { total: count ?? 0, page, per_page },
    });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/super-admin/infra/alerts', err, {}, { shape: 'nested' });
  }
}
