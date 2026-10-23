/**
 * GET   /api/admin/inquiries/[id] - 問い合わせ詳細 (#1121)
 * PATCH /api/admin/inquiries/[id] - ステータス・管理者メモの更新 (モバイルの問い合わせ画面が使っていた。その画面は #1598 で消した)
 * PUT   /api/admin/inquiries/[id] - 同上 (Web。PATCH と同じ処理)
 *
 * 呼び出し元: Web の /support/inquiries (モバイルの support の問い合わせ画面も呼んでいたが、通常の操作で届かない画面として消した。#1598)。
 * 応答は { inquiry: {...} } (camelCase)。更新の入力は { status?, adminNotes? }。
 * 権限: admin, super_admin, support
 *
 * 詳細は問い合わせ本文と管理者メモを返すため、返すたびに admin_audit_logs へ記録する
 * (admin.inquiry.view。#1200 の方針: 対象は情報を見られた本人、details は項目名だけ、記録に失敗しても返す)。
 * 更新も、更新後の問い合わせ (本文を含む) を返すので、変更が無い更新を含めて毎回記録する (admin.inquiry.update)。
 *
 * 同時の更新: 更新は「直前に読んだ status と updated_at のままなら書く」条件つきにする (読んでから書くまでに
 * 別の運営が変えていたら 0 行。updated_at は inquiries の UPDATE のたびにトリガー trigger_inquiries_updated_at が進める)。
 * 0 行なら読み直し、送られた変更がすでに入っていれば書かずに今の行を返し (変更なしとして記録する)、
 * 入っていなければ 409 CONFLICT_STALE_DATA (cross/04 §4.2)。これで監査の status_from と resolved_at の元にした値は、
 * 書いた時点の実際の直前の値と必ず一致し、読んでから書くまでの間に別の運営が書いた管理者メモを黙って上書きしない。
 * (管理者メモ自体を条件にしないのは、最大 5000 文字のメモが PostgREST の URL に入ってしまうため。updated_at で足りる)
 * 条件はこの要求の中で読んだ値なので、画面を開いてから保存するまでの間の変更は見分けない (画面が読んだ updated_at を送る形にはしていない)。
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
  inquiryUpdateAlreadyApplied,
  inquiryUpdateBodySchema,
  nextResolvedAt,
  normalizeAdminNotes,
  toInquiryDto,
  type InquiryRow,
} from '@/lib/admin/inquiries';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 読んでから書くまでに別の運営がこの問い合わせを変えていた (条件つきの更新が 0 行で、送られた変更が入っていない) */
const STALE_INQUIRY_MESSAGE = '別の運営が先にこの問い合わせを更新しました。画面を開き直して、もう一度確認してください';

export async function GET(request: Request, props: RouteContext) {
  const params = await props.params;
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
    return errorResponse(400, 'VALIDATION_ERROR', '問い合わせの ID (id) が正しくありません', idResult.error.flatten());
  }
  const id = idResult.data;

  const supabase = await createClient();
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

  const idResult = inquiryIdSchema.safeParse((await params).id);
  if (!idResult.success) {
    return errorResponse(400, 'VALIDATION_ERROR', '問い合わせの ID (id) が正しくありません', idResult.error.flatten());
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
  const supabase = await createClient();
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
  // 監査の status_from: この要求が書いた直前の値 (書かなかったときは返す行の値)
  let statusFrom = current.status;
  if (statusChanged || notesChanged) {
    // 直前に読んだ status と updated_at のままのときだけ書く (読んでから書くまでに別の運営が変えていたら 0 行)。
    // updated_at の列は NULL を許すので、読んだ値が NULL なら .eq ではなく .is で比べる (PostgREST の eq.null は NULL に一致しない)
    const updateQuery = supabase
      .from('inquiries')
      .update(update)
      .eq('id', id)
      .eq('status', current.status);
    const { data: updatedData, error: updateError } = await (current.updated_at === null
      ? updateQuery.is('updated_at', null)
      : updateQuery.eq('updated_at', current.updated_at)
    )
      .select(INQUIRY_COLUMNS)
      .maybeSingle();

    if (updateError) {
      log.error('問い合わせの更新に失敗しました', updateError, { inquiry_id: id });
      return errorResponse(500, 'INTERNAL_ERROR', '問い合わせの更新に失敗しました');
    }
    if (updatedData) {
      row = updatedData as InquiryRow;
    } else {
      // 0 行: 読んでから書くまでに、別の運営がこの問い合わせを変えた (または消えた)。読み直して決める
      const { data: rereadData, error: rereadError } = await supabase
        .from('inquiries')
        .select(INQUIRY_COLUMNS)
        .eq('id', id)
        .maybeSingle();
      if (rereadError) {
        log.error('問い合わせの読み直しに失敗しました', rereadError, { inquiry_id: id });
        return errorResponse(500, 'INTERNAL_ERROR', '問い合わせの更新に失敗しました');
      }
      if (!rereadData) {
        return errorResponse(404, 'NOT_FOUND', '問い合わせが見つかりません');
      }
      const reread = rereadData as InquiryRow;
      if (!inquiryUpdateAlreadyApplied(reread, input)) {
        // 書いていないので記録もしない (先の運営の変更は、その運営の監査に残っている)
        return errorResponse(409, 'CONFLICT_STALE_DATA', STALE_INQUIRY_MESSAGE);
      }
      // 別の運営が同じ変更を先にしていた: 書かずに今の行を返す。本文を返すので、変更なしとして記録する
      row = reread;
      statusFrom = reread.status;
      statusChanged = false;
      notesChanged = false;
    }
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
        status_from: statusFrom,
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
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  return updateInquiry(request, context, 'PATCH');
}

export async function PUT(request: Request, context: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  return updateInquiry(request, context, 'PUT');
}
