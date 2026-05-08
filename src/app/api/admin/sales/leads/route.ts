/**
 * GET /api/admin/sales/leads - 見込み客一覧
 * POST /api/admin/sales/leads - 見込み客作成
 *
 * operator/02-api-spec.md §14 準拠
 * 権限: sales, admin, super_admin
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { leadListQuerySchema, createLeadSchema } from '@/lib/admin/sales-schemas';

export async function GET(request: NextRequest) {
  try {
    const currentUser = await requireRole(['sales', 'admin', 'super_admin']);

    const { searchParams } = new URL(request.url);
    const queryResult = leadListQuerySchema.safeParse({
      stage: searchParams.get('stage') ?? undefined,
      assigned_to: searchParams.get('assigned_to') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    if (!queryResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: queryResult.error.flatten() } },
        { status: 400 },
      );
    }

    const { stage, assigned_to, page, per_page } = queryResult.data;
    const supabase = createClient();

    let query = supabase
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
        { count: 'exact' },
      )
      .order('updated_at', { ascending: false })
      .range((page - 1) * per_page, page * per_page - 1);

    if (stage) query = query.eq('stage', stage);
    if (assigned_to) query = query.eq('assigned_to', assigned_to);

    const { data, error, count } = await query;

    if (error) {
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: error.message } },
        { status: 500 },
      );
    }

    return NextResponse.json({
      data,
      meta: { total: count ?? 0, page, per_page },
    });
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
    console.error('[sales/leads] GET error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const currentUser = await requireRole(['sales', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = createLeadSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const supabase = createClient();
    const inputData = parseResult.data;

    // assigned_to が未指定の場合は作成者を割り当て
    const insertData = {
      ...inputData,
      assigned_to: inputData.assigned_to ?? currentUser.id,
      contact_email: inputData.contact_email || null,
    };

    const { data: lead, error } = await supabase
      .from('sales_leads')
      .insert(insertData)
      .select()
      .single();

    if (error || !lead) {
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: error?.message ?? 'Failed to create lead' } },
        { status: 500 },
      );
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: currentUser.id,
      action_type: 'admin.sales.lead.create',
      target_id: lead.id,
      target_type: 'sales_lead',
      details: { company_name: insertData.company_name, stage: 'approach' },
      severity: 'info',
      ip_address: request.headers.get('x-forwarded-for'),
    });

    return NextResponse.json({ data: lead }, { status: 201 });
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
    console.error('[sales/leads] POST error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
