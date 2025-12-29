import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 組織統計取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', user.id)
    .single();

  if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // メンバー数
    const { count: totalMembers } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', profile.organization_id);

    // アクティブメンバー（30日以内にログイン）
    const { count: activeMembers } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', profile.organization_id)
      .gte('last_login_at', thirtyDaysAgo.toISOString());

    // メンバーID取得
    const { data: members } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('organization_id', profile.organization_id);

    const memberIds = (members || []).map(m => m.id);

    // 今週の食事完了数
    let weeklyMeals = 0;
    let breakfastCount = 0;
    let totalMealsThisWeek = 0;

    if (memberIds.length > 0) {
      // 食事プランを取得
      const { data: mealPlans } = await supabase
        .from('meal_plans')
        .select('id')
        .in('user_id', memberIds);

      const planIds = (mealPlans || []).map(p => p.id);

      if (planIds.length > 0) {
        // 食事日を取得
        const { data: mealDays } = await supabase
          .from('meal_plan_days')
          .select('id')
          .in('meal_plan_id', planIds)
          .gte('day_date', sevenDaysAgo.toISOString().split('T')[0]);

        const dayIds = (mealDays || []).map(d => d.id);

        if (dayIds.length > 0) {
          // 完了した食事数
          const { count } = await supabase
            .from('planned_meals')
            .select('*', { count: 'exact', head: true })
            .in('meal_plan_day_id', dayIds)
            .eq('is_completed', true);

          weeklyMeals = count || 0;

          // 朝食数
          const { count: bCount } = await supabase
            .from('planned_meals')
            .select('*', { count: 'exact', head: true })
            .in('meal_plan_day_id', dayIds)
            .eq('meal_type', 'breakfast')
            .eq('is_completed', true);

          breakfastCount = bCount || 0;

          // 総食事数
          const { count: tCount } = await supabase
            .from('planned_meals')
            .select('*', { count: 'exact', head: true })
            .in('meal_plan_day_id', dayIds)
            .eq('is_completed', true);

          totalMealsThisWeek = tCount || 0;
        }
      }
    }

    // 朝食率計算
    const breakfastRate = totalMealsThisWeek > 0 
      ? Math.round((breakfastCount / (totalMealsThisWeek / 3)) * 100) 
      : 0;

    // 日次統計（過去30日）
    const { data: dailyStats } = await supabase
      .from('org_daily_stats')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .gte('date', thirtyDaysAgo.toISOString().split('T')[0])
      .order('date', { ascending: false });

    // 部署別統計
    const { data: departments } = await supabase
      .from('departments')
      .select('id, name')
      .eq('organization_id', profile.organization_id);

    const departmentStats = [];
    for (const dept of departments || []) {
      const { count } = await supabase
        .from('user_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', profile.organization_id)
        .eq('department', dept.name);

      departmentStats.push({
        id: dept.id,
        name: dept.name,
        memberCount: count || 0,
      });
    }

    return NextResponse.json({
      overview: {
        totalMembers: totalMembers || 0,
        activeMembers: activeMembers || 0,
        weeklyMeals,
        breakfastRate,
      },
      dailyStats: dailyStats || [],
      departmentStats,
    });

  } catch (error: any) {
    console.error('Org stats error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

