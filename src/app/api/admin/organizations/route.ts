/**
 * GET  /api/admin/organizations — 組織一覧取得
 * POST /api/admin/organizations — 組織作成
 * 権限: admin, super_admin
 *
 * operator/02-api-spec.md §4 (GET /api/admin/organizations :330・POST /api/admin/organizations :341) 準拠
 * E2E: w5-12-admin-adversarial C-14, C-14b, C-15, C-15b, C-16
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { z } from 'zod';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { ORG_PLAN_DEFAULT, ORG_PLAN_VALUES } from '@/lib/org-plans';

export const dynamic = 'force-dynamic';

const OrgSearchSchema = z.object({
  q: z.string().optional(),
  plan: z.enum(ORG_PLAN_VALUES).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(30),
});

const OrgCreateSchema = z.object({
  name: z.string().min(1, { message: 'name は必須です' }).max(200),
  plan: z.enum(ORG_PLAN_VALUES).optional().default(ORG_PLAN_DEFAULT),
  // organizations.owner_id は active な行では NOT NULL (CHECK organizations_active_has_owner。#1103 項目 10 → #1917)。作る組織は active。
  // 本文では省略してよく、未指定時は呼び出し元の運営を owner にする (下の POST で必ず埋める)
  owner_id: z.string().uuid().optional(),
});

export async function GET(request: Request) {
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

  void actor;

  const { searchParams } = new URL(request.url);
  const parseResult = OrgSearchSchema.safeParse(Object.fromEntries(searchParams));
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'パラメータが不正です', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { q, plan, page, per_page } = parseResult.data;
  const supabase = await createClient();

  try {
    let query = supabase
      .from('organizations')
      .select('id, name, plan, created_at, updated_at', { count: 'exact' });

    if (q) {
      query = query.ilike('name', `%${q}%`);
    }
    if (plan) {
      query = query.eq('plan', plan);
    }

    const from = (page - 1) * per_page;
    const to = from + per_page - 1;
    query = query.range(from, to).order('created_at', { ascending: false });

    const { data, error, count } = await query;

    if (error) {
      console.error('[api/admin/organizations] GET error:', error.message);
      return NextResponse.json({
        organizations: [],
        meta: { total: 0, page, per_page },
      });
    }

    return NextResponse.json({
      organizations: data ?? [],
      meta: { total: count ?? 0, page, per_page },
    });
  } catch (err) {
    console.error('[api/admin/organizations] GET unexpected error:', err);
    return NextResponse.json({
      organizations: [],
      meta: { total: 0, page, per_page },
    });
  }
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parseResult = OrgCreateSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { name, plan, owner_id } = parseResult.data;
  const supabase = await createClient();

  // owner_id は必ず INSERT に含める (active な行では NOT NULL (CHECK organizations_active_has_owner)。#1103 項目 10 → #1917)。
  // 明示的に指定がない場合は呼び出し元 admin を owner とする
  const effectiveOwnerId = owner_id ?? actor.id;

  // owner が既に他組織に所属しているかチェック (user_profiles_org_consistency 制約対応)
  const supabaseAdmin = getSupabaseAdmin();

  const { data: ownerProfile } = await supabaseAdmin
    .from('user_profiles')
    .select('organization_id')
    .eq('id', effectiveOwnerId)
    .single();

  if (ownerProfile?.organization_id) {
    return NextResponse.json(
      { error: { code: 'OWNER_ALREADY_IN_ORG', message: '指定した owner は既に別の組織に所属しています' } },
      { status: 409 },
    );
  }

  const { data: org, error: insertError } = await supabaseAdmin
    .from('organizations')
    .insert({ name, plan, owner_id: effectiveOwnerId })
    .select('id, name, plan, owner_id, created_at, updated_at')
    .single();

  if (insertError || !org) {
    // 退会の途中の人はオーナーにしない (#1917 の続き。DB のトリガー organizations_owner_not_deleting が INSERT を止める。
    // supabase/migrations/20261023130000_account_deletion_owner_guard.sql)。作らずに 409 で返す
    if (isOwnerAccountDeletingError(insertError)) {
      return NextResponse.json(
        { error: { code: OWNER_ACCOUNT_DELETING, message: '指定した owner は退会の手続き中です' } },
        { status: 409 },
      );
    }
    console.error('[api/admin/organizations] POST insert error:', insertError?.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '組織の作成に失敗しました' } },
      { status: 500 },
    );
  }

  // Round 3 C-3: 新規 org 作成時に org_license_pools 行を INSERT
  // service_role クライアントで RLS をバイパスして確実に挿入
  try {
    const { error: poolErr } = await supabaseAdmin
      .from('org_license_pools')
      .insert({
        organization_id: org.id,
        total_licenses: null, // unlimited by default
        used_licenses: 0,
      });
    if (poolErr) {
      console.error('[admin/organizations] org_license_pools INSERT failed', poolErr);
      // 致命ではないが警告 (ライセンス管理は後続で補完可能)
    }
  } catch (adminErr) {
    console.error('[admin/organizations] supabaseAdmin init failed', adminErr);
  }

  // owner の user_profiles を更新 (org_role='owner', organization_id 設定)
  const { error: profileUpdateError } = await supabaseAdmin
    .from('user_profiles')
    .update({ organization_id: org.id, org_role: 'owner' })
    .eq('id', effectiveOwnerId);

  if (profileUpdateError) {
    console.error('[api/admin/organizations] POST profile update error:', profileUpdateError.message);
    // org 作成は成功しているが user_profiles が更新できない場合はエラー
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'オーナーのプロフィール更新に失敗しました' } },
      { status: 500 },
    );
  }

  // 監査ログ
  await recordAdminAudit({
    supabase,
    actorId: actor.id,
    actionType: 'admin.organization.create',
    targetId: org.id,
    targetType: 'organization',
    details: { name, plan },
    severity: 'info',
    request,
    routeName: 'api/admin/organizations POST',
  });

  return NextResponse.json({ organization: org });
}

/** DB 関数・トリガーが RAISE EXCEPTION '<コード>' USING ERRCODE = 'P0001' で止めたときの SQLSTATE */
const PG_RAISE_EXCEPTION = 'P0001';
/**
 * 作る組織のオーナーが退会の途中 (退会の印 account_deletion_guards が新しい) のときに、トリガー organizations_owner_not_deleting が
 * RAISE するコード (supabase/migrations/20261023130000_account_deletion_owner_guard.sql)。応答の code にもそのまま使う
 */
const OWNER_ACCOUNT_DELETING = 'OWNER_ACCOUNT_DELETING';

/** 組織の INSERT が、オーナーが退会の途中なので止められたか (P0001 で、メッセージがそのコード) */
function isOwnerAccountDeletingError(error: { code?: string; message?: string } | null): boolean {
  return error?.code === PG_RAISE_EXCEPTION && error.message === OWNER_ACCOUNT_DELETING;
}
