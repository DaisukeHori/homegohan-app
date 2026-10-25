/**
 * 写真の解析 (analyze-meal-photo の mealId の経路) の書き込みの順序の守り (#121 の CAS を戻す。#2025 の続き)
 *
 * 同じ献立に写真の解析を 2 回続けて送ると、背景の処理 (EdgeRuntime.waitUntil) が 2 本並ぶ。以前は書き込みに条件が無く、
 * 後に終わった方が planned_meals を書いた。先に送った古い写真の結果が、後に送った新しい写真の結果を上書きしえた
 * (#160 で入った CAS は、#248 の競合の解消で消えていた)。
 *
 * 守り方 (updated_at を印に使う。process-meal-image-jobs の料理の画像の書き込み (#1527) と同じ楽観的な排他):
 *   1. 印を付ける (claimPhotoAnalysis): 解析を始める前に、行の updated_at を進める (トリガー trg_planned_meals_updated_at が
 *      DB の now() にする)。進めたあとの updated_at が、この解析の印になる。
 *      invokedAt (Next.js の route が Edge を呼ぶ直前の時刻) があるときは、行の updated_at が invokedAt 以前 (または NULL) の
 *      ときだけ印を付ける。呼んだあとに行が書かれていた (後から送った解析が先に印を付けた・ほかの書き込みがあった) なら、
 *      この解析は古いので、解析せずにやめる (Edge に遅れて届いた古い要求が、新しい要求の印を消さない)。
 *   2. 書く前に確かめる (isPhotoAnalysisCurrent): 解析のあと、行の updated_at が印のままかを見る。違えば、Storage への
 *      アップロードと画像のジョブの取り消しをせずにやめる。
 *   3. 書く (analyze-meal-photo/index.ts の update): updated_at が印のままの行にだけ書く (.eq('updated_at', 印))。
 *      0 行なら書かずにやめる (確かめてから書くまでのあいだに書かれた場合も、ここで止まる)。
 *
 * 後から送った解析の印が、先に送った解析の印を消すので、終わる順番によらず、最後に送った写真の結果だけが残る。
 * 解析のあいだに行がほかの書き手 (完了の RPC・料理の画像のジョブ・画面の編集など) に書かれた場合も、写真の結果を書かない
 * (#121 の「自分より新しい書き込みが既にある場合は更新をスキップする」と同じ)。
 *
 * db は service_role の client (RLS を通らない)。呼ぶ前に本人の行であることを確かめること (index.ts が確かめる)。
 * 型の import だけで、実行時の依存は無い (単体テスト・結合テストで読み込める)。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** 写真の解析の印を付けた結果 */
export type PhotoAnalysisClaim =
  | { status: "claimed"; token: string }
  | { status: "superseded" };

/** 本文の invokedAt を読んだ結果。無いときは null (Edge を利用者の JWT で直接呼んだときなど) */
export type ParsedInvokedAt = { ok: true; invokedAt: string | null } | { ok: false };

/**
 * 本文の invokedAt を ISO 8601 の文字列 (UTC。ミリ秒まで) にそろえる。無い (undefined / null) ときは null。
 * 文字列でない・日時として読めないときは ok: false (呼び出し側が 400 にする)
 */
export function parseInvokedAt(value: unknown): ParsedInvokedAt {
  if (value === undefined || value === null) return { ok: true, invokedAt: null };
  if (typeof value !== "string") return { ok: false };
  const time = Date.parse(value);
  if (Number.isNaN(time)) return { ok: false };
  return { ok: true, invokedAt: new Date(time).toISOString() };
}

/**
 * 解析を始める前に、献立の行に印を付ける (updated_at を進める)。
 * invokedAt があるときは、行の updated_at が invokedAt 以前 (または NULL) のときだけ付ける。付けられなければ superseded。
 * 行が無いときも superseded (呼び出し側は本人の行であることを先に確かめている)
 */
export async function claimPhotoAnalysis(
  db: Pick<SupabaseClient, "from">,
  params: { mealId: string; invokedAt: string | null },
): Promise<PhotoAnalysisClaim> {
  if (params.invokedAt === null) {
    return claimWith(db, params.mealId, null);
  }
  // 「updated_at が invokedAt 以前」と「updated_at が NULL」を 1 つの or (updated_at.is.null,updated_at.lte.…) にしない。
  // PostgREST は or の条件を、update の返す行 (と count) にも当て直す。印を付けると updated_at が now() に進んで条件から外れるので、
  // 書けていても 0 行が返る (ローカルの Supabase で確かめた。lte・is・eq は当て直さない)。条件ごとに 1 回ずつ付ける
  // (どちらも条件つきの 1 文なので、あいだに別の印が付いても、印が 2 つ付くことは無い)
  const claimed = await claimWith(db, params.mealId, { op: "lte", invokedAt: params.invokedAt });
  if (claimed.status === "claimed") return claimed;
  return claimWith(db, params.mealId, { op: "is_null" });
}

/** 印を付ける update を 1 回送る (condition が null なら条件なし) */
async function claimWith(
  db: Pick<SupabaseClient, "from">,
  mealId: string,
  condition: { op: "lte"; invokedAt: string } | { op: "is_null" } | null,
): Promise<PhotoAnalysisClaim> {
  // updated_at の値はトリガーが DB の now() で上書きする (ここで送る値は使われない)
  let query = db
    .from("planned_meals")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", mealId);
  if (condition?.op === "lte") query = query.lte("updated_at", condition.invokedAt);
  if (condition?.op === "is_null") query = query.is("updated_at", null);
  const { data, error } = await query.select("updated_at");
  if (error) throw error;
  const rows: Array<{ updated_at?: unknown }> = Array.isArray(data) ? data : [];
  const token = rows[0]?.updated_at;
  if (typeof token !== "string") return { status: "superseded" };
  return { status: "claimed", token };
}

/** 献立の行の updated_at が、この解析の印のままか (ほかの書き込みが無かったか) */
export async function isPhotoAnalysisCurrent(
  db: Pick<SupabaseClient, "from">,
  params: { mealId: string; token: string },
): Promise<boolean> {
  const { data, error } = await db
    .from("planned_meals")
    .select("id")
    .eq("id", params.mealId)
    .eq("updated_at", params.token)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
