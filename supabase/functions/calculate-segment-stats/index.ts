import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

// =====================================================
// メイン処理
// =====================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { periodType = 'weekly', forceRecalc = false } = await req.json().catch(() => ({}));
    
    console.log(`Starting segment stats calculation for period: ${periodType}`);

    // 1. メトリクス定義を取得
    const { data: metrics, error: metricsError } = await supabaseAdmin
      .from('metric_definitions')
      .select('*')
      .eq('is_active', true);
    
    if (metricsError) throw metricsError;

    // 2. セグメント定義を取得
    const { data: segments, error: segmentsError } = await supabaseAdmin
      .from('segment_definitions')
      .select('*')
      .eq('is_active', true);
    
    if (segmentsError) throw segmentsError;

    // 3. 期間を計算
    const { periodStart, periodEnd } = calculatePeriod(periodType);
    console.log(`Period: ${periodStart} to ${periodEnd}`);

    // 4. 全ユーザーのメトリクスを計算
    const userMetricsMap = await calculateAllUserMetrics(metrics!, periodType, periodStart, periodEnd);
    console.log(`Calculated metrics for ${userMetricsMap.size} users`);

    // 5. 各セグメントの統計を計算
    for (const segment of segments!) {
      await calculateSegmentStats(segment, metrics!, userMetricsMap, periodType, periodStart, periodEnd);
    }

    // 6. ユーザーのランキングを計算
    await calculateUserRankings(segments!, metrics!, userMetricsMap, periodType, periodStart);

    // 7. バッジを付与
    await awardSegmentBadges(periodType, periodStart);

    return new Response(JSON.stringify({ 
      success: true, 
      processedUsers: userMetricsMap.size,
      processedSegments: segments!.length,
      periodType,
      periodStart,
      periodEnd
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error: any) {
    console.error('Segment stats calculation error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});

// =====================================================
// 期間計算
// =====================================================

function calculatePeriod(periodType: string): { periodStart: string; periodEnd: string } {
  const now = new Date();
  let periodStart: Date;
  let periodEnd: Date;

  switch (periodType) {
    case 'daily':
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      periodEnd = periodStart;
      break;
    case 'weekly':
      // 月曜日起点
      const dayOfWeek = now.getDay();
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
      periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 6);
      break;
    case 'monthly':
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      break;
    case 'all_time':
      periodStart = new Date(2024, 0, 1);
      periodEnd = now;
      break;
    default:
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
      periodEnd = now;
  }

  return {
    periodStart: periodStart.toISOString().split('T')[0],
    periodEnd: periodEnd.toISOString().split('T')[0],
  };
}

// =====================================================
// ユーザーメトリクス計算
// =====================================================

interface UserMetrics {
  userId: string;
  profile: any;
  metrics: Map<string, number>;
  previousMetrics: Map<string, number>;
}

async function calculateAllUserMetrics(
  metricDefs: any[],
  periodType: string,
  periodStart: string,
  periodEnd: string
): Promise<Map<string, UserMetrics>> {
  const userMetricsMap = new Map<string, UserMetrics>();

  // 全ユーザープロファイルを取得
  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from('user_profiles')
    .select('*');

  if (profilesError) throw profilesError;
  if (!profiles || profiles.length === 0) return userMetricsMap;

  // 各ユーザーのメトリクスを計算
  for (const profile of profiles) {
    const userId = profile.id;
    const metrics = new Map<string, number>();
    const previousMetrics = new Map<string, number>();

    for (const metricDef of metricDefs) {
      const value = await calculateMetricForUser(userId, metricDef, periodStart, periodEnd);
      if (value !== null) {
        metrics.set(metricDef.code, value);
      }

      // 前期間の値を取得（改善率計算用）
      const previousValue = await getPreviousMetricValue(userId, metricDef.id, periodType, periodStart);
      if (previousValue !== null) {
        previousMetrics.set(metricDef.code, previousValue);
      }
    }

    userMetricsMap.set(userId, {
      userId,
      profile,
      metrics,
      previousMetrics,
    });

    // user_metricsテーブルに保存
    await saveUserMetrics(userId, metricDefs, metrics, previousMetrics, periodType, periodStart, periodEnd);
  }

  return userMetricsMap;
}

async function calculateMetricForUser(
  userId: string,
  metricDef: any,
  periodStart: string,
  periodEnd: string
): Promise<number | null> {
  switch (metricDef.code) {
    case 'record_streak':
      return await calculateRecordStreak(userId);
    
    case 'weekly_record_rate':
    case 'monthly_record_rate':
      return await calculateRecordRate(userId, periodStart, periodEnd);
    
    case 'breakfast_rate':
      return await calculateBreakfastRate(userId, periodStart, periodEnd);
    
    case 'breakfast_streak':
      return await calculateBreakfastStreak(userId);
    
    case 'veg_score_avg':
      return await calculateVegScoreAvg(userId, periodStart, periodEnd);
    
    case 'nutrition_score':
      return await calculateNutritionScore(userId, periodStart, periodEnd);
    
    case 'menu_execution_rate':
      return await calculateMenuExecutionRate(userId, periodStart, periodEnd);
    
    case 'total_meals':
      return await calculateTotalMeals(userId);
    
    default:
      return null;
  }
}

// --- 個別メトリクス計算関数 ---

async function calculateRecordStreak(userId: string): Promise<number> {
  const { data: streak } = await supabaseAdmin
    .from('health_streaks')
    .select('current_streak')
    .eq('user_id', userId)
    .eq('streak_type', 'meal_record')
    .single();
  
  return streak?.current_streak ?? 0;
}

async function calculateRecordRate(userId: string, periodStart: string, periodEnd: string): Promise<number> {
  const { data: meals } = await supabaseAdmin
    .from('meals')
    .select('eaten_at')
    .eq('user_id', userId)
    .gte('eaten_at', periodStart)
    .lte('eaten_at', periodEnd + 'T23:59:59Z');

  if (!meals || meals.length === 0) return 0;

  const uniqueDays = new Set(meals.map(m => m.eaten_at.split('T')[0]));
  const startDate = new Date(periodStart);
  const endDate = new Date(periodEnd);
  const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  
  return Math.round((uniqueDays.size / totalDays) * 100);
}

async function calculateBreakfastRate(userId: string, periodStart: string, periodEnd: string): Promise<number> {
  // planned_mealsから朝食の実行率を計算
  const { data: meals } = await supabaseAdmin
    .from('planned_meals')
    .select(`
      meal_type,
      is_completed,
      meal_plan_days!inner(day_date, meal_plans!inner(user_id))
    `)
    .eq('meal_plan_days.meal_plans.user_id', userId)
    .gte('meal_plan_days.day_date', periodStart)
    .lte('meal_plan_days.day_date', periodEnd);

  if (!meals || meals.length === 0) return 0;

  const breakfastMeals = meals.filter(m => m.meal_type === 'breakfast');
  if (breakfastMeals.length === 0) return 0;

  const completedBreakfasts = breakfastMeals.filter(m => m.is_completed);
  return Math.round((completedBreakfasts.length / breakfastMeals.length) * 100);
}

async function calculateBreakfastStreak(userId: string): Promise<number> {
  const { data: streak } = await supabaseAdmin
    .from('health_streaks')
    .select('current_streak')
    .eq('user_id', userId)
    .eq('streak_type', 'breakfast')
    .single();
  
  return streak?.current_streak ?? 0;
}

async function calculateVegScoreAvg(userId: string, periodStart: string, periodEnd: string): Promise<number> {
  const { data: meals } = await supabaseAdmin
    .from('planned_meals')
    .select(`
      veg_score,
      meal_plan_days!inner(day_date, meal_plans!inner(user_id))
    `)
    .eq('meal_plan_days.meal_plans.user_id', userId)
    .gte('meal_plan_days.day_date', periodStart)
    .lte('meal_plan_days.day_date', periodEnd)
    .not('veg_score', 'is', null);

  if (!meals || meals.length === 0) return 0;

  const totalVegScore = meals.reduce((sum, m) => sum + (m.veg_score || 0), 0);
  return Math.round((totalVegScore / meals.length) * 10) / 10;
}

async function calculateNutritionScore(userId: string, periodStart: string, periodEnd: string): Promise<number> {
  // veg_score を 0-100 スケールに変換して平均
  const vegScore = await calculateVegScoreAvg(userId, periodStart, periodEnd);
  // 0-5 を 0-100 に変換
  return Math.round(vegScore * 20);
}

async function calculateMenuExecutionRate(userId: string, periodStart: string, periodEnd: string): Promise<number> {
  const { data: meals } = await supabaseAdmin
    .from('planned_meals')
    .select(`
      is_completed,
      meal_plan_days!inner(day_date, meal_plans!inner(user_id))
    `)
    .eq('meal_plan_days.meal_plans.user_id', userId)
    .gte('meal_plan_days.day_date', periodStart)
    .lte('meal_plan_days.day_date', periodEnd);

  if (!meals || meals.length === 0) return 0;

  const completedMeals = meals.filter(m => m.is_completed);
  return Math.round((completedMeals.length / meals.length) * 100);
}

async function calculateTotalMeals(userId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('meals')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  return count ?? 0;
}

async function getPreviousMetricValue(
  userId: string,
  metricId: string,
  periodType: string,
  currentPeriodStart: string
): Promise<number | null> {
  // 前期間の開始日を計算
  const currentStart = new Date(currentPeriodStart);
  let previousStart: Date;

  switch (periodType) {
    case 'weekly':
      previousStart = new Date(currentStart);
      previousStart.setDate(previousStart.getDate() - 7);
      break;
    case 'monthly':
      previousStart = new Date(currentStart);
      previousStart.setMonth(previousStart.getMonth() - 1);
      break;
    default:
      return null;
  }

  const { data } = await supabaseAdmin
    .from('user_metrics')
    .select('value')
    .eq('user_id', userId)
    .eq('metric_id', metricId)
    .eq('period_type', periodType)
    .eq('period_start', previousStart.toISOString().split('T')[0])
    .single();

  return data?.value ?? null;
}

async function saveUserMetrics(
  userId: string,
  metricDefs: any[],
  metrics: Map<string, number>,
  previousMetrics: Map<string, number>,
  periodType: string,
  periodStart: string,
  periodEnd: string
): Promise<void> {
  for (const metricDef of metricDefs) {
    const value = metrics.get(metricDef.code);
    if (value === undefined) continue;

    const previousValue = previousMetrics.get(metricDef.code);
    const changeRate = previousValue && previousValue > 0
      ? Math.round(((value - previousValue) / previousValue) * 100)
      : null;

    await supabaseAdmin
      .from('user_metrics')
      .upsert({
        user_id: userId,
        metric_id: metricDef.id,
        period_type: periodType,
        period_start: periodStart,
        period_end: periodEnd,
        value,
        previous_value: previousValue,
        change_rate: changeRate,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,metric_id,period_type,period_start',
      });
  }
}

// =====================================================
// セグメント統計計算
// =====================================================

async function calculateSegmentStats(
  segment: any,
  metricDefs: any[],
  userMetricsMap: Map<string, UserMetrics>,
  periodType: string,
  periodStart: string,
  periodEnd: string
): Promise<void> {
  // セグメントに該当するユーザーをフィルタリング
  const segmentUsers = filterUsersBySegment(userMetricsMap, segment.axes);
  
  if (segmentUsers.length < 5) {
    // 5人未満の場合は統計を計算しない（プライバシー保護）
    console.log(`Segment ${segment.code} has less than 5 users, skipping stats calculation`);
    return;
  }

  for (const metricDef of metricDefs) {
    const values = segmentUsers
      .map(u => u.metrics.get(metricDef.code))
      .filter((v): v is number => v !== undefined && v !== null)
      .sort((a, b) => a - b);

    if (values.length === 0) continue;

    const stats = calculateStatistics(values);

    await supabaseAdmin
      .from('segment_stats')
      .upsert({
        segment_id: segment.id,
        metric_id: metricDef.id,
        period_type: periodType,
        period_start: periodStart,
        period_end: periodEnd,
        user_count: values.length,
        avg_value: stats.avg,
        median_value: stats.median,
        min_value: stats.min,
        max_value: stats.max,
        p10_value: stats.p10,
        p25_value: stats.p25,
        p75_value: stats.p75,
        p90_value: stats.p90,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'segment_id,metric_id,period_type,period_start',
      });
  }
}

function filterUsersBySegment(
  userMetricsMap: Map<string, UserMetrics>,
  axes: Record<string, string>
): UserMetrics[] {
  const users: UserMetrics[] = [];

  for (const userMetrics of userMetricsMap.values()) {
    const profile = userMetrics.profile;
    let matches = true;

    for (const [axis, value] of Object.entries(axes)) {
      switch (axis) {
        case 'age_group':
          if (profile.age_group !== value) matches = false;
          break;
        case 'gender':
          if (profile.gender !== value) matches = false;
          break;
        case 'perf_mode':
          if (!profile.perf_modes || !profile.perf_modes.includes(value)) matches = false;
          break;
      }
    }

    if (matches) {
      users.push(userMetrics);
    }
  }

  return users;
}

function calculateStatistics(values: number[]): {
  avg: number;
  median: number;
  min: number;
  max: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  const percentile = (p: number) => {
    const index = (p / 100) * (n - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };

  return {
    avg: Math.round((sorted.reduce((a, b) => a + b, 0) / n) * 100) / 100,
    median: percentile(50),
    min: sorted[0],
    max: sorted[n - 1],
    p10: percentile(10),
    p25: percentile(25),
    p75: percentile(75),
    p90: percentile(90),
  };
}

// =====================================================
// ユーザーランキング計算
// =====================================================

async function calculateUserRankings(
  segments: any[],
  metricDefs: any[],
  userMetricsMap: Map<string, UserMetrics>,
  periodType: string,
  periodStart: string
): Promise<void> {
  for (const segment of segments) {
    const segmentUsers = filterUsersBySegment(userMetricsMap, segment.axes);
    
    if (segmentUsers.length < 5) continue;

    for (const metricDef of metricDefs) {
      // メトリクス値でソート（高い方が良い場合は降順）
      const usersWithValues = segmentUsers
        .filter(u => u.metrics.has(metricDef.code))
        .map(u => ({
          userId: u.userId,
          value: u.metrics.get(metricDef.code)!,
        }))
        .sort((a, b) => metricDef.higher_is_better ? b.value - a.value : a.value - b.value);

      const totalUsers = usersWithValues.length;
      if (totalUsers === 0) continue;

      // セグメントの統計を取得
      const { data: stats } = await supabaseAdmin
        .from('segment_stats')
        .select('avg_value')
        .eq('segment_id', segment.id)
        .eq('metric_id', metricDef.id)
        .eq('period_type', periodType)
        .eq('period_start', periodStart)
        .single();

      const avgValue = stats?.avg_value ?? 0;

      // 各ユーザーのランキングを保存
      for (let i = 0; i < usersWithValues.length; i++) {
        const user = usersWithValues[i];
        const rank = i + 1;
        const percentile = Math.round(((totalUsers - rank) / totalUsers) * 100);
        const vsAvgRate = avgValue > 0
          ? Math.round(((user.value - avgValue) / avgValue) * 100)
          : 0;

        await supabaseAdmin
          .from('user_segment_rankings')
          .upsert({
            user_id: user.userId,
            segment_id: segment.id,
            metric_id: metricDef.id,
            period_type: periodType,
            period_start: periodStart,
            rank,
            total_users: totalUsers,
            percentile,
            value: user.value,
            vs_avg_rate: vsAvgRate,
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'user_id,segment_id,metric_id,period_type,period_start',
          });
      }
    }
  }
}

// =====================================================
// バッジ付与
// =====================================================

async function awardSegmentBadges(periodType: string, periodStart: string): Promise<void> {
  // セグメント比較系のバッジを取得
  const { data: badges } = await supabaseAdmin
    .from('badges')
    .select('*')
    .or('condition_json->type.eq.segment_rank,condition_json->type.eq.segment_percentile,condition_json->type.eq.segment_vs_avg,condition_json->type.eq.improvement');

  if (!badges || badges.length === 0) return;

  // ランキングデータを取得
  const { data: rankings } = await supabaseAdmin
    .from('user_segment_rankings')
    .select(`
      *,
      segment_definitions(code, name),
      metric_definitions(code, name)
    `)
    .eq('period_type', periodType)
    .eq('period_start', periodStart);

  if (!rankings || rankings.length === 0) return;

  // 各ランキングに対してバッジ条件をチェック
  for (const ranking of rankings) {
    for (const badge of badges) {
      const condition = badge.condition_json;
      let shouldAward = false;
      let message = '';

      // メトリクス特化バッジの場合、メトリクスコードをチェック
      if (badge.metric_code && badge.metric_code !== (ranking.metric_definitions as any)?.code) {
        continue;
      }

      switch (condition.type) {
        case 'segment_rank':
          if (ranking.rank <= condition.rank) {
            shouldAward = true;
            const segmentName = (ranking.segment_definitions as any)?.name ?? 'セグメント';
            const metricName = (ranking.metric_definitions as any)?.name ?? 'メトリクス';
            message = `${badge.icon} ${segmentName}の${metricName}で${ranking.rank}位！`;
          }
          break;

        case 'segment_percentile':
          if (ranking.percentile >= condition.threshold) {
            shouldAward = true;
            const segmentName = (ranking.segment_definitions as any)?.name ?? 'セグメント';
            const metricName = (ranking.metric_definitions as any)?.name ?? 'メトリクス';
            message = `${badge.icon} ${segmentName}の${metricName}で上位${100 - condition.threshold}%！`;
          }
          break;

        case 'segment_vs_avg':
          if (ranking.vs_avg_rate >= condition.threshold) {
            shouldAward = true;
            const segmentName = (ranking.segment_definitions as any)?.name ?? 'セグメント';
            const metricName = (ranking.metric_definitions as any)?.name ?? 'メトリクス';
            if (condition.threshold === 0) {
              message = `${badge.icon} ${segmentName}の${metricName}で平均超え！`;
            } else {
              message = `${badge.icon} ${segmentName}の${metricName}で平均+${ranking.vs_avg_rate}%！`;
            }
          }
          break;

        case 'improvement':
          // user_metricsから改善率を取得
          const { data: userMetric } = await supabaseAdmin
            .from('user_metrics')
            .select('change_rate')
            .eq('user_id', ranking.user_id)
            .eq('metric_id', ranking.metric_id)
            .eq('period_type', periodType)
            .eq('period_start', periodStart)
            .single();

          if (userMetric?.change_rate && userMetric.change_rate >= condition.threshold) {
            shouldAward = true;
            const metricName = (ranking.metric_definitions as any)?.name ?? 'メトリクス';
            message = `${badge.icon} ${metricName}が${userMetric.change_rate}%改善！`;
          }
          break;
      }

      if (shouldAward) {
        // バッジを付与（既に存在する場合はスキップ）
        const { error } = await supabaseAdmin
          .from('user_badges')
          .upsert({
            user_id: ranking.user_id,
            badge_id: badge.id,
            context_json: {
              segment_id: ranking.segment_id,
              metric_id: ranking.metric_id,
              period_type: periodType,
              period_start: periodStart,
              rank: ranking.rank,
              percentile: ranking.percentile,
              vs_avg_rate: ranking.vs_avg_rate,
            },
            message,
            obtained_at: new Date().toISOString(),
          }, {
            onConflict: 'user_id,badge_id',
            ignoreDuplicates: true,
          });

        if (!error) {
          console.log(`Awarded badge ${badge.code} to user ${ranking.user_id}: ${message}`);
        }
      }
    }
  }
}

