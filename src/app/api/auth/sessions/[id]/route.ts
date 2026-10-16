/**
 * DELETE /api/auth/sessions/{id} — ログイン中の端末を 1 つ失効させる (#1189。docs/design/cross/16-auth-history-sessions.md §14.2)
 *
 * id が UUID の形でなければ 404 → requireSessionUser → 本人の client で RPC auth_session_revoke (auth.sessions の行を消す。
 * 消された端末の次の要求・refresh は GoTrue が session_not_found で断る)。service_role は使わない (RPC が auth.uid() で本人の行に絞る)。
 * 応答: 200 { ok: true } (revoked) / 409 AUTH_SESSION_IS_CURRENT (いま使っている端末。ログアウトを使う) /
 *   404 AUTH_SESSION_NOT_FOUND (無い・他人の行・終わった行・UUID でない) / 401 / 403 / 500。Cache-Control: private, no-store。本文を読まない。
 */
import { type NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/sessions/session-claims';
import { sessionIsCurrent, sessionNotFound, sessionsFailure, sessionsJson } from '@/lib/auth/sessions/route-support';
import { revokeSession } from '@/lib/auth/sessions/store';
import { isUuid } from '@/lib/http-params';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'DELETE /api/auth/sessions/[id]';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return sessionNotFound();
  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));
    userId = ctx.user.id;
    const outcome = await revokeSession(supabase, id);
    if (outcome === 'current') return sessionIsCurrent();
    if (outcome === 'not_found') return sessionNotFound();
    return sessionsJson({ ok: true });
  } catch (err) {
    return sessionsFailure(ROUTE_NAME, err, userId);
  }
}
