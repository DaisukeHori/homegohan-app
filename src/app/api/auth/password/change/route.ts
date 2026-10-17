/**
 * POST /api/auth/password/change — ログイン中のパスワードの変更 (#1198。docs/design/cross/16-auth-history-sessions.md §14.6)
 *
 * 1. rejectNullCharacterBody → readJsonBody + PasswordChangeBodySchema (違えば 400 VALIDATION_ERROR) → validatePassword (違えば 422 VALID_PASSWORD_WEAK) →
 *    新しいパスワードが現在のパスワードと同じなら 422 VALID_PASSWORD_HISTORY
 * 2. requireSessionUser (Cookie / Bearer。user_profiles の行が無い利用者も通る R-15) → checkRateLimit(user.id, 'auth-password-change') (超過 429 + Retry-After)
 * 3. 世代数 = passwordHistoryGenerationsFor(ctx.roles) → RPC auth_password_check (現在のパスワードの確認と履歴の照合 §11.5) →
 *    GoTrue の PUT /auth/v1/user を本人の access token と current_password で呼ぶ (createClient() の auth.updateUser は使わない §13.7)
 * 4. 他の端末の失効は GoTrue が更新と同じトランザクションで行う (P-1)。route は signOut を呼ばない
 * 応答: 200 { ok: true } / 400 AUTH_CURRENT_PASSWORD_MISMATCH・VALIDATION_ERROR・INVALID_CHARACTER / 401 / 403 AUTH_REAUTHENTICATION_REQUIRED・AUTH_ACCOUNT_FROZEN /
 * 409 AUTH_PASSWORD_NOT_SET / 422 VALID_PASSWORD_HISTORY・VALID_PASSWORD_WEAK / 429 RATE_LIMITED / 500。Cache-Control: private, no-store。
 * 本文・ログにパスワードも GoTrue の英文も出さない。
 */
import { type NextRequest } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import {
  executePasswordUpdate,
  passwordSameAsCurrent,
  passwordValidationError,
  rejectWeakPassword,
} from '@/lib/auth/password/route-support';
import { sessionsFailure } from '@/lib/auth/sessions/route-support';
import { PasswordChangeBodySchema } from '@/lib/auth/sessions/schemas';
import { requireSessionUser } from '@/lib/auth/sessions/session-claims';
import { readJsonBody } from '@/lib/http-params';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/password/change';

export async function POST(request: NextRequest) {
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;

  const read = await readJsonBody(request);
  if (!read.ok) return passwordValidationError();
  const parsed = PasswordChangeBodySchema.safeParse(read.body);
  if (!parsed.success) return passwordValidationError();
  const { current_password: currentPassword, new_password: newPassword } = parsed.data;

  const weak = rejectWeakPassword(newPassword);
  if (weak) return weak;
  if (newPassword === currentPassword) return passwordSameAsCurrent();

  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));
    userId = ctx.user.id;
    return await executePasswordUpdate({
      mode: 'change',
      routeName: ROUTE_NAME,
      ctx,
      currentPassword,
      newPassword,
      admin: getSupabaseAdmin(),
    });
  } catch (err) {
    return sessionsFailure(ROUTE_NAME, err, userId);
  }
}
