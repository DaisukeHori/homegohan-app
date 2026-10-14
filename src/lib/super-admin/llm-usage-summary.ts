/**
 * 運営の LLM 使用量 (GET /api/super-admin/llm/usage) の集計を、DB の関数 llm_usage_summary で行う (#1498)。
 *
 * 以前は route が llm_usage_logs の行を 5,000 行 (MAX_ROWS) まで読んで集計していた。行は PostgREST の max_rows
 * (Supabase の既定 1,000) でも黙って打ち切られるので、
 *   - 異常使用の判定 (1 人・JST の 1 日に 5,000 回超) は、1 人の 1 日分の行すら読み切れず、事実上成り立たなかった
 *   - 期間の合計・モデル別・機能別・ユーザー別・日次の系列も、1,000 行を超える期間では実際より小さく出ていた
 * 関数は集計の結果を 1 つの JSONB で返す (行の集合を返さないので max_rows で打ち切られない)。
 * 関数の定義: supabase/migrations/20261011110000_llm_usage_summary.sql (service_role だけが呼べる)。
 *
 * ここには、関数の名前・引数の値・応答のスキーマ (形が想定と違えば例外にする。黙って 0 件にすると、異常のバナーが静かに消える)、
 * 応答を画面の項目 (以前の route と同じ名前) に直す純粋な関数を置く。
 */
import { z } from 'zod';
import { CalendarDateSchema } from '@/lib/calendar-date-schema';
import {
  findLlmUsageAnomalousUsers,
  LLM_USAGE_ANOMALY_DAILY_REQUESTS,
  LLM_USAGE_UNKNOWN_USER,
} from '@/lib/super-admin/llm-usage-anomaly';

/** DB の関数の名前 */
export const LLM_USAGE_SUMMARY_RPC = 'llm_usage_summary';

/** ユーザー別の表 (top_users) に載せる人数 (以前の route の Top 50 と同じ。画面はこのうち 20 人を表に出す) */
export const LLM_USAGE_TOP_USERS_LIMIT = 50;

/** 円の概算に使う 1 ドルあたりの円 (以前の route の値。画面の「概算」の表示だけに使う) */
export const LLM_USAGE_JPY_PER_USD = 152;

/** 期間の合計のコスト (ドル) を丸める小数の桁数 (以前の route と同じ。セント単位) */
const TOTAL_COST_USD_DECIMALS = 2;
/** ユーザー別のコスト (ドル) を丸める小数の桁数 (以前の route と同じ。1 回の呼び出しの単価が小さいので細かく残す) */
const USER_COST_USD_DECIMALS = 5;

/** 小数 decimals 桁で四捨五入する */
function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/** 回数 (count(*)) は 0 以上の整数 */
const CountSchema = z.number().int().nonnegative();
/** コスト (ドル。estimated_cost_usd の合計。NULL は DB で 0 として足してある) */
const CostSchema = z.number().finite();

/** DB の関数 llm_usage_summary の応答 (JSONB) */
export const LlmUsageSummaryRpcSchema = z.object({
  total_requests: CountSchema,
  total_tokens: CountSchema,
  total_cost_usd: CostSchema,
  by_model: z.array(z.object({ model: z.string(), requests: CountSchema, tokens: CountSchema, cost_usd: CostSchema })),
  by_function: z.array(z.object({ function_name: z.string(), requests: CountSchema, cost_usd: CostSchema })),
  /** user_id が NULL の行は 1 人としてまとめてある */
  top_users: z.array(z.object({ user_id: z.string().nullable(), requests: CountSchema, cost_usd: CostSchema })),
  /** JST の暦日ごと (日付の昇順) */
  timeseries: z.array(z.object({ date: CalendarDateSchema, requests: CountSchema, cost_usd: CostSchema })),
  /** JST の 1 日にしきい値を超えて呼んだ日があるユーザー全員 (top_users に入らない人も含む) */
  anomalous_users: z.array(
    z.object({
      user_id: z.string().nullable(),
      max_daily_requests: CountSchema,
      requests: CountSchema,
      cost_usd: CostSchema,
    }),
  ),
});

export type LlmUsageSummaryRpc = z.infer<typeof LlmUsageSummaryRpcSchema>;

/** DB の関数に渡す絞り込み (route のクエリを検証したもの) */
export interface LlmUsageSummaryFilters {
  /** 開始日の JST 0 時 (ISO 8601) */
  fromTimestamp: string;
  /** 終了日の翌日の JST 0 時 (ISO 8601。この時刻は含まない) */
  toTimestampExclusive: string;
  model?: string;
  functionName?: string;
  provider?: string;
}

/** DB の関数の引数。しきい値と人数は、このファイルと llm-usage-anomaly.ts の定数を渡す (値を SQL と 2 か所に書かない) */
export function llmUsageSummaryRpcArgs(filters: LlmUsageSummaryFilters) {
  return {
    p_from: filters.fromTimestamp,
    p_to_exclusive: filters.toTimestampExclusive,
    p_model: filters.model ?? null,
    p_function_name: filters.functionName ?? null,
    p_provider: filters.provider ?? null,
    p_top_users_limit: LLM_USAGE_TOP_USERS_LIMIT,
    p_anomaly_daily_requests: LLM_USAGE_ANOMALY_DAILY_REQUESTS,
  };
}

/** モデル名からプロバイダーを決める (以前の route と同じ) */
export function llmProviderOfModel(model: string): string {
  if (model.startsWith('grok')) return 'xai';
  if (model.startsWith('gemini') || model.startsWith('imagen')) return 'gemini';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1')) return 'openai';
  return 'unknown';
}

/** ユーザー別の 1 行 (top_users・anomalies) */
export interface LlmUsageUserRow {
  user_id: string;
  email: string | null;
  requests: number;
  cost_usd: number;
  is_anomaly: boolean;
}

/** GET /api/super-admin/llm/usage の data (項目名は以前の route と同じ。画面は cost_usd などの名前を読む) */
export interface LlmUsageResponseData {
  total_cost_usd: number;
  total_cost_jpy: number;
  total_requests: number;
  total_tokens: number;
  by_model: Array<{ model: string; provider: string; requests: number; tokens: number; cost_usd: number }>;
  by_function: Array<{ function: string; requests: number; cost_usd: number }>;
  top_users: LlmUsageUserRow[];
  timeseries: Array<{ date: string; cost_usd: number; requests: number }>;
  anomalies: LlmUsageUserRow[];
  period: { from: string; to: string };
}

/**
 * DB の関数の応答 (検証済み) を画面の項目に直す。
 * anomalies は、異常のユーザー全員 (以前は top_users のうち異常の人だけで、上位 50 人に入らない人は載らなかった)。
 * top_users の is_anomaly も同じ判定 (findLlmUsageAnomalousUsers) で付ける
 */
export function toLlmUsageResponseData(
  summary: LlmUsageSummaryRpc,
  period: { from: string; to: string },
): LlmUsageResponseData {
  const anomalous = findLlmUsageAnomalousUsers(summary.anomalous_users);
  const userRow = (row: { user_id: string | null; requests: number; cost_usd: number }): LlmUsageUserRow => {
    const userId = row.user_id ?? LLM_USAGE_UNKNOWN_USER;
    return {
      user_id: userId,
      email: null, // 別途 join が必要 (パフォーマンス上 omit。以前の route と同じ)
      requests: row.requests,
      cost_usd: roundTo(row.cost_usd, USER_COST_USD_DECIMALS),
      is_anomaly: anomalous.has(userId),
    };
  };

  return {
    total_cost_usd: roundTo(summary.total_cost_usd, TOTAL_COST_USD_DECIMALS),
    total_cost_jpy: Math.round(summary.total_cost_usd * LLM_USAGE_JPY_PER_USD),
    total_requests: summary.total_requests,
    total_tokens: summary.total_tokens,
    by_model: summary.by_model.map((m) => ({
      model: m.model,
      provider: llmProviderOfModel(m.model),
      requests: m.requests,
      tokens: m.tokens,
      cost_usd: m.cost_usd,
    })),
    by_function: summary.by_function.map((f) => ({ function: f.function_name, requests: f.requests, cost_usd: f.cost_usd })),
    top_users: summary.top_users.map(userRow),
    timeseries: summary.timeseries.map((t) => ({ date: t.date, cost_usd: t.cost_usd, requests: t.requests })),
    anomalies: summary.anomalous_users.map(userRow).filter((u) => u.is_anomaly),
    period,
  };
}
