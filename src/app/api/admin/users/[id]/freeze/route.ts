/**
 * POST /api/admin/users/{id}/freeze — ユーザー凍結
 * DELETE /api/admin/users/{id}/freeze — 凍結解除
 * operator/02-api-spec.md §4 準拠
 * 凍結状態は roles 配列ではなく frozen_at 列で管理する
 * ('banned' は公式 12 ロール外のため使用禁止: cross/CLAUDE.md §B)
 *
 * 同時の変更 (POST): 対象が super_admin でないことを読んで確かめてから書くまでに、別の運営が対象を super_admin にすることがある。
 * 凍結の UPDATE は「読んだ時点の super_admin でない状態のままなら書く」条件つきにし (src/lib/admin/user-ban.ts の SUPER_ADMIN_ROLES_LITERAL)、0 行なら読み直して、
 * 対象が無ければ 404、あれば 409 CONFLICT_STALE_DATA (書かず、監査も残さない。cross/04 §4.2)。
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { FreezeBodySchema, UnfreezeBodySchema } from '@/lib/admin/users-schemas';
import { recordAdminAudit } from '@/lib/admin/audit';
import { SUPER_ADMIN_ROLES_LITERAL, isNullRoles } from '@/lib/admin/user-ban';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { internalError } from '@/lib/api/errors';
import { isUuid } from '@/lib/http-params';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** 構造化ログの function_name */
const POST_ROUTE_NAME = 'POST /api/admin/users/[id]/freeze';
const DELETE_ROUTE_NAME = 'DELETE /api/admin/users/[id]/freeze';

/** ユーザーが無い (UUID の形でない id を含む) */
const USER_NOT_FOUND_RESPONSE = { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } } as const;

/** 読んで確かめてから書くまでに、対象の利用者の roles が変わった (super_admin になった等。条件つきの凍結の更新が 0 行) */
const STALE_FREEZE_TARGET_RESPONSE = {
  error: {
    code: 'CONFLICT_STALE_DATA',
    message: '対象のユーザーの権限が変わったため、凍結しませんでした。画面を読み込み直して、もう一度確認してください',
  },
} as const;

export async function POST(request: Request, props: Params) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
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
      { error: { code: 'OP_PERMISSION_DENIED', message: '永久 BAN はスーパー管理者 (super_admin) のみ実行可能です' } },
      { status: 403 },
    );
  }

  // temporary BAN は duration_days 必須
  if (freezeData.ban_type === 'temporary' && !freezeData.duration_days) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: '一時 BAN の場合は日数 (duration_days) が必須です' } },
      { status: 400 },
    );
  }

  // requireRole 通過後のみ到達する。RLS は user_profiles に自分の行のみの
  // ポリシーしか無いため、他ユーザーの存在確認・凍結更新には service_role が必須 (#1028)。
  const supabaseAdmin = getSupabaseAdmin();
  const supabase = await createClient();

  // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
  if (!isUuid(id)) {
    return NextResponse.json(USER_NOT_FOUND_RESPONSE, { status: 404 });
  }

  // 対象ユーザーが存在するか確認。読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗でユーザーが消えたように見せない。#1917)
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, roles')
    .eq('id', id)
    .maybeSingle();

  if (profileError) {
    return internalError(POST_ROUTE_NAME, profileError, { userId: actor.id, table: 'user_profiles' }, { shape: 'nested' });
  }
  if (!profile) {
    return NextResponse.json(USER_NOT_FOUND_RESPONSE, { status: 404 });
  }

  // super_admin を凍結しようとした場合は拒否
  if (Array.isArray(profile.roles) && profile.roles.includes('super_admin')) {
    return NextResponse.json(
      { error: { code: 'OP_TARGET_PROTECTED', message: 'スーパー管理者 (super_admin) のユーザーを凍結することはできません' } },
      { status: 403 },
    );
  }

  // 凍結期限計算 (#1030: unban_at 列に永続化するため UPDATE より先に計算する)
  let unbanAt: string | null = null;
  if (freezeData.ban_type === 'temporary' && freezeData.duration_days) {
    const unbanDate = new Date();
    unbanDate.setDate(unbanDate.getDate() + freezeData.duration_days);
    unbanAt = unbanDate.toISOString();
  }

  // frozen_at / frozen_reason / frozen_by / unban_at を UPDATE (roles には手を加えない)
  // #1030: unban_at を永続化することで、判定時比較 (requireUser/requireRole/middleware)
  // による一時 BAN の自動解除が可能になる。
  // 上で確かめた「super_admin でない」のままのときだけ書く (冒頭のコメント。読んだ roles が NULL なら NULL のまま)
  const freezeUpdate = supabaseAdmin
    .from('user_profiles')
    .update({
      frozen_at: new Date().toISOString(),
      frozen_reason: `[${freezeData.reason_category}] ${freezeData.reason_detail}`,
      frozen_by: actor.id,
      unban_at: unbanAt,
    } as Record<string, unknown>)
    .eq('id', id);
  const { data: frozen, error: updateError } = await (isNullRoles(profile.roles)
    ? freezeUpdate.is('roles', null)
    : freezeUpdate.not('roles', 'cs', SUPER_ADMIN_ROLES_LITERAL)
  )
    .select('id')
    .maybeSingle();

  if (updateError) {
    console.error('[api/admin/users/[id]/freeze] POST error:', updateError.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '凍結処理に失敗しました' } },
      { status: 500 },
    );
  }

  if (!frozen) {
    // 0 行: 読んでから書くまでに、対象の roles が変わった (super_admin になった等) か、対象が消えた。読み直して決める
    const { data: current, error: rereadError } = await supabaseAdmin
      .from('user_profiles')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (rereadError) {
      console.error('[api/admin/users/[id]/freeze] POST reread error:', rereadError.message);
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: '凍結処理に失敗しました' } },
        { status: 500 },
      );
    }
    if (!current) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } },
        { status: 404 },
      );
    }
    return NextResponse.json(STALE_FREEZE_TARGET_RESPONSE, { status: 409 });
  }

  // 監査ログ INSERT (operator/02-api-spec.md §3.3)
  const banId = crypto.randomUUID();
  await recordAdminAudit({
    supabase,
    actorId: actor.id,
    actionType: 'admin.user.ban',
    targetId: id,
    targetType: 'user',
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
    request,
    routeName: 'api/admin/users/[id]/freeze POST',
  });

  return NextResponse.json({
    data: {
      ban_id: banId,
      unban_at: unbanAt,
    },
  });
}

export async function DELETE(request: Request, props: Params) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
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

  // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
  if (!isUuid(id)) {
    return NextResponse.json(USER_NOT_FOUND_RESPONSE, { status: 404 });
  }

  // 対象ユーザーが存在するか確認。読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗でユーザーが消えたように見せない。#1917)
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (profileError) {
    return internalError(DELETE_ROUTE_NAME, profileError, { userId: actor.id, table: 'user_profiles' }, { shape: 'nested' });
  }
  if (!profile) {
    return NextResponse.json(USER_NOT_FOUND_RESPONSE, { status: 404 });
  }

  // frozen_at / frozen_reason / frozen_by / unban_at を NULL にリセット (凍結解除)
  const { error: updateError } = await supabaseAdmin
    .from('user_profiles')
    .update({
      frozen_at: null,
      frozen_reason: null,
      frozen_by: null,
      unban_at: null,
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
  await recordAdminAudit({
    supabase,
    actorId: actor.id,
    actionType: 'admin.user.unban',
    targetId: id,
    targetType: 'user',
    details: { reason },
    severity: 'warn',
    request,
    routeName: 'api/admin/users/[id]/freeze DELETE',
  });

  return NextResponse.json({ data: { success: true } });
}
