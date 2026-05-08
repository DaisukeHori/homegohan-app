/**
 * GET /api/admin/sales/leads/[id] - リード詳細
 * PATCH /api/admin/sales/leads/[id] - リード更新 (ステージ変更含む)
 *
 * operator/02-api-spec.md §14 準拠
 * 権限: sales, admin, super_admin
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { updateLeadSchema } from '@/lib/admin/sales-schemas';

type RouteContext = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    await requireRole(['sales', 'admin', 'super_admin']);
    const supabase = createClient();

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

    return NextResponse.json({ data: { ...lead, activities: activities ?? [] } });
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

export async function PATCH(request: NextRequest, { params }: RouteContext) {
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

    const supabase = createClient();
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
    await supabase.from('admin_audit_logs').insert({
      actor_id: currentUser.id,
      action_type: 'admin.sales.lead.update',
      target_id: params.id,
      target_type: 'sales_lead',
      details: updates,
      severity: 'info',
      ip_address: request.headers.get('x-forwarded-for'),
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
