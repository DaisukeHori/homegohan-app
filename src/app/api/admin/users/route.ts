/**
 * GET /api/admin/users — ユーザー一覧・検索
 * operator/02-api-spec.md §4 準拠
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { UsersSearchSchema } from '@/lib/admin/users-schemas';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireRole(['admin', 'super_admin', 'support']);
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

  const { searchParams } = new URL(request.url);
  const parseResult = UsersSearchSchema.safeParse(Object.fromEntries(searchParams));
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'パラメータが不正です', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const params = parseResult.data;
  // requireRole 通過後のみ到達する。RLS は user_profiles に自分の行のみの
  // ポリシーしか無いため、admin/support 向け一覧取得には service_role が必須 (#1028)。
  const supabase = getSupabaseAdmin();

  // ユーザープロファイルを検索
  let query = supabase
    .from('user_profiles')
    .select(
      `
      id,
      nickname,
      roles,
      organization_id,
      plan_key_cached,
      last_login_at,
      created_at,
      frozen_at,
      frozen_reason,
      frozen_by
    `,
      { count: 'exact' },
    );

  // 全文検索 (email/name/id)
  if (params.q) {
    query = query.or(
      `nickname.ilike.%${params.q}%,id.eq.${params.q.match(/^[0-9a-f-]{36}$/) ? params.q : '00000000-0000-0000-0000-000000000000'}`,
    );
  }

  // ロールフィルタ
  if (params.role) {
    query = query.contains('roles', [params.role]);
  }

  // ステータスフィルタ (凍結状態は frozen_at IS NOT NULL で判定)
  if (params.status === 'banned') {
    query = query.not('frozen_at', 'is', null);
  } else if (params.status === 'active') {
    query = query.is('frozen_at', null);
  }

  // 登録日フィルタ
  if (params.registered_from) {
    query = query.gte('created_at', params.registered_from);
  }
  if (params.registered_to) {
    query = query.lte('created_at', params.registered_to);
  }

  // 最終ログイン
  if (params.last_login_before) {
    query = query.lte('last_login_at', params.last_login_before);
  }

  // ソート
  const sortColumn =
    params.sort === 'last_login'
      ? 'last_login_at'
      : 'created_at';
  query = query.order(sortColumn, { ascending: params.order === 'asc' });

  // ページネーション
  const from = (params.page - 1) * params.per_page;
  const to = from + params.per_page - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;

  if (error) {
    console.error('[api/admin/users] DB error:', error.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'データベースエラーが発生しました' } },
      { status: 500 },
    );
  }

  const users = (data ?? []).map((u) => ({
    id: u.id,
    email: null, // email は auth.users から取得が必要 (#1028 のスコープ外。別 Issue で対応)
    nickname: u.nickname,
    plan_key: u.plan_key_cached ?? 'free',
    roles: u.roles ?? ['user'],
    is_banned: (u as { frozen_at?: string | null }).frozen_at != null,
    frozen_at: (u as { frozen_at?: string | null }).frozen_at ?? null,
    frozen_reason: (u as { frozen_reason?: string | null }).frozen_reason ?? null,
    frozen_by: (u as { frozen_by?: string | null }).frozen_by ?? null,
    last_login_at: u.last_login_at,
    registered_at: u.created_at,
    meal_count: 0, // 集計は別クエリが必要
    organization_id: u.organization_id,
  }));

  return NextResponse.json({
    data: users,
    meta: {
      total: count ?? 0,
      page: params.page,
      per_page: params.per_page,
    },
  });
}
