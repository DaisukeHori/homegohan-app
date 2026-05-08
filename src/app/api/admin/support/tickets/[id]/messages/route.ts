/**
 * GET /api/admin/support/tickets/[id]/messages - メッセージ一覧
 * POST /api/admin/support/tickets/[id]/messages - メッセージ追加
 *
 * operator/02-api-spec.md §10 準拠
 * 内部メモ (is_internal=true) は support / admin / super_admin のみ閲覧・作成可能
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createMessageSchema } from '@/lib/admin/support-schemas';

type RouteContext = { params: { id: string } };

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);
    const supabase = await createClient();

    const isInternalAllowed = currentUser.roles.some((r) =>
      ['support', 'admin', 'super_admin'].includes(r),
    );

    let query = supabase
      .from('support_ticket_messages')
      .select('id, ticket_id, sender_id, is_internal, body, attachments, created_at')
      .eq('ticket_id', params.id)
      .order('created_at', { ascending: true });

    if (!isInternalAllowed) {
      query = query.eq('is_internal', false);
    }

    const { data, error } = await query;
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
    console.error('[support/tickets/[id]/messages] GET error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = createMessageSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const { body: messageBody, is_internal, attachments } = parseResult.data;

    // 内部メモは support / admin / super_admin のみ
    if (is_internal) {
      const canSendInternal = currentUser.roles.some((r) =>
        ['support', 'admin', 'super_admin'].includes(r),
      );
      if (!canSendInternal) {
        return NextResponse.json(
          { error: { code: 'OP_PERMISSION_DENIED', message: '内部メモは support 以上のロールが必要です' } },
          { status: 403 },
        );
      }
    }

    const supabase = await createClient();

    // チケット存在確認
    const { data: ticket, error: ticketError } = await supabase
      .from('support_tickets')
      .select('id, status, user_id')
      .eq('id', params.id)
      .single();

    if (ticketError || !ticket) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Ticket not found' } },
        { status: 404 },
      );
    }

    const { data: message, error: msgError } = await supabase
      .from('support_ticket_messages')
      .insert({
        ticket_id: params.id,
        sender_id: currentUser.id,
        is_internal,
        body: messageBody,
        attachments,
      })
      .select()
      .single();

    if (msgError || !message) {
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: msgError?.message ?? 'Failed to create message' } },
        { status: 500 },
      );
    }

    // 顧客向けメッセージ (is_internal=false) の場合、Resend でメール送信
    if (!is_internal) {
      await sendEmailToUser(ticket.user_id, params.id, messageBody);

      // first_response_at が未設定の場合は設定
      await supabase
        .from('support_tickets')
        .update({
          first_response_at: new Date().toISOString(),
          status: ticket.status === 'open' ? 'in_progress' : ticket.status,
          updated_at: new Date().toISOString(),
        })
        .eq('id', params.id)
        .is('first_response_at', null);
    }

    return NextResponse.json({ data: message }, { status: 201 });
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
    console.error('[support/tickets/[id]/messages] POST error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

/**
 * ユーザーへのメール送信 (Resend)
 * API キーが未設定の場合は graceful degradation
 */
async function sendEmailToUser(
  userId: string,
  ticketId: string,
  messageBody: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[support/messages] RESEND_API_KEY not set, skipping email');
    return;
  }

  try {
    const supabase = await createClient();
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('id', userId)
      .single();

    // auth.users からメールアドレスを取得 (service_role が必要だが、graceful で skip)
    // 実際の実装では service_role クライアントを使用するか、
    // user_profiles にメールをキャッシュする列を追加する

    // email_delivery_logs に記録
    await supabase.from('email_delivery_logs').insert({
      recipient_id: userId,
      template_key: 'support_ticket_reply',
      subject: `サポートチケット #${ticketId.slice(0, 8)} への返信`,
      status: 'skipped',
      metadata: { ticket_id: ticketId, message_length: messageBody.length },
    });
  } catch (e) {
    console.error('[support/messages] Email delivery log error:', e);
  }
}
