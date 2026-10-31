/**
 * Web の route (POST /api/auth/login・GET /auth/callback) がログイン直後に呼ぶ、ログインの文脈 (利用者の IP・UA・国) の記録。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §13.5・§13.6。
 *
 * Web のログインは Next.js のサーバーが GoTrue を呼ぶので、トリガー on_auth_session_created (関数 auth_session_created) が作る user_sessions_metadata の行の
 * IP / UA はサーバーのもの (UA は node)。利用者の値は request にしか無いので、ここで上書きする (context_source = 'web')。
 * 例外を投げない: 失敗は warn を 1 回だけ残し、ログインの応答を変えない。warn の metadata は stage (と error_name) だけで、
 * token・IP・UA・利用者 ID・session_id・エラーの文面 (PostgREST・GoTrue の英文に値が入りうる) を出さない。
 */
import { extractClientIp } from '@/lib/admin/client-ip';
import { createLogger } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { countryCodeOf } from './request-context';
import { readSessionAuth, type SessionClaimsReader } from './session-claims';
import { recordWebLoginContext } from './store';

const LOGGER_NAME = 'auth/login-context';
const WARN_MESSAGE = 'ログインの文脈を記録できませんでした';

/**
 * Web の route が、GoTrue にセッションを作らせる呼び出しの成功の直後に呼ぶ。auth = route の createClient() の supabase.auth、
 * headers = request.headers、session = その呼び出しの戻りの data.session。トリガーが作った user_sessions_metadata の行
 * (context_source = 'auth') に request の IP・UA・国を書く。例外を投げない (失敗は warn を 1 回だけ残し、ログインの応答を変えない)
 */
export async function recordWebLoginContextFromRequest(
  auth: SessionClaimsReader,
  headers: Pick<Headers, 'get'>,
  session: { access_token: string } | null | undefined,
): Promise<void> {
  if (!session) return;
  try {
    const sessionAuth = await readSessionAuth(auth, `Bearer ${session.access_token}`);
    if (sessionAuth === null) {
      createLogger(LOGGER_NAME).warn(WARN_MESSAGE, { stage: 'claims' });
      return;
    }
    const recorded = await recordWebLoginContext(getSupabaseAdmin(), {
      userId: sessionAuth.claims.sub,
      sessionId: sessionAuth.claims.session_id,
      ipAddress: extractClientIp(headers),
      userAgent: headers.get('user-agent'),
      countryCode: countryCodeOf(headers),
    });
    if (!recorded) createLogger(LOGGER_NAME).warn(WARN_MESSAGE, { stage: 'record' });
  } catch (error) {
    createLogger(LOGGER_NAME).warn(WARN_MESSAGE, {
      stage: 'exception',
      error_name: error instanceof Error ? error.name : typeof error,
    });
  }
}
