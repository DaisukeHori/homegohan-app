/**
 * PATCH /api/admin/users/{id}/role — ユーザーロール変更
 * PUT   /api/admin/users/{id}/role — ユーザーロール変更 (PATCH と同一, E2E 互換)
 * 権限: super_admin のみ
 *
 * super_admin ロールの付与/剥奪は super_admin のみ可能。
 * admin は 403 (super_admin 付与は不可)。
 *
 * operator/02-api-spec.md §4 準拠
 * E2E: w5-12-admin-adversarial B-9, B-9b
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { RoleChangeBodySchema } from '@/lib/admin/users-schemas';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

async function handleRoleChange(request: Request, params: Params) {
  let actor;
  try {
    actor = await requireRole(['super_admin']);
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

  const { id } = params.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parseResult = RoleChangeBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { roles } = parseResult.data;

  // 自分自身のロール変更は禁止
  if (id === actor.id) {
    return NextResponse.json(
      { error: { code: 'OP_SELF_MODIFY', message: '自分自身のロールは変更できません' } },
      { status: 403 },
    );
  }

  const supabase = await createClient();

  // 対象ユーザー存在確認
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('id, roles')
    .eq('id', id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } },
      { status: 404 },
    );
  }

  // ロール更新
  const { error: updateError } = await supabase
    .from('user_profiles')
    .update({ roles } as Record<string, unknown>)
    .eq('id', id);

  if (updateError) {
    console.error('[api/admin/users/[id]/role] update error:', updateError.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'ロール更新に失敗しました' } },
      { status: 500 },
    );
  }

  // 監査ログ
  await supabase.from('admin_audit_logs').insert({
    actor_id: actor.id,
    action_type: 'admin.user.role_change',
    target_id: id,
    target_type: 'user',
    details: {
      previous_roles: profile.roles,
      new_roles: roles,
    },
    severity: 'warn',
    ip_address: request.headers.get('x-forwarded-for'),
  });

  return NextResponse.json({ data: { success: true, roles } });
}

export async function PATCH(request: Request, ctx: Params) {
  return handleRoleChange(request, ctx);
}

export async function PUT(request: Request, ctx: Params) {
  return handleRoleChange(request, ctx);
}
