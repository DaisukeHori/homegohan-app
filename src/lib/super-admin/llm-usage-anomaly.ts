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

/** 集計の行のうち、異常の判定に使う列 (llm_usage_logs の user_id / created_at) */
export interface LlmUsageAnomalyRow {
  user_id: string | null;
  created_at: string | null;
}

/** user_id が null の行をまとめるキー (ユーザー別の集計と同じ) */
export const LLM_USAGE_UNKNOWN_USER = 'unknown';

/**
 * 1 日 (dayOf が返す暦日。ルートは JST の暦日 jstDayOfTimestamp を渡す) のリクエスト数が
 * LLM_USAGE_ANOMALY_DAILY_REQUESTS を超えた日があるユーザーの ID の集まり。
 * 期間全体の件数では判定しない (7 日・30 日の表示で、1 日あたりは少ないユーザーを異常にしない)。
 * created_at が null の行は、どの日にも数えない
 */
export function findLlmUsageAnomalousUsers(
  rows: Iterable<LlmUsageAnomalyRow>,
  dayOf: (createdAt: string) => string,
): Set<string> {
  const dailyRequests = new Map<string, Map<string, number>>();
  const anomalous = new Set<string>();
  for (const row of rows) {
    if (!row.created_at) continue;
    const userId = row.user_id ?? LLM_USAGE_UNKNOWN_USER;
    const byDay = dailyRequests.get(userId) ?? new Map<string, number>();
    dailyRequests.set(userId, byDay);
    const day = dayOf(row.created_at);
    const count = (byDay.get(day) ?? 0) + 1;
    byDay.set(day, count);
    if (count > LLM_USAGE_ANOMALY_DAILY_REQUESTS) anomalous.add(userId);
  }
  return anomalous;
}

/** 画面のバナーの文 */
export const LLM_USAGE_ANOMALY_NOTICE = `1日 ${LLM_USAGE_ANOMALY_DAILY_REQUESTS.toLocaleString('ja-JP')} リクエスト超のユーザーがいます`;
