/**
 * POST /api/admin/users/{id}/freeze — ユーザー凍結
 * DELETE /api/admin/users/{id}/freeze — 凍結解除
 * operator/02-api-spec.md §4 準拠
 * 凍結状態は roles 配列ではなく frozen_at 列で管理する
 * ('banned' は公式 12 ロール外のため使用禁止: cross/CLAUDE.md §B)
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { FreezeBodySchema, UnfreezeBodySchema } from '@/lib/admin/users-schemas';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

export async function POST(request: Request, { params }: Params) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin']);
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

  const { id } = params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parseResult = FreezeBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const freezeData = parseResult.data;

  // permanent BAN は super_admin のみ可能
  if (freezeData.ban_type === 'permanent' && !actor.roles.includes('super_admin')) {
    return NextResponse.json(
      { error: { code: 'OP_PERMISSION_DENIED', message: '永久 BAN は super_admin のみ実行可能です' } },
      { status: 403 },
    );
  }

  // temporary BAN は duration_days 必須
  if (freezeData.ban_type === 'temporary' && !freezeData.duration_days) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: '一時 BAN の場合は duration_days が必須です' } },
      { status: 400 },
    );
  }

  // requireRole 通過後のみ到達する。RLS は user_profiles に自分の行のみの
  // ポリシーしか無いため、他ユーザーの存在確認・凍結更新には service_role が必須 (#1028)。
  const supabaseAdmin = getSupabaseAdmin();
  const supabase = await createClient();

  // 対象ユーザーが存在するか確認
  const { data: profile, error: profileError } = await supabaseAdmin
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

  // super_admin を凍結しようとした場合は拒否
  if (Array.isArray(profile.roles) && profile.roles.includes('super_admin')) {
    return NextResponse.json(
      { error: { code: 'OP_TARGET_PROTECTED', message: 'super_admin ユーザーを凍結することはできません' } },
      { status: 403 },
    );
  }

  // frozen_at / frozen_reason / frozen_by を UPDATE (roles には手を加えない)
  const { error: updateError } = await supabaseAdmin
    .from('user_profiles')
    .update({
      frozen_at: new Date().toISOString(),
      frozen_reason: `[${freezeData.reason_category}] ${freezeData.reason_detail}`,
      frozen_by: actor.id,
    } as Record<string, unknown>)
    .eq('id', id);

  if (updateError) {
    console.error('[api/admin/users/[id]/freeze] POST error:', updateError.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '凍結処理に失敗しました' } },
      { status: 500 },
    );
  }

  // 凍結期限計算
  let unbanAt: string | null = null;
  if (freezeData.ban_type === 'temporary' && freezeData.duration_days) {
    const unbanDate = new Date();
    unbanDate.setDate(unbanDate.getDate() + freezeData.duration_days);
    unbanAt = unbanDate.toISOString();
  }

  // 監査ログ INSERT (operator/02-api-spec.md §3.3)
  const banId = crypto.randomUUID();
  await supabase.from('admin_audit_logs').insert({
    actor_id: actor.id,
    action_type: 'admin.user.ban',
    target_id: id,
    target_type: 'user',
    details: {
      ban_id: banId,
      ban_type: freezeData.ban_type,
      reason_category: freezeData.reason_category,
      reason_detail: freezeData.reason_detail,
      duration_days: freezeData.duration_days,
      notify_user: freezeData.notify_user,
      unban_at: unbanAt,
    },
    severity: 'warn',
    ip_address: request.headers.get('x-forwarded-for'),
  });

  return NextResponse.json({
    data: {
      ban_id: banId,
      unban_at: unbanAt,
    },
  });
}

export async function DELETE(request: Request, { params }: Params) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin']);
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

  const { id } = params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parseResult = UnfreezeBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { reason } = parseResult.data;
  // requireRole 通過後のみ到達する。RLS は user_profiles に自分の行のみの
  // ポリシーしか無いため、他ユーザーの存在確認・凍結解除には service_role が必須 (#1028)。
  const supabaseAdmin = getSupabaseAdmin();
  const supabase = await createClient();

  // 対象ユーザーが存在するか確認
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id')
    .eq('id', id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } },
      { status: 404 },
    );
  }

  // frozen_at / frozen_reason / frozen_by を NULL にリセット (凍結解除)
  const { error: updateError } = await supabaseAdmin
    .from('user_profiles')
    .update({
      frozen_at: null,
      frozen_reason: null,
      frozen_by: null,
    } as Record<string, unknown>)
    .eq('id', id);

  if (updateError) {
    console.error('[api/admin/users/[id]/freeze] DELETE error:', updateError.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '凍結解除に失敗しました' } },
      { status: 500 },
    );
  }

  // 監査ログ INSERT
  await supabase.from('admin_audit_logs').insert({
    actor_id: actor.id,
    action_type: 'admin.user.unban',
    target_id: id,
    target_type: 'user',
    details: { reason },
    severity: 'warn',
    ip_address: request.headers.get('x-forwarded-for'),
  });

  return NextResponse.json({ data: { success: true } });
}
