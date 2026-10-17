/**
 * POST /api/auth/sessions/revoke-others — この端末以外のログインをすべて終える (#1189。docs/design/cross/16-auth-history-sessions.md §14.3)
 *
 * requireSessionUser → signOutOtherSessions(getSupabaseAdmin(), 本人の access token) = GoTrue の POST /logout?scope=others を
 * 本人の access token で呼ぶ (Web は Cookie のセッションの token、モバイルは Bearer の JWT。呼んだセッションは残る)。
 * createClient() の auth.signOut は呼ばない (Bearer だけの要求では GoTrue を呼ばずに成功を返し、何も消えない §3)。Cookie は触らない。
 * 応答: 200 { ok: true, remaining } (残りの live の行の数) / 401 / 403 / 500 (GoTrue の失敗。remaining は返さない)。
 * Cache-Control: private, no-store。本文を読まない (src/__tests__/api/null-character-routes.test.ts の対象外)。
 */
import { type NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/sessions/session-claims';
import { sessionsFailure, sessionsJson } from '@/lib/auth/sessions/route-support';
import { listLiveSessions, signOutOtherSessions } from '@/lib/auth/sessions/store';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/sessions/revoke-others';

export async function POST(request: NextRequest) {
  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));
    userId = ctx.user.id;
    await signOutOtherSessions(getSupabaseAdmin(), ctx.session.accessToken);
    const remaining = await listLiveSessions(supabase, ctx.user.id);
    return sessionsJson({ ok: true, remaining: remaining.length });
  } catch (err) {
    return sessionsFailure(ROUTE_NAME, err, userId);
  }
}
