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
 *
 * #1041 round-2 修正:
 *  - (F) `moderation_flags_admin_all` は admin/super_admin のみで
 *    content_moderator を許可しない。requireRole 通過後に service-role
 *    (`getSupabaseAdmin()`) へ切り替えて content_moderator でも読めるようにする。
 *  - (G) `PER_TYPE_FETCH_CAP` (500) 超のデータがある場合、`meta.total` に
 *    実件数 (キャップ超) を返しつつ `data` はキャップ内の 500 件しか
 *    ページングできず、後方ページが不整合に空になっていた。`meta.total` を
 *    実際にページングできる範囲 (キャップ後) に揃え、`meta.capped` で
 *    キャップ到達 (実件数がキャップを超えている) ことを明示する。
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { getSupabaseAdmin } from '@/lib/supabase/server';
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
  // requireRole 通過後のみ到達する (#1041 round-2 F)。
  const supabaseAdmin = getSupabaseAdmin();

  // ai_content (または将来追加され得る未サポートタイプ) は空を返す (要 migration、捏造しない)
  if (params.type && !isModerationBacked(params.type)) {
    return NextResponse.json({
      data: [],
      meta: { total: 0, page: params.page, per_page: params.per_page, capped: false },
    });
  }

  const typesToQuery: ModerationBackedType[] = params.type ? [params.type] : ['food', 'recipe'];

  try {
    let combined: NormalizedModerationItem[] = [];
    // #1041 round-2 (G): total は実際にページングできる範囲 (キャップ後) に揃える。
    // 実件数がキャップを超える場合は capped=true とし、後方ページが不整合に
    // 空になる (meta.total だけ大きい) 状態を避ける。
    let total = 0;
    let capped = false;

    for (const type of typesToQuery) {
      const [items, count] = await Promise.all([
        fetchModerationList(supabaseAdmin, type, params.status, PER_TYPE_FETCH_CAP),
        countModeration(supabaseAdmin, type, params.status),
      ]);
      combined = combined.concat(items);
      if (count > PER_TYPE_FETCH_CAP) {
        capped = true;
        total += PER_TYPE_FETCH_CAP;
      } else {
        total += count;
      }
    }

    combined.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));

    const from = (params.page - 1) * params.per_page;
    const paged = combined.slice(from, from + params.per_page);

    return NextResponse.json({
      data: paged,
      meta: { total, page: params.page, per_page: params.per_page, capped },
    });
  } catch (err) {
    console.error('[api/admin/moderation/queue] fetch error:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'モデレーションキューの取得に失敗しました' } },
      { status: 500 },
    );
  }
}
