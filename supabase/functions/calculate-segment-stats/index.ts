import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import { createLogger, generateRequestId } from '../_shared/db-logger.ts';

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

  // バッチ専用: CRON_SECRET 認証
  const authErr = requireServiceRole(req);
  if (authErr) {
    return new Response(authErr.body, {
      status: authErr.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const requestId = generateRequestId();
  const logger = createLogger('calculate-segment-stats', requestId);

  try {
    const { periodType = 'weekly', forceRecalc = false } = await req.json().catch(() => ({}));

    logger.info(`Starting segment stats calculation for period: ${periodType}`);

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
    logger.info(`Period: ${periodStart} to ${periodEnd}`);

    // 4. 全ユーザーのメトリクスを計算
    const userMetricsMap = await calculateAllUserMetrics(metrics!, periodType, periodStart, periodEnd);
    logger.info(`Calculated metrics for ${userMetricsMap.size} users`);

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
    logger.error('Segment stats calculation error', error);
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

// =====================================================
// バルク事前取得ヘルパー（N+1 解消）
// =====================================================

interface BulkData {
  mealStreaks: Map<string, number>;
  breakfastStreaks: Map<string, number>;
  mealDays: Map<string, number>;
  periodDays: number;
  breakfastPlanned: Map<string, number>;
  breakfastCompleted: Map<string, number>;
  vegScoreSum: Map<string, number>;
  vegScoreCount: Map<string, number>;
  plannedTotal: Map<string, number>;
  plannedCompleted: Map<string, number>;
  totalMeals: Map<string, number>;
}

async function fetchBulkData(periodStart: string, periodEnd: string): Promise<BulkData> {
  const startDate = new Date(periodStart);
  const endDate = new Date(periodEnd);
  const periodDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  // 5 クエリを並列実行（ユーザー数×メトリクス数の N+1 を解消）
  const [mealStreakResult, breakfastStreakResult, mealResult, plannedResult, totalMealResult] =
    await Promise.all([
      supabaseAdmin.from('health_streaks').select('user_id, current_streak').eq('streak_type', 'meal_record'),
      supabaseAdmin.from('health_streaks').select('user_id, current_streak').eq('streak_type', 'breakfast'),
      supabaseAdmin.from('meals').select('user_id, eaten_at').gte('eaten_at', periodStart).lte('eaten_at', periodEnd + 'T23:59:59Z'),
      supabaseAdmin.from('planned_meals').select(`
        meal_type, is_completed, veg_score,
        meal_plan_days!inner(day_date, meal_plans!inner(user_id))
      `).gte('meal_plan_days.day_date', periodStart).lte('meal_plan_days.day_date', periodEnd),
      supabaseAdmin.from('meals').select('user_id'),
    ]);

  const mealStreaks = new Map<string, number>(
    (mealStreakResult.data ?? []).map(r => [r.user_id, r.current_streak ?? 0])
  );
  const breakfastStreaks = new Map<string, number>(
    (breakfastStreakResult.data ?? []).map(r => [r.user_id, r.current_streak ?? 0])
  );

  const mealDaySetByUser = new Map<string, Set<string>>();
  for (const row of mealResult.data ?? []) {
    if (!row.user_id || !row.eaten_at) continue;
    let s = mealDaySetByUser.get(row.user_id);
    if (!s) { s = new Set(); mealDaySetByUser.set(row.user_id, s); }
    s.add(String(row.eaten_at).slice(0, 10));
  }
  const mealDays = new Map<string, number>();
  for (const [uid, s] of mealDaySetByUser) mealDays.set(uid, s.size);

  const breakfastPlanned = new Map<string, number>();
  const breakfastCompleted = new Map<string, number>();
  const vegScoreSum = new Map<string, number>();
  const vegScoreCount = new Map<string, number>();
  const plannedTotal = new Map<string, number>();
  const plannedCompleted = new Map<string, number>();

  for (const row of plannedResult.data ?? []) {
    const userId = (row.meal_plan_days as any)?.meal_plans?.user_id;
    if (!userId) continue;
    plannedTotal.set(userId, (plannedTotal.get(userId) ?? 0) + 1);
    if (row.is_completed) plannedCompleted.set(userId, (plannedCompleted.get(userId) ?? 0) + 1);
    if (row.meal_type === 'breakfast') {
      breakfastPlanned.set(userId, (breakfastPlanned.get(userId) ?? 0) + 1);
      if (row.is_completed) breakfastCompleted.set(userId, (breakfastCompleted.get(userId) ?? 0) + 1);
    }
    if (row.veg_score != null) {
      vegScoreSum.set(userId, (vegScoreSum.get(userId) ?? 0) + (row.veg_score as number));
      vegScoreCount.set(userId, (vegScoreCount.get(userId) ?? 0) + 1);
    }
  }

  const totalMeals = new Map<string, number>();
  for (const row of totalMealResult.data ?? []) {
    const uid = (row as any).user_id as string | undefined;
    if (!uid) continue;
    totalMeals.set(uid, (totalMeals.get(uid) ?? 0) + 1);
  }

  return { mealStreaks, breakfastStreaks, mealDays, periodDays, breakfastPlanned, breakfastCompleted, vegScoreSum, vegScoreCount, plannedTotal, plannedCompleted, totalMeals };
}

function computeMetricFromBulk(userId: string, metricCode: string, bulk: BulkData): number | null {
  switch (metricCode) {
    case 'record_streak':
      return bulk.mealStreaks.get(userId) ?? 0;
    case 'weekly_record_rate':
    case 'monthly_record_rate': {
      const days = bulk.mealDays.get(userId) ?? 0;
      return bulk.periodDays > 0 ? Math.round((days / bulk.periodDays) * 100) : 0;
    }
    case 'breakfast_rate': {
      const planned = bulk.breakfastPlanned.get(userId) ?? 0;
      const completed = bulk.breakfastCompleted.get(userId) ?? 0;
      return planned > 0 ? Math.round((completed / planned) * 100) : 0;
    }
    case 'breakfast_streak':
      return bulk.breakfastStreaks.get(userId) ?? 0;
    case 'veg_score_avg': {
      const sum = bulk.vegScoreSum.get(userId) ?? 0;
      const cnt = bulk.vegScoreCount.get(userId) ?? 0;
      return cnt > 0 ? Math.round((sum / cnt) * 10) / 10 : 0;
    }
    case 'nutrition_score': {
      const sum = bulk.vegScoreSum.get(userId) ?? 0;
      const cnt = bulk.vegScoreCount.get(userId) ?? 0;
      const vegAvg = cnt > 0 ? sum / cnt : 0;
      return Math.round(vegAvg * 20);
    }
    case 'menu_execution_rate': {
      const total = bulk.plannedTotal.get(userId) ?? 0;
      const completed = bulk.plannedCompleted.get(userId) ?? 0;
      return total > 0 ? Math.round((completed / total) * 100) : 0;
    }
    case 'total_meals':
      return bulk.totalMeals.get(userId) ?? 0;
    default:
      return null;
  }
}

function getPreviousPeriodStart(periodType: string, currentPeriodStart: string): string | null {
  const currentStart = new Date(currentPeriodStart);
  switch (periodType) {
    case 'weekly': {
      const d = new Date(currentStart);
      d.setDate(d.getDate() - 7);
      return d.toISOString().split('T')[0];
    }
    case 'monthly': {
      const d = new Date(currentStart);
      d.setMonth(d.getMonth() - 1);
      return d.toISOString().split('T')[0];
    }
    default:
      return null;
  }
}

async function calculateAllUserMetrics(
  metricDefs: any[],
  periodType: string,
  periodStart: string,
  periodEnd: string
): Promise<Map<string, UserMetrics>> {
  const userMetricsMap = new Map<string, UserMetrics>();

  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from('user_profiles')
    .select('*');

  if (profilesError) throw profilesError;
  if (!profiles || profiles.length === 0) return userMetricsMap;

  // バルク事前取得（N+1 回避: ユーザー数×メトリクス数のクエリ → 固定 5 クエリ）
  const bulk = await fetchBulkData(periodStart, periodEnd);

  const previousPeriodStart = getPreviousPeriodStart(periodType, periodStart);
  const prevMetricsByUser = new Map<string, Map<string, number>>();
  if (previousPeriodStart) {
    const { data: prevRows } = await supabaseAdmin
      .from('user_metrics')
      .select('user_id, metric_id, value')
      .eq('period_type', periodType)
      .eq('period_start', previousPeriodStart);
    for (const row of prevRows ?? []) {
      if (!prevMetricsByUser.has(row.user_id)) prevMetricsByUser.set(row.user_id, new Map());
      prevMetricsByUser.get(row.user_id)!.set(row.metric_id, row.value);
    }
  }

  const upsertRows: any[] = [];

  for (const profile of profiles) {
    const userId = profile.id;
    const metrics = new Map<string, number>();
    const previousMetrics = new Map<string, number>();

    for (const metricDef of metricDefs) {
      const value = computeMetricFromBulk(userId, metricDef.code, bulk);
      if (value !== null) metrics.set(metricDef.code, value);

      const prevVal = prevMetricsByUser.get(userId)?.get(metricDef.id);
      if (prevVal !== undefined && prevVal !== null) previousMetrics.set(metricDef.code, prevVal);
    }

    userMetricsMap.set(userId, { userId, profile, metrics, previousMetrics });

    for (const metricDef of metricDefs) {
      const value = metrics.get(metricDef.code);
      if (value === undefined) continue;
      const previousValue = previousMetrics.get(metricDef.code);
      const changeRate = previousValue && previousValue > 0
        ? Math.round(((value - previousValue) / previousValue) * 100)
        : null;
      upsertRows.push({
        user_id: userId,
        metric_id: metricDef.id,
        period_type: periodType,
        period_start: periodStart,
        period_end: periodEnd,
        value,
        previous_value: previousValue ?? null,
        change_rate: changeRate,
        updated_at: new Date().toISOString(),
      });
    }
  }

  // バルク upsert（チャンク分割で Supabase の上限を回避）
  const CHUNK = 200;
  for (let i = 0; i < upsertRows.length; i += CHUNK) {
    await supabaseAdmin
      .from('user_metrics')
      .upsert(upsertRows.slice(i, i + CHUNK), { onConflict: 'user_id,metric_id,period_type,period_start' });
  }

  return userMetricsMap;
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
