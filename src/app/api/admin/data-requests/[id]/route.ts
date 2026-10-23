/**
 * GET   /api/admin/data-requests/[id] - 個人情報の請求の運営向けの詳細 (#1178 / #1702 段 C)
 * PATCH /api/admin/data-requests/[id] - 運営の対応 (状態・本人への応答・内部メモの更新。If-Unmodified-Since の楽観的ロック)
 *
 * 設計: docs/design/cross/15-data-subject-requests.md §7.1・§7.4・§11・§13。応答は `{ data }`、エラーは nested。
 * 権限: admin / super_admin (DSR_OPERATOR_ROLES)。
 *
 * - 詳細と更新は admin_notes (内部メモ) を含むので、requireRole を通したあとに作る service_role の client で読み書きする
 *   (authenticated には admin_notes を GRANT していない。§4.3)。請求者のメールアドレスは同じ client で fetchUserEmails。
 * - 監査ログ (recordAdminAudit) は本人のセッションの client で記録する (RLS audit_logs_insert_admins)。
 *   GET は 200 のときだけ admin.dsr.view、PATCH は 200 のときだけ admin.dsr.update (変更が無くても応答に本文を含むので毎回)。
 *   404・409・412・422・428・入力の誤りでは記録しない。記録に失敗しても応答は返す (fail-open)。
 * - PATCH の検査の順序: NULL 文字 (400) → requireRole (401 / 403) → id (400) → 本文の JSON (400) → zod (400) →
 *   updateDsrByOperator (428 → 404 → 412 → 409 DSR_INVALID_TRANSITION → 422 → 409 CONFLICT_STALE_DATA)。
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { NO_STORE_HEADERS, authFailureResponse, errorResponse, fetchNicknames } from '@/lib/admin/inquiries';
import { fetchUserEmails } from '@/lib/admin/user-emails';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import {
  DSR_AUDIT_ACTIONS,
  DSR_OPERATOR_ROLES,
  dsrAdminUpdateBodySchema,
  dsrAuditTarget,
  dsrIdSchema,
  toDsrAdminDetailDto,
  type DsrAdminDetailDto,
  type DsrStatus,
} from '@/lib/data-subject-requests/core';
import {
  getDsrForOperator,
  updateDsrByOperator,
  type DsrAdminClient,
  type DsrContext,
  type DsrServiceResult,
} from '@/lib/data-subject-requests/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const GET_ROUTE_NAME = 'GET /api/admin/data-requests/[id]';
const PATCH_ROUTE_NAME = 'PATCH /api/admin/data-requests/[id]';
/** 監査ログの記録に失敗したときに db-logger へ出す名前 */
const GET_AUDIT_ROUTE_NAME = 'api/admin/data-requests/[id] GET';
const PATCH_AUDIT_ROUTE_NAME = 'api/admin/data-requests/[id] PATCH';

/** 楽観的ロックのヘッダ (GET が返した updated_at の文字列をそのまま送る。§7.4) */
const IF_UNMODIFIED_SINCE_HEADER = 'If-Unmodified-Since';
/** 入力の検査 (zod・id の形式) に落ちたときの 400 の文 (§13) */
const VALIDATION_ERROR_MESSAGE = '入力内容を確認してください';
/** 本文が JSON として読めないときの 400 の文 (§13) */
const INVALID_JSON_MESSAGE = 'リクエストボディが不正です';
/** 運営が「終わり」にした状態。この状態にした更新の監査は warn で残す (§11) */
const DSR_RESOLVED_BY_OPERATOR: ReadonlyArray<DsrStatus> = ['fulfilled', 'rejected'];

/** service が返す失敗の code (DsrServiceResult の失敗側) */
type DsrServiceFailure = Extract<DsrServiceResult<never>, { ok: false }>;

/**
 * 運営に返す 4xx の固定の文 (§13 のエラー表)。本人の操作だけが返す code (DSR_ALREADY_OPEN など) は運営の route には届かないが、
 * 型で全部の code を埋めておく (service の戻り値の code を増やしたときに、ここで書き忘れが型の誤りになる)
 */
const DSR_OPERATOR_ERROR_MESSAGES: Record<Exclude<DsrServiceFailure['code'], 'INTERNAL_ERROR'>, string> = {
  NOT_FOUND: '請求が見つかりません',
  DSR_ALREADY_OPEN: '同じ種類の請求がすでに受け付けられています。先にその請求の完了か取り下げをお待ちください',
  DSR_INVALID_STATE: 'この請求は現在の状態ではその操作ができません',
  DSR_VERIFICATION_INVALID: '確認リンクが正しくありません',
  DSR_VERIFICATION_EXPIRED: '確認リンクの期限が切れています。確認メールを再送してください',
  DSR_VERIFICATION_LIMIT: '確認メールの送信回数が上限に達しました。お問い合わせください',
  DSR_INVALID_TRANSITION: '現在の状態ではその変更はできません',
  DSR_RESPONSE_NOTE_REQUIRED: '対応済み・対応できずにするときは本人への応答を書いてください',
  CONFLICT_OPTIMISTIC_LOCK: '別の更新が先に行われました。再読み込みしてください',
  CONFLICT_STALE_DATA: '別の更新が先に行われました。再読み込みしてください',
  CONFLICT_PRECONDITION_REQUIRED: 'If-Unmodified-Since ヘッダが必要です',
};

/** 運営の route の 500 (internalError の nested。原因はログにだけ残す)。no-store を付ける */
function operatorInternalError(
  routeName: string,
  cause: unknown,
  ctx: { userId?: string; requestId?: string } = {},
): NextResponse {
  const response = internalError(routeName, cause, ctx, { shape: 'nested' });
  response.headers.set('Cache-Control', NO_STORE_HEADERS['Cache-Control']);
  return response;
}

/** service の失敗を nested の応答にする (500 は internalError。cause はログにだけ残し、本文に入れない) */
function serviceFailureResponse(
  routeName: string,
  failure: DsrServiceFailure,
  ctx: { userId: string; requestId: string },
): NextResponse {
  if (failure.code === 'INTERNAL_ERROR') return operatorInternalError(routeName, failure.cause, ctx);
  return errorResponse(failure.status, failure.code, DSR_OPERATOR_ERROR_MESSAGES[failure.code]);
}

/** requireRole の失敗を 401 / 403 にする。どちらでもない例外は 500 */
function roleFailureResponse(routeName: string, err: unknown, requestId: string): NextResponse {
  return authFailureResponse(err) ?? operatorInternalError(routeName, err, { requestId });
}

/**
 * 更新後の請求者 (ニックネームとメールアドレス)。退会済み (user_id が NULL) なら null。
 * どちらも補助情報なので、引けなければ null のまま返す (fetchNicknames / fetchUserEmails がログに残す)
 */
async function loadRequester(
  admin: DsrAdminClient,
  userId: string | null,
  ctx: DsrContext,
): Promise<DsrAdminDetailDto['requester']> {
  if (!userId) return null;
  const [names, emails] = await Promise.all([
    fetchNicknames([userId], ctx.log),
    fetchUserEmails(admin, [userId], PATCH_ROUTE_NAME),
  ]);
  return { user_id: userId, nickname: names.get(userId) ?? null, email: emails.get(userId) ?? null };
}

export async function GET(request: Request, props: RouteContext): Promise<NextResponse> {
  const requestId = generateRequestId();
  const logger = createLogger(GET_ROUTE_NAME, requestId);

  let actor;
  try {
    actor = await requireRole(DSR_OPERATOR_ROLES);
  } catch (err) {
    return roleFailureResponse(GET_ROUTE_NAME, err, requestId);
  }
  const ctx: DsrContext = { now: new Date(), requestId, log: logger.withUser(actor.id) };
  const errorCtx = { userId: actor.id, requestId };

  const idResult = dsrIdSchema.safeParse((await props.params).id);
  if (!idResult.success) {
    return errorResponse(400, 'VALIDATION_ERROR', VALIDATION_ERROR_MESSAGE, idResult.error.flatten());
  }
  const id = idResult.data;

  let supabase: Awaited<ReturnType<typeof createClient>>;
  let admin: DsrAdminClient;
  try {
    supabase = await createClient();
    // 運営のロールを確かめたあとにだけ service_role の client を作る
    admin = getSupabaseAdmin();
  } catch (error) {
    return operatorInternalError(GET_ROUTE_NAME, error, errorCtx);
  }

  const result = await getDsrForOperator(admin, id, ctx);
  // 404 などは何も返していないので、閲覧の記録も残さない
  if (!result.ok) return serviceFailureResponse(GET_ROUTE_NAME, result, errorCtx);
  const dto = result.data;
  const { targetId, targetType } = dsrAuditTarget(dto);

  await recordAdminAudit({
    supabase,
    actorId: actor.id,
    actionType: DSR_AUDIT_ACTIONS.view,
    targetId,
    targetType,
    // 返した項目名だけを入れる。請求の内容・応答・内部メモ・メールアドレスの値は入れない
    details: { request_id: dto.id, viewed_fields: Object.keys(dto) },
    request,
    routeName: GET_AUDIT_ROUTE_NAME,
  });

  return NextResponse.json({ data: dto }, { headers: NO_STORE_HEADERS });
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  // 本文に NULL 文字 (U+0000) があれば、認証・DB に触れる前に 400 INVALID_CHARACTER (#1657。§7.1 の形)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;

  const requestId = generateRequestId();
  const logger = createLogger(PATCH_ROUTE_NAME, requestId);

  let actor;
  try {
    actor = await requireRole(DSR_OPERATOR_ROLES);
  } catch (err) {
    return roleFailureResponse(PATCH_ROUTE_NAME, err, requestId);
  }
  const ctx: DsrContext = { now: new Date(), requestId, log: logger.withUser(actor.id) };
  const errorCtx = { userId: actor.id, requestId };

  const idResult = dsrIdSchema.safeParse((await context.params).id);
  if (!idResult.success) {
    return errorResponse(400, 'VALIDATION_ERROR', VALIDATION_ERROR_MESSAGE, idResult.error.flatten());
  }
  const id = idResult.data;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_JSON', INVALID_JSON_MESSAGE);
  }
  const bodyResult = dsrAdminUpdateBodySchema.safeParse(body);
  if (!bodyResult.success) {
    return errorResponse(400, 'VALIDATION_ERROR', VALIDATION_ERROR_MESSAGE, bodyResult.error.flatten());
  }

  let supabase: Awaited<ReturnType<typeof createClient>>;
  let admin: DsrAdminClient;
  try {
    supabase = await createClient();
    // 運営のロールを確かめたあとにだけ service_role の client を作る
    admin = getSupabaseAdmin();
  } catch (error) {
    return operatorInternalError(PATCH_ROUTE_NAME, error, errorCtx);
  }

  const result = await updateDsrByOperator(
    admin,
    { id, ifUnmodifiedSince: request.headers.get(IF_UNMODIFIED_SINCE_HEADER), input: bodyResult.data },
    ctx,
  );
  // 書き込まなかった (428 / 404 / 412 / 409 / 422) ときは、監査ログにも残さない
  if (!result.ok) return serviceFailureResponse(PATCH_ROUTE_NAME, result, errorCtx);
  const { before, after, changed } = result.data;
  const { targetId, targetType } = dsrAuditTarget(after);

  // 応答には請求の内容・応答・内部メモが入るので、変更が無い更新でも記録する (閲覧の記録を迂回する読み取りにしない)。
  // 請求者の解決と記録は互いに独立。どちらも失敗を握って (ログに残して) 続行する
  const [requester] = await Promise.all([
    loadRequester(admin, after.user_id, ctx),
    recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: DSR_AUDIT_ACTIONS.update,
      targetId,
      targetType,
      // 状態の前後と、応答・内部メモを変えたかどうかだけ。応答・メモの中身は入れない
      details: {
        request_id: after.id,
        status_from: before.status,
        status_to: after.status,
        response_note_changed: changed.response_note,
        admin_notes_changed: changed.admin_notes,
        changed: changed.status || changed.response_note || changed.admin_notes,
      },
      severity: DSR_RESOLVED_BY_OPERATOR.includes(after.status) ? 'warn' : 'info',
      request,
      routeName: PATCH_AUDIT_ROUTE_NAME,
    }),
  ]);

  return NextResponse.json({ data: toDsrAdminDetailDto(after, requester, ctx.now) }, { headers: NO_STORE_HEADERS });
}
