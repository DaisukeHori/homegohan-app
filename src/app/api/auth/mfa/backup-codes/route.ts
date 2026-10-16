/**
 * POST /api/auth/mfa/backup-codes — バックアップコードの再発行 (#1176。docs/design/cross/12-operator-mfa.md §14.6。段 B)
 *
 * 認可: requireRole(MFA_REQUIRED_ROLES) (既定 = AAL2 が要る。aal1 は 403 AUTH_2FA_REQUIRED / AUTH_2FA_ENROLLMENT_REQUIRED)。
 * 手順:
 *   別オリジン → 403 / 認可 → 401・403 / verified な TOTP factor が無い → 409 AUTH_2FA_NOT_ENROLLED /
 *   issueBackupCodes (旧行を全部消して 10 行) の呼び出しが監査の起点 (§17.2。中の DELETE が走ると旧コードは戻せない):
 *     成功・失敗のどちらでも監査 admin.mfa.backup_codes_regenerate を 1 行 → 成功は 200 { backup_codes }・失敗は 500
 *     (登録の verify と違い、押し直せばもう一度 DELETE → INSERT するので 500 にする)
 * アプリの WebView の借り物のセッションでも 409 にしない (Web の側で token を発行し直さない §8・§10)。
 * 本文を読まない (src/__tests__/api/null-character-routes.test.ts の対象外)。
 */
import { type NextRequest } from 'next/server';
import { AuthError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/helpers';
import { MFA_AUDIT_ACTIONS, MFA_AUDIT_FAILED_STEPS, recordMfaAudit } from '@/lib/auth/mfa/audit';
import { formatBackupCode, issueBackupCodes } from '@/lib/auth/mfa/backup-codes';
import { findVerifiedTotpFactor } from '@/lib/auth/mfa/factors';
import { MFA_REQUIRED_ROLES } from '@/lib/auth/mfa/policy';
import {
  isCrossOriginRequest,
  mfaAuthFailure,
  mfaForbiddenOrigin,
  mfaInternalError,
  mfaJson,
} from '@/lib/auth/mfa/route-support';
import type { MfaBackupCodesResponse } from '@/lib/auth/mfa/schemas';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/mfa/backup-codes';
const HTTP_OK = 200;
const HTTP_CONFLICT = 409;

const NOT_ENROLLED_MESSAGE = '認証アプリが登録されていません。先に登録してください。';

export async function POST(request: NextRequest) {
  if (isCrossOriginRequest(request)) return mfaForbiddenOrigin();

  let actorId: string;
  try {
    actorId = (await requireRole(MFA_REQUIRED_ROLES)).id;
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

    if (findVerifiedTotpFactor(user) === null) {
      return mfaJson({ error: NOT_ENROLLED_MESSAGE, code: 'AUTH_2FA_NOT_ENROLLED' }, HTTP_CONFLICT);
    }
    // 監査の起点 (issueBackupCodes) より前に service_role の client を作っておく (作れなければ何も変えずに 500 §17.2)
    const admin = getSupabaseAdmin();

    let codes: string[] | null = null;
    let stepError: unknown = null;
    try {
      codes = await issueBackupCodes(admin, user.id);
    } catch (error) {
      stepError = error;
    }
    await recordMfaAudit({
      admin,
      actorId: user.id,
      targetUserId: user.id,
      action: MFA_AUDIT_ACTIONS.backupCodesRegenerate,
      details: {
        backup_codes_issued: codes === null ? null : codes.length,
        failed_step: codes === null ? MFA_AUDIT_FAILED_STEPS.issueBackupCodes : null,
      },
      request,
      routeName: ROUTE_NAME,
    });

    if (codes === null) return mfaInternalError(ROUTE_NAME, stepError, user.id);
    const body: MfaBackupCodesResponse = { ok: true, backup_codes: codes.map(formatBackupCode) };
    return mfaJson(body, HTTP_OK);
  } catch (err) {
    return mfaAuthFailure(err) ?? mfaInternalError(ROUTE_NAME, err, actorId);
  }
}
