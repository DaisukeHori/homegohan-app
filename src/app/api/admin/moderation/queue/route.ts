/**
 * GET /api/admin/moderation/queue — モデレーションキュー一覧
 * operator/02-api-spec.md §5 準拠
 * 権限: admin, super_admin, content_moderator
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { ModerationQueueSearchSchema } from '@/lib/admin/moderation-schemas';

export const dynamic = 'force-dynamic';

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
  const parseResult = ModerationQueueSearchSchema.safeParse(Object.fromEntries(searchParams));
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'パラメータが不正です', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const params = parseResult.data;
  const supabase = await createClient();

  // moderation_items テーブルからキューを取得 (未作成の場合は空を返す)
  try {
    let query = supabase
      .from('moderation_items')
      .select('*', { count: 'exact' })
      .eq('status', params.status);

    if (params.type) {
      query = query.eq('type', params.type);
    }

    const from = (params.page - 1) * params.per_page;
    const to = from + params.per_page - 1;
    query = query.range(from, to).order('created_at', { ascending: true });

    const { data, error, count } = await query;

    if (error) {
      // テーブル未作成の場合は空配列を返す
      return NextResponse.json({
        data: [],
        meta: { total: 0, page: params.page, per_page: params.per_page },
      });
    }

    return NextResponse.json({
      data: data ?? [],
      meta: {
        total: count ?? 0,
        page: params.page,
        per_page: params.per_page,
      },
    });
  } catch {
    // テーブル不在時のフォールバック
    return NextResponse.json({
      data: [],
      meta: { total: 0, page: params.page, per_page: params.per_page },
    });
  }
}
