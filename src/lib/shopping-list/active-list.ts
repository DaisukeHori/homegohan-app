// #1214 / #1312: ユーザーのアクティブな買い物リストを取得する (無ければ作る)。共通ヘルパー。
//
// shopping_lists には部分ユニーク索引 idx_shopping_lists_active_unique (user_id) WHERE status = 'active' があり、
// ユーザーごとにアクティブなリストは 1 つしか持てない。
// 以前はここで「SELECT して無ければ INSERT し、23505 (unique_violation) なら再取得」を行っていた (#1214)。
// add-recipe どうしの競合は防げたが、買い物リストの再生成 (Edge Function regenerate-shopping-list-v2) の
// 「今のリストをアーカイブ -> 新しいリストを INSERT」とは直列化されておらず、その間にここでリストが作られると、
// 再生成の INSERT が 23505 で失敗していた (#1312)。
//
// 今は DB 関数 public.get_or_create_active_shopping_list に任せる。この関数は、再生成が使う
// replace_active_shopping_list と同じユーザーごとの排他ロックを取るので、同時に来ても 1 件ずつ順に処理され、
// どちらも失敗しない。ロックを取らない書き込みが先にコミットした場合の数え直しも関数の中で行う
// (supabase/migrations/20261008120000_shopping_list_active_lock.sql)。
//
// 呼び出し元: src/app/api/shopping-list/add-recipe/route.ts、src/lib/ai/consultation-action-executor.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatLocalDate } from '@/lib/date-utils';

/** 新規作成するリストのタイトル (shopping_lists の列は title。name 列は無い) */
const DEFAULT_SHOPPING_LIST_TITLE = '買い物リスト';

/** 新規作成するリストの対象期間 (今日から 7 日間。今日を含めて end_date = 今日 + 6 日) */
const DEFAULT_RANGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ユーザーのアクティブな買い物リストを返す。無ければ作成する。
 * 同じユーザーの再生成や別の追加と同時に呼ばれても、DB 関数のロックで直列化されるので失敗しない。
 *
 * 失敗した場合は Supabase (PostgREST) のエラーをそのまま throw する。
 * 呼び出し側でログに残し、クライアントには固定文言を返すこと (生のエラー文を返さない)。
 *
 * userId は呼び出した本人 (supabase クライアントの JWT の持ち主) でなければならない。
 * 本人以外を指定すると、DB 関数が 42501 (FORBIDDEN) で拒否する。
 */
export async function getOrCreateActiveShoppingList(
  supabase: Pick<SupabaseClient, 'rpc'>,
  userId: string,
): Promise<{ id: string }> {
  // 日付は JST 基準。toISOString().slice(0, 10) は UTC の日付なので、JST の早朝 (0:00-9:00) に前日にずれる。
  // JST は夏時間が無いため、ミリ秒の加算で日付を進めてよい (実行環境のタイムゾーンに依存しない)。
  // 作成済みのリストがあるときは、これらの値は使われない。
  const now = new Date();
  const { data, error } = await supabase.rpc('get_or_create_active_shopping_list', {
    p_user_id: userId,
    p_title: DEFAULT_SHOPPING_LIST_TITLE,
    p_start_date: formatLocalDate(now),
    p_end_date: formatLocalDate(new Date(now.getTime() + (DEFAULT_RANGE_DAYS - 1) * DAY_MS)),
  });

  if (error) throw error;
  // 関数は uuid を返す。エラーなしで id が無いのは想定外なので、成功扱いにしない
  if (typeof data !== 'string' || data === '') {
    throw new Error('get_or_create_active_shopping_list returned no id');
  }
  return { id: data };
}
