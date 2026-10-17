/**
 * GET /api/auth/sessions — ログイン中の端末の一覧 (#1189。docs/design/cross/16-auth-history-sessions.md §14.1)
 *
 * 認証: requireSessionUser (Cookie / Bearer。user_profiles の行が無い利用者も通す R-15。行があって凍結中は 403)。
 * 行は本人の client (RLS) で読む (live の行を last_active_at の降順)。
 * 応答: 200 { sessions: SessionSummary[] } (device_label = UA から決まる言葉・is_current = 要求の JWT の session_id の行) /
 *   401 AUTH_UNAUTHENTICATED / 403 AUTH_ACCOUNT_FROZEN / 500 INTERNAL_ERROR。Cache-Control: private, no-store。本文を読まない。
 */
import { type NextRequest } from 'next/server';
import { SessionsResponseSchema } from '@/lib/auth/sessions/schemas';
import { requireSessionUser } from '@/lib/auth/sessions/session-claims';
import { sessionsFailure, sessionsJson, toSessionSummary } from '@/lib/auth/sessions/route-support';
import { listLiveSessions } from '@/lib/auth/sessions/store';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'GET /api/auth/sessions';

export async function GET(request: NextRequest) {
  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));
    userId = ctx.user.id;
    const rows = await listLiveSessions(supabase, ctx.user.id);
    const body = SessionsResponseSchema.parse({
      sessions: rows.map((row) => toSessionSummary(row, ctx.session.claims.session_id)),
    });
    return sessionsJson(body);
  } catch (err) {
    return sessionsFailure(ROUTE_NAME, err, userId);
  }
}
