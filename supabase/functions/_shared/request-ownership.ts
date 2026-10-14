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
