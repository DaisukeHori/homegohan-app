/**
 * GET /api/operator/membership/org/[id]/candidates
 * 指定組織の transferable メンバ一覧を返す (service_role 経由)
 * 05-operator-emergency-ui.md §E 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'GET /api/operator/membership/org/[id]/candidates';

/**
 * 通知・候補の取得に使う service_role のクライアント。接続情報は env-required の getter で取り出す (#1434)。
 * 欠けていれば MissingEnvError (message は固定の文で、変数名はサーバーのログにだけ残る)。
 */
function getServiceRoleClient() {
  const { url, serviceRoleKey } = getSupabaseServiceConfig();
  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const logger = createLogger(ROUTE_NAME, generateRequestId());
  try {
    const { userId: operatorId } = await requireSuperAdmin();
    const { id: orgId } = params;

    const admin = getServiceRoleClient();

    const { data, error } = await admin
      .from('user_profiles')
      .select('id, nickname, org_role, last_login_at')
      .eq('organization_id', orgId)
      .neq('org_role', 'owner')
      .order('last_login_at', { ascending: false, nullsFirst: false });

    if (error) {
      return internalError(ROUTE_NAME, error, { userId: operatorId }, { shape: 'nested' });
    }

    // auth.users からメールアドレスを取得する。listUsers() は page / perPage を渡さないと先頭 50 件しか返さず、
    // 登録ユーザーが 50 人を超えると候補者の email が欠けるため、候補者の分だけを引く (#1204)。
    // 取得できなかった人は email: null で返し、警告ログに残す
    const userIds = (data ?? []).map((r) => r.id);
    const emailMap = await resolveAuthEmails(userIds, { admin, logger: logger.withUser(operatorId) });

    const candidates = (data ?? []).map((row) => ({
      id: row.id,
      nickname: row.nickname,
      org_role: row.org_role,
      last_login_at: row.last_login_at,
      email: emailMap.get(row.id) ?? null,
    }));

    return NextResponse.json({ data: candidates });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    // 本文は汎用メッセージだけにし、元のエラーは構造化ログに残す (#1172)
    return internalError(ROUTE_NAME, err, {}, { shape: 'nested' });
  }
}
