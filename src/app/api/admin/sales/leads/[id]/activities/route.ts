/**
 * GET /api/admin/sales/leads/[id]/activities - 活動履歴一覧
 * POST /api/admin/sales/leads/[id]/activities - 活動記録追加
 *
 * operator/02-api-spec.md §14 準拠
 * 権限: sales, admin, super_admin
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createActivitySchema } from '@/lib/admin/sales-schemas';

type RouteContext = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    await requireRole(['sales', 'admin', 'super_admin']);
    const supabase = createClient();

    const { data, error } = await supabase
      .from('sales_lead_activities')
      .select('id, lead_id, actor_id, activity_type, details, created_at')
      .eq('lead_id', params.id)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: error.message } },
        { status: 500 },
      );
    }

    return NextResponse.json({ data: data ?? [] });
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
    console.error('[sales/leads/[id]/activities] GET error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const currentUser = await requireRole(['sales', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = createActivitySchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const { activity_type, details } = parseResult.data;
    const supabase = createClient();

    // リード存在確認
    const { data: lead, error: leadError } = await supabase
      .from('sales_leads')
      .select('id')
      .eq('id', params.id)
      .single();

    if (leadError || !lead) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Lead not found' } },
        { status: 404 },
      );
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
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: activityError?.message ?? 'Failed to create activity' } },
        { status: 500 },
      );
    }

    // リードの updated_at を更新
    await supabase
      .from('sales_leads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', params.id);

    return NextResponse.json({ data: activity }, { status: 201 });
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
    console.error('[sales/leads/[id]/activities] POST error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
