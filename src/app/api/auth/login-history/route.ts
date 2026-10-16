/**
 * GET /api/auth/login-history — 最近のログイン (#1190。docs/design/cross/16-auth-history-sessions.md §14.5)
 *
 * requireSessionUser → 本人の client (RLS) で、終わった行を含め created_at の降順で LOGIN_HISTORY_PAGE_SIZE (20) 件。
 * 応答: 200 { entries: LoginHistoryEntry[] } (ended_at = revoked_at) / 401 / 403 / 500。Cache-Control: private, no-store。本文を読まない。
 */
import { type NextRequest } from 'next/server';
import { LOGIN_HISTORY_PAGE_SIZE } from '@/lib/auth/sessions/constants';
import { LoginHistoryResponseSchema } from '@/lib/auth/sessions/schemas';
import { requireSessionUser } from '@/lib/auth/sessions/session-claims';
import { sessionsFailure, sessionsJson, toLoginHistoryEntry } from '@/lib/auth/sessions/route-support';
import { listLoginHistory } from '@/lib/auth/sessions/store';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'GET /api/auth/login-history';

export async function GET(request: NextRequest) {
  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));
    userId = ctx.user.id;
    const rows = await listLoginHistory(supabase, ctx.user.id, LOGIN_HISTORY_PAGE_SIZE);
    const body = LoginHistoryResponseSchema.parse({ entries: rows.map(toLoginHistoryEntry) });
    return sessionsJson(body);
  } catch (err) {
    return sessionsFailure(ROUTE_NAME, err, userId);
  }
}
