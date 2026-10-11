import { createClient } from '@/lib/supabase/server';
import { calculatePeriodLocal } from '@/lib/date-utils';
import { NextResponse } from 'next/server';
import type {
  MetricRankingSummary,
  ComparisonHighlight,
  ComparisonResponse,
  ComparisonPrize,
  MetricDefinition,
  SegmentDefinition,
} from '@/types/comparison';
import { internalError } from '@/lib/api/errors';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const periodType = searchParams.get('periodType') || 'weekly';

  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 期間を計算 (JST の暦。集計の Edge Function calculate-segment-stats が保存する period_start と同じ値 #1211)
    const { periodStart, periodEnd } = calculatePeriodLocal(periodType);

    // 1〜4. 互いに独立した 4 クエリを並列に取得する (#1225)
    //   絞り込み条件は冒頭で確定済みの user.id / periodType / periodStart だけで、クエリ同士に依存は無い。
    //   1 つずつ await すると DB 往復 4 回分の待ち時間がそのままレスポンス時間に乗るため、Promise.all で同時に発行する。
    //   (supabase-js のクエリは await されて初めて発行される。Promise.all に渡すことで 4 つ同時に走る)
    const [rankingsResult, segmentStatsResult, userMetricsResult, userBadgesResult] = await Promise.all([
      // 1. ユーザーのランキングを取得
      supabase
        .from('user_segment_rankings')
        .select(`
          *,
          segment_definitions(id, code, name, axes, level),
          metric_definitions(id, code, name, description, category, unit, higher_is_better)
        `)
        .eq('user_id', user.id)
        .eq('period_type', periodType)
        .eq('period_start', periodStart),
      // 2. セグメント統計を取得
      supabase
        .from('segment_stats')
        .select('*')
        .eq('period_type', periodType)
        .eq('period_start', periodStart),
      // 3. ユーザーのメトリクスを取得
      supabase
        .from('user_metrics')
        .select('*')
        .eq('user_id', user.id)
        .eq('period_type', periodType)
        .eq('period_start', periodStart),
      // 4. ユーザーのバッジを取得（セグメント比較系）
      supabase
        .from('user_badges')
        .select(`
          *,
          badges(code, name, icon, condition_json)
        `)
        .eq('user_id', user.id)
        .not('context_json', 'is', null),
    ]);

    // エラー処理は従来どおり: rankings の error だけログに出し、他の 3 つは error を見ずに空扱いにする
    const { data: rankings, error: rankingsError } = rankingsResult;
    const { data: segmentStats } = segmentStatsResult;
    const { data: userMetrics } = userMetricsResult;
    const { data: userBadges } = userBadgesResult;

    if (rankingsError) {
      console.error('Rankings error:', rankingsError);
    }

    // 5. ランキングをメトリクスごとにグループ化
    const rankingsByMetric = new Map<string, MetricRankingSummary>();

    for (const ranking of rankings || []) {
      const metric = ranking.metric_definitions as MetricDefinition | null;
      const segment = ranking.segment_definitions as SegmentDefinition | null;
      
      if (!metric || !segment) continue;

      // セグメント統計を探す
      const stats = segmentStats?.find(
        s => s.segment_id === ranking.segment_id && s.metric_id === ranking.metric_id
      );

      // プライズを判定
      const prize = determinePrize(ranking, userBadges || []);

      if (!rankingsByMetric.has(metric.code)) {
        rankingsByMetric.set(metric.code, {
          metric,
          segments: [],
        });
      }

      rankingsByMetric.get(metric.code)!.segments.push({
        segment,
        rank: ranking.rank,
        totalUsers: ranking.total_users,
        percentile: ranking.percentile,
        value: ranking.value,
        avgValue: stats?.avg_value ?? null,
        vsAvgRate: ranking.vs_avg_rate,
        prize,
      });
    }

    // 6. ハイライトを生成
    const highlights = generateHighlights(rankings || [], userMetrics || [], userBadges || []);

    // 7. レスポンス生成
    const response: ComparisonResponse = {
      rankings: Array.from(rankingsByMetric.values()),
      highlights,
      userMetrics: userMetrics || [],
      periodType,
      periodStart,
      periodEnd,
    };

    return NextResponse.json(response);

  } catch (error: any) {
    return internalError('GET /api/comparison/rankings', error);
  }
}

function determinePrize(ranking: any, userBadges: any[]): ComparisonPrize | null {
  // ランキングに対応するバッジを探す
  const relevantBadge = userBadges.find(ub => {
    const context = ub.context_json;
    if (!context) return false;
    return (
      context.segment_id === ranking.segment_id &&
      context.metric_id === ranking.metric_id
    );
  });

  if (relevantBadge && relevantBadge.badges) {
    return {
      code: relevantBadge.badges.code,
      name: relevantBadge.badges.name,
      icon: relevantBadge.badges.icon || '🏅',
      category: relevantBadge.badges.condition_json?.type || 'achievement',
      message: relevantBadge.message || '',
    };
  }

  // バッジがなくても条件に応じてプライズを表示
  if (ranking.rank === 1) {
    return {
      code: 'rank_1',
      name: '1位',
      icon: '🏆',
      category: 'rank',
      message: `${ranking.segment_definitions?.name || 'セグメント'}で1位！`,
    };
  } else if (ranking.rank <= 3) {
    return {
      code: 'top_3',
      name: 'トップ3',
      icon: '🥉',
      category: 'rank',
      message: `${ranking.segment_definitions?.name || 'セグメント'}でトップ3！`,
    };
  } else if (ranking.percentile >= 90) {
    return {
      code: 'top_10',
      name: '上位10%',
      icon: '🥈',
      category: 'percentile',
      message: `上位${Math.round(100 - ranking.percentile)}%！`,
    };
  } else if (ranking.vs_avg_rate && ranking.vs_avg_rate > 0) {
    return {
      code: 'above_avg',
      name: '平均超え',
      icon: '⭐',
      category: 'achievement',
      message: `平均を${Math.round(ranking.vs_avg_rate)}%上回っています！`,
    };
  }

  return null;
}

function generateHighlights(
  rankings: any[],
  userMetrics: any[],
  userBadges: any[]
): ComparisonHighlight[] {
  const highlights: ComparisonHighlight[] = [];

  // 1位のランキングを探す
  const topRankings = rankings.filter(r => r.rank === 1);
  for (const ranking of topRankings.slice(0, 2)) {
    highlights.push({
      type: 'top_prize',
      message: `🏆 ${ranking.segment_definitions?.name || ''}の${ranking.metric_definitions?.name || ''}で1位！`,
      metric: ranking.metric_definitions?.code || '',
      icon: '🏆',
    });
  }

  // 改善しているメトリクスを探す
  const improvedMetrics = userMetrics.filter(m => m.change_rate && m.change_rate > 10);
  for (const metric of improvedMetrics.slice(0, 2)) {
    highlights.push({
      type: 'improvement',
      message: `📈 前期間より${Math.round(metric.change_rate)}%改善！`,
      metric: metric.metric_id,
      icon: '📈',
    });
  }

  // 平均を大きく上回っているランキングを探す
  const aboveAvgRankings = rankings.filter(r => r.vs_avg_rate && r.vs_avg_rate > 30);
  for (const ranking of aboveAvgRankings.slice(0, 2)) {
    if (highlights.length >= 4) break;
    highlights.push({
      type: 'above_avg',
      message: `⭐ ${ranking.segment_definitions?.name || ''}の平均を${Math.round(ranking.vs_avg_rate)}%上回っています！`,
      metric: ranking.metric_definitions?.code || '',
      icon: '⭐',
    });
  }

  return highlights.slice(0, 4);
}

