/**
 * POST /api/admin/support/tickets/[id]/assign - 担当者割り当て
 *
 * operator/02-api-spec.md §10 準拠
 * 権限: support, admin, super_admin
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { internalError } from '@/lib/api/errors';
import { AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED, authFailureNested } from '@/lib/api/error-responses';
import { assignTicketSchema } from '@/lib/admin/support-schemas';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

/** 400: 本文・クエリの検証の失敗の文 (項目ごとの理由は details に添える。message は画面がそのまま出す文なので文字列にする) */
const VALIDATION_ERROR_MESSAGE = '入力内容を確認してください';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = assignTicketSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: VALIDATION_ERROR_MESSAGE, details: parseResult.error.flatten() } },
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
        { error: { code: 'NOT_FOUND', message: 'チケットが見つかりません' } },
        { status: 404 },
      );
    }

    // 監査ログ
    await recordAdminAudit({
      supabase,
      actorId: currentUser.id,
      actionType: 'admin.support.ticket.assign',
      targetId: params.id,
      targetType: 'support_ticket',
      details: { assignee_id },
      severity: 'info',
      request,
      routeName: 'api/admin/support/tickets/[id]/assign POST',
    });

    return NextResponse.json({ data: ticket });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('POST /api/admin/support/tickets/[id]/assign', err, { log_context: '[support/tickets/[id]/assign] POST error' }, { shape: 'nested' });
  }
}
