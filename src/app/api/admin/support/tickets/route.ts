/**
 * GET /api/admin/support/tickets - チケット一覧
 * POST /api/admin/support/tickets - チケット作成 (運営側起票)
 *
 * operator/02-api-spec.md §10 準拠
 * 権限: support, admin, super_admin
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { ticketListQuerySchema, createTicketSchema } from '@/lib/admin/support-schemas';

export async function GET(request: NextRequest) {
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);

    const { searchParams } = new URL(request.url);
    const queryResult = ticketListQuerySchema.safeParse({
      status: searchParams.get('status') ?? undefined,
      priority: searchParams.get('priority') ?? undefined,
      assignee_id: searchParams.get('assignee_id') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    if (!queryResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: queryResult.error.flatten() } },
        { status: 400 },
      );
    }

    const { status, priority, assignee_id, page, per_page } = queryResult.data;
    const supabase = createClient();

    let query = supabase
      .from('support_tickets')
      .select(
        `
        id,
        user_id,
        subject,
        category,
        priority,
        status,
        assignee_id,
        first_response_at,
        resolved_at,
        closed_at,
        organization_id,
        created_at,
        updated_at
      `,
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range((page - 1) * per_page, page * per_page - 1);

    if (status) query = query.eq('status', status);
    if (priority) query = query.eq('priority', priority);
    if (assignee_id) query = query.eq('assignee_id', assignee_id);

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
    console.error('[support/tickets] GET error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = createTicketSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const { user_id, subject, category, priority, body: messageBody } = parseResult.data;
    const supabase = createClient();

    // トランザクション的に ticket + 最初のメッセージを作成
    const { data: ticket, error: ticketError } = await supabase
      .from('support_tickets')
      .insert({ user_id, subject, category, priority, status: 'open' })
      .select()
      .single();

    if (ticketError || !ticket) {
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: ticketError?.message ?? 'Failed to create ticket' } },
        { status: 500 },
      );
    }

    // 最初のメッセージを作成 (運営側が起票したため is_internal = false)
    const { error: msgError } = await supabase.from('support_ticket_messages').insert({
      ticket_id: ticket.id,
      sender_id: currentUser.id,
      is_internal: false,
      body: messageBody,
    });

    if (msgError) {
      console.error('[support/tickets] Message creation failed:', msgError);
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: currentUser.id,
      action_type: 'admin.support.ticket.create',
      target_id: ticket.id,
      target_type: 'support_ticket',
      details: { subject, category, priority, user_id },
      severity: 'info',
      ip_address: request.headers.get('x-forwarded-for'),
    });

    return NextResponse.json({ data: ticket }, { status: 201 });
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
    console.error('[support/tickets] POST error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
