/**
 * PUT /api/admin/moderation/{id} — モデレーション個別解決
 * 権限: admin, super_admin, content_moderator
 *
 * body: { type: 'food' | 'recipe' | 'ai_content', action: 'approve' | 'reject' | ... }
 *
 * E2E: w5-12-admin-adversarial G-28, G-29, G-30
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';
import { MODERATION_TYPES, ModerationActions } from '@/lib/admin/moderation-schemas';

export const dynamic = 'force-dynamic';

const PutBodySchema = z.object({
  type: z.enum(MODERATION_TYPES),
  action: z.enum(ModerationActions),
  ban_duration_days: z.number().int().min(1).max(365).optional(),
  resolution_note: z.string().min(1).max(5000).optional(),
});

type Params = { params: { id: string } };

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

  const parseResult = PutBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { type, action, ban_duration_days, resolution_note } = parseResult.data;

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
      console.error('[api/admin/moderation/[id]] PUT update error:', updateError.message);
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: '更新に失敗しました' } },
        { status: 500 },
      );
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: actor.id,
      action_type: `admin.moderation.${action}`,
      target_id: id,
      target_type: `moderation_item:${type}`,
      details: { action, moderation_type: type, ban_duration_days, resolution_note },
      severity: action.includes('ban') ? 'warn' : 'info',
      ip_address: request.headers.get('x-forwarded-for'),
    });

    return NextResponse.json({ data: { success: true, status: newStatus } });
  } catch {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } },
      { status: 404 },
    );
  }
}
