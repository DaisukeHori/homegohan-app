/**
 * POST /api/auth/mfa/recover — バックアップコードで回復する (#1176。docs/design/cross/12-operator-mfa.md §14.5)
 *
 * バックアップコードは「AAL2 を与える」のではなく「TOTP を消して登録し直させる」(§7.1)。
 * 認可: requireRole(MFA_REQUIRED_ROLES, { assurance: 'session' })。AAL1 で呼ぶ (AAL は見ない §0.2・走査 ②)。
 * 手順:
 *   別オリジン → 403 / 認可 → 401・403 / 本文 (MfaRecoverBodySchema) → 400 VALIDATION_ERROR /
 *   回数制限 auth-mfa-recover (3 回/分・10 回/時) → 429 + Retry-After /
 *   正規化 (normalizeBackupCode) して形が違えば 400 AUTH_2FA_INVALID (DB に触れない) / verified な factor が無い → 409 AUTH_2FA_NOT_ENROLLED /
 *   消費の前に factor の一覧 (admin.mfa.listFactors。読めなければ 500 でコードを消費しない) /
 *   consumeBackupCode (投げれば 500・false なら 400 AUTH_2FA_INVALID。どちらも何も変わっていないので監査を書かない) /
 *   true ならここが監査の起点 (§17.2): 全 factor を admin.mfa.deleteFactor (失敗したら残りの factor もコードの削除もしない) →
 *   残りのコードを全部消す → 監査 admin.mfa.recover (warn。途中で止まっても必ず 1 行) → 200 { ok, next } か 500
 * verified な factor を消した時点で Supabase が本人の全セッションを終える (§3.1)。画面は応答の next (ログイン → 登録) へページごと移る。
 * 本文の NULL 文字: rejectNullCharacterBody を呼ばない (normalizeBackupCode が英数字以外を取り除き、DB に届くのは user_id と SHA-256 の hex だけ。
 * src/__tests__/api/null-character-routes.test.ts の EXCLUDED §23 N-28)。
 * アプリの WebView の借り物のセッションでも断らない (factor の削除は service_role で、Web の側で token を発行し直さない §10)。
 */
import { type NextRequest } from 'next/server';
import { AuthError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/helpers';
import { MFA_AUDIT_ACTIONS, MFA_AUDIT_FAILED_STEPS, recordMfaAudit, type MfaAuditDetailsMap } from '@/lib/auth/mfa/audit';
import {
  consumeBackupCode,
  deleteBackupCodes,
  isWellFormedBackupCode,
  normalizeBackupCode,
} from '@/lib/auth/mfa/backup-codes';
import { findVerifiedTotpFactor } from '@/lib/auth/mfa/factors';
import { MFA_REQUIRED_ROLES } from '@/lib/auth/mfa/policy';
import {
  isCrossOriginRequest,
  mfaAuthFailure,
  mfaForbiddenOrigin,
  mfaInternalError,
  mfaJson,
  mfaRateLimited,
} from '@/lib/auth/mfa/route-support';
import { MFA_RECOVER_NEXT_PATH, MfaRecoverBodySchema, type MfaRecoverResponse } from '@/lib/auth/mfa/schemas';
import { checkRateLimit, getRetryAfterSec } from '@/lib/rate-limit';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/mfa/recover';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;

const VALIDATION_ERROR_MESSAGE = '入力内容が正しくありません。';
const INVALID_CODE_MESSAGE = 'バックアップコードが正しくありません。';
const NOT_ENROLLED_MESSAGE = '認証アプリが登録されていません。先に登録してください。';

type RecoverFailedStep = MfaAuditDetailsMap['admin.mfa.recover']['failed_step'];

export async function POST(request: NextRequest) {
  if (isCrossOriginRequest(request)) return mfaForbiddenOrigin();

  let actorId: string;
  try {
    actorId = (await requireRole(MFA_REQUIRED_ROLES, { assurance: 'session' })).id;
  } catch (err) {
    return mfaAuthFailure(err) ?? mfaInternalError(ROUTE_NAME, err);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    rawBody = null;
  }
  const parsed = MfaRecoverBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return mfaJson({ error: VALIDATION_ERROR_MESSAGE, code: 'VALIDATION_ERROR' }, HTTP_BAD_REQUEST);
  }

  try {
    // 判定できない (Upstash の例外) ときは通さない (fail-closed。catch の 500)
    const rateLimit = await checkRateLimit(actorId, 'auth-mfa-recover');
    if (!rateLimit.success) return mfaRateLimited(getRetryAfterSec(rateLimit));

    const normalized = normalizeBackupCode(parsed.data.code);
    if (!isWellFormedBackupCode(normalized)) {
      return mfaJson({ error: INVALID_CODE_MESSAGE, code: 'AUTH_2FA_INVALID' }, HTTP_BAD_REQUEST);
    }

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

    const admin = getSupabaseAdmin();
    // 消費の前に読む: 読み取りの失敗でコードを 1 個失わせない (読み取りは何も変えない)
    const { data: listed, error: listError } = await admin.auth.admin.mfa.listFactors({ userId: user.id });
    if (listError || !listed) return mfaInternalError(ROUTE_NAME, listError, user.id);
    const factors = listed.factors;

    const consumed = await consumeBackupCode(admin, user.id, normalized);
    if (!consumed) {
      return mfaJson({ error: INVALID_CODE_MESSAGE, code: 'AUTH_2FA_INVALID' }, HTTP_BAD_REQUEST);
    }

    // ここから監査の起点 (コードを 1 個使った) の後 (§17.2): 手順が失敗しても例外で抜けず、監査を 1 行書いてから応答する
    let factorsDeleted = 0;
    let backupCodesDeleted: number | null = null;
    let failedStep: RecoverFailedStep = null;
    let stepError: unknown = null;
    for (const factor of factors) {
      const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: user.id });
      if (deleteError) {
        failedStep = MFA_AUDIT_FAILED_STEPS.deleteFactor;
        stepError = deleteError;
        break;
      }
      factorsDeleted += 1;
    }
    if (failedStep === null) {
      try {
        backupCodesDeleted = await deleteBackupCodes(admin, user.id);
      } catch (error) {
        failedStep = MFA_AUDIT_FAILED_STEPS.deleteBackupCodes;
        stepError = error;
      }
    }
    await recordMfaAudit({
      admin,
      actorId: user.id,
      targetUserId: user.id,
      action: MFA_AUDIT_ACTIONS.recover,
      details: { factors_deleted: factorsDeleted, backup_codes_deleted: backupCodesDeleted, failed_step: failedStep },
      request,
      routeName: ROUTE_NAME,
    });

    if (failedStep !== null) return mfaInternalError(ROUTE_NAME, stepError, user.id);
    const body: MfaRecoverResponse = { ok: true, next: MFA_RECOVER_NEXT_PATH };
    return mfaJson(body, HTTP_OK);
  } catch (err) {
    return mfaAuthFailure(err) ?? mfaInternalError(ROUTE_NAME, err, actorId);
  }
}
