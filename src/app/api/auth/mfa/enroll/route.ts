/**
 * POST /api/auth/mfa/enroll — 認証アプリ (TOTP) の登録を始める (#1176。docs/design/cross/12-operator-mfa.md §14.2)
 *
 * 認可: requireRole(MFA_REQUIRED_ROLES, { assurance: 'session' }) (ロールだけ見て AAL は見ない。aal1 で使う §0.2・走査 ②)。
 * 手順: 別オリジン → 403 FORBIDDEN_ORIGIN / verified な TOTP factor があれば 409 AUTH_2FA_ALREADY_ENROLLED (先に解除) /
 *       unverified な TOTP factor を全部 mfa.unenroll (登録を途中でやめた factor を溜めない S-20) / mfa.enroll(totp)。
 * 応答 200 = MfaEnrollResponseSchema ({ ok, factor_id, qr_code_svg, secret, uri })。これらの値はログに出さない。
 *   qr_code_svg は素の SVG (auth-js が data.totp.qr_code に付けた data URL の前置きを toBareQrCodeSvg で外す。画面が 1 回だけ前置する)。
 * 本文は読まない。監査は書かない (登録の完了 = verify の成功で admin.mfa.enroll を書く §17)。
 * アプリの WebView の借り物のセッションでも断らない (Web の側で token を発行し直さない。§10 の借り物の enroll の行)。
 */
import { type NextRequest } from 'next/server';
import { AuthError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/helpers';
import {
  MFA_TOTP_FRIENDLY_NAME,
  MFA_TOTP_ISSUER,
  findVerifiedTotpFactor,
  listUnverifiedTotpFactorIds,
  toBareQrCodeSvg,
} from '@/lib/auth/mfa/factors';
import { MFA_REQUIRED_ROLES } from '@/lib/auth/mfa/policy';
import {
  isCrossOriginRequest,
  mfaAuthFailure,
  mfaForbiddenOrigin,
  mfaInternalError,
  mfaJson,
} from '@/lib/auth/mfa/route-support';
import type { MfaEnrollResponse } from '@/lib/auth/mfa/schemas';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/mfa/enroll';
const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const ALREADY_ENROLLED_MESSAGE = '認証アプリはすでに登録されています。変更するには先に解除してください。';

export async function POST(request: NextRequest) {
  if (isCrossOriginRequest(request)) return mfaForbiddenOrigin();

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

    if (findVerifiedTotpFactor(user) !== null) {
      return mfaJson({ error: ALREADY_ENROLLED_MESSAGE, code: 'AUTH_2FA_ALREADY_ENROLLED' }, HTTP_CONFLICT);
    }

    for (const factorId of listUnverifiedTotpFactorIds(user)) {
      const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId });
      if (unenrollError) return mfaInternalError(ROUTE_NAME, unenrollError, actorId);
    }

    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      issuer: MFA_TOTP_ISSUER,
      friendlyName: MFA_TOTP_FRIENDLY_NAME,
    });
    if (enrollError || !data) return mfaInternalError(ROUTE_NAME, enrollError, actorId);

    const body: MfaEnrollResponse = {
      ok: true,
      factor_id: data.id,
      qr_code_svg: toBareQrCodeSvg(data.totp.qr_code),
      secret: data.totp.secret,
      uri: data.totp.uri,
    };
    return mfaJson(body, HTTP_OK);
  } catch (err) {
    return mfaAuthFailure(err) ?? mfaInternalError(ROUTE_NAME, err, actorId);
  }
}
