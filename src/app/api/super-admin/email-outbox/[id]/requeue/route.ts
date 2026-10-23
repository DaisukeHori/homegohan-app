/**
 * POST /api/super-admin/email-outbox/[id]/requeue — 届けられなかったメール (dead) の再送 (#1708 / #1193)
 *
 * 正本: docs/design/operator/10-logs-and-mail-retry.md §9.2・§10・§11。
 * dead の行を queued に戻す (requeue_email_outbox。試行回数を 0 に、再送の回数を +1 に)。送るのは次の worker。
 * 再送は監査ログ (admin_audit_logs) に super_admin.email_outbox.requeue を 1 行残す。
 *
 * 権限は super_admin だけ (admin も不可)。email_outbox は service_role しか読み書きできないので、
 * 必ず先に requireRole で super_admin を確かめてから service role の client (getSupabaseAdmin) を作ること。
 * 本文は読まない (request.json() を呼ばない)。
 *
 * 応答:
 *   200 { data: { id, status: 'queued' } }
 *   400 VALIDATION_ERROR (id が UUID でない)
 *   401 UNAUTHORIZED / 403 FORBIDDEN
 *   404 OP_EMAIL_OUTBOX_NOT_FOUND (行が無い)
 *   409 OP_EMAIL_OUTBOX_NOT_REQUEUEABLE (dead でない: details.reason = 'not_dead' / 宛先を伏せた行: 'redacted')
 *   500 INTERNAL_ERROR (読み取り・RPC の失敗。中身は出さず app_logs に残す)
 * 監査は再送できたときだけ (404 / 409 / 500 は残さない)。記録の失敗で応答は変えない (fail-open)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { recordAdminAudit } from '@/lib/admin/audit';
import { internalError } from '@/lib/api/errors';
import { INVALID_ID_PARAM_CODE, INVALID_ID_PARAM_MESSAGE, isUuid, normalizeUuid } from '@/lib/http-params';

const ROUTE_NAME = 'POST /api/super-admin/email-outbox/[id]/requeue';

/** 監査ログ (admin_audit_logs) の action_type (§10) */
const AUDIT_ACTION_TYPE = 'super_admin.email_outbox.requeue';
/** 監査の target_type: 行に利用者 (user_id) があればその人、無ければ送信待ちの行そのもの */
const AUDIT_TARGET_TYPE_USER = 'user';
const AUDIT_TARGET_TYPE_OUTBOX = 'email_outbox';

/** requeue_email_outbox の戻り値 (supabase/migrations の email_outbox の migration §5.2 (4)) */
const REQUEUE_RESULT = {
  requeued: 'requeued',
  notFound: 'not_found',
  notDead: 'not_dead',
  redacted: 'redacted',
} as const;

/**
 * 再送できる行の状態 (requeue_email_outbox は FOR UPDATE でロックした行がこの状態のときだけ queued に戻し 'requeued' を返す)。
 * 監査の previous_status はこの値を残す (#1917): 先に読んだ row.status はロックの外で読んだ値で、読んでから RPC までの間に
 * 行が dead になった (worker が送れずに dead にした) ときは、再送の直前の状態 (dead) と食い違う
 */
const REQUEUEABLE_STATUS = 'dead';

/** 新しいエラーコード (§11。cross/04-api-conventions.md §4.2 OP 系) */
const NOT_FOUND_CODE = 'OP_EMAIL_OUTBOX_NOT_FOUND';
const NOT_REQUEUEABLE_CODE = 'OP_EMAIL_OUTBOX_NOT_REQUEUEABLE';

const NOT_FOUND_MESSAGE = '指定のメールが見つかりません';
const NOT_REQUEUEABLE_MESSAGES = {
  [REQUEUE_RESULT.notDead]: '届けられなかったメールだけを再送できます',
  [REQUEUE_RESULT.redacted]: '宛先を伏せた行は再送できません',
} as const;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

type RouteContext = { params: Promise<{ id: string }> };

function errorResponse(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status, headers: NO_STORE },
  );
}

function notFound() {
  return errorResponse(404, NOT_FOUND_CODE, NOT_FOUND_MESSAGE);
}

function notRequeueable(reason: keyof typeof NOT_REQUEUEABLE_MESSAGES) {
  return errorResponse(409, NOT_REQUEUEABLE_CODE, NOT_REQUEUEABLE_MESSAGES[reason], { reason });
}

export async function POST(request: NextRequest, props: RouteContext) {
  const { id: rawId } = await props.params;
  try {
    // super_admin のみ許可 (admin も不可)。service role を使う前に必ずここを通す
    const user = await requireRole(['super_admin']);

    if (!isUuid(rawId)) {
      return errorResponse(400, INVALID_ID_PARAM_CODE, INVALID_ID_PARAM_MESSAGE);
    }
    // 大文字の UUID でも DB では同じ行に当たる。監査に残す値を DB の表記 (小文字) にそろえる (#1707)
    const id = normalizeUuid(rawId);

    const admin = getSupabaseAdmin();

    // 監査に残す文面の名前・利用者を先に読む (本文・宛先は読まない)。status は select に残すが監査には使わない
    // (前の状態は RPC がロックの下で確かめた REQUEUEABLE_STATUS。#1917)
    const { data: row, error: readError } = await admin
      .from('email_outbox')
      .select('id, template, user_id, status')
      .eq('id', id)
      .maybeSingle();
    if (readError) {
      return internalError(ROUTE_NAME, readError, { userId: user.id, step: 'read', outbox_id: id }, { shape: 'nested' });
    }
    if (!row) return notFound();

    const { data: result, error: rpcError } = await admin.rpc('requeue_email_outbox', { p_id: id });
    if (rpcError) {
      return internalError(ROUTE_NAME, rpcError, { userId: user.id, step: 'requeue', outbox_id: id }, { shape: 'nested' });
    }

    if (result === REQUEUE_RESULT.notFound) return notFound();
    if (result === REQUEUE_RESULT.notDead || result === REQUEUE_RESULT.redacted) return notRequeueable(result);
    if (result !== REQUEUE_RESULT.requeued) {
      return internalError(
        ROUTE_NAME,
        new Error('requeue_email_outbox が想定外の値を返しました'),
        { userId: user.id, step: 'requeue', outbox_id: id, result: String(result) },
        { shape: 'nested' },
      );
    }

    // 再送の監査 (§10)。INSERT は本人の権限の client (RLS audit_logs_insert_admins)。失敗しても応答は変えない
    await recordAdminAudit({
      supabase: await createClient(),
      actorId: user.id,
      actionType: AUDIT_ACTION_TYPE,
      targetId: row.user_id ?? row.id,
      targetType: row.user_id ? AUDIT_TARGET_TYPE_USER : AUDIT_TARGET_TYPE_OUTBOX,
      details: { outbox_id: row.id, template: row.template, previous_status: REQUEUEABLE_STATUS },
      request,
      routeName: ROUTE_NAME,
    });

    return NextResponse.json({ data: { id: row.id, status: 'queued' } }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthError) {
      return errorResponse(401, 'UNAUTHORIZED', err.message);
    }
    if (err instanceof ForbiddenError) {
      return errorResponse(403, 'FORBIDDEN', err.message);
    }
    return internalError(ROUTE_NAME, err, { outbox_id: rawId }, { shape: 'nested' });
  }
}
