/**
 * GET  /api/admin/moderation/{type}/{id} — 個別モデレーションアイテム取得
 * POST /api/admin/moderation/{type}/{id} — 個別モデレーション (承認/却下)
 * PUT  /api/admin/moderation/{type}/{id} — モデレーション個別解決 (E2E: w5-12-admin-adversarial G-28, G-29, G-30)
 * operator/02-api-spec.md §5 準拠
 * 権限: admin, super_admin, content_moderator
 *
 * #1041 (F4-04) 修正: 実在しない `moderation_items` テーブル参照を廃止し、
 * 実テーブル (moderation_flags / recipe_flags) を参照する。
 * BAN 対象ユーザーはフラグテーブル自身の user_id/reporter_id ではなく、
 * フラグが指すコンテンツの所有者 (meals.user_id / recipes.user_id) を用いる
 * (通報者を誤って BAN する事故を防ぐため)。
 * DB エラー時は 404 に丸めず 500 を返す (fail-closed)。
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import {
  ModerationResolveBodySchema,
  MODERATION_TYPES,
  type ModerationType,
} from '@/lib/admin/moderation-schemas';
import {
  fetchModerationSingle,
  isModerationBacked,
  resolveModerationItem,
} from '@/lib/admin/moderation-backend';

export const dynamic = 'force-dynamic';

type Params = { params: { type: string; id: string } };

const NOT_FOUND_RESPONSE = NextResponse.json(
  { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } },
  { status: 404 },
);

function internalErrorResponse() {
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: '内部エラーが発生しました' } },
    { status: 500 },
  );
}

export async function GET(_request: Request, { params }: Params) {
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

  const { type, id } = params;

  if (!MODERATION_TYPES.includes(type as ModerationType)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: `type は ${MODERATION_TYPES.join(', ')} のいずれかである必要があります` } },
      { status: 400 },
    );
  }

  const moderationType = type as ModerationType;

  // ai_content はバックエンドテーブル未実装 (要 migration)。該当アイテムは存在しない。
  if (!isModerationBacked(moderationType)) {
    return NOT_FOUND_RESPONSE;
  }

  const supabase = await createClient();

  try {
    const item = await fetchModerationSingle(supabase, moderationType, id);
    if (!item) {
      return NOT_FOUND_RESPONSE;
    }
    return NextResponse.json({ data: item });
  } catch (err) {
    console.error('[api/admin/moderation/[type]/[id]] GET error:', err instanceof Error ? err.message : err);
    return internalErrorResponse();
  }
}

export async function POST(request: Request, { params }: Params) {
  return handleResolve(request, params);
}

export async function PUT(request: Request, { params }: Params) {
  return handleResolve(request, params);
}

async function handleResolve(request: Request, params: { type: string; id: string }) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'content_moderator']);
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

  const { type, id } = params;

  // type バリデーション
  if (!MODERATION_TYPES.includes(type as ModerationType)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: `type は ${MODERATION_TYPES.join(', ')} のいずれかである必要があります` } },
      { status: 400 },
    );
  }

  const moderationType = type as ModerationType;

  // ai_content はバックエンドテーブル未実装 (要 migration)。該当アイテムは存在しない。
  if (!isModerationBacked(moderationType)) {
    return NOT_FOUND_RESPONSE;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parseResult = ModerationResolveBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { action, ban_duration_days, resolution_note } = parseResult.data;

  // delete_and_temp_ban は ban_duration_days 必須
  if (action === 'delete_and_temp_ban' && !ban_duration_days) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'delete_and_temp_ban の場合は ban_duration_days が必須です' } },
      { status: 400 },
    );
  }

  // delete_and_perm_ban は super_admin のみ
  if (action === 'delete_and_perm_ban' && !actor.roles.includes('super_admin')) {
    return NextResponse.json(
      { error: { code: 'OP_PERMISSION_DENIED', message: '永久 BAN は super_admin のみ実行可能です' } },
      { status: 403 },
    );
  }

  const supabase = await createClient();
  const newStatus = action === 'approve' ? 'approved' : action === 'escalate' ? 'escalated' : 'rejected';

  let item;
  try {
    item = await fetchModerationSingle(supabase, moderationType, id);
  } catch (err) {
    console.error('[api/admin/moderation/[type]/[id]] fetch error:', err instanceof Error ? err.message : err);
    return internalErrorResponse();
  }

  if (!item) {
    return NOT_FOUND_RESPONSE;
  }

  // BAN 対象はフラグが指すコンテンツの所有者 (meals.user_id / recipes.user_id)。
  // フラグ行自身の user_id/reporter_id (通報者) を誤って使わないこと。
  const contentUserId = item.user_id;

  try {
    await resolveModerationItem(supabase, moderationType, id, {
      status: newStatus,
      resolvedBy: actor.id,
      resolutionNote: resolution_note ?? null,
    });
  } catch (err) {
    console.error('[api/admin/moderation/[type]/[id]] update error:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '更新に失敗しました' } },
      { status: 500 },
    );
  }

  // BAN アクションの場合、ユーザーの roles を更新
  let banApplied: boolean | null = null;
  if (
    contentUserId &&
    (action === 'delete_and_temp_ban' || action === 'delete_and_perm_ban' || action === 'delete_and_warn')
  ) {
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('roles')
      .eq('id', contentUserId)
      .single();

    if (userProfile && (action === 'delete_and_temp_ban' || action === 'delete_and_perm_ban')) {
      const currentRoles: string[] = Array.isArray(userProfile.roles) ? userProfile.roles : ['user'];
      const { error: banError } = await supabase.rpc('admin_set_user_roles', {
        p_user_id: contentUserId,
        p_roles: [...new Set([...currentRoles, 'banned'])],
      });
      banApplied = !banError;
      if (banError) {
        console.error('[api/admin/moderation/[type]/[id]] BAN role update failed:', banError.message);
      }
    }
  }

  // 監査ログ INSERT
  await supabase.from('admin_audit_logs').insert({
    actor_id: actor.id,
    action_type: `admin.moderation.${action}`,
    target_id: id,
    target_type: `moderation_item:${type}`,
    details: {
      action,
      moderation_type: type,
      ban_duration_days,
      resolution_note,
      content_user_id: contentUserId,
      ban_applied: banApplied,
    },
    severity: action.includes('ban') ? 'warn' : 'info',
    ip_address: request.headers.get('x-forwarded-for'),
  });

  return NextResponse.json({ data: { success: true, status: newStatus } });
}
