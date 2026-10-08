/**
 * GET /api/super-admin/logs — 運用ログ (app_logs) の閲覧 (#1157)
 *
 * app_logs には API ルート・Edge Function・ブラウザのログが溜まるが、読む画面が無く、
 * 運用者が SQL を直接叩かない限り誰も気づけなかった。その閲覧口。読み取り専用。
 *
 * 権限は super_admin だけ (admin も不可)。app_logs の RLS は「本人の行だけ読める」(#1171) なので、
 * 全員分の行を読むために service role (getSupabaseAdmin) を使う。
 * そのため、必ず先に requireRole で super_admin を確かめてから admin client を作ること。
 *
 * 絞り込み (すべて任意。組み合わせると AND):
 *   level / source / function_name / user_id / request_id : 完全一致
 *   from / to : created_at の範囲 (どちらも含む。ISO 8601。例: 2026-10-08T05:00:00Z)
 * ページ送り: 新しい順に limit 件 (既定 50、最大 200)。続きがあれば meta.next_cursor が返るので、
 *   次のリクエストの cursor= にそのまま渡す (詳細は src/lib/super-admin/app-logs.ts)。
 *
 * 使う索引 (supabase/baseline/prod_schema.sql): created_at / level / function_name / source / user_id。
 * request_id には索引が無いので、request_id だけで探すと全行を順に調べる (ローカルで 30 万行を約 50ms)。
 * 行が増えて DB の時間切れになったときは、期間 (from / to) を絞るよう促す (504)。
 *
 * message / error_message / error_stack / metadata は保存されたまま返す。秘密情報のマスクは
 * 書き込み時に済んでいる (src/lib/db-logger.ts → supabase/functions/_shared/log-sanitizer.ts: #1171 / #1287)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import {
  encodeAppLogCursor,
  olderThanCursorFilter,
  parseAppLogsQuery,
  type AppLogEntry,
  type AppLogListResponse,
} from '@/lib/super-admin/app-logs';

export const dynamic = 'force-dynamic';

/** PostgreSQL の「時間切れでクエリを取り消した」エラー (statement_timeout) */
const PG_QUERY_CANCELED = '57014';

/** ログの中身を返すので、ブラウザや途中の経路に保存させない */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function errorResponse(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status, headers: NO_STORE },
  );
}

export async function GET(request: NextRequest) {
  const logger = createLogger('GET /api/super-admin/logs', generateRequestId());
  try {
    // super_admin のみ許可 (admin も不可)。service role を使う前に必ずここを通す
    const user = await requireRole(['super_admin']);

    const parsed = parseAppLogsQuery(new URL(request.url).searchParams);
    if (!parsed.ok) {
      return errorResponse(400, 'VALIDATION_ERROR', '入力値が不正です', parsed.details);
    }
    const { level, source, function_name: functionName, user_id: userId, request_id: requestId, from, to, cursor, limit } =
      parsed.query;

    // app_logs の SELECT は RLS で本人の行だけ (#1171)。全体を読むには service role が要る
    const supabase = getSupabaseAdmin();

    let query = supabase
      .from('app_logs')
      .select('id, created_at, level, source, function_name, user_id, request_id, message, error_message, error_stack, metadata');

    if (level) query = query.eq('level', level);
    if (source) query = query.eq('source', source);
    if (functionName) query = query.eq('function_name', functionName);
    if (userId) query = query.eq('user_id', userId);
    if (requestId) query = query.eq('request_id', requestId);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);
    // 続きのページ: 前のページの最後の行より古い行だけ (cursor は decode 済みで、形を検証してある)。
    // created_at <= カーソルの日時 は、or 条件が含意する範囲なので結果は変わらない。ただし索引 (created_at) の
    // 範囲条件として使われるので、カーソルの位置から読み始められる。これが無いと or 条件は絞り込みとして
    // 新しい行から順に当てはめられ、深いページほど読み飛ばす行が増える
    // (ローカルで 30 万行の 20 万行目のページを EXPLAIN すると、読み飛ばし 20 万行・29ms が 1 行・0.08ms になった)
    if (cursor) query = query.lte('created_at', cursor.created_at).or(olderThanCursorFilter(cursor));

    // 新しい順。同じ時刻の行は id の大きい順にして、並びを一意にする (カーソルの前提)。
    // limit + 1 件取り、余分な 1 件があれば「続きがある」と分かる (続きが無いのに次のカーソルを返さない)
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (error) {
      // postgrest-js の error は Error ではない素のオブジェクトで、そのまま渡すと app_logs.error_message が
      // '[object Object]' になる。message を持つ Error に包んで渡す
      logger.withUser(user.id).error('アプリログの取得に失敗', new Error(error.message), {
        pg_code: error.code,
        level,
        source,
        function_name: functionName,
        user_id: userId,
        request_id: requestId,
        from,
        to,
        has_cursor: Boolean(cursor),
        limit,
      });
      if (error.code === PG_QUERY_CANCELED) {
        return errorResponse(
          504,
          'QUERY_TIMEOUT',
          '検索に時間がかかりすぎました。期間 (開始・終了) などの条件を絞って、もう一度お試しください',
        );
      }
      return errorResponse(500, 'INTERNAL_ERROR', 'アプリログの取得に失敗しました');
    }

    const rows = (data ?? []) as AppLogEntry[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    const body: AppLogListResponse = {
      data: page,
      meta: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeAppLogCursor({ created_at: last.created_at, id: last.id }) : null,
      },
    };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthError) {
      return errorResponse(401, 'UNAUTHORIZED', err.message);
    }
    if (err instanceof ForbiddenError) {
      return errorResponse(403, 'FORBIDDEN', err.message);
    }
    // 想定外の例外は内容を記録し、画面には中身を出さない
    logger.error('アプリログ API で予期しないエラー', err);
    return errorResponse(500, 'INTERNAL_ERROR', 'サーバーエラーが発生しました');
  }
}
