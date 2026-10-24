/**
 * GET /api/admin/support/tickets - チケット一覧
 * POST /api/admin/support/tickets - チケット作成 (運営側起票)
 *
 * operator/02-api-spec.md §10 準拠
 * 権限: support, admin, super_admin
 *
 * #1326: 一覧は 1 件以上返したとき、1 回の取得 = 1 行で admin.support.ticket.list を監査ログに残す
 * (絞り込みの条件と件数だけ。返したチケットの ID や件名は入れない)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED, authFailureNested } from '@/lib/api/error-responses';
import { ticketListQuerySchema, createTicketSchema } from '@/lib/admin/support-schemas';
import { internalError } from '@/lib/api/errors';
import { buildListViewDetails, recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

/** 400: 本文・クエリの検証の失敗の文 (項目ごとの理由は details に添える。message は画面がそのまま出す文なので文字列にする) */
const VALIDATION_ERROR_MESSAGE = '入力内容を確認してください';

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
        { error: { code: 'VALIDATION_ERROR', message: VALIDATION_ERROR_MESSAGE, details: queryResult.error.flatten() } },
        { status: 400 },
      );
    }

    const { status, priority, assignee_id, page, per_page } = queryResult.data;
    const supabase = await createClient();

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
      return internalError('GET /api/admin/support/tickets', error, { userId: currentUser.id }, { shape: 'nested' });
    }

    const rows = data ?? [];
    // #1326: 一覧の閲覧を 1 回 = 1 行で残す。0 件のときは情報を返していないので記録しない。
    // 記録に失敗しても一覧は返す (失敗は db-logger に error で残る)
    if (rows.length > 0) {
      await recordAdminAudit({
        supabase,
        actorId: currentUser.id,
        actionType: 'admin.support.ticket.list',
        targetType: 'support_ticket',
        details: buildListViewDetails({ status, priority, assignee_id, page, per_page }, rows.length, count ?? null),
        request,
        routeName: 'api/admin/support/tickets GET',
      });
    }

    return NextResponse.json({
      data,
      meta: { total: count ?? 0, page, per_page },
    });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('GET /api/admin/support/tickets', err, { log_context: '[support/tickets] GET error' }, { shape: 'nested' });
  }
}

export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = createTicketSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: VALIDATION_ERROR_MESSAGE, details: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const { user_id, subject, category, priority, body: messageBody } = parseResult.data;
    const supabase = await createClient();

    // トランザクション的に ticket + 最初のメッセージを作成
    const { data: ticket, error: ticketError } = await supabase
      .from('support_tickets')
      .insert({ user_id, subject, category, priority, status: 'open' })
      .select()
      .single();

    if (ticketError || !ticket) {
      return internalError('POST /api/admin/support/tickets', ticketError, { userId: currentUser.id }, { shape: 'nested' });
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
    await recordAdminAudit({
      supabase,
      actorId: currentUser.id,
      actionType: 'admin.support.ticket.create',
      targetId: ticket.id,
      targetType: 'support_ticket',
      details: { subject, category, priority, user_id },
      severity: 'info',
      request,
      routeName: 'api/admin/support/tickets POST',
    });

    return NextResponse.json({ data: ticket }, { status: 201 });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('POST /api/admin/support/tickets', err, { log_context: '[support/tickets] POST error' }, { shape: 'nested' });
  }
}
