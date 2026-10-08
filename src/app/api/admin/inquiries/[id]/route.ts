/**
 * GET   /api/admin/inquiries/[id] - 問い合わせ詳細 (#1121)
 * PATCH /api/admin/inquiries/[id] - ステータス・管理者メモの更新 (モバイル)
 * PUT   /api/admin/inquiries/[id] - 同上 (Web。PATCH と同じ処理)
 *
 * 呼び出し元: Web の /support/inquiries、モバイルの admin / support の問い合わせ画面。
 * 応答は { inquiry: {...} } (camelCase)。更新の入力は { status?, adminNotes? }。
 * 権限: admin, super_admin, support
 *
 * 詳細は問い合わせ本文と管理者メモを返すため、返すたびに admin_audit_logs へ記録する
 * (admin.inquiry.view。#1200 の方針: 対象は情報を見られた本人、details は項目名だけ、記録に失敗しても返す)。
 * 更新も、更新後の問い合わせ (本文を含む) を返すので、変更が無い更新を含めて毎回記録する (admin.inquiry.update)。
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { recordAdminAudit } from '@/lib/admin/audit';
import {
  INQUIRY_ADMIN_ROLES,
  INQUIRY_COLUMNS,
  NO_STORE_HEADERS,
  authFailureResponse,
  errorResponse,
  fetchNicknames,
  inquiryAuditTarget,
  inquiryIdSchema,
  inquiryUpdateBodySchema,
  nextResolvedAt,
  normalizeAdminNotes,
  toInquiryDto,
  type InquiryRow,
} from '@/lib/admin/inquiries';

export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

export async function GET(request: Request, { params }: RouteContext) {
  const logger = createLogger('GET /api/admin/inquiries/[id]', generateRequestId());

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

  const idResult = inquiryIdSchema.safeParse(params.id);
  if (!idResult.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'id が不正です', idResult.error.flatten());
  }
  const id = idResult.data;

  const supabase = createClient();
  const { data, error } = await supabase
    .from('inquiries')
    .select(INQUIRY_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    // 読み込みの失敗を「見つからない」にしない (404 は行が無いときだけ)
    log.error('問い合わせ詳細の取得に失敗しました', error, { inquiry_id: id });
    return errorResponse(500, 'INTERNAL_ERROR', '問い合わせの取得に失敗しました');
  }
  if (!data) {
    // 見つからないときは何も返していないので、閲覧の記録も残さない
    return errorResponse(404, 'NOT_FOUND', '問い合わせが見つかりません');
  }

  const row = data as InquiryRow;
  const { targetId, targetType } = inquiryAuditTarget(row);

  // ニックネームの解決と閲覧の記録は互いに独立。どちらも失敗を握って (ログに残して) 続行する
  const [names] = await Promise.all([
    fetchNicknames([row.user_id], log),
    recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: 'admin.inquiry.view',
      targetId,
      targetType,
      // 返した項目名だけを入れる。本文・メールアドレス・メモの中身は入れない
      details: { inquiry_id: row.id, viewed_fields: Object.keys(toInquiryDto(row, null)) },
      request,
      routeName: 'api/admin/inquiries/[id] GET',
    }),
  ]);

  return NextResponse.json(
    { inquiry: toInquiryDto(row, row.user_id ? (names.get(row.user_id) ?? null) : null) },
    { headers: NO_STORE_HEADERS },
  );
}

/** PATCH と PUT の共通処理。Web は PUT、モバイルは PATCH で同じボディを送る */
async function updateInquiry(request: Request, { params }: RouteContext, method: 'PATCH' | 'PUT') {
  const logger = createLogger(`${method} /api/admin/inquiries/[id]`, generateRequestId());

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

  const idResult = inquiryIdSchema.safeParse(params.id);
  if (!idResult.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'id が不正です', idResult.error.flatten());
  }
  const id = idResult.data;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'リクエストボディが不正です');
  }
  const bodyResult = inquiryUpdateBodySchema.safeParse(body);
  if (!bodyResult.success) {
    return errorResponse(400, 'VALIDATION_ERROR', '入力内容を確認してください', bodyResult.error.flatten());
  }
  const input = bodyResult.data;

  // 更新対象は inquiries の RLS (admin / super_admin / support のみ UPDATE 可) に任せ、本人のセッションで行う
  const supabase = createClient();
  const { data: currentData, error: readError } = await supabase
    .from('inquiries')
    .select(INQUIRY_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (readError) {
    log.error('更新対象の問い合わせを取得できませんでした', readError, { inquiry_id: id });
    return errorResponse(500, 'INTERNAL_ERROR', '問い合わせの更新に失敗しました');
  }
  if (!currentData) {
    return errorResponse(404, 'NOT_FOUND', '問い合わせが見つかりません');
  }
  const current = currentData as InquiryRow;

  // 書き込む列は status / admin_notes / resolved_at の 3 つだけ。
  // 本文・メールアドレス・種別・問い合わせ者などは、リクエストに含まれていても書き換えない。
  const update: Partial<Pick<InquiryRow, 'status' | 'admin_notes' | 'resolved_at'>> = {};
  let statusChanged = false;
  let notesChanged = false;

  if (input.status !== undefined && input.status !== current.status) {
    statusChanged = true;
    update.status = input.status;
    update.resolved_at = nextResolvedAt(input.status, current, new Date().toISOString());
  }
  if (input.adminNotes !== undefined) {
    const notes = normalizeAdminNotes(input.adminNotes);
    if (notes !== current.admin_notes) {
      notesChanged = true;
      update.admin_notes = notes;
    }
  }

  // 変更が無いときは書き込まない (updated_at を動かさない)
  let row = current;
  if (statusChanged || notesChanged) {
    const { data: updatedData, error: updateError } = await supabase
      .from('inquiries')
      .update(update)
      .eq('id', id)
      .select(INQUIRY_COLUMNS)
      .maybeSingle();

    if (updateError) {
      log.error('問い合わせの更新に失敗しました', updateError, { inquiry_id: id });
      return errorResponse(500, 'INTERNAL_ERROR', '問い合わせの更新に失敗しました');
    }
    if (!updatedData) {
      // 読み込みから更新までの間に削除された
      return errorResponse(404, 'NOT_FOUND', '問い合わせが見つかりません');
    }
    row = updatedData as InquiryRow;
  }

  const { targetId, targetType } = inquiryAuditTarget(row);

  // 応答には本文と管理者メモが入るので、変更が無い更新でも記録する (閲覧の記録を迂回する読み取りにしない)。
  // ニックネームの解決と記録は互いに独立。どちらも失敗を握って (ログに残して) 続行する
  const [names] = await Promise.all([
    fetchNicknames([row.user_id], log),
    recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: 'admin.inquiry.update',
      targetId,
      targetType,
      // ステータスの前後と、メモを変えたかどうかだけ。メモの中身は入れない
      details: {
        inquiry_id: id,
        status_from: current.status,
        status_to: row.status,
        admin_notes_changed: notesChanged,
        changed: statusChanged || notesChanged,
      },
      request,
      routeName: `api/admin/inquiries/[id] ${method}`,
    }),
  ]);

  return NextResponse.json(
    { inquiry: toInquiryDto(row, row.user_id ? (names.get(row.user_id) ?? null) : null) },
    { headers: NO_STORE_HEADERS },
  );
}

export async function PATCH(request: Request, context: RouteContext) {
  return updateInquiry(request, context, 'PATCH');
}

export async function PUT(request: Request, context: RouteContext) {
  return updateInquiry(request, context, 'PUT');
}
