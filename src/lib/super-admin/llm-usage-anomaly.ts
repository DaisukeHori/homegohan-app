/**
 * 運営の LLM 使用量 (GET /api/super-admin/llm/usage・画面 /super-admin/llm) の「異常使用」の判定 (#1482)。
 *
 * 異常 = 1 人のユーザーが、JST の 1 日に LLM_USAGE_ANOMALY_DAILY_REQUESTS 回を超えて呼んだ日がある
 * (docs/design/operator/03-ui-spec.md「1 ユーザー 5,000 req/日超 → バナー表示」)。
 * 以前は期間全体の件数で判定していたので、7 日・30 日の表示では、画面の文「1日 5,000 リクエスト超」と食い違っていた。
 * 画面の文もこの定数から作る (判定と文の値がずれないように、何も import しない小さなファイルに置く)。
 * 1 日あたりの回数は DB の関数 llm_usage_summary (supabase/migrations/20261011110000_llm_usage_summary.sql) が数える (#1498)。
 */

/** 1 人・JST の 1 日あたりのリクエスト数がこれを超えたら異常 (運営の設計書の値) */
export const LLM_USAGE_ANOMALY_DAILY_REQUESTS = 5000;

/**
 * 異常の判定に使う 1 行 (DB の関数 llm_usage_summary が返す anomalous_users の 1 人分。#1498)。
 * 1 日あたりの回数は DB の中で、llm_usage_logs の全行を JST の暦日ごとに数えたもの
 * (以前は route が読んだ行で数えていたが、行は PostgREST の max_rows (既定 1,000) で打ち切られ、1 人の 1 日分すら読み切れなかった)
 */
export interface LlmUsageAnomalyRow {
  /** NULL は user_id の無い行をまとめたもの */
  user_id: string | null;
  /** JST の暦日の 1 日あたりのリクエスト数のうち、いちばん多い日の回数 */
  max_daily_requests: number;
}

/** user_id が null の行をまとめるキー (ユーザー別の集計と同じ) */
export const LLM_USAGE_UNKNOWN_USER = 'unknown';

/**
 * JST の 1 日のリクエスト数が LLM_USAGE_ANOMALY_DAILY_REQUESTS を超えた日があるユーザーの ID の集まり。
 * rows は DB の関数 llm_usage_summary の anomalous_users (route はしきい値に同じ定数を渡すので、ふつうは全員が当たる。
 * ここでもう一度同じ定数で判定し、判定の値をこのファイルの 1 か所に置く)。
 * 期間全体の件数では判定しない (7 日・30 日の表示で、1 日あたりは少ないユーザーを異常にしない)。
 * ちょうど LLM_USAGE_ANOMALY_DAILY_REQUESTS 回の日は異常にしない
 */
export function findLlmUsageAnomalousUsers(rows: Iterable<LlmUsageAnomalyRow>): Set<string> {
  const anomalous = new Set<string>();
  for (const row of rows) {
    if (row.max_daily_requests > LLM_USAGE_ANOMALY_DAILY_REQUESTS) {
      anomalous.add(row.user_id ?? LLM_USAGE_UNKNOWN_USER);
    }
  }
  return anomalous;
}

/** 画面のバナーの文 */
export const LLM_USAGE_ANOMALY_NOTICE = `1日 ${LLM_USAGE_ANOMALY_DAILY_REQUESTS.toLocaleString('ja-JP')} リクエスト超のユーザーがいます`;
