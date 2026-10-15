/**
 * GET /api/admin/sales/leads/[id] - リード詳細
 * PATCH /api/admin/sales/leads/[id] - リード更新 (ステージ変更含む)
 *
 * operator/02-api-spec.md §14 準拠
 * 権限: sales, admin, super_admin
 *
 * #1326: 詳細は担当者の連絡先と活動履歴を返すため、返すたびに admin.sales.lead.view を監査ログに残す
 * (対象はリード。details は返した項目名と活動履歴の件数だけで、値は入れない)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { updateLeadSchema } from '@/lib/admin/sales-schemas';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    const currentUser = await requireRole(['sales', 'admin', 'super_admin']);
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
      .single();

    if (error || !lead) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Lead not found' } },
        { status: 404 },
      );
    }

    // 活動履歴も取得
    const { data: activities } = await supabase
      .from('sales_lead_activities')
      .select('id, lead_id, actor_id, activity_type, details, created_at')
      .eq('lead_id', params.id)
      .order('created_at', { ascending: false });

    const body = { ...lead, activities: activities ?? [] };

    // #1326: 詳細を返す前に、誰がどのリードを見たかを監査ログに残す。404 は上で返しているので、
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
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: err.message } },
        { status: 403 },
      );
    }
    console.error('[sales/leads/[id]] GET error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const currentUser = await requireRole(['sales', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = updateLeadSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const updates = parseResult.data;

    // 現在のステージを取得 (ステージ変更の監査用)
    const { data: existingLead } = await supabase
      .from('sales_leads')
      .select('stage')
      .eq('id', params.id)
      .single();

    const { data: lead, error } = await supabase
      .from('sales_leads')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select()
      .single();

    if (error || !lead) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Lead not found' } },
        { status: 404 },
      );
    }

    // ステージ変更の場合は活動履歴に自動記録
    if (updates.stage && existingLead && updates.stage !== existingLead.stage) {
      await supabase.from('sales_lead_activities').insert({
        lead_id: params.id,
        actor_id: currentUser.id,
        activity_type: 'stage_change',
        details: {
          from_stage: existingLead.stage,
          to_stage: updates.stage,
        },
      });
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
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: err.message } },
        { status: 403 },
      );
    }
    console.error('[sales/leads/[id]] PATCH error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
