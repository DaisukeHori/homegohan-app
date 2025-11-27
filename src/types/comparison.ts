// セグメント比較機能の型定義

export interface MetricDefinition {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  unit: string | null;
  higher_is_better: boolean;
}

export interface SegmentDefinition {
  id: string;
  code: string;
  name: string;
  axes: Record<string, string>;
  level: number;
}

export interface SegmentStats {
  id: string;
  segment_id: string;
  metric_id: string;
  period_type: string;
  period_start: string;
  period_end: string;
  user_count: number;
  avg_value: number | null;
  median_value: number | null;
  min_value: number | null;
  max_value: number | null;
  p10_value: number | null;
  p25_value: number | null;
  p75_value: number | null;
  p90_value: number | null;
}

export interface UserMetric {
  id: string;
  user_id: string;
  metric_id: string;
  period_type: string;
  period_start: string;
  period_end: string;
  value: number;
  previous_value: number | null;
  change_rate: number | null;
}

export interface UserSegmentRanking {
  id: string;
  user_id: string;
  segment_id: string;
  metric_id: string;
  period_type: string;
  period_start: string;
  rank: number;
  total_users: number;
  percentile: number;
  value: number;
  vs_avg_rate: number | null;
  segment_definitions?: SegmentDefinition;
  metric_definitions?: MetricDefinition;
}

export interface RankingWithDetails extends UserSegmentRanking {
  segment: SegmentDefinition;
  metric: MetricDefinition;
  stats: SegmentStats | null;
}

export interface ComparisonPrize {
  code: string;
  name: string;
  icon: string;
  category: string;
  message: string;
}

export interface MetricRankingSummary {
  metric: MetricDefinition;
  segments: {
    segment: SegmentDefinition;
    rank: number;
    totalUsers: number;
    percentile: number;
    value: number;
    avgValue: number | null;
    vsAvgRate: number | null;
    prize: ComparisonPrize | null;
  }[];
}

export interface ComparisonHighlight {
  type: 'top_prize' | 'improvement' | 'streak' | 'above_avg';
  message: string;
  metric: string;
  icon: string;
}

export interface ComparisonResponse {
  rankings: MetricRankingSummary[];
  highlights: ComparisonHighlight[];
  userMetrics: UserMetric[];
  periodType: string;
  periodStart: string;
  periodEnd: string;
}

