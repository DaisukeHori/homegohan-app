import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { date, organizationId } = await req.json().catch(() => ({}));
    
    // 対象日付（指定なければ今日）
    const targetDateStr = date || new Date().toISOString().split('T')[0];

    console.log(`Aggregating stats for date: ${targetDateStr}`);

    // 1. 集計対象の組織を取得
    let orgQuery = supabaseAdmin.from('organizations').select('id');
    if (organizationId) {
      orgQuery = orgQuery.eq('id', organizationId);
    }
    const { data: orgs, error: orgError } = await orgQuery;
    if (orgError) throw orgError;

    const results = [];

    // 2. 各組織ごとに集計を実行
    for (const org of orgs || []) {
      // メンバー取得
      const { data: members, error: memError } = await supabaseAdmin
        .from('user_profiles')
        .select('id')
        .eq('organization_id', org.id);
      
      if (memError) {
        console.error(`Error fetching members for org ${org.id}`, memError);
        continue;
      }

      const memberIds = members?.map(m => m.id) || [];
      const memberCount = memberIds.length;

      if (memberCount === 0) {
        // メンバー0の場合は0埋めでレコード作成
        await upsertStats(org.id, targetDateStr, 0, 0, 0, 0, 0);
        continue;
      }

      // planned_mealsから該当日のデータを取得
      // meal_plan_days経由でユーザーを特定
      const { data: plannedMeals, error: mealError } = await supabaseAdmin
        .from('planned_meals')
        .select(`
          id, 
          meal_type, 
          is_completed, 
          completed_at,
          veg_score,
          meal_plan_days!inner(
            day_date,
            meal_plans!inner(user_id)
          )
        `)
        .eq('meal_plan_days.day_date', targetDateStr)
        .in('meal_plan_days.meal_plans.user_id', memberIds);

      if (mealError) {
        console.error(`Error fetching planned_meals for org ${org.id}`, mealError);
        continue;
      }

      const meals = plannedMeals || [];

      // --- 指標計算 ---

      // アクティブ人数（完了した食事があるユーザー）
      const activeUserIds = new Set(
        meals
          .filter(m => m.is_completed)
          .map(m => (m.meal_plan_days as any)?.meal_plans?.user_id)
          .filter(Boolean)
      );
      const activeMemberCount = activeUserIds.size;

      // 完了した食事数
      const completedMeals = meals.filter(m => m.is_completed);
      const totalCompletedMeals = completedMeals.length;

      // 朝食率（完了した朝食 / 完了した食事総数）
      const breakfastCount = completedMeals.filter(m => m.meal_type === 'breakfast').length;
      const breakfastRate = totalCompletedMeals > 0 ? Math.round((breakfastCount / totalCompletedMeals) * 100) : 0;

      // 深夜食率 (22:00-04:00に完了した食事)
      const lateNightCount = completedMeals.filter(m => {
        if (!m.completed_at) return false;
        const d = new Date(m.completed_at);
        // UTC時間に9時間足してJSTの時間を取得
        const jstHour = (d.getUTCHours() + 9) % 24;
        return jstHour >= 22 || jstHour < 4;
      }).length;
      const lateNightRate = totalCompletedMeals > 0 ? Math.round((lateNightCount / totalCompletedMeals) * 100) : 0;

      // 平均スコア（veg_scoreを使用）
      const scores = meals
        .filter(m => m.veg_score !== null && m.veg_score !== undefined)
        .map(m => m.veg_score as number);
      
      const totalScore = scores.reduce((sum, score) => sum + score, 0);
      // veg_score(0-5) -> 100点満点換算 (*20)
      const avgScore = scores.length > 0 ? Math.round((totalScore / scores.length) * 20) : 0;

      // DB保存
      await upsertStats(
        org.id,
        targetDateStr,
        memberCount,
        activeMemberCount,
        breakfastRate,
        lateNightRate,
        avgScore
      );

      results.push({ orgId: org.id, memberCount, totalCompletedMeals });
    }

    return new Response(JSON.stringify({ success: true, processed: results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error: any) {
    console.error('Aggregation error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});

async function upsertStats(
  orgId: string,
  date: string,
  memberCount: number,
  activeCount: number,
  breakfastRate: number,
  lateNightRate: number,
  avgScore: number
) {
  const { error } = await supabaseAdmin
    .from('org_daily_stats')
    .upsert({
      organization_id: orgId,
      date: date,
      member_count: memberCount,
      active_member_count: activeCount,
      breakfast_rate: breakfastRate,
      late_night_rate: lateNightRate,
      avg_score: avgScore,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'organization_id, date'
    });

  if (error) throw error;
}
