/**
 * generate-menu-v5: 最終書き込み (completed / failed) の CAS (#1202)
 *
 * 献立生成キューは、cron が claim_menu_request で行を取り、Edge Function が自分自身への再帰呼び出しで
 * Step1〜6 を進める。ワーカーが止まった行 (リースが切れた行) は、別の cron が取り直して続きから再開する。
 * このとき、止まったと見なされた側のチェーンが実は遅れて動いていると、同じ request に 2 本が最後まで走り、
 * 後から終わった側が、先に確定した status / progress / generated_data を上書きしてしまう。
 *
 * そこで最終書き込みは「まだ終わっていない行 (queued / processing)」にだけ当て、終わった行は上書きしない。
 * 失敗側の更新 (index.ts の fail_background / fail) が #122 から使っている集合と同じにしてある。
 *
 * Deno 専用の import を持たない (Vitest と結合テストからも読み込めるようにするため)。
 */

/** まだ終わっていない (最終書き込みを受け付ける) status。失敗側の CAS (#122) と同じ集合 */
export const ACTIVE_REQUEST_STATUSES = ["queued", "processing"] as const;

/**
 * 最終書き込みの UPDATE を組み立てる (await で実行する)。
 * id が一致し、status がまだ終わっていない行にだけ当たる。
 * .select("id") を付けてあるので、更新できた行が返る。結果が 0 件なら、
 * 呼び出し側は「すでに別の経路で終わっていたので書かなかった」と判断できる (エラーにはならない)。
 */
export function buildActiveRequestUpdate(
  supabase: any,
  requestId: string,
  update: Record<string, unknown>,
) {
  return supabase
    .from("weekly_menu_requests")
    .update(update)
    .eq("id", requestId)
    .in("status", [...ACTIVE_REQUEST_STATUSES])
    .select("id");
}

/** buildActiveRequestUpdate の結果から、実際に書き込めたか (1 行以上更新できたか) を判定する */
export function wasRequestUpdated(rows: unknown): boolean {
  return Array.isArray(rows) && rows.length > 0;
}
