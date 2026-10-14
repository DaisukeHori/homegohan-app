/**
 * #1217 修正前の NPS / CSAT 集計 (GET /api/admin/finance/nps の route.ts が全行を JS で数えていた処理) を、
 * そのまま写したもの。テストの「正解」として使う (新しい実装は DB の関数で数え、丸めだけを TS で行う)。
 *
 * 式を変えないこと。修正前と修正後で画面に出る数字が同じであることの基準になる。
 *   - 単体テスト: tests/admin-finance-nps-route.test.ts
 *   - 結合テスト: tests/integration/rls/csat-nps-summary-rpc.test.ts / tests/integration/security/admin-finance-nps-route.test.ts
 */

export interface LegacyNpsSummary {
  total_responses: number;
  promoters: number;
  passives: number;
  detractors: number;
  nps_score: number;
  avg_score: number;
  response_rate: number;
}

export interface LegacyCsatSummary {
  total_responses: number;
  avg_score: number;
  score_distribution: Record<string, number>;
}

/**
 * NPS。responses は「回答済み (responded_at あり) で、期間・プランに合う行」の全部、sentCount は
 * 「期間・プランに合う行」の件数 (未回答を含む)。
 */
export function legacyNpsSummary(responses: ReadonlyArray<{ score: number }>, sentCount: number): LegacyNpsSummary {
  const total = responses.length;
  const promoters = responses.filter((r) => r.score >= 9).length;
  const passives = responses.filter((r) => r.score >= 7 && r.score <= 8).length;
  const detractors = responses.filter((r) => r.score <= 6).length;
  const npsScore = total > 0
    ? Math.round(((promoters - detractors) / total) * 100 * 10) / 10
    : 0;
  const avgScore = total > 0
    ? Math.round(responses.reduce((s, r) => s + r.score, 0) / total * 10) / 10
    : 0;

  const responseRate = (sentCount ?? 0) > 0
    ? Math.round((total / (sentCount ?? 1)) * 100 * 10) / 10
    : 0;

  return {
    total_responses: total,
    promoters,
    passives,
    detractors,
    nps_score: npsScore,
    avg_score: avgScore,
    response_rate: responseRate,
  };
}

/** CSAT。rows は「期間に合う行」の全部 */
export function legacyCsatSummary(rows: ReadonlyArray<{ score: number }>): LegacyCsatSummary {
  const csatTotal = rows.length;
  const csatAvg = csatTotal > 0
    ? Math.round(rows.reduce((s, r) => s + r.score, 0) / csatTotal * 10) / 10
    : 0;
  const csatDist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const r of rows) {
    csatDist[String(r.score)] = (csatDist[String(r.score)] ?? 0) + 1;
  }
  return { total_responses: csatTotal, avg_score: csatAvg, score_distribution: csatDist };
}
