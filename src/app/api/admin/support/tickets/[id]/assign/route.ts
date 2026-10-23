/**
 * POST /api/admin/support/tickets/[id]/assign - 担当者割り当て
 *
 * operator/02-api-spec.md §10 準拠
 * 権限: support, admin, super_admin
 *
 * 更新の DB の失敗 (#1917): DB の失敗は 500 INTERNAL_ERROR にし、チケットの行が無いときだけ 404 にする
 * (一時的な失敗でチケットが消えたように見せない)。担当者が存在しない (外部キー違反) は 400 VALIDATION_ERROR。
 * UUID の形でない id は DB に渡さず 404。壊れた JSON の本文は 400 INVALID_JSON。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { internalError } from '@/lib/api/errors';
import { AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED, authFailureNested, invalidJsonNested } from '@/lib/api/error-responses';
import { isUuid, readJsonBody } from '@/lib/http-params';
import { assignTicketSchema } from '@/lib/admin/support-schemas';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

/** 400: 本文・クエリの検証の失敗の文 (項目ごとの理由は details に添える。message は画面がそのまま出す文なので文字列にする) */
const VALIDATION_ERROR_MESSAGE = '入力内容を確認してください';

type RouteContext = { params: Promise<{ id: string }> };

/** チケットが無い (UUID の形でない id を含む) */
const TICKET_NOT_FOUND_RESPONSE = { error: { code: 'NOT_FOUND', message: 'チケットが見つかりません' } } as const;

/** PostgreSQL の外部キー違反のエラーコード (担当者が auth.users に無い) */
const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';

/** 担当者 (assignee_id) が存在しない利用者を指している */
const ASSIGNEE_INVALID_RESPONSE = { error: { code: 'VALIDATION_ERROR', message: VALIDATION_ERROR_MESSAGE } } as const;

export async function POST(request: NextRequest, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const currentUser = await requireRole(['support', 'admin', 'super_admin']);

    // 壊れた JSON は 400 INVALID_JSON (外側の catch の 500 に落とさない)
    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) return invalidJsonNested();
    const parseResult = assignTicketSchema.safeParse(bodyResult.body);
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

    const { assignee_id } = parseResult.data;
    const supabase = await createClient();

    const { data: ticket, error } = await supabase
      .from('support_tickets')
      .update({ assignee_id, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select()
      .maybeSingle();

    // 書けなかったときは 404 にしない (更新した行が無いときだけ 404。一時的な失敗でチケットが消えたように見せない)
    if (error) {
      // 担当者 (assignee_id) が auth.users に無い (外部キー違反) は入力の誤り
      if (error.code === POSTGRES_FOREIGN_KEY_VIOLATION) {
        return NextResponse.json(ASSIGNEE_INVALID_RESPONSE, { status: 400 });
      }
      return internalError('POST /api/admin/support/tickets/[id]/assign', error, { userId: currentUser.id, table: 'support_tickets' }, { shape: 'nested' });
    }
    if (!ticket) {
      return NextResponse.json(TICKET_NOT_FOUND_RESPONSE, { status: 404 });
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
