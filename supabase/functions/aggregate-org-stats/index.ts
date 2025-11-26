import { serve } from 'https://deno.land/std@0.178.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { date, organizationId } = await req.json().catch(() => ({}));
    
    // 対象日付（指定なければ今日）
    const targetDateStr = date || new Date().toISOString().split('T')[0];
    const targetDateStart = new Date(`${targetDateStr}T00:00:00Z`);
    const targetDateEnd = new Date(`${targetDateStr}T23:59:59.999Z`);

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
    for (const org of orgs) {
      // メンバー取得
      const { data: members, error: memError } = await supabaseAdmin
        .from('user_profiles')
        .select('id')
        .eq('organization_id', org.id);
      
      if (memError) {
        console.error(`Error fetching members for org ${org.id}`, memError);
        continue;
      }

      const memberIds = members.map(m => m.id);
      const memberCount = memberIds.length;

      if (memberCount === 0) {
        // メンバー0の場合は0埋めでレコード作成
        await upsertStats(org.id, targetDateStr, 0, 0, 0, 0, 0);
        continue;
      }

      // 食事データ取得
      // 日付範囲フィルタ
      const { data: meals, error: mealError } = await supabaseAdmin
        .from('meals')
        .select(`
          id, meal_type, eaten_at, user_id,
          meal_nutrition_estimates ( veg_score )
        `)
        .in('user_id', memberIds)
        .gte('eaten_at', targetDateStart.toISOString())
        .lte('eaten_at', targetDateEnd.toISOString());

      if (mealError) {
        console.error(`Error fetching meals for org ${org.id}`, mealError);
        continue;
      }

      // --- 指標計算 ---

      // アクティブ人数
      const activeUserIds = new Set(meals.map(m => m.user_id));
      const activeMemberCount = activeUserIds.size;

      // 食事ログ総数
      const totalMeals = meals.length;

      // 朝食率
      const breakfastCount = meals.filter(m => m.meal_type === 'breakfast').length;
      const breakfastRate = totalMeals > 0 ? Math.round((breakfastCount / totalMeals) * 100) : 0;

      // 深夜食率 (22:00-04:00)
      // 注意: JST/UTCの扱いに注意が必要だが、ここではeaten_at(ISO文字列)をParseして判定
      // 簡易的にローカル時間(UTC)で判定してしまうとずれるので、+9時間(JST)として判定するか、
      // クライアントから送られた eaten_at が正しければその時刻を使う。
      // ここでは new Date(eaten_at).getHours() はUTC時間になる環境が多い。
      // 日本時間前提で計算: UTC+9
      const lateNightCount = meals.filter(m => {
        const d = new Date(m.eaten_at);
        // UTC時間に9時間足してJSTの時間を取得
        const jstHour = (d.getUTCHours() + 9) % 24;
        return jstHour >= 22 || jstHour < 4;
      }).length;
      const lateNightRate = totalMeals > 0 ? Math.round((lateNightCount / totalMeals) * 100) : 0;

      // 平均スコア
      // meal_nutrition_estimates は配列で返る可能性があるが、通常1対1
      const scores = meals.flatMap(m => m.meal_nutrition_estimates || [])
                         .filter(n => n.veg_score !== null)
                         .map(n => n.veg_score);
      
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

      results.push({ orgId: org.id, memberCount, totalMeals });
    }

    return new Response(JSON.stringify({ success: true, processed: results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
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


