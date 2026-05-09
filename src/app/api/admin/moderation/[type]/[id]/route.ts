/**
 * GET  /api/admin/moderation/{type}/{id} — 個別モデレーションアイテム取得
 * POST /api/admin/moderation/{type}/{id} — 個別モデレーション (承認/却下)
 * PUT  /api/admin/moderation/{type}/{id} — モデレーション個別解決 (E2E: w5-12-admin-adversarial G-28, G-29, G-30)
 * operator/02-api-spec.md §5 準拠
 * 権限: admin, super_admin, content_moderator
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

export const dynamic = 'force-dynamic';

type Params = { params: { type: string; id: string } };

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

  const supabase = await createClient();

  try {
    const { data, error } = await supabase
      .from('moderation_items')
      .select('*')
      .eq('id', id)
      .eq('type', type)
      .single();

    if (error || !data) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } },
        { status: 404 },
      );
    }

    return NextResponse.json({ data });
  } catch {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } },
      { status: 404 },
    );
  }
}

export async function POST(request: Request, { params }: Params) {
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

  // モデレーションアイテムの状態遷移
  const newStatus = action === 'approve' ? 'approved' : action === 'escalate' ? 'escalated' : 'rejected';

  let contentUserId: string | null = null;

  try {
    // モデレーションアイテム取得
    const { data: item, error: itemError } = await supabase
      .from('moderation_items')
      .select('id, user_id, type')
      .eq('id', id)
      .eq('type', type)
      .single();

    if (itemError || !item) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } },
        { status: 404 },
      );
    }

    contentUserId = item.user_id;

    // ステータス更新
    const { error: updateError } = await supabase
      .from('moderation_items')
      .update({
        status: newStatus,
        resolved_by: actor.id,
        resolved_at: new Date().toISOString(),
        resolution_note: resolution_note ?? null,
      } as Record<string, unknown>)
      .eq('id', id);

    if (updateError) {
      console.error('[api/admin/moderation/[type]/[id]] update error:', updateError.message);
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: '更新に失敗しました' } },
        { status: 500 },
      );
    }
  } catch {
    // moderation_items テーブル未作成の場合
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } },
      { status: 404 },
    );
  }

  // BAN アクションの場合、ユーザーの roles を更新
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
      await supabase
        .from('user_profiles')
        .update({ roles: [...new Set([...currentRoles, 'banned'])] } as Record<string, unknown>)
        .eq('id', contentUserId);
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
    },
    severity: action.includes('ban') ? 'warn' : 'info',
    ip_address: request.headers.get('x-forwarded-for'),
  });

  return NextResponse.json({ data: { success: true, status: newStatus } });
}

export async function PUT(request: Request, { params }: Params) {
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

  let contentUserId: string | null = null;

  try {
    const { data: item, error: itemError } = await supabase
      .from('moderation_items')
      .select('id, user_id, type')
      .eq('id', id)
      .eq('type', type)
      .single();

    if (itemError || !item) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } },
        { status: 404 },
      );
    }

    contentUserId = item.user_id;

    const { error: updateError } = await supabase
      .from('moderation_items')
      .update({
        status: newStatus,
        resolved_by: actor.id,
        resolved_at: new Date().toISOString(),
        resolution_note: resolution_note ?? null,
      } as Record<string, unknown>)
      .eq('id', id);

    if (updateError) {
      console.error('[api/admin/moderation/[type]/[id]] PUT update error:', updateError.message);
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: '更新に失敗しました' } },
        { status: 500 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } },
      { status: 404 },
    );
  }

  // BAN アクションの場合、ユーザーの roles を更新
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
      await supabase
        .from('user_profiles')
        .update({ roles: [...new Set([...currentRoles, 'banned'])] } as Record<string, unknown>)
        .eq('id', contentUserId);
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
    },
    severity: action.includes('ban') ? 'warn' : 'info',
    ip_address: request.headers.get('x-forwarded-for'),
  });

  return NextResponse.json({ data: { success: true, status: newStatus } });
}
