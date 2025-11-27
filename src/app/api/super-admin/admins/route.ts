import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 管理者一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || profile?.roles?.includes('super_admin') !== true) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    // 全ユーザーを取得し、管理者ロールを持つユーザーをフィルター
    const { data: allUsers, error } = await supabase
      .from('user_profiles')
      .select(`
        id,
        nickname,
        roles,
        organization_id,
        last_login_at,
        created_at
      `);

    if (error) throw error;

    // 管理者ロールを持つユーザーをフィルター
    const adminRoles = ['admin', 'super_admin', 'support', 'org_admin'];
    const admins = (allUsers || []).filter((u: any) => 
      u.roles?.some((r: string) => adminRoles.includes(r))
    );

    // 最近のアクション数を取得
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const adminsWithStats = await Promise.all(
      admins.map(async (admin: any) => {
        const { count: actionCount } = await supabase
          .from('admin_audit_logs')
          .select('*', { count: 'exact', head: true })
          .eq('admin_id', admin.id)
          .gte('created_at', sevenDaysAgo.toISOString());

        return {
          id: admin.id,
          nickname: admin.nickname,
          roles: admin.roles,
          organizationId: admin.organization_id,
          lastLoginAt: admin.last_login_at,
          createdAt: admin.created_at,
          recentActionCount: actionCount || 0,
        };
      })
    );

    return NextResponse.json({ admins: adminsWithStats });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

