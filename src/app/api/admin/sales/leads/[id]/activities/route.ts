/**
 * GET /api/admin/sales/leads/[id]/activities - 活動履歴一覧
 * POST /api/admin/sales/leads/[id]/activities - 活動記録追加
 *
 * operator/02-api-spec.md §14 準拠
 * 権限: sales, admin, super_admin
 *
 * #1571: 活動の記録は運営の操作で状態 (営業リードの活動履歴) を変えるので、
 * 追加できたときに admin.sales.lead.activity_add を監査ログに 1 行残す (対象はリード。details は活動の種類と ID だけ)。
 *
 * 読み込みの DB の失敗 (#1917 の整合の候補 C19 と同じ型): 追加の前のリードの存在の確認は、DB の失敗を 500 INTERNAL_ERROR にし、
 * リードの行が無いときだけ 404 にする (一時的な失敗でリードが消えたように見せない)。
 * UUID の形でない id は、DB に渡す前に 404 NOT_FOUND で断る (GET・POST とも)。uuid 型の列に渡すと 22P02 で失敗し、
 * 「DB の失敗は 500」に入ってしまうため (形の違う id は「そのリードは無い」と同じに扱う)。
 * 追加のあとのリードの updated_at の更新に失敗しても、活動は追加できているので 201 のまま (fail-open)。失敗は db-logger に error で残す。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED, authFailureNested } from '@/lib/api/error-responses';
import { createActivitySchema } from '@/lib/admin/sales-schemas';
import { errorCodeOf, internalError, toLoggableError } from '@/lib/api/errors';
import { createLogger } from '@/lib/db-logger';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { recordAdminAudit } from '@/lib/admin/audit';
import { isUuid } from '@/lib/http-params';

/** 400: 本文・クエリの検証の失敗の文 (項目ごとの理由は details に添える。message は画面がそのまま出す文なので文字列にする) */
const VALIDATION_ERROR_MESSAGE = '入力内容を確認してください';

type RouteContext = { params: Promise<{ id: string }> };

const LEAD_NOT_FOUND_RESPONSE = { error: { code: 'NOT_FOUND', message: 'リードが見つかりません' } } as const;

/** 構造化ログ (app_logs.function_name) に出す名前 */
const POST_ROUTE_NAME = 'POST /api/admin/sales/leads/[id]/activities';

/** 活動の追加のあとのリードの updated_at の更新の失敗を db-logger に error で残す (応答は変えない) */
const LEAD_TOUCH_FAILURE_MESSAGE = '活動の追加のあとのリード (sales_leads) の updated_at の更新に失敗しました';

function logLeadTouchFailure(error: unknown, context: { userId: string; leadId: string; activityId: string }): void {
  try {
    const errorCode = errorCodeOf(error);
    createLogger(POST_ROUTE_NAME)
      .withUser(context.userId)
      .error(LEAD_TOUCH_FAILURE_MESSAGE, toLoggableError(error), {
        ...(errorCode ? { error_code: errorCode } : {}),
        lead_id: context.leadId,
        activity_id: context.activityId,
      });
  } catch {
    // ログ出力の失敗で、追加の応答を止めない
  }
}

export async function GET(_request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    await requireRole(['sales', 'admin', 'super_admin']);

    // UUID の形でない id は DB に渡さず 404 (渡すと 22P02 で下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(LEAD_NOT_FOUND_RESPONSE, { status: 404 });
    }

    const supabase = await createClient();

    const { data, error } = await supabase
      .from('sales_lead_activities')
      .select('id, lead_id, actor_id, activity_type, details, created_at')
      .eq('lead_id', params.id)
      .order('created_at', { ascending: false });

    if (error) {
      return internalError('GET /api/admin/sales/leads/[id]/activities', error, {}, { shape: 'nested' });
    }

    return NextResponse.json({ data: data ?? [] });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('GET /api/admin/sales/leads/[id]/activities', err, { log_context: '[sales/leads/[id]/activities] GET error' }, { shape: 'nested' });
  }
}

export async function POST(request: NextRequest, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const currentUser = await requireRole(['sales', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = createActivitySchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: VALIDATION_ERROR_MESSAGE, details: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    // UUID の形でない id は DB に渡さず 404 (渡すと 22P02 で下の「読み込みの DB の失敗は 500」に入る)。
    // 本文の検査のあとに置くのは、行が無い UUID と同じ順 (400 → 404) にそろえるため
    if (!isUuid(params.id)) {
      return NextResponse.json(LEAD_NOT_FOUND_RESPONSE, { status: 404 });
    }

    const { activity_type, details } = parseResult.data;
    const supabase = await createClient();

    // リード存在確認。読めなかったときは 404 にしない (行が無いときだけ 404)
    const { data: lead, error: leadError } = await supabase
      .from('sales_leads')
      .select('id')
      .eq('id', params.id)
      .maybeSingle();

    if (leadError) {
      return internalError(POST_ROUTE_NAME, leadError, { userId: currentUser.id, table: 'sales_leads' }, { shape: 'nested' });
    }
    if (!lead) {
      return NextResponse.json(LEAD_NOT_FOUND_RESPONSE, { status: 404 });
    }

    const { data: activity, error: activityError } = await supabase
      .from('sales_lead_activities')
      .insert({
        lead_id: params.id,
        actor_id: currentUser.id,
        activity_type,
        details,
      })
      .select()
      .single();

    if (activityError || !activity) {
      return internalError(POST_ROUTE_NAME, activityError, { userId: currentUser.id }, { shape: 'nested' });
    }

    // リードの updated_at を更新。失敗しても活動は追加できているので 201 のまま (失敗は db-logger に error で残す)
    const { error: touchError } = await supabase
      .from('sales_leads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', params.id);
    if (touchError) {
      logLeadTouchFailure(touchError, { userId: currentUser.id, leadId: params.id, activityId: activity.id });
    }

    // 監査ログ (#1571)。活動の本文 (details) は営業メモで連絡先などを含みうるので入れない。記録に失敗しても追加は成功のまま (失敗は db-logger に残る)
    await recordAdminAudit({
      supabase,
      actorId: currentUser.id,
      actionType: 'admin.sales.lead.activity_add',
      targetId: params.id,
      targetType: 'sales_lead',
      details: { activity_id: activity.id, activity_type },
      request,
      routeName: 'api/admin/sales/leads/[id]/activities POST',
    });

    return NextResponse.json({ data: activity }, { status: 201 });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('POST /api/admin/sales/leads/[id]/activities', err, { log_context: '[sales/leads/[id]/activities] POST error' }, { shape: 'nested' });
  }
}
