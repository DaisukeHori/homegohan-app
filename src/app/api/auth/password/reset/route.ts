/**
 * POST /api/auth/password/reset — 再設定メールのリンク / コードで作ったセッションによるパスワードの再設定 (#1198。
 * docs/design/cross/16-auth-history-sessions.md §14.7)
 *
 * 1. rejectNullCharacterBody → PasswordResetBodySchema (違えば 400 VALIDATION_ERROR) → validatePassword (違えば 422 VALID_PASSWORD_WEAK)
 * 2. requireSessionUser (user_profiles の行が無い利用者も通る S-30) → amr に 60 分以内の recovery / otp が無ければ 403 AUTH_RECOVERY_SESSION_REQUIRED
 *    (盗んだ普通のセッション = amr が password / oauth では再設定させない S-15) → checkRateLimit(user.id, 'auth-password-reset')
 * 3. 世代数 → RPC auth_password_check (p_current_password = NULL §11.5 の行 6・7) → GoTrue の PUT /auth/v1/user を本人の access token で呼ぶ
 *    (本文は password だけ。再設定のセッションは GoTrue の UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD の免除に当たる)
 * 4. 全端末のログアウトはページが行う (既存)。route は signOut を呼ばない
 * 応答: 200 { ok: true } / 400 VALIDATION_ERROR・INVALID_CHARACTER / 401 / 403 AUTH_RECOVERY_SESSION_REQUIRED・AUTH_REAUTHENTICATION_REQUIRED・AUTH_ACCOUNT_FROZEN /
 * 422 VALID_PASSWORD_HISTORY・VALID_PASSWORD_WEAK / 429 RATE_LIMITED / 500。再設定は AUTH_PASSWORD_NOT_SET を返さない (パスワードの無い利用者は
 * 最初のパスワードを作れる S-28)。Cache-Control: private, no-store。
 */
import { type NextRequest } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES } from '@/lib/auth/password/policy';
import {
  executePasswordUpdate,
  passwordRecoverySessionRequired,
  passwordValidationError,
  rejectWeakPassword,
} from '@/lib/auth/password/route-support';
import { sessionsFailure } from '@/lib/auth/sessions/route-support';
import { PasswordResetBodySchema } from '@/lib/auth/sessions/schemas';
import { hasRecentRecoveryMethod, requireSessionUser } from '@/lib/auth/sessions/session-claims';
import { readJsonBody } from '@/lib/http-params';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/password/reset';

export async function POST(request: NextRequest) {
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;

  const read = await readJsonBody(request);
  if (!read.ok) return passwordValidationError();
  const parsed = PasswordResetBodySchema.safeParse(read.body);
  if (!parsed.success) return passwordValidationError();
  const newPassword = parsed.data.new_password;

  const weak = rejectWeakPassword(newPassword);
  if (weak) return weak;

  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));
    userId = ctx.user.id;
    if (!hasRecentRecoveryMethod(ctx.session.claims, new Date(), PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES)) {
      return passwordRecoverySessionRequired();
    }
    return await executePasswordUpdate({
      mode: 'reset',
      routeName: ROUTE_NAME,
      ctx,
      currentPassword: null,
      newPassword,
      admin: getSupabaseAdmin(),
    });
  } catch (err) {
    return sessionsFailure(ROUTE_NAME, err, userId);
  }
}
