/**
 * GET /api/admin/moderation/queue — モデレーションキュー一覧
 * operator/02-api-spec.md §5 準拠
 * 権限: admin, super_admin, content_moderator
 *
 * #1041 (F4-04) 修正: 実在しない `moderation_items` テーブル参照を廃止し、
 * 実テーブル (moderation_flags / recipe_flags) を参照する。
 * `type` 未指定時は両テーブルをマージしてページングする。
 * ai_content はバックエンドテーブル未実装のため常に空 (要 migration)。
 * DB エラー時は空配列にフォールバックせず 500 を返す (fail-closed)。
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { ModerationQueueSearchSchema } from '@/lib/admin/moderation-schemas';
import {
  countModeration,
  fetchModerationList,
  isModerationBacked,
  type ModerationBackedType,
  type NormalizedModerationItem,
} from '@/lib/admin/moderation-backend';

export const dynamic = 'force-dynamic';

// 1 タイプあたりの安全上限 (メモリ内マージ・ソートのためのフェッチ件数)
const PER_TYPE_FETCH_CAP = 500;

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

  // ai_content (または将来追加され得る未サポートタイプ) は空を返す (要 migration、捏造しない)
  if (params.type && !isModerationBacked(params.type)) {
    return NextResponse.json({
      data: [],
      meta: { total: 0, page: params.page, per_page: params.per_page },
    });
  }

  const typesToQuery: ModerationBackedType[] = params.type ? [params.type] : ['food', 'recipe'];

  try {
    let combined: NormalizedModerationItem[] = [];
    let total = 0;

    for (const type of typesToQuery) {
      const [items, count] = await Promise.all([
        fetchModerationList(supabase, type, params.status, PER_TYPE_FETCH_CAP),
        countModeration(supabase, type, params.status),
      ]);
      combined = combined.concat(items);
      total += count;
    }

    combined.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));

    const from = (params.page - 1) * params.per_page;
    const paged = combined.slice(from, from + params.per_page);

    return NextResponse.json({
      data: paged,
      meta: { total, page: params.page, per_page: params.per_page },
    });
  } catch (err) {
    console.error('[api/admin/moderation/queue] fetch error:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'モデレーションキューの取得に失敗しました' } },
      { status: 500 },
    );
  }
}
