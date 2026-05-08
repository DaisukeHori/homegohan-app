/**
 * GET /api/admin/users/{id} — ユーザー詳細
 * PATCH /api/admin/users/{id} — admin_note 更新
 * operator/02-api-spec.md §4 準拠
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { UserPatchBodySchema } from '@/lib/admin/users-schemas';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

export async function GET(_request: Request, { params }: Params) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'support']);
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
  const supabase = await createClient();

  // ユーザープロファイル取得
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } },
      { status: 404 },
    );
  }

  // サポートチケット数 (テーブルが存在する場合)
  let supportTicketCount = 0;
  try {
    const { count } = await supabase
      .from('support_tickets')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', id);
    supportTicketCount = count ?? 0;
  } catch {
    // support_tickets テーブルが未作成の場合は 0 を返す
  }

  // アクティブサブスクリプション
  let activeSubscription = null;
  try {
    const { data: sub } = await supabase
      .from('personal_subscriptions')
      .select('plan_key, status, current_period_end')
      .eq('user_id', id)
      .in('status', ['active', 'trialing', 'paused', 'past_due', 'grace'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sub) {
      activeSubscription = {
        plan_key: sub.plan_key,
        status: sub.status,
        next_billing_at: sub.current_period_end,
      };
    }
  } catch {
    // personal_subscriptions テーブルが未作成の場合
  }

  // BAN 履歴 (admin_audit_logs から取得)
  let banHistory: unknown[] = [];
  try {
    const { data: banLogs } = await supabase
      .from('admin_audit_logs')
      .select('*')
      .eq('target_id', id)
      .in('action_type', ['admin.user.ban', 'admin.user.unban', 'admin.user.freeze', 'admin.user.unfreeze'])
      .order('created_at', { ascending: false })
      .limit(20);
    banHistory = banLogs ?? [];
  } catch {
    // actor が super_admin でない場合は SELECT 権限なし
  }

  // 監査ログ (actor が super_admin のみ閲覧可能)
  const auditLogs = actor.roles.includes('super_admin') ? banHistory : [];

  void auditLogs; // 現在は ban_history として返す

  return NextResponse.json({
    data: {
      id: profile.id,
      email: null,
      display_name: profile.display_name,
      roles: profile.roles ?? ['user'],
      plan_key: profile.plan_key_cached ?? 'free',
      organization_id: profile.organization_id,
      family_group_ids: [],
      stats: {
        meal_count: 0,
        ai_session_count: 0,
        health_checkup_count: 0,
        last_meal_at: null,
      },
      ban_history: banHistory,
      support_ticket_count: supportTicketCount,
      active_subscription: activeSubscription,
      is_banned: Array.isArray(profile.roles) && profile.roles.includes('banned'),
      last_login_at: profile.last_login_at ?? null,
      registered_at: profile.created_at,
    },
  });
}

export async function PATCH(request: Request, { params }: Params) {
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

  const parseResult = UserPatchBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { admin_note } = parseResult.data;
  const supabase = await createClient();

  // admin_note をプロファイルに保存
  const { error: updateError } = await supabase
    .from('user_profiles')
    .update({ admin_note } as Record<string, unknown>)
    .eq('id', id);

  if (updateError) {
    console.error('[api/admin/users/[id]] PATCH error:', updateError.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '更新に失敗しました' } },
      { status: 500 },
    );
  }

  // 監査ログ
  await supabase.from('admin_audit_logs').insert({
    actor_id: actor.id,
    action_type: 'admin.user.note_update',
    target_id: id,
    target_type: 'user',
    details: { admin_note },
    severity: 'info',
    ip_address: request.headers.get('x-forwarded-for'),
  });

  return NextResponse.json({ data: { success: true } });
}
