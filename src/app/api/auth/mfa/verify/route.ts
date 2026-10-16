/**
 * POST /api/auth/mfa/verify — 認証アプリの 6 桁を確かめて、セッションを aal2 にする (#1176。docs/design/cross/12-operator-mfa.md §14.3)
 *
 * 登録 (unverified な factor の verify) と、ログインごとの確認 (verified な factor の verify) の両方を受ける。
 * 認可: requireRole(MFA_REQUIRED_ROLES, { assurance: 'session' }) (ロールだけ見て AAL は見ない。aal1 で使う §0.2・走査 ②)。
 * 手順:
 *   別オリジン → 403 / 認可 → 401・403 / 本文 (MfaVerifyBodySchema) → 400 VALIDATION_ERROR /
 *   アプリの WebView の借り物のセッション (refresh_token が使えない値) → 409 AUTH_2FA_NATIVE_SESSION (回数制限を数えず Supabase も呼ばない §16.4) /
 *   回数制限 auth-mfa-verify (5 回/分・20 回/時) → 429 + Retry-After / 本人の factor でない → 404 AUTH_2FA_NOT_ENROLLED /
 *   challengeAndVerify: 6 桁の不一致 → 400 AUTH_2FA_INVALID・Supabase の回数制限 → 429・それ以外 → 500 (何も変わっていないので監査を書かない)
 *   成功: ssr の client がセッション (aal2) を Cookie に書く。Supabase は同じ利用者の他のセッションを終える (§3.1・§26.3。route は何もしない)
 *     verified な factor の verify → 200 { ok, aal: 'aal2' } (監査を書かない。ログインの一部)
 *     unverified な factor の verify (登録) → ここが監査の起点 (§17.2): バックアップコード 10 個を発行し、成功・失敗のどちらでも
 *       監査 admin.mfa.enroll を 1 行書いてから 200。発行に失敗したら backup_codes の無い 200 (500 にしない: verify はもう取り消せず、
 *       打ち直した verify は verified な factor の verify なのでコードを返さないため。画面は「表示できなかった」案内を出す §15.2)
 * 本文の NULL 文字: rejectNullCharacterBody を呼ばない (factor_id は z.uuid()、code は 6 桁の数字の検査を通ったものだけが Supabase に届く。
 * src/__tests__/api/null-character-routes.test.ts の EXCLUDED §23 N-28)。
 */
import { type NextRequest } from 'next/server';
import { AuthError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/helpers';
import { MFA_AUDIT_ACTIONS, MFA_AUDIT_FAILED_STEPS, recordMfaAudit } from '@/lib/auth/mfa/audit';
import { formatBackupCode, issueBackupCodes } from '@/lib/auth/mfa/backup-codes';
import { ownsFactor } from '@/lib/auth/mfa/factors';
import { MFA_REQUIRED_ROLES } from '@/lib/auth/mfa/policy';
import {
  isCrossOriginRequest,
  mfaAuthFailure,
  mfaForbiddenOrigin,
  mfaInternalError,
  mfaJson,
  mfaRateLimited,
} from '@/lib/auth/mfa/route-support';
import { MfaVerifyBodySchema, type MfaVerifyResponse } from '@/lib/auth/mfa/schemas';
import { createLogger } from '@/lib/db-logger';
import { normalizeUuid } from '@/lib/http-params';
import { isNativeBridgedSession } from '@/lib/native-auth-bridge';
import { checkRateLimit, getRetryAfterSec } from '@/lib/rate-limit';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/mfa/verify';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_TOO_MANY_REQUESTS = 429;
/** auth-js が 6 桁の不一致で返す error.code */
const SUPABASE_MFA_VERIFICATION_FAILED = 'mfa_verification_failed';

const VALIDATION_ERROR_MESSAGE = '入力内容が正しくありません。';
const NATIVE_SESSION_MESSAGE =
  'アプリの中では、この画面で二段階認証の確認や解除ができません。アプリの確認画面か、ブラウザで行ってください。';
const NOT_ENROLLED_MESSAGE = '認証アプリが登録されていません。先に登録してください。';
const INVALID_CODE_MESSAGE = '確認コードが正しくありません。認証アプリの最新のコードを入力してください。';

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
  const parsed = MfaVerifyBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return mfaJson({ error: VALIDATION_ERROR_MESSAGE, code: 'VALIDATION_ERROR' }, HTTP_BAD_REQUEST);
  }
  const { code } = parsed.data;
  // factor の id は小文字 (Supabase の user.factors)。大文字・混在で送られた本人の factor_id が ownsFactor の === で 404 にならないよう、
  // 受け取った直後にそろえ、以後 (判定・challengeAndVerify・監査) はそろえた値だけを使う (#1793)
  const factorId = normalizeUuid(parsed.data.factor_id);

  try {
    const supabase = await createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (isNativeBridgedSession(session)) {
      return mfaJson({ error: NATIVE_SESSION_MESSAGE, code: 'AUTH_2FA_NATIVE_SESSION' }, HTTP_CONFLICT);
    }

    // 判定できない (Upstash の例外) ときは通さない (fail-closed。catch の 500)
    const rateLimit = await checkRateLimit(actorId, 'auth-mfa-verify');
    if (!rateLimit.success) return mfaRateLimited(getRetryAfterSec(rateLimit));

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    // requireRole の後にセッションが切れた (Cookie の token が失効した) とき
    if (userError || !user) throw new AuthError('AUTH_UNAUTHENTICATED');

    if (!ownsFactor(user, factorId)) {
      return mfaJson({ error: NOT_ENROLLED_MESSAGE, code: 'AUTH_2FA_NOT_ENROLLED' }, HTTP_NOT_FOUND);
    }
    const wasUnverified = (user.factors ?? []).some((f) => f.id === factorId && f.status === 'unverified');
    // 登録なら、監査の起点 (verify の成功) より前に service_role の client を作っておく (作れなければ何も変えずに 500 §17.2)
    const admin = wasUnverified ? getSupabaseAdmin() : null;

    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (verifyError) {
      if (
        verifyError.code === SUPABASE_MFA_VERIFICATION_FAILED ||
        verifyError.status === HTTP_BAD_REQUEST ||
        verifyError.status === HTTP_UNPROCESSABLE_ENTITY
      ) {
        return mfaJson({ error: INVALID_CODE_MESSAGE, code: 'AUTH_2FA_INVALID' }, HTTP_BAD_REQUEST);
      }
      if (verifyError.status === HTTP_TOO_MANY_REQUESTS) return mfaRateLimited(null);
      return mfaInternalError(ROUTE_NAME, verifyError, actorId);
    }

    if (admin === null) {
      const verified: MfaVerifyResponse = { ok: true, aal: 'aal2' };
      return mfaJson(verified, HTTP_OK);
    }

    // ここから監査の起点の後 (§17.2): 手順が失敗しても例外で抜けず、監査を 1 行書いてから応答する
    let codes: string[] | null = null;
    let failedStep: typeof MFA_AUDIT_FAILED_STEPS.issueBackupCodes | null = null;
    try {
      codes = await issueBackupCodes(admin, user.id);
    } catch (error) {
      failedStep = MFA_AUDIT_FAILED_STEPS.issueBackupCodes;
      createLogger(ROUTE_NAME).withUser(user.id).error('バックアップコードの発行に失敗しました', error);
    }
    await recordMfaAudit({
      admin,
      actorId: user.id,
      targetUserId: user.id,
      action: MFA_AUDIT_ACTIONS.enroll,
      details: { factor_id: factorId, backup_codes_issued: codes === null ? null : codes.length, failed_step: failedStep },
      request,
      routeName: ROUTE_NAME,
    });

    const enrolled: MfaVerifyResponse =
      codes === null ? { ok: true, aal: 'aal2' } : { ok: true, aal: 'aal2', backup_codes: codes.map(formatBackupCode) };
    return mfaJson(enrolled, HTTP_OK);
  } catch (err) {
    return mfaAuthFailure(err) ?? mfaInternalError(ROUTE_NAME, err, actorId);
  }
}
