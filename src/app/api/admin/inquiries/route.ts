/**
 * GET /api/admin/inquiries - 問い合わせ一覧 (#1121)
 *
 * /api/contact が inquiries に保存した問い合わせを、サポート担当者が一覧する。
 * 呼び出し元: Web の /support/inquiries、モバイルの admin / support の問い合わせ画面。
 * どちらも { inquiries: [...] } (camelCase) を読む。
 *
 * 一覧は「概要」(件名・連絡先・状態・日時) だけを返す。問い合わせ本文と管理者メモは
 * 詳細 (GET /api/admin/inquiries/[id]) でだけ返し、そこで閲覧を監査ログに記録する (#1200 と同じ方針)。
 *
 * クエリ:
 *   status  pending | in_progress | resolved | closed (省略で全件)
 *   limit   1〜100 (既定 50)
 *   page    1〜 (既定 1)
 * 並び順は新しい順 (created_at 降順)。
 * 権限: admin, super_admin, support
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { clampIntParam } from '@/lib/http-params';
import {
  INQUIRY_ADMIN_ROLES,
  INQUIRY_LIST_COLUMNS,
  NO_STORE_HEADERS,
  authFailureResponse,
  errorResponse,
  fetchNicknames,
  inquiryListQuerySchema,
  toInquirySummaryDto,
  type InquirySummaryRow,
} from '@/lib/admin/inquiries';

export const dynamic = 'force-dynamic';

const LIMIT_OPTIONS = { min: 1, max: 100, default: 50 };
const PAGE_OPTIONS = { min: 1, max: 10000, default: 1 };

export async function GET(request: Request) {
  const logger = createLogger('GET /api/admin/inquiries', generateRequestId());

  let actor;
  try {
    actor = await requireRole(INQUIRY_ADMIN_ROLES);
  } catch (err) {
    const failure = authFailureResponse(err);
    if (failure) return failure;
    logger.error('権限の確認に失敗しました', err);
    return errorResponse(500, 'INTERNAL_ERROR', 'サーバーエラーが発生しました');
  }
  const log = logger.withUser(actor.id);

  const { searchParams } = new URL(request.url);
  const parsed = inquiryListQuerySchema.safeParse({
    // ?status= のように空で送られたときは「絞り込みなし」として扱う
    status: searchParams.get('status') || undefined,
  });
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'パラメータが不正です', parsed.error.flatten());
  }
  const { status } = parsed.data;
  const limit = clampIntParam(searchParams.get('limit'), LIMIT_OPTIONS);
  const page = clampIntParam(searchParams.get('page'), PAGE_OPTIONS);
  const from = (page - 1) * limit;

  // inquiries は RLS (admin / super_admin / support のみ SELECT 可) に任せ、本人のセッションで読む。
  // service_role を使うのは、RLS で読めないニックネームの解決だけ (fetchNicknames)。
  const supabase = createClient();
  let query = supabase
    .from('inquiries')
    .select(INQUIRY_LIST_COLUMNS, { count: 'exact' })
    // 同時刻の行が前後してページをまたいで重複・欠落しないよう、id で順序を確定させる
    .order('created_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(from, from + limit - 1);
  if (status) query = query.eq('status', status);

  const { data, error, count, status: httpStatus } = await query;

  // 件数より後ろのページは PostgREST が 416 (PGRST103) を返す。エラーではなく空のページとして返す。
  // ローカルの Supabase では 416 の本文が途中で切れて error.code が取れない (message が '{"' だけになる) ため、
  // code だけでなく HTTP ステータスでも判定する (結合テストで確認済み)
  const beyondLastPage = !!error && (httpStatus === 416 || error.code === 'PGRST103');
  if (error && !beyondLastPage) {
    // 以前の画面は失敗を握りつぶして「該当する問い合わせはありません」と表示していた。
    // 取得できなかったことが分かるよう、空配列ではなく 500 を返す。
    log.error('問い合わせ一覧の取得に失敗しました', error, { status, page, limit });
    return errorResponse(500, 'INTERNAL_ERROR', '問い合わせの取得に失敗しました');
  }

  const rows = (beyondLastPage ? [] : (data ?? [])) as InquirySummaryRow[];
  const names = await fetchNicknames(
    rows.map((row) => row.user_id),
    log,
  );
  const inquiries = rows.map((row) => toInquirySummaryDto(row, row.user_id ? (names.get(row.user_id) ?? null) : null));

  return NextResponse.json(
    {
      inquiries,
      // 範囲外のページでは件数を取れないので null (画面は無視する)
      total: beyondLastPage ? null : (count ?? inquiries.length),
      page,
      limit,
    },
    { headers: NO_STORE_HEADERS },
  );
}
