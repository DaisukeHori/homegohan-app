/**
 * POST /api/admin/support/tickets/[id]/assign - 担当者割り当て
 *
 * operator/02-api-spec.md §10 準拠
 * 権限: support, admin, super_admin
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { assignTicketSchema } from '@/lib/admin/support-schemas';

type RouteContext = { params: { id: string } };

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = assignTicketSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const { assignee_id } = parseResult.data;
    const supabase = await createClient();

    const { data: ticket, error } = await supabase
      .from('support_tickets')
      .update({ assignee_id, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select()
      .single();

    if (error || !ticket) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Ticket not found' } },
        { status: 404 },
      );
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: currentUser.id,
      action_type: 'admin.support.ticket.assign',
      target_id: params.id,
      target_type: 'support_ticket',
      details: { assignee_id },
      severity: 'info',
      ip_address: request.headers.get('x-forwarded-for'),
    });

    return NextResponse.json({ data: ticket });
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
    console.error('[support/tickets/[id]/assign] POST error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
