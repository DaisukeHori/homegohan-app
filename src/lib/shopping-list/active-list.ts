// #1214: ユーザーのアクティブな買い物リストを取得する (無ければ作る)。共通ヘルパー。
//
// shopping_lists には部分ユニーク索引 idx_shopping_lists_active_unique (user_id) WHERE status = 'active' があり、
// ユーザーごとにアクティブなリストは 1 つしか持てない。
// そのため「SELECT して無ければ INSERT」を同時に 2 本が実行すると、どちらも「無い」と判定して INSERT し、
// 後から INSERT した側が 23505 (unique_violation) で失敗する。データは壊れないが、呼び出し側は 500 になり、
// 追加しようとした食材が失われていた。
// 23505 は「別のリクエストが先に作った」ことを意味するので、失敗扱いにせず、作られたリストを再取得して使う。
// (PostgREST の upsert は部分ユニーク索引の WHERE 条件を指定できないため、ON CONFLICT では書けない。)
//
// 呼び出し元: src/app/api/shopping-list/add-recipe/route.ts、src/lib/ai/consultation-action-executor.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatLocalDate } from '@/lib/date-utils';

/** PostgreSQL の unique_violation (SQLSTATE) */
const UNIQUE_VIOLATION = '23505';

/** 新規作成するリストのタイトル (shopping_lists の列は title。name 列は無い) */
const DEFAULT_SHOPPING_LIST_TITLE = '買い物リスト';

/** 新規作成するリストの対象期間 (今日から 7 日間。今日を含めて end_date = 今日 + 6 日) */
const DEFAULT_RANGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * SELECT → INSERT の最大試行回数。
 * 通常は「INSERT が 23505 で負けた次の SELECT」で必ず見つかるので 2 回目で終わる。
 * 負けた直後にそのリストが再生成などでアーカイブされた、という極めて稀な場合のための余裕であり、
 * 無限ループを避けるための上限でもある。
 */
const MAX_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/**
 * ユーザーのアクティブな買い物リストを返す。無ければ作成する。
 * 同時実行で作成に負けた (23505) 場合は、先に作られたリストを再取得して返す。
 *
 * 失敗した場合は Supabase (PostgREST) のエラーをそのまま throw する。
 * 呼び出し側でログに残し、クライアントには固定文言を返すこと (生のエラー文を返さない)。
 */
export async function getOrCreateActiveShoppingList(
  supabase: Pick<SupabaseClient, 'from'>,
  userId: string,
): Promise<{ id: string }> {
  let lastConflict: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { data: existing, error: selectError } = await supabase
      .from('shopping_lists')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    if (selectError) throw selectError;
    if (existing) return { id: existing.id };

    // 日付は JST 基準。toISOString().slice(0, 10) は UTC の日付なので、JST の早朝 (0:00-9:00) に前日にずれる。
    // JST は夏時間が無いため、ミリ秒の加算で日付を進めてよい (実行環境のタイムゾーンに依存しない)。
    const now = new Date();
    const { data: created, error: insertError } = await supabase
      .from('shopping_lists')
      .insert({
        user_id: userId,
        status: 'active',
        title: DEFAULT_SHOPPING_LIST_TITLE,
        start_date: formatLocalDate(now),
        end_date: formatLocalDate(new Date(now.getTime() + (DEFAULT_RANGE_DAYS - 1) * DAY_MS)),
      })
      .select('id')
      .single();

    if (!insertError) {
      if (!created) throw new Error('shopping_lists insert returned no row');
      return { id: created.id };
    }

    // 23505 以外 (RLS 拒否・接続エラーなど) は再試行しても直らないのでそのまま投げる
    if (!isUniqueViolation(insertError)) throw insertError;

    // 別のリクエストが先にアクティブなリストを作った。次の周回の SELECT で拾う。
    lastConflict = insertError;
  }

  throw lastConflict;
}
