/**
 * GET  /api/admin/organizations — 組織一覧取得
 * POST /api/admin/organizations — 組織作成
 * 権限: admin, super_admin
 *
 * operator/02-api-spec.md §6 準拠
 * E2E: w5-12-admin-adversarial C-14, C-14b, C-15, C-15b, C-16
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const OrgSearchSchema = z.object({
  q: z.string().optional(),
  plan: z.enum(['standard', 'premium', 'enterprise']).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(30),
});

const OrgCreateSchema = z.object({
  name: z.string().min(1, { message: 'name は必須です' }).max(200),
  plan: z.enum(['standard', 'premium', 'enterprise']).optional().default('standard'),
  // P0 Critical Fix F11: owner_id は必須 (organizations.owner_id NOT NULL)
  // 未指定時は呼び出し元 admin を owner にする
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

  // P0 Critical Fix F11: owner_id を INSERT に含める (NOT NULL 制約対応)
  // 明示的に指定がない場合は呼び出し元 admin を owner とする
  const effectiveOwnerId = owner_id ?? actor.id;

  // owner が既に他組織に所属しているかチェック (user_profiles_org_consistency 制約対応)
  const { createClient: createAdminSupabaseClient } = await import('@supabase/supabase-js');
  const supabaseAdminUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAdminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseAdminUrl || !supabaseAdminKey) {
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'サーバー設定エラーです' } },
      { status: 500 },
    );
  }
  const supabaseAdmin = createAdminSupabaseClient(supabaseAdminUrl, supabaseAdminKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

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
    console.error('[api/admin/organizations] POST insert error:', insertError?.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '組織の作成に失敗しました' } },
      { status: 500 },
    );
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
  await supabase.from('admin_audit_logs').insert({
    actor_id: actor.id,
    action_type: 'admin.organization.create',
    target_id: org.id,
    target_type: 'organization',
    details: { name, plan },
    severity: 'info',
    ip_address: request.headers.get('x-forwarded-for'),
  });

  return NextResponse.json({ organization: org });
}
