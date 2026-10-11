// #1432: 健康インサイト (POST /api/health/insights) が health_insights に保存する行の組み立て。
//
// 以前のルートは、health_insights に無い `content` 列と、数値の `priority` (列は text で、CHECK は
// low / medium / high / critical) を入れ、NOT NULL で既定値の無い analysis_date / period_start / period_end /
// period_type / summary を入れていなかった。insert は必ず失敗し、画面の「AIインサイトを生成」は常に 500 になっていた。
//
// 列の形:
//   - analysis_date / period_start / period_end は JST の暦日 (YYYY-MM-DD)。#1407 で日付を JST にそろえたのと同じ考え方
//   - 期間は「JST の今日を終了日に、そこから N 日さかのぼった日を開始日」とする
//   - 本文は summary、優先度は low / medium / high / critical の文字列、おすすめは recommendations (text[])
// 暦日は Web 側の JST の関数 (packages/shared の formatLocalDate) で求め、境界 (JST 0:00〜8:59・年末・うるう日) を
// tests/health-insight-rows.test.ts で確かめる。
// 以前は Edge Function generate-health-insights も同じ形の行を組み立てていたが、どこからも呼ばれていなかったので
// #1440 で削除した。健康インサイトを書き込むのはこのファイルを使う POST /api/health/insights だけ。
//
// 行の型は src/types/database.types.ts の health_insights の Insert 型にしている。存在しない列を書いたり、
// NOT NULL の列を書き忘れたりすると、型検査 (npm run typecheck) で止まる。

import { formatLocalDate } from '@/lib/date-utils';
import type { TablesInsert } from '@/types/database.types';

export type HealthInsightInsert = TablesInsert<'health_insights'>;

/** JST の暦日を求めるタイムゾーン */
const JST_TIME_ZONE = 'Asia/Tokyo';

/**
 * 分析する期間の、終了日 (JST の今日) から開始日までさかのぼる日数。期間は開始日と終了日の両方を含む。
 * 30 日 (period_type は monthly)。
 */
export const HEALTH_INSIGHT_LOOKBACK_DAYS = 30;

/** 上の期間 (30 日さかのぼる) を表す period_type */
export const HEALTH_INSIGHT_PERIOD_TYPE = 'monthly';

/** LLM に作らせる insight_type。これ以外が返ってきたら FALLBACK_INSIGHT_TYPE にする */
export const GENERATED_INSIGHT_TYPES = ['nutrition', 'activity', 'sleep', 'checkup', 'trend', 'goal'] as const;
export type GeneratedInsightType = (typeof GENERATED_INSIGHT_TYPES)[number];
const FALLBACK_INSIGHT_TYPE: GeneratedInsightType = 'trend';

/** health_insights.priority の CHECK 制約 (health_insights_priority_check) が許す値 */
export const HEALTH_INSIGHT_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type HealthInsightPriority = (typeof HEALTH_INSIGHT_PRIORITIES)[number];
/** LLM が優先度を返さなかった・想定外の値を返したときの値。列の既定値 ('medium') と同じ */
const FALLBACK_PRIORITY: HealthInsightPriority = 'medium';

/** 一覧のタイトルとして読める長さに切る (以前のルートと同じ上限) */
export const MAX_INSIGHT_TITLE_LENGTH = 200;
/** タイトルが空で返ってきたときに使う */
const FALLBACK_TITLE = '健康インサイト';

/** 1 件のインサイトに付ける、おすすめアクションの上限 (LLM には 3 件までと頼む。多すぎる分は捨てる) */
export const MAX_INSIGHT_RECOMMENDATIONS = 5;

/** YYYY-MM-DD の形 (ゼロ埋め) */
const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 暦日 (YYYY-MM-DD) から offsetDays 日ずらした暦日を返す。暦の計算だけを UTC の関数で行うので、
 * 実行環境のタイムゾーンやサマータイムに左右されない (Edge Functions 側の _shared/jst-date.ts の addDaysToDate と同じ考え方)。
 */
function shiftDay(day: string, offsetDays: number): string {
  if (!YMD_PATTERN.test(day)) {
    throw new RangeError(`Invalid date (expected YYYY-MM-DD): ${day}`);
  }
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + offsetDays)).toISOString().slice(0, 10);
}

/**
 * 健康インサイトの分析期間を JST の暦日で返す。終了日は JST の今日、開始日はその HEALTH_INSIGHT_LOOKBACK_DAYS 日前。
 * analysisDate は JST の今日 (= periodEnd)。
 * 例: JST 2026-10-08 05:30 → { analysisDate: "2026-10-08", periodStart: "2026-09-08", periodEnd: "2026-10-08" }
 */
export function calculateHealthInsightPeriod(now: Date = new Date()): {
  analysisDate: string;
  periodStart: string;
  periodEnd: string;
  periodType: string;
} {
  const periodEnd = formatLocalDate(now, JST_TIME_ZONE);
  return {
    analysisDate: periodEnd,
    periodStart: shiftDay(periodEnd, -HEALTH_INSIGHT_LOOKBACK_DAYS),
    periodEnd,
    periodType: HEALTH_INSIGHT_PERIOD_TYPE,
  };
}

/**
 * LLM の応答 (insightSchema) の 1 件。LLM の出力なので、どの値も信用せず unknown として受ける。
 */
export interface GeneratedInsight {
  title?: unknown;
  summary?: unknown;
  insight_type?: unknown;
  is_alert?: unknown;
  priority?: unknown;
  recommendations?: unknown;
}

/** 保存する insight_type の一覧 (GENERATED_INSIGHT_TYPES) にある値か。画面のアイコンの引き当てにも使う (#1440) */
export function isGeneratedInsightType(value: unknown): value is GeneratedInsightType {
  return typeof value === 'string' && (GENERATED_INSIGHT_TYPES as readonly string[]).includes(value);
}

function isPriority(value: unknown): value is HealthInsightPriority {
  return typeof value === 'string' && (HEALTH_INSIGHT_PRIORITIES as readonly string[]).includes(value);
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toRecommendations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(toTrimmedString)
    .filter((item) => item.length > 0)
    .slice(0, MAX_INSIGHT_RECOMMENDATIONS);
}

/**
 * LLM が作ったインサイトを health_insights の行にする。
 * 本文 (summary) が空のものは、画面に何も出せないので保存しない (呼び出し側は 0 件なら「生成できなかった」として扱う)。
 */
export function buildHealthInsightRows(
  userId: string,
  generated: readonly GeneratedInsight[],
  now: Date = new Date(),
): HealthInsightInsert[] {
  const { analysisDate, periodStart, periodEnd, periodType } = calculateHealthInsightPeriod(now);

  const rows: HealthInsightInsert[] = [];
  for (const insight of generated) {
    const summary = toTrimmedString(insight.summary);
    if (summary.length === 0) continue;
    const title = toTrimmedString(insight.title).slice(0, MAX_INSIGHT_TITLE_LENGTH) || FALLBACK_TITLE;
    rows.push({
      user_id: userId,
      analysis_date: analysisDate,
      period_start: periodStart,
      period_end: periodEnd,
      period_type: periodType,
      insight_type: isGeneratedInsightType(insight.insight_type) ? insight.insight_type : FALLBACK_INSIGHT_TYPE,
      title,
      summary,
      recommendations: toRecommendations(insight.recommendations),
      priority: isPriority(insight.priority) ? insight.priority : FALLBACK_PRIORITY,
      is_alert: insight.is_alert === true,
      is_read: false,
      is_dismissed: false,
    });
  }
  return rows;
}
