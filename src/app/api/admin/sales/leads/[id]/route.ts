/**
 * GET /api/admin/sales/leads/[id] - リード詳細
 * PATCH /api/admin/sales/leads/[id] - リード更新 (ステージ変更含む)
 *
 * operator/02-api-spec.md §14 準拠
 * 権限: sales, admin, super_admin
 *
 * #1326: 詳細は担当者の連絡先と活動履歴を返すため、返すたびに admin.sales.lead.view を監査ログに残す
 * (対象はリード。details は返した項目名と活動履歴の件数だけで、値は入れない)。
 *
 * 読み込みの DB の失敗 (#1917 の整合の候補 C19): GET のリードの読み込みと活動履歴の読み込みは、DB の失敗を 500 INTERNAL_ERROR にし、
 * リードの行が無いときだけ 404 にする (一時的な失敗でリードが消えたように見せない。PATCH の「読み込みの失敗は 500」と同じ)。
 * 活動履歴の読み込みの失敗も空の履歴にせず 500 にする (履歴が無いように見せない)。
 * UUID の形でない id は、DB に渡す前に 404 NOT_FOUND で断る (GET・PATCH とも)。uuid 型の列に渡すと 22P02 で失敗し、
 * 上の「DB の失敗は 500」に入ってしまうため (形の違う id は「そのリードは無い」と同じに扱う)。
 * PATCH の本文が JSON として読めないときは 400 INVALID_JSON (外側の catch の 500 に落とさない。#1917)。
 *
 * ステージの変更の活動履歴 (#1917 の整合の候補 C20): stage_change の書き込みに失敗しても、リードの更新は書けているので応答は 200 のまま
 * (監査ログと同じ fail-open)。失敗は db-logger に error で残す (黙って捨てない)。
 *
 * 同時の更新 (#1917 の整合の候補と同じ型): ステージを送った更新は「直前に読んだ stage のままなら書く」条件つきにする
 * (読んでから書くまでに別の担当者がステージを変えていたら 0 行)。0 行なら読み直し、行が無ければ 404、
 * あれば 409 CONFLICT_STALE_DATA (cross/04 §4.2)。これで活動履歴の stage_change の from_stage は、
 * 書いた時点の実際の直前のステージと必ず一致する (別の担当者が変えたステージを、履歴に残さずに戻すこともない)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED, authFailureNested, invalidJsonNested } from '@/lib/api/error-responses';
import { updateLeadSchema } from '@/lib/admin/sales-schemas';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { errorCodeOf, internalError, toLoggableError } from '@/lib/api/errors';
import { createLogger } from '@/lib/db-logger';
import { isUuid, readJsonBody } from '@/lib/http-params';

/** 400: 本文・クエリの検証の失敗の文 (項目ごとの理由は details に添える。message は画面がそのまま出す文なので文字列にする) */
const VALIDATION_ERROR_MESSAGE = '入力内容を確認してください';

type RouteContext = { params: Promise<{ id: string }> };

/** 読んでから書くまでに別の担当者がステージを変えていた (条件つきの更新が 0 行で、リードはある) */
const STALE_LEAD_RESPONSE = {
  error: { code: 'CONFLICT_STALE_DATA', message: '別の担当者が先にこのリードのステージを変えました。画面を開き直して、もう一度確認してください' },
} as const;

const LEAD_NOT_FOUND_RESPONSE = { error: { code: 'NOT_FOUND', message: 'リードが見つかりません' } } as const;

/** 構造化ログ (app_logs.function_name) に出す名前 */
const GET_ROUTE_NAME = 'GET /api/admin/sales/leads/[id]';
const PATCH_ROUTE_NAME = 'PATCH /api/admin/sales/leads/[id]';

/** 活動履歴の stage_change の書き込みの失敗を db-logger に error で残す (応答は変えない。記録の失敗で更新の応答を止めない) */
const STAGE_CHANGE_ACTIVITY_FAILURE_MESSAGE = 'ステージの変更の活動履歴 (sales_lead_activities の stage_change) の書き込みに失敗しました';

function logStageChangeActivityFailure(
  error: unknown,
  context: { userId: string; leadId: string; fromStage: string; toStage: string },
): void {
  try {
    const errorCode = errorCodeOf(error);
    createLogger(PATCH_ROUTE_NAME)
      .withUser(context.userId)
      .error(STAGE_CHANGE_ACTIVITY_FAILURE_MESSAGE, toLoggableError(error), {
        ...(errorCode ? { error_code: errorCode } : {}),
        lead_id: context.leadId,
        from_stage: context.fromStage,
        to_stage: context.toStage,
      });
  } catch {
    // ログ出力の失敗で、更新の応答を止めない
  }
}

export async function GET(request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    const currentUser = await requireRole(['sales', 'admin', 'super_admin']);

    // UUID の形でない id は DB に渡さず 404 (渡すと 22P02 で下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(LEAD_NOT_FOUND_RESPONSE, { status: 404 });
    }

    const supabase = await createClient();

    const { data: lead, error } = await supabase
      .from('sales_leads')
      .select(
        `
        id,
        company_name,
        industry,
        employee_count,
        contact_name,
        contact_email,
        contact_phone,
        source,
        stage,
        assigned_to,
        estimated_acv,
        notes,
        converted_org_id,
        created_at,
        updated_at
      `,
      )
      .eq('id', params.id)
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ 404)
    if (error) {
      return internalError(GET_ROUTE_NAME, error, { userId: currentUser.id, table: 'sales_leads' }, { shape: 'nested' });
    }
    if (!lead) {
      return NextResponse.json(LEAD_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // 活動履歴も取得。読めなかったときは空の履歴にしない (500)
    const { data: activities, error: activitiesError } = await supabase
      .from('sales_lead_activities')
      .select('id, lead_id, actor_id, activity_type, details, created_at')
      .eq('lead_id', params.id)
      .order('created_at', { ascending: false });

    if (activitiesError) {
      return internalError(GET_ROUTE_NAME, activitiesError, { userId: currentUser.id, table: 'sales_lead_activities' }, { shape: 'nested' });
    }

    const body = { ...lead, activities: activities ?? [] };

    // #1326: 詳細を返す前に、誰がどのリードを見たかを監査ログに残す。404・500 は上で返しているので、
    // ここに来るのは情報を返すときだけ。details は項目名と活動履歴の件数だけ (連絡先などの値は入れない)。
    // 記録に失敗しても閲覧は止めない (失敗は db-logger に error で残る)
    await recordAdminAudit({
      supabase,
      actorId: currentUser.id,
      actionType: 'admin.sales.lead.view',
      targetId: params.id,
      targetType: 'sales_lead',
      details: { viewed_fields: Object.keys(body), activity_count: body.activities.length },
      request,
      routeName: 'api/admin/sales/leads/[id] GET',
    });

    return NextResponse.json({ data: body });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('GET /api/admin/sales/leads/[id]', err, { log_context: '[sales/leads/[id]] GET error' }, { shape: 'nested' });
  }
}

export async function PATCH(request: NextRequest, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const currentUser = await requireRole(['sales', 'admin', 'super_admin']);

    // 壊れた JSON は 400 INVALID_JSON (外側の catch の 500 に落とさない)
    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) return invalidJsonNested();
    const parseResult = updateLeadSchema.safeParse(bodyResult.body);
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

    const supabase = await createClient();
    const updates = parseResult.data;

    // 現在のステージを取得 (ステージ変更の活動履歴の from_stage 用)。読めなかったときは 404 にしない (行が無いときだけ 404)
    const { data: existingLead, error: readError } = await supabase
      .from('sales_leads')
      .select('stage')
      .eq('id', params.id)
      .maybeSingle();

    if (readError) {
      return internalError('PATCH /api/admin/sales/leads/[id]', readError, { log_context: '[sales/leads/[id]] PATCH read error' }, { shape: 'nested' });
    }
    if (!existingLead) {
      return NextResponse.json(LEAD_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // ステージを送ったときは、直前に読んだ stage のままのときだけ書く (読んでから書くまでに別の担当者が変えていたら 0 行)
    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const updateQuery = getSupabaseAdmin()
      .from('sales_leads')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', params.id);
    const { data: lead, error } = await (updates.stage !== undefined
      ? updateQuery.eq('stage', existingLead.stage)
      : updateQuery
    )
      .select()
      .maybeSingle();

    if (error) {
      return internalError('PATCH /api/admin/sales/leads/[id]', error, { log_context: '[sales/leads/[id]] PATCH update error' }, { shape: 'nested' });
    }
    if (!lead) {
      if (updates.stage === undefined) {
        // 読み込みから更新までの間に削除された
        return NextResponse.json(LEAD_NOT_FOUND_RESPONSE, { status: 404 });
      }
      // 0 行: 別の担当者がステージを変えた (またはリードが消えた)。読み直して決める
      const { data: currentLead, error: rereadError } = await supabase
        .from('sales_leads')
        .select('id')
        .eq('id', params.id)
        .maybeSingle();
      if (rereadError) {
        return internalError('PATCH /api/admin/sales/leads/[id]', rereadError, { log_context: '[sales/leads/[id]] PATCH reread error' }, { shape: 'nested' });
      }
      if (!currentLead) {
        return NextResponse.json(LEAD_NOT_FOUND_RESPONSE, { status: 404 });
      }
      // 書いていないので、活動履歴も監査ログも残さない
      return NextResponse.json(STALE_LEAD_RESPONSE, { status: 409 });
    }

    // ステージ変更の場合は活動履歴に自動記録 (from_stage は条件つきの更新で確かめた直前の値)
    // 書き込みに失敗しても、リードの更新は書けているので応答は 200 のまま (監査ログと同じ fail-open)。失敗は db-logger に error で残す
    if (updates.stage !== undefined && updates.stage !== existingLead.stage) {
      // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
      const { error: activityError } = await getSupabaseAdmin().from('sales_lead_activities').insert({
        lead_id: params.id,
        actor_id: currentUser.id,
        activity_type: 'stage_change',
        details: {
          from_stage: existingLead.stage,
          to_stage: updates.stage,
        },
      });
      if (activityError) {
        logStageChangeActivityFailure(activityError, {
          userId: currentUser.id,
          leadId: params.id,
          fromStage: existingLead.stage,
          toStage: updates.stage,
        });
      }
    }

    // 監査ログ
    await recordAdminAudit({
      supabase,
      actorId: currentUser.id,
      actionType: 'admin.sales.lead.update',
      targetId: params.id,
      targetType: 'sales_lead',
      details: updates,
      severity: 'info',
      request,
      routeName: 'api/admin/sales/leads/[id] PATCH',
    });

    return NextResponse.json({ data: lead });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('PATCH /api/admin/sales/leads/[id]', err, { log_context: '[sales/leads/[id]] PATCH error' }, { shape: 'nested' });
  }
}
