/**
 * 買い物リスト再生成で、今のアクティブなリストを新しいリストに差し替える DB 手順 (#1312)
 *
 * 以前の regenerate-shopping-list-v2 は、PostgREST への別々の HTTP 呼び出しで
 *   1) アクティブなリストを archived にする (結果のエラーは見ていなかった)
 *   2) 新しいアクティブなリストを INSERT する
 * と処理していた。その間に POST /api/shopping-list/add-recipe が「アクティブなリストが無い」と判断して自分のリストを作ると、
 * 2) が部分ユニーク索引 idx_shopping_lists_active_unique の 23505 で失敗し、再生成のリクエストが failed になった。
 *
 * 今は DB 関数 public.replace_active_shopping_list に任せる。アーカイブと INSERT を 1 トランザクションで行い、
 * add-recipe 側の get_or_create_active_shopping_list と同じユーザーごとの排他ロックを取るので、
 * どちらが先に来ても互いを失敗させない (supabase/migrations/20261008120000_shopping_list_active_lock.sql)。
 * この関数は service_role だけが実行できる。呼び出し側 (Edge Function) は service role のクライアントを渡すこと。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ReplaceActiveShoppingListParams {
  userId: string;
  /** 対象期間の開始日 (YYYY-MM-DD) */
  startDate: string;
  /** 対象期間の終了日 (YYYY-MM-DD) */
  endDate: string;
  /** 生成に使った人数設定。無ければ null */
  servingsConfig?: unknown;
}

/**
 * userId の今のアクティブなリストをアーカイブして、新しいアクティブなリストを作り、その id を返す。
 * 失敗した場合は Supabase (PostgREST) のエラーをそのまま throw する (アーカイブも取り消される)。
 */
export async function replaceActiveShoppingList(
  supabase: Pick<SupabaseClient, "rpc">,
  params: ReplaceActiveShoppingListParams,
): Promise<string> {
  const { data, error } = await supabase.rpc("replace_active_shopping_list", {
    p_user_id: params.userId,
    p_title: `${params.startDate}〜${params.endDate}の買い物リスト`,
    p_start_date: params.startDate,
    p_end_date: params.endDate,
    // 引数を省略した場合 (undefined) は JSON から落ちるので、null を明示して送る
    p_servings_config: params.servingsConfig ?? null,
  });

  if (error) throw error;
  // 関数は uuid を返す。エラーなしで id が無いのは想定外なので、成功扱いにしない
  if (typeof data !== "string" || data === "") {
    throw new Error("replace_active_shopping_list returned no list id");
  }
  return data;
}
