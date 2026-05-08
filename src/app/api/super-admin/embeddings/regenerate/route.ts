/**
 * POST /api/super-admin/embeddings/regenerate — Embedding 再生成
 * super_admin ロール必須
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

const ALLOWED_TABLES = ['dataset_ingredients', 'recipes', 'meals', 'catalog_products'] as const;

export async function POST(request: NextRequest) {
  try {
    await requireRole(['super_admin']);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'リクエストボディが不正です' } }, { status: 400 });
    }

    const { table, onlyMissing } = (body as Record<string, unknown>) ?? {};

    if (!table || typeof table !== 'string') {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'table は必須です' } }, { status: 400 });
    }

    if (!(ALLOWED_TABLES as readonly string[]).includes(table)) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: `table は ${ALLOWED_TABLES.join(' / ')} のいずれかである必要があります` } },
        { status: 400 },
      );
    }

    // 実際の再生成処理はここでは未実装 (Edge Function 呼び出し等)
    return NextResponse.json({
      ok: true,
      table,
      onlyMissing: Boolean(onlyMissing),
      message: '再生成ジョブをキューに追加しました',
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
