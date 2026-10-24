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
import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import { API_OP_PERMISSION_DENIED_CODE, forbiddenMessageOf, operatorMfaRequiredNested } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { dbErrorMentionsCode } from '@/lib/errors/db-raised-code';
import { AdminSetUserRolesResultSchema, RoleChangeBodySchema } from '@/lib/admin/users-schemas';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { isUuid, normalizeUuid } from '@/lib/http-params';
import { internalError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** 構造化ログの function_name (PATCH と PUT は同じ処理) */
const ROUTE_NAME = 'PATCH /api/admin/users/[id]/role';

/** ユーザーが無い (UUID の形でない id を含む) */
const USER_NOT_FOUND_RESPONSE = { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } } as const;

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
      // 二段階認証が未完了 (MfaRequiredError) なら、code は従来どおり OP_PERMISSION_DENIED のまま、文は二段階認証の日本語の固定の文
      // (ForbiddenError の code の表。下の RPC が DB の二段階認証の判定で止まったときと同じ文。#1917)
      const message = err instanceof MfaRequiredError ? forbiddenMessageOf(err) : '権限がありません';
      return NextResponse.json({ error: { code: API_OP_PERMISSION_DENIED_CODE, message } }, { status: 403 });
    }
    throw err;
  }

  const { id: rawId } = await params.params;
  // UUID の形なら小文字にそろえ、以後はこの値だけを使う (#1707。自分の判定・DB・RPC・監査)。
  // そろえないと、大文字にした自分の UUID が下の自分の判定をすり抜ける (RPC の CANNOT_MODIFY_OWN_ROLES では止まるが、code が OP_PERMISSION_DENIED になる)
  const id = normalizeUuid(rawId);

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
  if (id === normalizeUuid(actor.id)) {
    return NextResponse.json(
      { error: { code: 'OP_SELF_MODIFY', message: '自分自身のロールは変更できません' } },
      { status: 403 },
    );
  }

  // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
  if (!isUuid(id)) {
    return NextResponse.json(USER_NOT_FOUND_RESPONSE, { status: 404 });
  }

  // requireRole 通過後のみ到達する。RLS は user_profiles に自分の行のみの
  // ポリシーしか無いため、他ユーザーの存在確認には service_role が必須 (#1028)。
  const supabaseAdmin = getSupabaseAdmin();
  // admin_set_user_roles は SECURITY DEFINER 関数で auth.uid() から呼び出し元の
  // 権限・自己変更禁止を判定するため、RPC 呼び出しは session client のまま維持する
  // (service_role で呼ぶと auth.uid() が NULL になり常に FORBIDDEN になる)。
  const supabase = await createClient();

  // 対象ユーザー存在確認 (404 を RPC より前に返すためだけに読む。監査の previous_roles には使わない: 下の RPC の戻り値を参照。#1917)
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, roles')
    .eq('id', id)
    .maybeSingle();

  // 読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗でユーザーが消えたように見せない。#1917)
  if (profileError) {
    return internalError(ROUTE_NAME, profileError, { userId: actor.id, table: 'user_profiles' }, { shape: 'nested' });
  }
  if (!profile) {
    return NextResponse.json(USER_NOT_FOUND_RESPONSE, { status: 404 });
  }

  // ロール更新 (auth.uid() 依存の SECURITY DEFINER 関数のため session client で呼ぶ)
  const { data: updated, error: updateError } = await supabase
    .rpc('admin_set_user_roles', { p_user_id: id, p_roles: roles });

  if (updateError) {
    console.error('[api/admin/users/[id]/role] update error:', updateError.message);
    // RPC が RAISE EXCEPTION したコードの判定は共通の関数で行い、route では (ログのほかに) `.message` を読まない (#1917)
    if (dbErrorMentionsCode(updateError, 'USER_NOT_FOUND')) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } },
        { status: 404 },
      );
    }
    // DB の二段階認証の判定 (OPERATOR_MFA_REQUIRED。cross/12 §11.4) で止まったら、ゲート (requireRole) が二段階認証で止めたときと
    // 同じ 403 (code は OP_PERMISSION_DENIED・文は二段階認証の日本語の固定の文) にする (汎用の 500 にしない。#1917)
    const mfaRequired = operatorMfaRequiredNested(updateError, { code: { fixed: API_OP_PERMISSION_DENIED_CODE } });
    if (mfaRequired) return mfaRequired;
    if (
      dbErrorMentionsCode(updateError, 'FORBIDDEN') ||
      dbErrorMentionsCode(updateError, 'CANNOT_MODIFY_OWN_ROLES')
    ) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'ロール更新に失敗しました' } },
      { status: 500 },
    );
  }

  // 監査の previous_roles は、RPC が対象の行をロックして読んだ変える前の roles (#1917)。上で先に読んだ profile.roles は、
  // super_admin 2 人がほぼ同時に同じ利用者のロールを変えると、この UPDATE の直前の値 (先の変更の後の値) と食い違う。
  // 戻り値の形が違う (previous_roles を返さない、#1917 の migration の前の定義の DB) ときだけ先に読んだ値で記録し、
  // 食い違いうることをログに残す (ロールの変更は済んでいるので 500 にしない)
  const rpcResult = AdminSetUserRolesResultSchema.safeParse(updated);
  if (!rpcResult.success) {
    console.error(
      '[api/admin/users/[id]/role] admin_set_user_roles の戻り値に previous_roles が無い。先に読んだ roles を監査に残す:',
      rpcResult.error.message,
    );
  }
  const previousRoles = rpcResult.success ? rpcResult.data[0].previous_roles : profile.roles;

  // 監査ログ
  await recordAdminAudit({
    supabase,
    actorId: actor.id,
    actionType: 'admin.user.role_change',
    targetId: id,
    targetType: 'user',
    details: {
      previous_roles: previousRoles,
      new_roles: roles,
    },
    severity: 'warn',
    request,
    routeName: 'api/admin/users/[id]/role handleRoleChange',
  });

  return NextResponse.json({ data: { success: true, roles } });
}

export async function PATCH(request: Request, ctx: Params) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  return handleRoleChange(request, ctx);
}

export async function PUT(request: Request, ctx: Params) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  return handleRoleChange(request, ctx);
}
