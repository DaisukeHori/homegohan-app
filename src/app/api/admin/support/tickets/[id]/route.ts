/**
 * GET /api/admin/support/tickets/[id] - チケット詳細
 * PATCH /api/admin/support/tickets/[id] - ステータス・優先度変更
 *
 * operator/02-api-spec.md §10 準拠
 * 権限: support, admin, super_admin
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { updateTicketSchema } from '@/lib/admin/support-schemas';

type RouteContext = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);
    const supabase = await createClient();

    const { data: ticket, error } = await supabase
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
      )
      .eq('id', params.id)
      .single();

    if (error || !ticket) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Ticket not found' } },
        { status: 404 },
      );
    }

    // メッセージ取得 (内部メモは support / admin / super_admin のみ)
    const isInternalAllowed = currentUser.roles.some((r) =>
      ['support', 'admin', 'super_admin'].includes(r),
    );

    let messagesQuery = supabase
      .from('support_ticket_messages')
      .select('id, ticket_id, sender_id, is_internal, body, attachments, created_at')
      .eq('ticket_id', params.id)
      .order('created_at', { ascending: true });

    if (!isInternalAllowed) {
      messagesQuery = messagesQuery.eq('is_internal', false);
    }

    const { data: messages } = await messagesQuery;

    return NextResponse.json({ data: { ...ticket, messages: messages ?? [] } });
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
    console.error('[support/tickets/[id]] GET error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = updateTicketSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const updates = parseResult.data;

    // resolved 状態に変更する場合は resolved_at を設定
    const extraUpdates: Record<string, unknown> = {};
    if (updates.status === 'resolved') {
      extraUpdates.resolved_at = new Date().toISOString();
    } else if (updates.status === 'closed') {
      extraUpdates.closed_at = new Date().toISOString();
    }

    const { data: ticket, error } = await supabase
      .from('support_tickets')
      .update({ ...updates, ...extraUpdates, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select()
      .single();

    if (error || !ticket) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Ticket not found' } },
        { status: 404 },
      );
    }

    // 監査ログ (状態変更は記録必須)
    await supabase.from('admin_audit_logs').insert({
      actor_id: currentUser.id,
      action_type: 'admin.support.ticket.update',
      target_id: params.id,
      target_type: 'support_ticket',
      details: updates,
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
    console.error('[support/tickets/[id]] PATCH error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
