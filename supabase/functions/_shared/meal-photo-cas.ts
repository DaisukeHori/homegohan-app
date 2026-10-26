/**
 * 写真の解析 (analyze-meal-photo の mealId の経路) の書き込みの順序の守り (#121 の CAS を戻す。#2025 の続き。#2050)
 *
 * 同じ献立に写真の解析を 2 回続けて送ると、背景の処理 (EdgeRuntime.waitUntil) が 2 本並ぶ。以前は書き込みに条件が無く、
 * 後に終わった方が planned_meals を書いた。先に送った古い写真の結果が、後に送った新しい写真の結果を上書きしえた
 * (#160 で入った CAS は、#248 の競合の解消で消えていた)。
 *
 * 守り方 (updated_at を印に使う。process-meal-image-jobs の料理の画像の書き込み (#1527) と同じ楽観的な排他):
 *   0. 要求の印を付ける (markPhotoAnalysisRequest。Next.js の route が Edge を呼ぶ直前に、利用者の client で呼ぶ): 行の updated_at を
 *      進め (トリガー trg_planned_meals_updated_at が DB の now() にする)、進めたあとの updated_at を invokedAt として Edge へ送る。
 *      送った順 = 要求の印が付いた順で、後に送った要求の印は行に残る (#2050)。
 *   1. 印を付ける (claimPhotoAnalysis。Edge の背景の処理): 解析を始める前に、行の updated_at を進める。進めたあとの updated_at が、
 *      この解析の印になる。
 *      invokedAt があるときは、行の updated_at が invokedAt 以前 (または NULL) のときだけ印を付ける。呼んだあとに行が書かれていた
 *      (後から送った要求の印・後から送った解析の印・ほかの書き込みがあった) なら、この解析は古いので、解析せずにやめる
 *      (Edge に遅れて届いた古い要求が、新しい要求の印を消さない)。
 *   2. 書く前に確かめる (isPhotoAnalysisCurrent): 解析のあと、行の updated_at が印のままかを見る。違えば、Storage への
 *      アップロードと画像のジョブの取り消しをせずにやめる。
 *   3. 書く (analyze-meal-photo/index.ts の update): updated_at が印のままの行にだけ書く (.eq('updated_at', 印))。
 *      0 行なら書かずにやめる (確かめてから書くまでのあいだに書かれた場合も、ここで止まる)。
 *
 * 後から送った要求の印と、後から送った解析の印が、先に送った解析の印を消す (または付けさせない) ので、終わる順番によらず、
 * 最後に送った写真の結果だけが残る。先に送った解析の Edge の起動が遅れ、その印を付けようとする時刻が後に送った要求の時刻より
 * 後になっても、後に送った要求の印が行に残っているので、先に送った解析の印は付かない (#2050。0 が無かったときは、invokedAt が
 * route の時計で、先に送った解析の印が後に送った要求の時刻より後に付くと、後に送った解析の印が付かなかった)。
 * 解析のあいだに行がほかの書き手 (完了の RPC・料理の画像のジョブ・画面の編集など) に書かれた場合も、写真の結果を書かない
 * (#121 の「自分より新しい書き込みが既にある場合は更新をスキップする」と同じ)。
 *
 * 要求の印が付かない (本人の行が見つからない) ときは、route は今までどおり route の時計を invokedAt として送る
 * (Edge の背景の処理は本人の行の確認で止まる)。Edge を利用者の JWT で直接呼んだとき (invokedAt が無い) は 0 を通らない。
 *
 * claimPhotoAnalysis / isPhotoAnalysisCurrent の db は service_role の client (RLS を通らない)。呼ぶ前に本人の行であることを
 * 確かめること (index.ts が確かめる)。markPhotoAnalysisRequest の db は利用者の client (RLS が本人の行だけに絞る)。
 * 型の import だけで、実行時の依存は無い (単体テスト・結合テスト・Next.js の route で読み込める)。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** 写真の解析の印を付けた結果 */
export type PhotoAnalysisClaim =
  | { status: "claimed"; token: string }
  | { status: "superseded" };

/** 本文の invokedAt を読んだ結果。無いときは null (Edge を利用者の JWT で直接呼んだときなど) */
export type ParsedInvokedAt = { ok: true; invokedAt: string | null } | { ok: false };

/** 写真の解析の要求に印を付けた結果 (markPhotoAnalysisRequest) */
export type PhotoAnalysisRequestMark =
  | { status: "marked"; requestedAt: string }
  | { status: "not_found" };

/** timestamptz の秒の下の桁の数 (PostgreSQL はマイクロ秒まで持つ) */
const TIMESTAMPTZ_FRACTION_DIGITS = 6;
/** Date が持つ秒の下の桁の数 (ミリ秒) */
const DATE_FRACTION_DIGITS = 3;
/** ISO 8601 の日時 (秒まで・秒の下の桁・Z か ±hh:mm)。秒の下の桁を Date より細かく持つ値を、桁を落とさずに読むため */
const ISO_DATE_TIME_WITH_FRACTION = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 本文の invokedAt を ISO 8601 の文字列 (UTC。マイクロ秒まで) にそろえる。無い (undefined / null) ときは null。
 * 文字列でない・日時として読めないときは ok: false (呼び出し側が 400 にする)。
 * invokedAt は route が付けた要求の印 (DB の updated_at。マイクロ秒まで) なので、秒の下の桁を Date のミリ秒に丸めない
 * (丸めると、印の直後の updated_at が invokedAt より後になり、自分の要求の印で claimPhotoAnalysis が止まる。#2050)
 */
export function parseInvokedAt(value: unknown): ParsedInvokedAt {
  if (value === undefined || value === null) return { ok: true, invokedAt: null };
  if (typeof value !== "string") return { ok: false };
  const time = Date.parse(value);
  if (Number.isNaN(time)) return { ok: false };
  const isoSeconds = "YYYY-MM-DDTHH:mm:ss".length;
  const matched = ISO_DATE_TIME_WITH_FRACTION.exec(value);
  if (!matched) {
    // 形が違う日時 (Date が読める別の書き方) は、Date のミリ秒までをマイクロ秒の 6 桁で書く
    const iso = new Date(time).toISOString();
    const millis = iso.slice(isoSeconds + 1, isoSeconds + 1 + DATE_FRACTION_DIGITS);
    return { ok: true, invokedAt: `${iso.slice(0, isoSeconds)}.${millis.padEnd(TIMESTAMPTZ_FRACTION_DIGITS, "0")}Z` };
  }
  const [, dateTimeToSeconds, fractionDigits = "", zone] = matched;
  // 秒までは、秒の下の桁を外した値を Date で UTC にそろえる (時差は分の単位なので、秒の下の桁は変わらない。丸めで秒が繰り上がらない)
  const secondsTime = Date.parse(`${dateTimeToSeconds}${zone}`);
  if (Number.isNaN(secondsTime)) return { ok: false };
  const secondsInUtc = new Date(secondsTime).toISOString().slice(0, isoSeconds);
  // 秒の下の桁はマイクロ秒の 6 桁にそろえる (7 桁目からは timestamptz に無いので落とす)
  const fraction = fractionDigits.padEnd(TIMESTAMPTZ_FRACTION_DIGITS, "0").slice(0, TIMESTAMPTZ_FRACTION_DIGITS);
  return { ok: true, invokedAt: `${secondsInUtc}.${fraction}Z` };
}

/**
 * 写真の解析を Edge へ送る直前に、献立の行に要求の印を付ける (updated_at を進める。Next.js の route が呼ぶ)。
 * 進めたあとの updated_at (DB の時刻) を requestedAt として返す。route はこれを invokedAt として Edge へ送る。
 * db は利用者の client (RLS が本人の行だけに絞る)。行が見えない (他人の献立・消えた献立) ときは not_found で、行を変えない。
 * 送るのは updated_at だけ (トリガーが DB の now() にする。利用者の client に許された列だけを書く)
 */
export async function markPhotoAnalysisRequest(
  db: Pick<SupabaseClient, "from">,
  params: { mealId: string },
): Promise<PhotoAnalysisRequestMark> {
  const { data, error } = await db
    .from("planned_meals")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", params.mealId)
    .select("updated_at");
  if (error) throw error;
  const rows: Array<{ updated_at?: unknown }> = Array.isArray(data) ? data : [];
  const requestedAt = rows[0]?.updated_at;
  if (typeof requestedAt !== "string") return { status: "not_found" };
  return { status: "marked", requestedAt };
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
