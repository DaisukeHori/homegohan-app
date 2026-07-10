/**
 * GET /api/admin/moderation — モデレーションフラグ一覧
 * 権限: admin, super_admin, content_moderator
 *
 * レスポンス形式:
 *   { mealFlags: [], recipeFlags: [], aiFlags: [] }
 *
 * #1041 (F4-04) 修正: 実在しない `moderation_items` テーブル参照を廃止し、
 * 実テーブル (moderation_flags / recipe_flags) を参照するよう修正。
 * ai_content はバックエンドテーブルが未実装のため常に空配列 (要 migration、捏造しない)。
 * DB エラー発生時は空配列にフォールバックせず 500 を返す (fail-closed)。
 *
 * E2E: w5-12-admin-adversarial G-27, G-27b
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';
import { fetchModerationList } from '@/lib/admin/moderation-backend';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'escalated']).optional().default('pending'),
});

export async function GET(request: Request) {
  try {
    await requireRole(['admin', 'super_admin', 'content_moderator']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
        { status: 403 },
      );
    }
    throw err;
  }

  const { searchParams } = new URL(request.url);
  const parseResult = QuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'パラメータが不正です', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { status } = parseResult.data;
  const supabase = await createClient();

  try {
    const [mealFlags, recipeFlags] = await Promise.all([
      fetchModerationList(supabase, 'food', status, 50),
      fetchModerationList(supabase, 'recipe', status, 50),
    ]);

    // ai_content はバックエンドテーブル未実装 (要 migration)。既存レスポンス形式との
    // 互換のため空配列を返すが、これは「該当なし」ではなく「未サポート」を意味する。
    const aiFlags: never[] = [];

    return NextResponse.json({ mealFlags, recipeFlags, aiFlags });
  } catch (err) {
    console.error('[api/admin/moderation] fetch error:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'モデレーションデータの取得に失敗しました' } },
      { status: 500 },
    );
  }
}
