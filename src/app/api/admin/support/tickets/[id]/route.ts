/**
 * GET /api/admin/support/tickets/[id] - チケット詳細
 * PATCH /api/admin/support/tickets/[id] - ステータス・優先度変更
 *
 * operator/02-api-spec.md §10 準拠
 * 権限: support, admin, super_admin
 *
 * 読み込み・更新の DB の失敗 (#1917): DB の失敗は 500 INTERNAL_ERROR にし、チケットの行が無いときだけ 404 にする
 * (一時的な失敗でチケットが消えたように見せない)。更新の担当者が存在しない (外部キー違反) は 400 VALIDATION_ERROR。
 * UUID の形でない id は DB に渡さず 404。壊れた JSON の本文は 400 INVALID_JSON。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { internalError } from '@/lib/api/errors';
import { AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED, authFailureNested, invalidJsonNested } from '@/lib/api/error-responses';
import { isUuid, readJsonBody } from '@/lib/http-params';
import { updateTicketSchema } from '@/lib/admin/support-schemas';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

/** 400: 本文・クエリの検証の失敗の文 (項目ごとの理由は details に添える。message は画面がそのまま出す文なので文字列にする) */
const VALIDATION_ERROR_MESSAGE = '入力内容を確認してください';

type RouteContext = { params: Promise<{ id: string }> };

/** チケットが無い (UUID の形でない id を含む) */
const TICKET_NOT_FOUND_RESPONSE = { error: { code: 'NOT_FOUND', message: 'チケットが見つかりません' } } as const;

/** PostgreSQL の外部キー違反のエラーコード (担当者が auth.users に無い) */
const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';

export async function GET(request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);

    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(TICKET_NOT_FOUND_RESPONSE, { status: 404 });
    }

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
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗でチケットが消えたように見せない)
    if (error) {
      return internalError('GET /api/admin/support/tickets/[id]', error, { userId: currentUser.id, table: 'support_tickets' }, { shape: 'nested' });
    }
    if (!ticket) {
      return NextResponse.json(TICKET_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // メッセージ取得 (内部メモは support / admin / super_admin のみ)
    const isInternalAllowed = currentUser.roles.some((r) =>
      ['support', 'admin', 'super_admin'].includes(r),
    );

    // 書いた日時の古い順。同じ日時は id の順 (#2139 T1)
    let messagesQuery = orderListBy(
      supabase
        .from('support_ticket_messages')
        .select('id, ticket_id, sender_id, is_internal, body, attachments, created_at')
        .eq('ticket_id', params.id),
      LIST_ORDERS.adminSupportTicketMessages,
    );

    if (!isInternalAllowed) {
      messagesQuery = messagesQuery.eq('is_internal', false);
    }

    // メッセージが読めなかった (DB の失敗) ときは 500。空の一覧にしない (#1917 の続き。以前は失敗を捨て、
    // メッセージが 1 件も無いチケットに見えていた)。監査ログは情報を返すときだけ残すので、ここで返すときは残さない
    const { data: messages, error: messagesError } = await messagesQuery;
    if (messagesError) {
      return internalError('GET /api/admin/support/tickets/[id]', messagesError, { userId: currentUser.id, table: 'support_ticket_messages' }, { shape: 'nested' });
    }

    const data = { ...ticket, messages: messages ?? [] };

    // #1200: チケット (件名・本文など、ユーザーが書いた内容) を返す前に、誰が誰の
    // チケットを閲覧したかを監査ログへ残す。対象は「情報を見られた本人 (ticket.user_id)」
    // にそろえ、開示請求のときに target_id だけで全ての閲覧を引けるようにする。
    // 起票した利用者が退会していると user_id は NULL になる (#1175。チケットは残る)。
    // その場合は、チケット自体を対象にして記録を残す (/messages と同じ扱い)。
    // 記録に失敗しても閲覧は止めない (失敗は db-logger に error で残る)。
    // details には返した項目名だけを入れ、件名や本文は入れない。
    await recordAdminAudit({
      supabase,
      actorId: currentUser.id,
      actionType: 'admin.support.ticket.view',
      targetId: ticket.user_id ?? ticket.id,
      targetType: ticket.user_id ? 'user' : 'support_ticket',
      details: { ticket_id: ticket.id, viewed_fields: Object.keys(data) },
      request,
      routeName: 'api/admin/support/tickets/[id] GET',
    });

    return NextResponse.json({ data });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('GET /api/admin/support/tickets/[id]', err, { log_context: '[support/tickets/[id]] GET error' }, { shape: 'nested' });
  }
}

export async function PATCH(request: NextRequest, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);

    // 壊れた JSON は 400 INVALID_JSON (外側の catch の 500 に落とさない)
    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) return invalidJsonNested();
    const parseResult = updateTicketSchema.safeParse(bodyResult.body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: VALIDATION_ERROR_MESSAGE, details: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    // UUID の形でない id は DB に渡さず 404 (本文の検査 (400) のあと。行が無い UUID と同じ順にそろえる)
    if (!isUuid(params.id)) {
      return NextResponse.json(TICKET_NOT_FOUND_RESPONSE, { status: 404 });
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

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { data: ticket, error } = await getSupabaseAdmin()
      .from('support_tickets')
      .update({ ...updates, ...extraUpdates, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select()
      .maybeSingle();

    // 書けなかったときは 404 にしない (更新した行が無いときだけ 404)
    if (error) {
      // 担当者 (assignee_id) が auth.users に無い (外部キー違反) は入力の誤り
      if (error.code === POSTGRES_FOREIGN_KEY_VIOLATION) {
        return NextResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: VALIDATION_ERROR_MESSAGE } },
          { status: 400 },
        );
      }
      return internalError('PATCH /api/admin/support/tickets/[id]', error, { userId: currentUser.id, table: 'support_tickets' }, { shape: 'nested' });
    }
    if (!ticket) {
      return NextResponse.json(TICKET_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // 監査ログ (状態変更は記録必須)
    await recordAdminAudit({
      supabase,
      actorId: currentUser.id,
      actionType: 'admin.support.ticket.update',
      targetId: params.id,
      targetType: 'support_ticket',
      details: updates,
      severity: 'info',
      request,
      routeName: 'api/admin/support/tickets/[id] PATCH',
    });

    return NextResponse.json({ data: ticket });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('PATCH /api/admin/support/tickets/[id]', err, { log_context: '[support/tickets/[id]] PATCH error' }, { shape: 'nested' });
  }
}
