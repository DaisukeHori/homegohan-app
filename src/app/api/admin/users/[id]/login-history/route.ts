/**
 * GET /api/admin/users/{id}/login-history — 利用者のログイン履歴 (直近 LOGIN_HISTORY_PAGE_SIZE 回) を運営が見る (#1720 段 D)
 *
 * 設計の正典: docs/design/cross/16-auth-history-sessions.md §14.9 (この route)・§17 (画面)・§20.2 (テスト)。
 * - 権限: admin / super_admin (support は 403)。requireRole の末尾で運営の AAL2 (二段階認証) も求める
 *   (docs/design/cross/12-operator-mfa.md §7.1。tests/operator-mfa-entry-points-scan.test.ts が見る)。
 * - 行は service_role で読む (user_sessions_metadata の RLS は本人の行だけを見せるため。requireRole を通した後だけ)。
 * - 1 件以上返したときだけ、監査 admin.user.view_login_history を 1 行記録する。記録は利用者の client (createClient()) で書く
 *   (admin_audit_logs は actor_id = auth.uid() を WITH CHECK で強制する。service_role の client は渡さない)。
 *   details は返した件数だけ (IP・端末などの値は入れない)。記録の失敗では閲覧を止めない (GET /api/admin/users/{id} と同じ)。
 * - 本文を読まないので rejectNullCharacterBody は呼ばない。
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { recordAdminAudit } from '@/lib/admin/audit';
import { internalError } from '@/lib/api/errors';
import { isUuid } from '@/lib/http-params';
import { LOGIN_HISTORY_PAGE_SIZE } from '@/lib/auth/sessions/constants';
import { deviceFamilyOf, deviceLabelOf } from '@/lib/auth/sessions/device-family';
import { listLoginHistory, type SessionRow } from '@/lib/auth/sessions/store';
import type { LoginHistoryEntry } from '@/lib/auth/sessions/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 構造化ログ・監査の記録の失敗の発生元 */
const ROUTE_NAME = 'api/admin/users/[id]/login-history GET';
/** 監査の種別 (docs/design/operator/07-audit-monitoring.md §4.1.1・cross/16 §14.9) */
const AUDIT_ACTION_TYPE = 'admin.user.view_login_history';
/** 他人のログインの IP・端末を含むので、共有のキャッシュにもブラウザのキャッシュにも残さない (cross/16 §14 の共通) */
const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

type Params = { params: Promise<{ id: string }> };

/** user_sessions_metadata の 1 行を、本人の画面と同じ形 (LoginHistoryEntrySchema。ended_at = revoked_at §14.5) に */
function toLoginHistoryEntry(row: SessionRow): LoginHistoryEntry {
  return {
    session_id: row.session_id,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    device_label: deviceLabelOf(deviceFamilyOf(row.user_agent)),
    device_name: row.device_name,
    ip_address: row.ip_address,
    country_code: row.country_code,
    ended_at: row.revoked_at,
    ended_reason: row.ended_reason,
    is_new_device: row.is_new_device,
    is_new_ip: row.is_new_ip,
    is_new_country: row.is_new_country,
    alert_sent_at: row.alert_sent_at,
  };
}

export async function GET(request: Request, props: Params) {
  const params = await props.params;
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    throw err;
  }

  const { id } = params;
  // uuid の列に UUID でない文字列を渡すと 22P02 で 500 になるので、先に 404 で断る
  if (!isUuid(id)) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  let rows: SessionRow[];
  try {
    rows = await listLoginHistory(getSupabaseAdmin(), id, LOGIN_HISTORY_PAGE_SIZE);
  } catch (error) {
    return internalError(ROUTE_NAME, error, { userId: actor.id }, { shape: 'nested' });
  }
  const entries = rows.map(toLoginHistoryEntry);

  // 0 件のときは記録しない (operator/07 §4.1.1 の閲覧の記録の規則)
  if (entries.length > 0) {
    await recordAdminAudit({
      supabase: await createClient(),
      actorId: actor.id,
      actionType: AUDIT_ACTION_TYPE,
      targetId: id,
      targetType: 'user',
      details: { returned_count: entries.length },
      request,
      routeName: ROUTE_NAME,
    });
  }

  return NextResponse.json({ data: { entries } }, { headers: NO_STORE_HEADERS });
}
