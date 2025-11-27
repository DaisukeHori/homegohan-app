import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { 
  MetricRankingSummary, 
  ComparisonHighlight, 
  ComparisonResponse,
  ComparisonPrize 
} from '@/types/comparison';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const periodType = searchParams.get('periodType') || 'weekly';

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 期間を計算
    const { periodStart, periodEnd } = calculatePeriod(periodType);

    // 1. ユーザーのランキングを取得
    const { data: rankings, error: rankingsError } = await supabase
      .from('user_segment_rankings')
      .select(`
        *,
        segment_definitions(id, code, name, axes, level),
        metric_definitions(id, code, name, description, category, unit, higher_is_better)
      `)
      .eq('user_id', user.id)
      .eq('period_type', periodType)
      .eq('period_start', periodStart);

    if (rankingsError) {
      console.error('Rankings error:', rankingsError);
    }

    // 2. セグメント統計を取得
    const { data: segmentStats } = await supabase
      .from('segment_stats')
      .select('*')
      .eq('period_type', periodType)
      .eq('period_start', periodStart);

    // 3. ユーザーのメトリクスを取得
    const { data: userMetrics } = await supabase
      .from('user_metrics')
      .select('*')
      .eq('user_id', user.id)
      .eq('period_type', periodType)
      .eq('period_start', periodStart);

    // 4. ユーザーのバッジを取得（セグメント比較系）
    const { data: userBadges } = await supabase
      .from('user_badges')
      .select(`
        *,
        badges(code, name, icon, condition_json)
      `)
      .eq('user_id', user.id)
      .not('context_json', 'is', null);

    // 5. ランキングをメトリクスごとにグループ化
    const rankingsByMetric = new Map<string, MetricRankingSummary>();

    for (const ranking of rankings || []) {
      const metric = ranking.metric_definitions as any;
      const segment = ranking.segment_definitions as any;
      
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
    console.error('Comparison API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

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
    default:
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
      periodEnd = now;
  }

  return {
    periodStart: periodStart.toISOString().split('T')[0],
    periodEnd: periodEnd.toISOString().split('T')[0],
  };
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

