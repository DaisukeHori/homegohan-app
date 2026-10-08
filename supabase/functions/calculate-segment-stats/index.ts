import { createClient } from "@supabase/supabase-js";
import { requireServiceRole } from '../_shared/auth.ts';
import { chunkArray, embeddedOne, fetchAllRows, throwIfError } from '../_shared/bulk-query.ts';
import { createLogger, generateRequestId } from '../_shared/db-logger.ts';

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

// 1 回の upsert に載せる行数の上限 (リクエストのサイズを抑える)
const UPSERT_CHUNK = 200;

/**
 * 指標の向き。metric_definitions.higher_is_better の DB 既定値は true なので、
 * null (未設定) も「高い方が良い」として扱う。順位の並びとバッジの判定で同じ向きを使うための共通の判定。
 */
function isHigherBetter(metricDef: { higher_is_better?: boolean | null } | null | undefined): boolean {
  return metricDef?.higher_is_better !== false;
}

/** numeric 列の値 (JSON では数値、文字列で来る場合もある) を数値にする。null・数値にできない値は null */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// =====================================================
// メイン処理
// =====================================================

// バッチ専用 (ブラウザからは呼ばれない) なので CORS は付けない (#1167)。
// ブラウザの事前確認 (OPTIONS) は下の認証で 401 になり、CORS ヘッダーが無いためブラウザ側で止まる。
Deno.serve(async (req) => {
  // バッチ専用: CRON_SECRET 認証
  const authErr = requireServiceRole(req);
  if (authErr) {
    return new Response(authErr.body, {
      status: authErr.status,
      headers: { 'Content-Type': 'application/json' },
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
    
    throwIfError('metric_definitions の取得', metricsError);

    // 2. セグメント定義を取得
    const { data: segments, error: segmentsError } = await supabaseAdmin
      .from('segment_definitions')
      .select('*')
      .eq('is_active', true);
    
    throwIfError('segment_definitions の取得', segmentsError);

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
    await awardSegmentBadges(periodType, periodStart, userMetricsMap);

    return new Response(JSON.stringify({ 
      success: true, 
      processedUsers: userMetricsMap.size,
      processedSegments: segments!.length,
      periodType,
      periodStart,
      periodEnd
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error: any) {
    logger.error('Segment stats calculation error', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Content-Type': 'application/json' },
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
  /** 前の期間からの変化率 (%)。指標コード → 値。前の期間の値が無い (0 以下を含む) 指標は入らない。user_metrics.change_rate と同じ値 */
  changeRates: Map<string, number>;
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

// planned_meals の 1 行。所有者 (user_id) と日付 (day_date) は user_daily_meals にある。
// 実際の応答は多対一なのでオブジェクトだが、型の上では配列になり得る。embeddedOne で 1 件に揃えて読む。
interface DailyMealRef {
  user_id: string;
  day_date: string;
}

interface PlannedMealRow {
  meal_type: string;
  is_completed: boolean | null;
  veg_score: number | null;
  user_daily_meals: DailyMealRef | DailyMealRef[] | null;
}

async function fetchBulkData(periodStart: string, periodEnd: string): Promise<BulkData> {
  const startDate = new Date(periodStart);
  const endDate = new Date(periodEnd);
  const periodDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  // 5 クエリを並列実行（ユーザー数×メトリクス数の N+1 を解消）
  // どのクエリも、失敗したら例外にする (失敗を「行が無い」と取り違えて、0 の指標を保存しないため)。
  // また API は 1 回の応答を 1000 行で打ち切るので、fetchAllRows で全件を取る。
  //
  // 日付の扱い (JST と UTC が混ざっているので、取得ごとにどちらかを明示する):
  //   - 期間 (periodStart / periodEnd) は calculatePeriod が求める YYYY-MM-DD で、実行環境 (Deno = UTC) の暦日。
  //     JST に揃えるのは #1211 の担当で、ここでは従来どおりの値をそのまま使う
  //   - planned_meals: 日付は user_daily_meals.day_date (date 型。JST の暦日でタイムゾーンを持たない)。
  //     期間の文字列とそのまま比較する
  //   - meals: eaten_at は timestamptz (時刻)。期間の端は UTC の 0:00〜23:59:59 で切り、
  //     日別の数え方 (下の mealDaySetByUser) も UTC の暦日
  const [mealStreakRows, breakfastStreakRows, mealRows, plannedRows, totalMealRows] =
    await Promise.all([
      fetchAllRows<{ user_id: string; current_streak: number | null }>('health_streaks (meal_record) の取得', () =>
        supabaseAdmin.from('health_streaks').select('user_id, current_streak').eq('streak_type', 'meal_record'),
      ),
      fetchAllRows<{ user_id: string; current_streak: number | null }>('health_streaks (breakfast) の取得', () =>
        supabaseAdmin.from('health_streaks').select('user_id, current_streak').eq('streak_type', 'breakfast'),
      ),
      fetchAllRows<{ user_id: string; eaten_at: string }>('meals (期間内) の取得', () =>
        supabaseAdmin.from('meals').select('user_id, eaten_at').gte('eaten_at', periodStart).lte('eaten_at', periodEnd + 'T23:59:59Z'),
      ),
      // planned_meals に user_id / 日付の列は無い。所有者と日付は daily_meal_id でつながる user_daily_meals (user_id, day_date) にある
      // (以前の meal_plan_days / meal_plans は date-based model への移行で削除済み。本番にも無い #1306)。
      // ハンズオン (チュートリアル) 用の仮データ (is_sandbox = true) は、実際の食事ではないので集計から除く。
      fetchAllRows<PlannedMealRow>('planned_meals (期間内) の取得', () =>
        supabaseAdmin
          .from('planned_meals')
          .select('meal_type, is_completed, veg_score, user_daily_meals!inner(user_id, day_date)')
          .gte('user_daily_meals.day_date', periodStart)
          .lte('user_daily_meals.day_date', periodEnd)
          .eq('user_daily_meals.is_sandbox', false),
      ),
      fetchAllRows<{ user_id: string }>('meals (全期間) の取得', () => supabaseAdmin.from('meals').select('user_id')),
    ]);

  const mealStreaks = new Map<string, number>(
    mealStreakRows.map((r): [string, number] => [r.user_id, r.current_streak ?? 0])
  );
  const breakfastStreaks = new Map<string, number>(
    breakfastStreakRows.map((r): [string, number] => [r.user_id, r.current_streak ?? 0])
  );

  const mealDaySetByUser = new Map<string, Set<string>>();
  for (const row of mealRows) {
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

  for (const row of plannedRows) {
    const userId = embeddedOne(row.user_daily_meals)?.user_id;
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
  for (const row of totalMealRows) {
    const uid = row.user_id;
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

  // セグメントの判定 (filterUsersBySegment) に使う列だけを読む。全ユーザー分なので、select('*') で個人情報まで運ばない
  const profiles = await fetchAllRows<{
    id: string;
    age_group: string | null;
    gender: string | null;
    perf_modes: string[] | null;
  }>('user_profiles の取得', () =>
    supabaseAdmin.from('user_profiles').select('id, age_group, gender, perf_modes'),
  );

  if (profiles.length === 0) return userMetricsMap;

  // バルク事前取得（N+1 回避: ユーザー数×メトリクス数のクエリ → 固定 5 クエリ）
  const bulk = await fetchBulkData(periodStart, periodEnd);

  const previousPeriodStart = getPreviousPeriodStart(periodType, periodStart);
  const prevMetricsByUser = new Map<string, Map<string, number>>();
  if (previousPeriodStart) {
    const prevRows = await fetchAllRows<{ user_id: string; metric_id: string; value: number }>(
      'user_metrics (前期間) の取得',
      () =>
        supabaseAdmin
          .from('user_metrics')
          .select('user_id, metric_id, value')
          .eq('period_type', periodType)
          .eq('period_start', previousPeriodStart),
    );
    for (const row of prevRows) {
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

    const changeRates = new Map<string, number>();
    userMetricsMap.set(userId, { userId, profile, metrics, previousMetrics, changeRates });

    for (const metricDef of metricDefs) {
      const value = metrics.get(metricDef.code);
      if (value === undefined) continue;
      const previousValue = previousMetrics.get(metricDef.code);
      const changeRate = previousValue && previousValue > 0
        ? Math.round(((value - previousValue) / previousValue) * 100)
        : null;
      // 改善バッジの判定 (awardSegmentBadges) が、user_metrics を引き直さずに済むよう覚えておく
      if (changeRate !== null) changeRates.set(metricDef.code, changeRate);
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
  for (const chunk of chunkArray(upsertRows, UPSERT_CHUNK)) {
    const { error } = await supabaseAdmin
      .from('user_metrics')
      .upsert(chunk, { onConflict: 'user_id,metric_id,period_type,period_start' });
    throwIfError('user_metrics の保存', error);
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

    const { error } = await supabaseAdmin
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
    throwIfError(`segment_stats の保存 (${segment.code} / ${metricDef.code})`, error);
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
      const higherIsBetter = isHigherBetter(metricDef);
      const usersWithValues = segmentUsers
        .filter(u => u.metrics.has(metricDef.code))
        .map(u => ({
          userId: u.userId,
          value: u.metrics.get(metricDef.code)!,
        }))
        .sort((a, b) => higherIsBetter ? b.value - a.value : a.value - b.value);

      const totalUsers = usersWithValues.length;
      if (totalUsers === 0) continue;

      // セグメントの統計を取得
      const { data: stats, error: statsError } = await supabaseAdmin
        .from('segment_stats')
        .select('avg_value')
        .eq('segment_id', segment.id)
        .eq('metric_id', metricDef.id)
        .eq('period_type', periodType)
        .eq('period_start', periodStart)
        .maybeSingle();
      throwIfError(`segment_stats の取得 (${segment.code} / ${metricDef.code})`, statsError);

      const avgValue = stats?.avg_value ?? 0;

      // 各ユーザーのランキングを作る
      //   - 順位は競技方式: 同じ値の利用者は同じ順位にし、次の順位は同順位の人数ぶん飛ばす (1, 1, 1, 4, 4)。
      //     並びだけで決めると、同じ値でも user_profiles の取得順 (順序指定なし) の先頭だけが 1 位になり、
      //     順位バッジが取得順で付く・付かないが変わってしまう
      //   - 百分位は「自分より厳密に下の利用者の割合」。同じ値の利用者は、同点の最後の順位で数える
      //     (同率 1 位の 30 人 / 100 人が、百分位 99 = 上位 1% になってしまうと、「上位 X%」のバッジが人数の割に付きすぎる)
      //   - 平均が 0 以下のときは、平均との差の割合が決まらない (0 で割れない)ので、0 ではなく null で保存する。
      //     0 で保存すると「平均ちょうど」と見分けがつかず、バッジの判定が平均超えとして扱ってしまう
      const rankingRows: Record<string, unknown>[] = [];
      let start = 0;
      while (start < totalUsers) {
        // 同じ値が続く範囲 [start, end]
        let end = start;
        while (end + 1 < totalUsers && usersWithValues[end + 1].value === usersWithValues[start].value) end++;

        const rank = start + 1;
        const percentile = Math.round(((totalUsers - (end + 1)) / totalUsers) * 100);
        for (let i = start; i <= end; i++) {
          const user = usersWithValues[i];
          const vsAvgRate = avgValue > 0
            ? Math.round(((user.value - avgValue) / avgValue) * 100)
            : null;

          rankingRows.push({
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
          });
        }
        start = end + 1;
      }

      // 1 行ずつ upsert すると、利用者の数だけ往復する。まとめて保存する (user_metrics と同じチャンク分割)
      for (const chunk of chunkArray(rankingRows, UPSERT_CHUNK)) {
        const { error } = await supabaseAdmin
          .from('user_segment_rankings')
          .upsert(chunk, {
            onConflict: 'user_id,segment_id,metric_id,period_type,period_start',
          });
        throwIfError(`user_segment_rankings の保存 (${segment.code} / ${metricDef.code})`, error);
      }
    }
  }
}

// =====================================================
// バッジ付与
// =====================================================
//
// user_badges は (user_id, badge_id) が主キーで、upsert は ignoreDuplicates (すでに持っていれば何もしない)。
// つまり、一度付いたバッジは後から条件を満たし直しても記録が置き換わらず、誤って付けると消えない。
// そのため判定は「付けすぎない」側に寄せる (下の isComparableGroup / judgeBadge)。

/**
 * 順位・百分位・平均比のバッジを付けてよい (利用者どうしを比べる意味がある) セグメント×指標か。
 *   - 全員が同じ値 (最大 = 最小): 順位に差が無い。同点を取得順で並べただけの「1 位」にバッジが付いてしまう
 *   - higher_is_better の指標で最大値が 0 以下: 誰も実績が無い (全員 0 を含む)。記録が無い指標の「1 位」「平均超え」になる
 */
function isComparableGroup(range: { min: number; max: number } | undefined, higherIsBetter: boolean): boolean {
  if (!range) return false;
  if (range.max <= range.min) return false;
  if (higherIsBetter && range.max <= 0) return false;
  return true;
}

interface BadgeJudgement {
  higherIsBetter: boolean;
  /** isComparableGroup の結果 (そのセグメント×指標が、比べる意味のある分布か) */
  comparable: boolean;
  /** 前の期間からの変化率 (%)。前の期間の値が無ければ null */
  changeRate: number | null;
}

/** 1 件のランキングがバッジの条件を満たすなら、利用者に見せるメッセージを返す。満たさなければ null */
function judgeBadge(badge: any, ranking: any, judgement: BadgeJudgement): string | null {
  const condition = badge.condition_json;
  const segmentName = ranking.segment_definitions?.name ?? 'セグメント';
  const metricName = ranking.metric_definitions?.name ?? 'メトリクス';
  const { higherIsBetter, comparable, changeRate } = judgement;

  // 高い方が良い指標で値が 0 以下の利用者は、順位が付いていても実績が無い (記録していない人どうしは同順位に入る)。
  // 順位・百分位のバッジは付けない
  const value = toNumber(ranking.value);
  const hasResult = !higherIsBetter || (value !== null && value > 0);

  switch (condition.type) {
    case 'segment_rank':
      if (comparable && hasResult && ranking.rank <= condition.rank) {
        return `${badge.icon} ${segmentName}の${metricName}で${ranking.rank}位！`;
      }
      return null;

    case 'segment_percentile':
      if (comparable && hasResult && ranking.percentile >= condition.threshold) {
        return `${badge.icon} ${segmentName}の${metricName}で上位${100 - condition.threshold}%！`;
      }
      return null;

    case 'segment_vs_avg': {
      // 平均が 0 以下のときは vs_avg_rate が null (平均比は決まらない)。JS では null >= 0 が true になるので、
      // 数値として比べる前に外す
      const vsAvgRate = toNumber(ranking.vs_avg_rate);
      if (!comparable || vsAvgRate === null) return null;
      // 低い方が良い指標では、平均より低いほど良い。向きをそろえた「平均を上回った割合」で比べる
      const rate = higherIsBetter ? vsAvgRate : -vsAvgRate;
      // threshold 0 の「平均超え」は、平均ちょうど (0%) を含めない (アプリ側 determinePrize の vs_avg_rate > 0 と同じ)。
      // 平均+20% / +50% は、バッジの説明が「20%以上」なので、その値ちょうどを含める
      const reached = condition.threshold > 0 ? rate >= condition.threshold : rate > condition.threshold;
      if (!reached) return null;
      return condition.threshold === 0
        ? `${badge.icon} ${segmentName}の${metricName}で平均超え！`
        : `${badge.icon} ${segmentName}の${metricName}で平均+${rate}%！`;
    }

    case 'improvement': {
      if (changeRate === null) return null;
      // 低い方が良い指標では、値が下がることが改善
      const improvement = higherIsBetter ? changeRate : -changeRate;
      if (improvement > 0 && improvement >= condition.threshold) {
        return `${badge.icon} ${metricName}が${improvement}%改善！`;
      }
      return null;
    }

    default:
      return null;
  }
}

async function awardSegmentBadges(
  periodType: string,
  periodStart: string,
  userMetricsMap: Map<string, UserMetrics>
): Promise<void> {
  // セグメント比較系のバッジを取得
  // condition_json の type は文字列として比べる。`->` は jsonb を返すため、`eq.segment_rank` が
  // json として解釈されて 22P02 (invalid input syntax for type json) になる。`->>` (text) を使う。
  const { data: badges, error: badgesError } = await supabaseAdmin
    .from('badges')
    .select('*')
    .or('condition_json->>type.eq.segment_rank,condition_json->>type.eq.segment_percentile,condition_json->>type.eq.segment_vs_avg,condition_json->>type.eq.improvement');
  throwIfError('badges の取得', badgesError);

  if (!badges || badges.length === 0) return;

  // ランキングデータを取得
  const rankings = await fetchAllRows<any>('user_segment_rankings の取得', () =>
    supabaseAdmin
      .from('user_segment_rankings')
      .select(`
        *,
        segment_definitions(code, name),
        metric_definitions(code, name, higher_is_better)
      `)
      .eq('period_type', periodType)
      .eq('period_start', periodStart),
  );

  if (rankings.length === 0) return;

  // セグメント×指標ごとに、利用者の値の最小・最大を求める (全員が同じ値か・誰かが 0 を超えているかの判定に使う)
  const valueRanges = new Map<string, { min: number; max: number }>();
  for (const ranking of rankings) {
    const value = toNumber(ranking.value);
    if (value === null) continue;
    const key = `${ranking.segment_id}:${ranking.metric_id}`;
    const range = valueRanges.get(key);
    if (!range) {
      valueRanges.set(key, { min: value, max: value });
    } else {
      range.min = Math.min(range.min, value);
      range.max = Math.max(range.max, value);
    }
  }

  // 各ランキングに対してバッジ条件をチェックする。
  // (user_id, badge_id) ごとに、最初に条件を満たした 1 件だけを残す。user_badges の主キーと ignoreDuplicates により、
  // 1 件ずつ upsert しても 2 件目以降は捨てられるだけなので、結果は同じ。まとめて送って往復を減らす
  const awards = new Map<string, Record<string, unknown>>();
  const obtainedAt = new Date().toISOString();

  for (const ranking of rankings) {
    const metric = ranking.metric_definitions as { code?: string; higher_is_better?: boolean | null } | null;
    const higherIsBetter = isHigherBetter(metric);
    const judgement: BadgeJudgement = {
      higherIsBetter,
      comparable: isComparableGroup(valueRanges.get(`${ranking.segment_id}:${ranking.metric_id}`), higherIsBetter),
      // 改善率は calculateAllUserMetrics で計算済み。user_metrics を 1 件ずつ引き直さない
      changeRate: (metric?.code ? userMetricsMap.get(ranking.user_id)?.changeRates.get(metric.code) : undefined) ?? null,
    };

    for (const badge of badges) {
      // メトリクス特化バッジの場合、メトリクスコードをチェック
      if (badge.metric_code && badge.metric_code !== metric?.code) {
        continue;
      }

      const key = `${ranking.user_id}:${badge.id}`;
      if (awards.has(key)) continue;

      const message = judgeBadge(badge, ranking, judgement);
      if (message === null) continue;

      awards.set(key, {
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
        obtained_at: obtainedAt,
      });
    }
  }

  // バッジを付与（既に存在する場合はスキップ）
  for (const chunk of chunkArray([...awards.values()], UPSERT_CHUNK)) {
    const { error } = await supabaseAdmin
      .from('user_badges')
      .upsert(chunk, {
        onConflict: 'user_id,badge_id',
        ignoreDuplicates: true,
      });
    throwIfError('user_badges の保存', error);
  }
  console.log(`Badge candidates: ${awards.size} (already owned badges are kept as is)`);
}
