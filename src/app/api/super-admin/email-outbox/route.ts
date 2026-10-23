/**
 * GET /api/super-admin/email-outbox — メールの送信待ち (email_outbox) の一覧 (#1708 / #1193)
 *
 * 正本: docs/design/operator/10-logs-and-mail-retry.md §9.2・§11。
 * アプリが送るメールは、sendEmail が email_outbox に 1 行入れ、worker (GET /api/cron/email-outbox) が送る。
 * 送信待ち (queued)・送信済み (sent)・届けられなかったもの (dead) を新しい順に返す。dead の行は画面から再送できる
 * (POST /api/super-admin/email-outbox/[id]/requeue)。
 *
 * 権限は super_admin だけ (admin も不可)。email_outbox は service_role しか読めない (RLS + GRANT) ので、
 * 必ず先に requireRole で super_admin を確かめてから service role の client (getSupabaseAdmin) を作ること。
 *
 * 絞り込み (すべて任意。組み合わせると AND):
 *   status   : queued / sent / dead (既定 dead)
 *   template : 文面の名前 (完全一致・100 文字まで)
 * ページ送り: 新しい順に limit 件 (既定 50、最大 200)。続きがあれば meta.next_cursor を次の cursor= に渡す
 * (カーソルはアプリログの一覧と同じ形: src/lib/super-admin/app-logs.ts)。
 *
 * 宛先はマスクして返し、件名・本文・宛先の生の値・Idempotency-Key・Resend の ID は返さない
 * (本文には招待などのトークンを含むものがあるため。R-09)。宛先をマスクし本文を返さないので、閲覧は監査に残さない (§10)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { encodeAppLogCursor, olderThanCursorFilter } from '@/lib/super-admin/app-logs';
import {
  EMAIL_OUTBOX_LIST_COLUMNS,
  EmailOutboxApiRowSchema,
  parseEmailOutboxQuery,
  toEmailOutboxListItem,
  type EmailOutboxListResponse,
} from '@/lib/super-admin/email-outbox';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'GET /api/super-admin/email-outbox';

/** PostgreSQL の「時間切れでクエリを取り消した」エラー (statement_timeout) */
const PG_QUERY_CANCELED = '57014';

/** 宛先 (マスク済み) と失敗の文面を返すので、ブラウザや途中の経路に保存させない */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function errorResponse(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status, headers: NO_STORE },
  );
}

export async function GET(request: NextRequest) {
  const logger = createLogger(ROUTE_NAME, generateRequestId());
  try {
    // super_admin のみ許可 (admin も不可)。service role を使う前に必ずここを通す
    const user = await requireRole(['super_admin']);

    const parsed = parseEmailOutboxQuery(new URL(request.url).searchParams);
    if (!parsed.ok) {
      return errorResponse(400, 'VALIDATION_ERROR', '入力値が不正です', parsed.details);
    }
    const { status, template, cursor, limit } = parsed.query;

    // email_outbox は service_role だけが読める (RLS + GRANT)
    const supabase = getSupabaseAdmin();

    let query = supabase.from('email_outbox').select(EMAIL_OUTBOX_LIST_COLUMNS).eq('status', status);
    if (template) query = query.eq('template', template);
    // 続きのページ: 前のページの最後の行より古い行だけ (cursor は decode 済みで、形を検証してある)。
    // created_at <= カーソルの日時 は or 条件が含意する範囲で、索引 (status, created_at DESC, id DESC) の範囲条件にもなる
    if (cursor) query = query.lte('created_at', cursor.created_at).or(olderThanCursorFilter(cursor));

    // 新しい順。同じ時刻の行は id の大きい順 (カーソルの前提)。limit + 1 件取り、余分な 1 件で「続きがある」と分かる
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (error) {
      // postgrest-js の error は Error ではない素のオブジェクト。message を持つ Error に包んで渡す
      logger.withUser(user.id).error('メールの送信待ちの取得に失敗', new Error(error.message), {
        pg_code: error.code,
        status,
        template,
        has_cursor: Boolean(cursor),
        limit,
      });
      if (error.code === PG_QUERY_CANCELED) {
        return errorResponse(504, 'QUERY_TIMEOUT', '検索に時間がかかりすぎました。条件を絞って、もう一度お試しください');
      }
      return errorResponse(500, 'INTERNAL_ERROR', 'メールの送信待ちの取得に失敗しました');
    }

    // 列の形を確かめてから、宛先をマスクした形にする (形が違えば黙って返さず 500 にして記録する)
    const rows = EmailOutboxApiRowSchema.array().safeParse(data ?? []);
    if (!rows.success) {
      logger.withUser(user.id).error('メールの送信待ちの行の形が想定と違います', new Error('email_outbox の行の形が想定と違います'), {
        issues: rows.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`),
      });
      return errorResponse(500, 'INTERNAL_ERROR', 'メールの送信待ちの取得に失敗しました');
    }

    const hasMore = rows.data.length > limit;
    const page = hasMore ? rows.data.slice(0, limit) : rows.data;
    const last = page[page.length - 1];

    const body: EmailOutboxListResponse = {
      data: page.map(toEmailOutboxListItem),
      meta: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeAppLogCursor({ created_at: last.created_at, id: last.id }) : null,
      },
    };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    // 認可の失敗の文は日本語の固定の文 (例外の文面は本文に出さない #1917)。code は UNAUTHORIZED / FORBIDDEN のまま
    const authFailure = authFailureNested(err, { headers: NO_STORE });
    if (authFailure) return authFailure;
    // 想定外の例外は内容を記録し、画面には中身を出さない
    logger.error('メールの送信待ちの一覧 API で予期しないエラー', err);
    return errorResponse(500, 'INTERNAL_ERROR', 'サーバーエラーが発生しました');
  }
}
