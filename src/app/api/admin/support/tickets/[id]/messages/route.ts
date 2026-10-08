/**
 * GET /api/admin/support/tickets/[id]/messages - メッセージ一覧
 * POST /api/admin/support/tickets/[id]/messages - メッセージ追加
 *
 * operator/02-api-spec.md §10 準拠
 * 内部メモ (is_internal=true) は support / admin / super_admin のみ閲覧・作成可能
 *
 * 顧客向けメッセージ (is_internal=false) を投稿すると、顧客本人へメールで知らせる (#1183)。
 * 顧客がチケットを閲覧できる画面は無く、このメールが唯一の通知経路。
 * メールが送れなくてもメッセージは保存済みなので 201 を返し、送信結果は応答の `email` に載せる。
 * 内部メモはメールにしない。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createMessageSchema } from '@/lib/admin/support-schemas';
import { recordAdminAudit } from '@/lib/admin/audit';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { sendTicketReplyEmail } from '@/lib/admin/send-ticket-reply-email';
import type { ReplyEmailOutcome } from '@/lib/admin/support-reply-email-status';

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

    const messages = data ?? [];

    // #1200: チケットの詳細 GET と同じメッセージ本文を返すため、こちらも閲覧を記録する。
    // メッセージを 1 件も返さないときは何も開示していないため記録しない。
    // 対象は「情報を見られた本人 (チケットを作ったユーザー)」にそろえる。
    // チケットの持ち主を引けなかったときも記録は残したいので、チケット自体を対象にして記録する。
    // 記録に失敗しても閲覧は止めない (失敗は db-logger に error で残る)。
    // details には返した項目名だけを入れ、メッセージ本文は入れない。
    if (messages.length > 0) {
      let ticketOwnerId: string | null = null;
      try {
        const { data: ticketOwner } = await supabase
          .from('support_tickets')
          .select('user_id')
          .eq('id', params.id)
          .maybeSingle();
        ticketOwnerId = ticketOwner?.user_id ?? null;
      } catch {
        // 持ち主を引けなくても閲覧は止めない。下でチケットを対象にして記録する。
      }

      await recordAdminAudit({
        supabase,
        actorId: currentUser.id,
        actionType: 'admin.support.ticket.view_messages',
        targetId: ticketOwnerId ?? params.id,
        targetType: ticketOwnerId ? 'user' : 'support_ticket',
        details: { ticket_id: params.id, viewed_fields: Object.keys(messages[0]) },
        request,
        routeName: 'api/admin/support/tickets/[id]/messages GET',
      });
    }

    return NextResponse.json({ data: messages });
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
  const logger = createLogger('POST /api/admin/support/tickets/[id]/messages', generateRequestId());

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

    // チケット存在確認 (subject は顧客へのメールに載せる)
    const { data: ticket, error: ticketError } = await supabase
      .from('support_tickets')
      .select('id, status, user_id, subject')
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

    // 内部メモ (is_internal=true) は顧客に見せないため、メールにしない (email は応答に含めない)
    let email: ReplyEmailOutcome | undefined;

    // 顧客向けメッセージ (is_internal=false) の場合
    if (!is_internal) {
      // first_response_at が未設定の場合は設定
      // (メール通知の成否に関わらず、返信を投稿した時点で記録する)
      await supabase
        .from('support_tickets')
        .update({
          first_response_at: new Date().toISOString(),
          status: ticket.status === 'open' ? 'in_progress' : ticket.status,
          updated_at: new Date().toISOString(),
        })
        .eq('id', params.id)
        .is('first_response_at', null);

      // 顧客本人へメールで知らせる。送れなくても (キー未設定・宛先なし・Resend の失敗)
      // メッセージは保存済みなので返信は成功させ、結果を email に載せて画面で案内する。
      // sendTicketReplyEmail は例外を投げず、失敗は app_logs に記録する。
      email = await sendTicketReplyEmail({
        ticket: { id: ticket.id, user_id: ticket.user_id, subject: ticket.subject },
        messageId: message.id,
        messageBody,
        logger: logger.withUser(currentUser.id),
      });
    }

    return NextResponse.json({ data: message, email }, { status: 201 });
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
