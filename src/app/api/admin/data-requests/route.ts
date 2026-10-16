/**
 * GET /api/admin/data-requests - 個人情報の請求 (開示・訂正・利用停止・消去) の運営向けの一覧 (#1178 / #1702 段 C)
 *
 * 設計: docs/design/cross/15-data-subject-requests.md §7.1・§7.4・§11。応答は operator/02 §3.2 の `{ data, meta }`、エラーは nested。
 * 権限: admin / super_admin (DSR_OPERATOR_ROLES。support を含めない理由は設計 §3.2)。
 *
 * - 一覧は本人のセッションの client (RLS data_subject_requests_select_operator・列の GRANT の中の DSR_ADMIN_LIST_COLUMNS) で読む
 *   (service.ts の listDsrForOperator)。請求の内容・応答・内部メモは返さない (詳細でだけ返す)。
 * - クエリ: status / request_type / overdue=1 (期限超過) / page / per_page (DSR_ADMIN_PAGE_LIMITS / DSR_ADMIN_LIST_LIMITS で丸める)。
 * - 1 件以上返したときだけ、1 回の検索 = 1 行で admin.dsr.list を監査ログに残す (条件と件数だけ。返した行の ID や値は入れない)。
 *   記録に失敗しても一覧は返す (fail-open)。
 * - 本文を読まないので rejectNullCharacterBody は呼ばない (src/__tests__/api/null-character-routes.test.ts の表の外)。
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { clampIntParam } from '@/lib/http-params';
import { internalError } from '@/lib/api/errors';
import { buildListViewDetails, recordAdminAudit } from '@/lib/admin/audit';
import { NO_STORE_HEADERS, authFailureResponse, errorResponse } from '@/lib/admin/inquiries';
import {
  DSR_ADMIN_LIST_LIMITS,
  DSR_ADMIN_PAGE_LIMITS,
  DSR_AUDIT_ACTIONS,
  DSR_OPERATOR_ROLES,
  dsrAdminListQuerySchema,
} from '@/lib/data-subject-requests/core';
import { listDsrForOperator, type DsrContext } from '@/lib/data-subject-requests/service';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'GET /api/admin/data-requests';
/** 監査ログの記録に失敗したときに db-logger へ出す名前 */
const AUDIT_ROUTE_NAME = 'api/admin/data-requests GET';
/** 監査ログの target_type (一覧は特定の請求を対象にしない) */
const DSR_AUDIT_TARGET_TYPE = 'data_subject_request';
/** 入力の検査 (zod) に落ちたときの 400 の文 (設計 §13) */
const VALIDATION_ERROR_MESSAGE = '入力内容を確認してください';

/** 運営の route の 500 (internalError の nested。原因はログにだけ残す)。no-store を付ける */
function operatorInternalError(cause: unknown, ctx: { userId?: string; requestId?: string } = {}): NextResponse {
  const response = internalError(ROUTE_NAME, cause, ctx, { shape: 'nested' });
  response.headers.set('Cache-Control', NO_STORE_HEADERS['Cache-Control']);
  return response;
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = generateRequestId();
  const logger = createLogger(ROUTE_NAME, requestId);

  let actor;
  try {
    actor = await requireRole(DSR_OPERATOR_ROLES);
  } catch (err) {
    const failure = authFailureResponse(err);
    if (failure) return failure;
    return operatorInternalError(err, { requestId });
  }
  const ctx: DsrContext = { now: new Date(), requestId, log: logger.withUser(actor.id) };

  const { searchParams } = new URL(request.url);
  const parsed = dsrAdminListQuerySchema.safeParse({
    // ?status= のように空で送られたときは「絞り込みなし」として扱う (問い合わせ一覧と同じ)
    status: searchParams.get('status') || undefined,
    request_type: searchParams.get('request_type') || undefined,
    overdue: searchParams.get('overdue') || undefined,
  });
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', VALIDATION_ERROR_MESSAGE, parsed.error.flatten());
  }
  const query = parsed.data;
  const page = clampIntParam(searchParams.get('page'), DSR_ADMIN_PAGE_LIMITS);
  const perPage = clampIntParam(searchParams.get('per_page'), DSR_ADMIN_LIST_LIMITS);

  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch (error) {
    return operatorInternalError(error, { userId: actor.id, requestId });
  }

  const result = await listDsrForOperator(supabase, { query, page, perPage }, ctx);
  if (!result.ok) {
    return operatorInternalError(result.cause, { userId: actor.id, requestId });
  }
  const { rows, total } = result.data;

  // 一覧の閲覧を 1 回 = 1 行で残す (#1326 と同じ)。0 件のときは情報を返していないので記録しない。
  // 記録に失敗しても一覧は返す (失敗は db-logger に error で残る)
  if (rows.length > 0) {
    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: DSR_AUDIT_ACTIONS.list,
      targetId: null,
      targetType: DSR_AUDIT_TARGET_TYPE,
      details: buildListViewDetails(
        {
          status: query.status,
          request_type: query.request_type,
          overdue: query.overdue,
          page,
          per_page: perPage,
        },
        rows.length,
        total,
      ),
      request,
      routeName: AUDIT_ROUTE_NAME,
    });
  }

  return NextResponse.json(
    // 範囲外のページでは件数を取れないので total は null (問い合わせ一覧と同じ)
    { data: rows, meta: { total, page, per_page: perPage } },
    { headers: NO_STORE_HEADERS },
  );
}
