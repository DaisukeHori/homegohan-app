/**
 * DELETE /api/auth/mfa/factors/{id} — 認証アプリ (TOTP の factor) の解除 (#1176。docs/design/cross/12-operator-mfa.md §14.4。段 B)
 *
 * 認可: requireRole(MFA_REQUIRED_ROLES) (既定 = AAL2 が要る。aal1 は 403 AUTH_2FA_REQUIRED / AUTH_2FA_ENROLLMENT_REQUIRED)。
 * 手順:
 *   別オリジン → 403 / 認可 → 401・403 /
 *   アプリの WebView の借り物のセッション → 409 AUTH_2FA_NATIVE_SESSION (unenroll も refreshSession も呼ばない。
 *     借り物のセッションは refresh できず、unenroll だけが済んで 500 になるのを防ぐ §16.4) /
 *   本人の verified な TOTP factor の id でない (他人・存在しない・本人の unverified・TOTP でない) → 404 AUTH_2FA_NOT_ENROLLED
 *     (unenroll・deleteBackupCodes・refreshSession・監査のどれも呼ばない §10) /
 *   mfa.unenroll の error → 500 (何も変わっていないので監査を書かない) /
 *   ここから監査の起点の後 (§17.2): バックアップコードを全部消す → (消せたら) refreshSession で aal1 の token に更新 →
 *     監査 admin.mfa.unenroll を 1 行 → コードの削除の失敗は 500・refresh の失敗は 200 { aal: 'aal2' }・最後まで進めば 200 { aal: 'aal1' }
 * 本文を読まない (src/__tests__/api/null-character-routes.test.ts の対象外)。
 */
import { type NextRequest } from 'next/server';
import { AuthError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/helpers';
import { MFA_AUDIT_ACTIONS, MFA_AUDIT_FAILED_STEPS, recordMfaAudit, type MfaAuditDetailsMap } from '@/lib/auth/mfa/audit';
import { deleteBackupCodes } from '@/lib/auth/mfa/backup-codes';
import { isVerifiedTotpFactorId } from '@/lib/auth/mfa/factors';
import { MFA_REQUIRED_ROLES } from '@/lib/auth/mfa/policy';
import {
  isCrossOriginRequest,
  mfaAuthFailure,
  mfaForbiddenOrigin,
  mfaInternalError,
  mfaJson,
} from '@/lib/auth/mfa/route-support';
import type { MfaUnenrollResponse } from '@/lib/auth/mfa/schemas';
import { createLogger } from '@/lib/db-logger';
import { normalizeUuid } from '@/lib/http-params';
import { isNativeBridgedSession } from '@/lib/native-auth-bridge';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'DELETE /api/auth/mfa/factors/[id]';
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

const NATIVE_SESSION_MESSAGE =
  'アプリの中では、この画面で二段階認証の確認や解除ができません。アプリの確認画面か、ブラウザで行ってください。';
const NOT_ENROLLED_MESSAGE = '認証アプリが登録されていません。先に登録してください。';

type UnenrollFailedStep = MfaAuditDetailsMap['admin.mfa.unenroll']['failed_step'];

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossOriginRequest(request)) return mfaForbiddenOrigin();

  let actorId: string;
  try {
    actorId = (await requireRole(MFA_REQUIRED_ROLES)).id;
  } catch (err) {
    return mfaAuthFailure(err) ?? mfaInternalError(ROUTE_NAME, err);
  }

  // factor の id は小文字 (Supabase の user.factors)。大文字・混在のパスの id が isVerifiedTotpFactorId の === で 404 にならないよう、
  // 受け取った直後にそろえ、以後 (判定・unenroll・監査) はそろえた値だけを使う (#1793)
  const factorId = normalizeUuid((await params).id);

  try {
    const supabase = await createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (isNativeBridgedSession(session)) {
      return mfaJson({ error: NATIVE_SESSION_MESSAGE, code: 'AUTH_2FA_NATIVE_SESSION' }, HTTP_CONFLICT);
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    // requireRole の後にセッションが切れた (Cookie の token が失効した) とき
    if (userError || !user) throw new AuthError('AUTH_UNAUTHENTICATED');

    if (!isVerifiedTotpFactorId(user, factorId)) {
      return mfaJson({ error: NOT_ENROLLED_MESSAGE, code: 'AUTH_2FA_NOT_ENROLLED' }, HTTP_NOT_FOUND);
    }
    // 監査の起点 (unenroll の成功) より前に service_role の client を作っておく (作れなければ何も変えずに 500 §17.2)
    const admin = getSupabaseAdmin();

    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId });
    if (unenrollError) return mfaInternalError(ROUTE_NAME, unenrollError, user.id);

    // ここから監査の起点 (factor を消した) の後 (§17.2): 手順が失敗しても例外で抜けず、監査を 1 行書いてから応答する
    let backupCodesDeleted: number | null = null;
    let failedStep: UnenrollFailedStep = null;
    let codeDeleteError: unknown = null;
    try {
      backupCodesDeleted = await deleteBackupCodes(admin, user.id);
    } catch (error) {
      failedStep = MFA_AUDIT_FAILED_STEPS.deleteBackupCodes;
      codeDeleteError = error;
    }
    if (failedStep === null) {
      // 新しい token は aal1 (Cookie を更新する)。失敗しても解除は済んでいる (Cookie の aal2 の token の寿命まで P-3)
      const { error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError) {
        failedStep = MFA_AUDIT_FAILED_STEPS.refreshSession;
        createLogger(ROUTE_NAME).withUser(user.id).error('解除の後のセッションの更新に失敗しました', refreshError);
      }
    }
    await recordMfaAudit({
      admin,
      actorId: user.id,
      targetUserId: user.id,
      action: MFA_AUDIT_ACTIONS.unenroll,
      details: { factor_id: factorId, backup_codes_deleted: backupCodesDeleted, failed_step: failedStep },
      request,
      routeName: ROUTE_NAME,
    });

    if (failedStep === MFA_AUDIT_FAILED_STEPS.deleteBackupCodes) {
      return mfaInternalError(ROUTE_NAME, codeDeleteError, user.id);
    }
    const body: MfaUnenrollResponse = {
      ok: true,
      aal: failedStep === MFA_AUDIT_FAILED_STEPS.refreshSession ? 'aal2' : 'aal1',
    };
    return mfaJson(body, HTTP_OK);
  } catch (err) {
    return mfaAuthFailure(err) ?? mfaInternalError(ROUTE_NAME, err, actorId);
  }
}
