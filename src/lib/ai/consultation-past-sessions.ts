/**
 * 閉じた AI 相談の要約の引き継ぎ (pastSessionSummaries) の形 (#2283 W1)。
 *
 * 問題:
 *   新しい相談の作成 (src/app/api/ai/consultation/sessions/route.ts の POST) は、閉じた相談の context_snapshot をまるごと
 *   読んで、新しい相談の context_snapshot.pastSessionSummaries に入れていた。閉じる route
 *   (src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts) はその snapshot を展開して保存し直すので、
 *   前の相談の snapshot (さらに前の相談の snapshot を含む) が入れ子で入り、大きさがおよそ倍々に増える経路があった。
 *   読む側 (会話の続きの POST のプロンプト) が使うのは、閉じた相談の snapshot のうち key_facts と user_insights だけ。
 *
 * 決まり:
 *   - 閉じた相談の要約は、PAST_SESSION_SUMMARY_COLUMNS の列だけを読む。snapshot からは key_facts と user_insights だけを
 *     JSON の path で読む (snapshot の丸ごとを読まない)
 *   - pastSessionSummaries の 1 件は PastSessionSummary の形 (要約の列と key_facts・user_insights だけ)。snapshot も
 *     pastSessionSummaries も持たないので、入れ子の深さは 1 を超えない
 *   - 閉じる route が snapshot を保存し直すときは compactContextSnapshot を通す。修正前に作った相談の
 *     pastSessionSummaries (前の相談の snapshot を丸ごと持つ) も、ここで小さな形に詰め直す
 */
import type { Json } from '@/types/database.types';

/**
 * 閉じた相談の要約を読むときの列 (作成の POST と、会話の続きの POST の両方)。
 * key_facts・user_insights は context_snapshot の中の値だけを JSON の path で読む (PostgREST の `別名:列->キー`)
 */
export const PAST_SESSION_SUMMARY_COLUMNS =
  'id, title, summary, key_topics, summary_generated_at, key_facts:context_snapshot->key_facts, user_insights:context_snapshot->user_insights';

/** context_snapshot の中の、閉じた相談の要約の一覧のキー */
export const PAST_SESSION_SUMMARIES_KEY = 'pastSessionSummaries';

/** pastSessionSummaries の 1 件 (閉じた相談の要約。snapshot は持たない) */
export type PastSessionSummary = {
  id: string | null;
  title: string | null;
  summary: string | null;
  key_topics: Json[];
  summary_generated_at: string | null;
  key_facts: Json[];
  user_insights: Json[];
};

type JsonObject = { [key: string]: Json | undefined };

function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonArray(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 閉じた相談の要約の 1 行 (PAST_SESSION_SUMMARY_COLUMNS で読んだ行) を PastSessionSummary にする。
 * 修正前の形 (key_facts・user_insights を context_snapshot の中に持つ。pastSessionSummaries の古い 1 件) も読める。
 * 配列でない key_facts・user_insights・key_topics は空の配列にする
 */
export function toPastSessionSummary(row: Json | undefined): PastSessionSummary {
  const source: JsonObject = isJsonObject(row) ? row : {};
  const snapshot = source.context_snapshot;
  const nested: JsonObject = isJsonObject(snapshot) ? snapshot : {};
  return {
    id: stringOrNull(source.id),
    title: stringOrNull(source.title),
    summary: stringOrNull(source.summary),
    key_topics: jsonArray(source.key_topics),
    summary_generated_at: stringOrNull(source.summary_generated_at),
    key_facts: jsonArray(source.key_facts ?? nested.key_facts),
    user_insights: jsonArray(source.user_insights ?? nested.user_insights),
  };
}

/**
 * 閉じる route が保存し直す context_snapshot の土台。pastSessionSummaries があれば小さな形に詰め直す
 * (修正前に作った相談の、前の相談の snapshot を丸ごと持つ一覧を、保存し直すときに落とす)。オブジェクトでなければ空にする
 */
export function compactContextSnapshot(snapshot: Json | undefined): JsonObject {
  if (!isJsonObject(snapshot)) return {};
  if (!(PAST_SESSION_SUMMARIES_KEY in snapshot)) return { ...snapshot };
  return { ...snapshot, [PAST_SESSION_SUMMARIES_KEY]: jsonArray(snapshot[PAST_SESSION_SUMMARIES_KEY]).map((entry) => toPastSessionSummary(entry)) };
}
