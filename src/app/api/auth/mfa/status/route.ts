/**
 * GET /api/auth/mfa/status — 運営ロールの二段階認証 (TOTP) の状態 (#1176。docs/design/cross/12-operator-mfa.md §14.1)
 *
 * 認可: requireRole(MFA_REQUIRED_ROLES, { assurance: 'session' }) (ロールだけ見て AAL は見ない。aal1 で使う §0.2・走査 ②)。
 * 対象ロールでなければ 403 PERM_DENIED。
 * 応答 200 = MfaStatusResponseSchema (src/lib/auth/mfa/schemas.ts):
 *   enrolled / factor   : user.factors の verified な TOTP (findVerifiedTotpFactor)。enrolled が true のときだけ factor が null でない
 *   aal                 : 署名を確かめた JWT の claim (readSessionAssurance)
 *   backup_codes_remaining : 未使用のバックアップコードの数 (service_role で読む)
 *   enforce_from / grace : 猶予の環境変数 OPERATOR_MFA_ENFORCE_FROM (readMfaEnforceFromEnv)。grace = enforce_from があり、いまがそれより前
 * 監査は書かない (読み取りだけ)。
 */
import { AuthError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/helpers';
import { readSessionAssurance } from '@/lib/auth/mfa/assurance';
import { countRemainingBackupCodes } from '@/lib/auth/mfa/backup-codes';
import { findVerifiedTotpFactor } from '@/lib/auth/mfa/factors';
import { MFA_REQUIRED_ROLES, readMfaEnforceFromEnv } from '@/lib/auth/mfa/policy';
import { mfaAuthFailure, mfaInternalError, mfaJson } from '@/lib/auth/mfa/route-support';
import type { MfaStatusResponse } from '@/lib/auth/mfa/schemas';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'GET /api/auth/mfa/status';
const HTTP_OK = 200;

export async function GET() {
  let actorId: string;
  try {
    actorId = (await requireRole(MFA_REQUIRED_ROLES, { assurance: 'session' })).id;
  } catch (err) {
    return mfaAuthFailure(err) ?? mfaInternalError(ROUTE_NAME, err);
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    // requireRole の後にセッションが切れた (Cookie の token が失効した) とき
    if (userError || !user) throw new AuthError('AUTH_UNAUTHENTICATED');

    const session = await readSessionAssurance(supabase, user);
    const backupCodesRemaining = await countRemainingBackupCodes(getSupabaseAdmin(), user.id);
    const factor = findVerifiedTotpFactor(user);
    const { enforceFrom } = readMfaEnforceFromEnv();
    const now = new Date();

    const body: MfaStatusResponse = {
      ok: true,
      required: true,
      enrolled: factor !== null,
      aal: session.aal,
      factor: factor
        ? { id: factor.id, friendly_name: factor.friendly_name ?? null, created_at: factor.created_at }
        : null,
      backup_codes_remaining: backupCodesRemaining,
      enforce_from: enforceFrom ? enforceFrom.toISOString() : null,
      grace: enforceFrom !== null && now.getTime() < enforceFrom.getTime(),
    };
    return mfaJson(body, HTTP_OK);
  } catch (err) {
    return mfaAuthFailure(err) ?? mfaInternalError(ROUTE_NAME, err, actorId);
  }
}
