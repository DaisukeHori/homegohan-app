import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// ユーザー一覧取得（管理者用）
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 管理者権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || !profile?.roles?.some((r: string) => ['admin', 'super_admin', 'support'].includes(r))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const role = searchParams.get('role');
  const status = searchParams.get('status');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = (page - 1) * limit;

  let dbQuery = supabase
    .from('user_profiles')
    .select('*', { count: 'exact' });

  // フィルター
  // #273 PostgREST injection 対策: .or() による生文字列埋め込みを廃止し、カラム別に安全分岐
  if (query) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(query)) {
      // UUID 形式: id の完全一致のみ（.or() は使わない）
      dbQuery = dbQuery.eq('id', query);
    } else {
      // ニックネーム部分一致: 制御文字・記号を除去して長さを制限
      const sanitized = query.replace(/[^\p{L}\p{N}\s\-_.@]/gu, '').slice(0, 100);
      if (sanitized.length > 0) {
        dbQuery = dbQuery.ilike('nickname', `%${sanitized}%`);
      }
    }
  }
  if (role) {
    // 配列にroleが含まれているかチェック
    dbQuery = dbQuery.contains('roles', [role]);
  }
  if (status === 'banned') {
    dbQuery = dbQuery.eq('is_banned', true);
  } else if (status === 'active') {
    dbQuery = dbQuery.eq('is_banned', false);
  }

  const { data, error, count } = await dbQuery
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const users = (data || []).map((u: any) => ({
    id: u.id,
    nickname: u.nickname,
    roles: u.roles,
    age: u.age,
    gender: u.gender,
    organizationId: u.organization_id,
    department: u.department,
    isBanned: u.is_banned,
    bannedAt: u.banned_at,
    bannedReason: u.banned_reason,
    lastLoginAt: u.last_login_at,
    loginCount: u.login_count,
    profileCompleteness: u.profile_completeness,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  }));

  return NextResponse.json({
    users,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
}
