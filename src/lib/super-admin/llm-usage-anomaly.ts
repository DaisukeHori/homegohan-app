/**
 * 運営の LLM 使用量 (GET /api/super-admin/llm/usage・画面 /super-admin/llm) の「異常使用」の判定 (#1482)。
 *
 * 異常 = 1 人のユーザーが、JST の 1 日に LLM_USAGE_ANOMALY_DAILY_REQUESTS 回を超えて呼んだ日がある
 * (docs/design/operator/03-ui-spec.md「1 ユーザー 5,000 req/日超 → バナー表示」)。
 * 以前は期間全体の件数で判定していたので、7 日・30 日の表示では、画面の文「1日 5,000 リクエスト超」と食い違っていた。
 * 画面の文もこの定数から作る (判定と文の値がずれないように、何も import しない小さなファイルに置く)。
 */

/** 1 人・JST の 1 日あたりのリクエスト数がこれを超えたら異常 (運営の設計書の値) */
export const LLM_USAGE_ANOMALY_DAILY_REQUESTS = 5000;

/** 1 日のリクエスト数 dailyRequests が異常の基準を超えるか */
export function exceedsLlmUsageAnomalyDailyRequests(dailyRequests: number): boolean {
  return dailyRequests > LLM_USAGE_ANOMALY_DAILY_REQUESTS;
}

/** 画面のバナーの文 */
export const LLM_USAGE_ANOMALY_NOTICE = `1日 ${LLM_USAGE_ANOMALY_DAILY_REQUESTS.toLocaleString('ja-JP')} リクエスト超のユーザーがいます`;
