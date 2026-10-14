/**
 * NPS / CSAT 集計の組み立て (GET /api/admin/finance/nps)。#1217
 *
 * 件数・合計は DB の関数 (get_nps_summary / get_csat_summary。
 * supabase/migrations/20261008120100_csat_nps_summary_rpc.sql) が数える。以前は route.ts が
 * nps_surveys / csat_feedbacks の該当行を全部読み込み、JavaScript で数えていた。
 * ここでは次のことだけを行う。
 *   - 関数の戻り値 (整数の 1 行) を検証する。形が違うときは例外にする (欠けた数字を 0 として画面に出さない)。
 *   - 平均・NPS スコア・回答率を小数第 1 位に丸める。式は以前の route.ts と同じ
 *     (整数どうしの割り算 → Math.round(x * 10) / 10)。関数が返すのは整数だけなので、画面に出る数字は変わらない。
 *   - 直近の一覧 (最大 RECENT_LIMIT 件) と合わせて、画面が使うレスポンス (NpsSummary / CsatSummary) の形にする。
 */
import { z } from 'zod';
import type { CsatSummary, NpsSummary } from '@/lib/admin/finance-schemas';

/** 「最近のコメント / フィードバック」に出す最大件数 (レスポンスの recent_comments / recent_feedbacks) */
export const RECENT_LIMIT = 10;

/** 件数・合計。bigint は PostgREST から JSON の数値で返る。null・欠け・負数・小数・文字列は不正として弾く */
const Count = z.number().int().nonnegative();

/** get_nps_summary の戻り値 1 行 */
export const NpsSummaryRowSchema = z.object({
  /** 送信数 (未回答を含む) */
  sent_count: Count,
  /** 回答数 (responded_at あり) */
  total_responses: Count,
  /** 推奨者 (9-10) */
  promoters: Count,
  /** 中立 (7-8) */
  passives: Count,
  /** 批判者 (0-6) */
  detractors: Count,
  /** 回答のスコア合計 (平均の計算用) */
  score_sum: Count,
});

export type NpsSummaryRow = z.infer<typeof NpsSummaryRowSchema>;

/** get_csat_summary の戻り値 1 行 */
export const CsatSummaryRowSchema = z.object({
  /** 回答数 */
  total_responses: Count,
  /** スコア合計 (平均の計算用) */
  score_sum: Count,
  score_1_count: Count,
  score_2_count: Count,
  score_3_count: Count,
  score_4_count: Count,
  score_5_count: Count,
});

export type CsatSummaryRow = z.infer<typeof CsatSummaryRowSchema>;

/** PostgREST の関数呼び出しの戻り値 (TABLE を返す関数は 1 行の配列) から 1 行目を取り出す */
export function firstRpcRow(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

/** 直近の NPS 回答 1 件 (nps_surveys から取った列) */
export interface NpsRecentRow {
  id: string;
  score: number;
  comment: string | null;
  plan_key: string | null;
  responded_at: string | null;
}

/** 直近の CSAT フィードバック 1 件 (csat_feedbacks から取った列) */
export interface CsatRecentRow {
  id: string;
  score: number;
  comment: string | null;
  ticket_id: string | null;
  created_at: string;
}

/** 小数第 1 位に丸める (以前の route.ts と同じ式。Math.round は .5 を +∞ 方向へ丸める) */
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** NPS の集計結果 (レスポンスの data.nps) */
export function buildNpsSummary(row: NpsSummaryRow, recent: ReadonlyArray<NpsRecentRow>): NpsSummary {
  const total = row.total_responses;
  return {
    total_responses: total,
    promoters: row.promoters,
    passives: row.passives,
    detractors: row.detractors,
    nps_score: total > 0 ? round1(((row.promoters - row.detractors) / total) * 100) : 0,
    avg_score: total > 0 ? round1(row.score_sum / total) : 0,
    response_rate: row.sent_count > 0 ? round1((total / row.sent_count) * 100) : 0,
    recent_comments: recent.slice(0, RECENT_LIMIT).map((r) => ({
      id: r.id,
      score: r.score,
      comment: r.comment,
      plan_key: r.plan_key,
      responded_at: r.responded_at,
    })),
  };
}

/** CSAT の集計結果 (レスポンスの data.csat) */
export function buildCsatSummary(row: CsatSummaryRow, recent: ReadonlyArray<CsatRecentRow>): CsatSummary {
  const total = row.total_responses;
  return {
    total_responses: total,
    avg_score: total > 0 ? round1(row.score_sum / total) : 0,
    score_distribution: {
      '1': row.score_1_count,
      '2': row.score_2_count,
      '3': row.score_3_count,
      '4': row.score_4_count,
      '5': row.score_5_count,
    },
    recent_feedbacks: recent.slice(0, RECENT_LIMIT).map((r) => ({
      id: r.id,
      score: r.score,
      comment: r.comment,
      ticket_id: r.ticket_id,
      created_at: r.created_at,
    })),
  };
}
