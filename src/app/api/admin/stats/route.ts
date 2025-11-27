import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// システム統計取得（管理者用）
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 管理者権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // ユーザー統計
    const { count: totalUsers } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true });

    const { count: newUsersToday } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today);

    const { count: activeUsers } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('last_login_at', thirtyDaysAgo.toISOString());

    // 食事統計
    const { count: totalMeals } = await supabase
      .from('planned_meals')
      .select('*', { count: 'exact', head: true });

    const { count: completedMealsToday } = await supabase
      .from('planned_meals')
      .select('*', { count: 'exact', head: true })
      .gte('completed_at', today)
      .eq('is_completed', true);

    // 健康記録統計
    const { count: healthRecordsToday } = await supabase
      .from('health_records')
      .select('*', { count: 'exact', head: true })
      .eq('record_date', today);

    // AI利用統計
    const { count: aiSessionsTotal } = await supabase
      .from('ai_consultation_sessions')
      .select('*', { count: 'exact', head: true });

    // お問い合わせ統計
    const { count: pendingInquiries } = await supabase
      .from('inquiries')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    // レシピ統計
    const { count: publicRecipes } = await supabase
      .from('recipes')
      .select('*', { count: 'exact', head: true })
      .eq('is_public', true);

    // 日次統計履歴
    const { data: dailyStats } = await supabase
      .from('system_daily_stats')
      .select('*')
      .order('date', { ascending: false })
      .limit(30);

    return NextResponse.json({
      overview: {
        totalUsers: totalUsers || 0,
        newUsersToday: newUsersToday || 0,
        activeUsers: activeUsers || 0,
        totalMeals: totalMeals || 0,
        completedMealsToday: completedMealsToday || 0,
        healthRecordsToday: healthRecordsToday || 0,
        aiSessionsTotal: aiSessionsTotal || 0,
        pendingInquiries: pendingInquiries || 0,
        publicRecipes: publicRecipes || 0,
      },
      dailyStats: dailyStats || [],
    });

  } catch (error: any) {
    console.error('Stats fetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

