import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 管理者一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { data: admins, error } = await supabase
      .from('user_profiles')
      .select(`
        id,
        nickname,
        role,
        organization_id,
        last_login_at,
        created_at
      `)
      .in('role', ['admin', 'super_admin', 'support', 'org_admin'])
      .order('role', { ascending: true });

    if (error) throw error;

    // 最近のアクション数を取得
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const adminsWithStats = await Promise.all(
      (admins || []).map(async (admin: any) => {
        const { count: actionCount } = await supabase
          .from('admin_audit_logs')
          .select('*', { count: 'exact', head: true })
          .eq('admin_id', admin.id)
          .gte('created_at', sevenDaysAgo.toISOString());

        return {
          id: admin.id,
          nickname: admin.nickname,
          role: admin.role,
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

