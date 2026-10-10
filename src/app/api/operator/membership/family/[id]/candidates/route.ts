/**
 * GET /api/operator/membership/family/[id]/candidates
 * 指定家族グループの transferable メンバ一覧を返す (service_role 経由)
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

const ROUTE_NAME = 'GET /api/operator/membership/family/[id]/candidates';

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
    const { id: familyId } = params;

    const admin = getServiceRoleClient();

    // adult ロールの active メンバを candidate とする
    const { data: members, error } = await admin
      .from('family_members')
      .select('user_id, role, joined_at')
      .eq('family_id', familyId)
      .eq('status', 'active')
      .in('role', ['adult', 'representative'])
      .neq('role', 'representative')
      .order('joined_at', { ascending: true });

    if (error) {
      return internalError(ROUTE_NAME, error, { userId: operatorId }, { shape: 'nested' });
    }

    // adult / representative はアカウントを持つが、念のため NULL は除く (.in() に null を渡すと uuid として解釈できず失敗する)
    const userIds = (members ?? [])
      .map((m) => m.user_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    // user_profiles からニックネームを取得
    const { data: profiles } = await admin
      .from('user_profiles')
      .select('id, nickname, last_login_at')
      .in('id', userIds);

    const profileMap: Record<string, { nickname: string | null; last_login_at: string | null }> = {};
    for (const p of profiles ?? []) {
      profileMap[p.id] = { nickname: p.nickname, last_login_at: p.last_login_at };
    }

    // email 取得 (auth.users)。listUsers() は page / perPage を渡さないと先頭 50 件しか返さず、
    // 登録ユーザーが 50 人を超えると候補者の email が欠けるため、候補者の分だけを引く (#1204)。
    // 取得できなかった人は email: null で返し、警告ログに残す
    const emailMap = await resolveAuthEmails(userIds, { admin, logger: logger.withUser(operatorId) });

    const candidates = (members ?? []).map((m) => ({
      id: m.user_id,
      role: m.role,
      nickname: profileMap[m.user_id]?.nickname ?? null,
      email: emailMap.get(m.user_id) ?? null,
      last_login_at: profileMap[m.user_id]?.last_login_at ?? null,
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
