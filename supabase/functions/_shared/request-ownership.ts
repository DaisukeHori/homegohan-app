/**
 * 非同期ジョブの行 (shopping_list_requests など、id と user_id を持つテーブル) の所有権確認
 *
 * Edge Function は service role (RLS の対象外) でジョブの行を更新するため、body の requestId を
 * そのまま使うと、他人のジョブの行を書き換えられる (#1240 IDOR)。書き込みを始める前にこの関数で確かめる。
 * 他人の行と存在しない行は、呼び出し側で同じ 404 にする (他人の requestId が実在するかを漏らさない)。
 * generate-menu-v4 の weekly_menu_requests の owner_check と同じ考え方。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUID の形の文字列を小文字にそろえる。UUID の形でない値はそのまま返す (形の検査は呼び出し側の仕事)。
 * src/lib/http-params.ts の normalizeUuid (#1707) と同じ。Edge Function は src/ を import できないため、ここに同じものを置く。
 * Postgres の uuid 型は大文字と小文字を区別せずに比べるが、JS の `===` は区別する。JWT の利用者 id は小文字なので、
 * body の UUID を利用者 id と比べる前にこれでそろえる (#1793)
 */
export function normalizeUuid(value: string): string {
  return UUID_RE.test(value) ? value.toLowerCase() : value;
}

export type RequestOwnership =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_owner" }
  | { ok: false; reason: "lookup_failed"; message: string };

export async function verifyRequestOwnership(
  supabase: Pick<SupabaseClient, "from">,
  table: string,
  requestId: unknown,
  userId: string,
): Promise<RequestOwnership> {
  // UUID でない値は、問い合わせると型エラー (22P02) になるため、存在しない行と同じに扱う
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return { ok: false, reason: "not_found" };
  }

  const { data, error } = await supabase
    .from(table)
    .select("user_id")
    .eq("id", requestId)
    .maybeSingle();

  if (error) return { ok: false, reason: "lookup_failed", message: error.message };
  if (!data) return { ok: false, reason: "not_found" };
  if (String((data as { user_id: unknown }).user_id) !== String(userId)) {
    return { ok: false, reason: "not_owner" };
  }
  return { ok: true };
}
