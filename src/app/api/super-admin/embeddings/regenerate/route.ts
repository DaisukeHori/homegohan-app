/**
 * POST /api/super-admin/embeddings/regenerate — Embedding 再生成
 * super_admin ロール必須
 *
 * #1041 (F4-12) 修正:
 *  - 従来は `table` のバリデーション通過後、実処理を一切行わず常に
 *    `{ ok: true, message: '再生成ジョブをキューに追加しました' }` を返す偽成功だった。
 *  - ALLOWED_TABLES に実際には embedding 列を持たない `recipes` / `meals` /
 *    `catalog_products` が含まれており、実装済みの Edge Function
 *    (`supabase/functions/regenerate-embeddings`) が対応する
 *    `dataset_ingredients` / `dataset_recipes` / `dataset_menu_sets` と
 *    一致していなかった。ALLOWED_TABLES を実スキーマ (embedding 列を実際に
 *    持つテーブル) に合わせて修正する。
 *  - Edge Function 未設定 (env 不足) の場合は 503 を返す (安全側の失敗)。
 *  - Edge Function 呼び出しが失敗した場合は 502 を返す (偽成功にしない)。
 *  - 成功時は Edge Function の実際の処理結果 (processed / hasMore 等) を
 *    そのまま返す。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

// supabase/functions/regenerate-embeddings/index.ts の TABLE_CONFIGS と一致させる。
// (embedding 列を実際に持つテーブルのみ。dataset_menu_sets は content_embedding、
//  他は name_embedding を持つ。'recipes' / 'meals' / 'catalog_products' は
//  embedding 列を持たないため対象外 — 追加するには migration が必要)
const ALLOWED_TABLES = ['dataset_ingredients', 'dataset_recipes', 'dataset_menu_sets'] as const;

interface EdgeFunctionResult {
  success?: boolean;
  processed?: number;
  offset?: number;
  nextOffset?: number;
  totalCount?: number | null;
  hasMore?: boolean;
  message?: string;
  error?: string;
}

export async function POST(request: NextRequest) {
  try {
    await requireRole(['super_admin']);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'リクエストボディが不正です' } }, { status: 400 });
    }

    const { table, onlyMissing, offset, limit } = (body as Record<string, unknown>) ?? {};

    if (!table || typeof table !== 'string') {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'table は必須です' } }, { status: 400 });
    }

    if (!(ALLOWED_TABLES as readonly string[]).includes(table)) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: `table は ${ALLOWED_TABLES.join(' / ')} のいずれかである必要があります` } },
        { status: 400 },
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      // 判定不能 (Edge Function 呼び出し不可) な場合は成功を偽装せず、
      // 明示的にサービス利用不可を返す (fail-closed)。
      return NextResponse.json(
        {
          error: {
            code: 'OP_EMBEDDING_JOB_UNAVAILABLE',
            message: '埋め込み再生成サービスが設定されていません (Supabase 接続情報が不足しています)',
          },
        },
        { status: 503 },
      );
    }

    const edgeFnUrl = `${supabaseUrl}/functions/v1/regenerate-embeddings`;

    let edgeRes: Response;
    try {
      edgeRes = await fetch(edgeFnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({
          table,
          onlyMissing: Boolean(onlyMissing),
          offset: typeof offset === 'number' ? offset : 0,
          limit: typeof limit === 'number' ? limit : 100,
        }),
      });
    } catch (fetchErr) {
      console.error('[super-admin/embeddings/regenerate] Edge Function fetch failed:', fetchErr);
      return NextResponse.json(
        {
          error: {
            code: 'OP_EMBEDDING_JOB_FAILED',
            message: '埋め込み再生成ジョブの呼び出しに失敗しました',
          },
        },
        { status: 502 },
      );
    }

    const edgeData = (await edgeRes.json().catch(() => ({}))) as EdgeFunctionResult;

    if (!edgeRes.ok || edgeData.error) {
      console.error('[super-admin/embeddings/regenerate] Edge Function returned error:', edgeData.error ?? edgeRes.status);
      return NextResponse.json(
        {
          error: {
            code: 'OP_EMBEDDING_JOB_FAILED',
            message: edgeData.error ?? `埋め込み再生成ジョブが失敗しました (HTTP ${edgeRes.status})`,
          },
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      table,
      onlyMissing: Boolean(onlyMissing),
      processed: edgeData.processed ?? 0,
      offset: edgeData.offset ?? 0,
      nextOffset: edgeData.nextOffset,
      totalCount: edgeData.totalCount ?? null,
      hasMore: edgeData.hasMore ?? false,
      message: edgeData.message ?? '再生成ジョブを実行しました',
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
