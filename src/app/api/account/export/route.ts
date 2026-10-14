import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import {
  buildExportFilename,
  generateAccountExport,
  type ExportSummary,
} from '@/lib/account-export';

/**
 * #1131 個人データエクスポート (GDPR データポータビリティ)
 *
 * GET /api/account/export
 * ログイン中のユーザー本人のデータだけを JSON ファイルとして返す。
 * Web の設定画面 (Cookie 認証) と、モバイルアプリ (Authorization: Bearer) が同じ URL・同じ契約で使う。
 * 本人以外の ID を受け取る入力は無い。何を出すか / 出さないかは src/lib/account-export-tables.ts を参照。
 *
 * 全テーブルを走査するため、レスポンスはストリームで返す (大きなアカウントでも 1 ページ分しかメモリに載せず、
 * サーバーレス関数のレスポンスサイズ上限にも掛からない)。
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const logger = createLogger('GET /api/account/export', generateRequestId()).withUser(user.id);

  // 重い読み取りなので連打を防ぐ。判定できないとき (Redis 障害) は通さない (fail-close)
  try {
    const rateLimit = await checkRateLimit(user.id, 'export');
    if (!rateLimit.success) {
      logger.warn('Account export rate limited', { reset: rateLimit.reset });
      return rateLimitExceededResponse(rateLimit);
    }
  } catch (error) {
    logger.error('Account export rate limit check failed', error);
    return NextResponse.json(
      { error: 'エクスポートを開始できませんでした。時間をおいて再度お試しください。', code: 'EXPORT_UNAVAILABLE' },
      { status: 503, headers: NO_STORE },
    );
  }

  const startedAt = Date.now();
  const iterator = generateAccountExport(supabase, user.id);

  // 最初のテーブルを読むところまでを先に実行し、失敗したらストリームを始める前に 500 を返す
  let first: IteratorResult<string, ExportSummary>;
  try {
    first = await iterator.next();
  } catch (error) {
    logger.error('Account export failed before streaming', error);
    return NextResponse.json(
      { error: 'エクスポートに失敗しました。時間をおいて再度お試しください。', code: 'EXPORT_FAILED' },
      { status: 500, headers: NO_STORE },
    );
  }

  const encoder = new TextEncoder();
  let pending: IteratorResult<string, ExportSummary> | null = first;
  let bytes = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = pending ?? (await iterator.next());
        pending = null;
        if (step.done) {
          const summary = step.value;
          logger.info('Account export completed', {
            complete: summary.complete,
            tables: Object.keys(summary.row_counts).length,
            rows: Object.values(summary.row_counts).reduce((sum, count) => sum + count, 0),
            bytes,
            duration_ms: Date.now() - startedAt,
            truncated_tables: summary.truncated_tables.map((t) => `${t.table}:${t.reason}`),
            skipped_tables: summary.skipped_tables.map((t) => `${t.table}:${t.reason}`),
          });
          controller.close();
          return;
        }
        const chunk = encoder.encode(step.value);
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      } catch (error) {
        // 200 を返し始めた後なので、途中で打ち切って受け取り側を失敗させる (欠けた JSON を完成品に見せない)
        logger.error('Account export failed while streaming', error, { bytes });
        controller.error(error);
      }
    },
    async cancel() {
      logger.warn('Account export cancelled by the client', { bytes });
      await iterator.return(undefined as unknown as ExportSummary);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${buildExportFilename()}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
