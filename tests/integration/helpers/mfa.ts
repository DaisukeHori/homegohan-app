/**
 * 結合テストの道具: 運営ロールの JWT を作る (#1176。docs/design/cross/12-operator-mfa.md §22.4.1。段 B)
 *
 * 段 B から、必須ロール (super_admin / admin / finance / org_industrial_doctor) の運営の入口は aal2 のセッションだけを通す。
 * 結合テストで運営の JWT を作る経路 (createTestUserWithRoles・TestUserPool・自前でサインインする 5 本) を
 * signInForIntegration 1 つに寄せ、必須ロールなら TOTP を登録・確認して aal2 にする (昇格の手順を 1 か所に置く)。
 * ローカルの Supabase では MFA の回数制限が効かない (§22.4.4。結合テスト M-13 が前提を固定する)。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isMfaRequiredRoleSet } from '@/lib/auth/mfa/policy';
import { generateTotp, TOTP_STEP_SECONDS } from '../../helpers/totp';

/** TOTP の時計のずれで 1 回目の verify が外れたとき、次の窓 (TOTP_STEP_SECONDS 後の時刻の 6 桁) で試し直す回数 */
export const TOTP_RETRY_ONCE = 1;

/**
 * challenge / verify が 429 (Supabase の MFA の回数制限) を返したときの Error のメッセージの頭。やり直さない (§22.4.4: ローカルの Supabase では
 * MFA の回数制限が効かないことが前提で、それが崩れたら M-13 が赤になる。待って試し直すと、崩れたことが「ときどき遅い」に隠れる)
 */
export const MFA_PROMOTION_RATE_LIMITED_MESSAGE =
  'Supabase の MFA の回数制限 (429) に当たりました。ローカルの Supabase では MFA の回数制限が効かない前提です (docs/design/cross/12-operator-mfa.md §22.4.4。結合テスト M-13 を確かめてください)';

/** 回数制限の HTTP ステータス */
const HTTP_TOO_MANY_REQUESTS = 429;
/** 6 桁の不一致で GoTrue が返す HTTP ステータス */
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE_ENTITY = 422;
/** auth-js の error.code: 6 桁の不一致 */
const MFA_VERIFICATION_FAILED_CODE = 'mfa_verification_failed';
/** auth-js の error.code: 回数制限 */
const OVER_REQUEST_RATE_LIMIT_CODE = 'over_request_rate_limit';
/** 1 秒のミリ秒 */
const MILLISECONDS_PER_SECOND = 1000;
/** 昇格で登録する factor の表示名 (1 利用者 1 個) */
const INTEGRATION_TOTP_FRIENDLY_NAME = 'integration-authenticator';

interface AuthLikeError {
  readonly status?: number;
  readonly code?: string;
}

function isRateLimited(error: AuthLikeError): boolean {
  return error.status === HTTP_TOO_MANY_REQUESTS || error.code === OVER_REQUEST_RATE_LIMIT_CODE;
}

function isCodeMismatch(error: AuthLikeError): boolean {
  return (
    error.code === MFA_VERIFICATION_FAILED_CODE ||
    error.status === HTTP_BAD_REQUEST ||
    error.status === HTTP_UNPROCESSABLE_ENTITY
  );
}

/**
 * サインイン済みの client のセッションを aal2 にし、aal2 の access_token を返す:
 *   mfa.enroll({ factorType: 'totp' }) → generateTotp(data.totp.secret) (tests/helpers/totp.ts)
 *   → mfa.challengeAndVerify({ factorId, code }) → data.access_token
 * verify は同じ利用者の他のセッションを終える (§26.3) ので、1 利用者につき 1 つのセッションだけを昇格させる。
 * challengeAndVerify の error が status 429 (または code 'over_request_rate_limit') なら、やり直さずに
 * `${MFA_PROMOTION_RATE_LIMITED_MESSAGE} (段: verify)` の Error を投げる。6 桁の不一致 (mfa_verification_failed / 400 / 422) だけを TOTP_RETRY_ONCE 回やり直す。
 */
export async function promoteToAal2(userClient: SupabaseClient): Promise<string> {
  const { data: enrolled, error: enrollError } = await userClient.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: INTEGRATION_TOTP_FRIENDLY_NAME,
  });
  if (enrollError || !enrolled) {
    throw new Error(`TOTP の昇格に失敗しました (段: enroll。status ${enrollError?.status ?? 'none'})`);
  }
  const factorId = enrolled.id;
  const secret = enrolled.totp.secret;
  const startedAt = Date.now() / MILLISECONDS_PER_SECOND;

  for (let attempt = 0; attempt <= TOTP_RETRY_ONCE; attempt += 1) {
    const code = generateTotp(secret, startedAt + attempt * TOTP_STEP_SECONDS);
    const { data: verified, error: verifyError } = await userClient.auth.mfa.challengeAndVerify({ factorId, code });
    if (!verifyError && verified) return verified.access_token;
    if (verifyError && isRateLimited(verifyError)) {
      throw new Error(`${MFA_PROMOTION_RATE_LIMITED_MESSAGE} (段: verify)`);
    }
    if (!verifyError || !isCodeMismatch(verifyError)) {
      throw new Error(`TOTP の昇格に失敗しました (段: verify。status ${verifyError?.status ?? 'none'})`);
    }
  }
  throw new Error(`TOTP の昇格に失敗しました (段: verify。6 桁の不一致が ${TOTP_RETRY_ONCE + 1} 回続きました)`);
}

/**
 * 使い捨ての anon client (auth: { autoRefreshToken: false, persistSession: false }。users.ts の今のサインインと同じ作り) で
 * email + password のサインインをし、roles が必須ロール (isMfaRequiredRoleSet。src/lib/auth/mfa/policy.ts) を含めば
 * promoteToAal2 で aal2 にしたうえで、その JWT を返す。含まなければ aal1 の JWT をそのまま返す。
 * 失敗は Error を投げる (メッセージに password・token を入れない。email と段 (sign-in / enroll / verify) だけ)。
 */
export async function signInForIntegration(params: {
  email: string;
  password: string;
  roles: ReadonlyArray<string>;
}): Promise<string> {
  // 共有の supabaseAdmin でサインインすると、以後の supabaseAdmin の要求がこのユーザーの JWT で送られ
  // service_role でなくなる (supabase-js がセッションを保持する) ため、サインインは使い捨てのクライアントで行う。
  const signInClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data, error } = await signInClient.auth.signInWithPassword({
    email: params.email,
    password: params.password,
  });
  if (error || !data.session) {
    throw new Error(`Failed to sign in test user ${params.email} (段: sign-in。status ${error?.status ?? 'none'})`);
  }
  if (!isMfaRequiredRoleSet(params.roles)) return data.session.access_token;
  try {
    return await promoteToAal2(signInClient);
  } catch (err) {
    const reason = err instanceof Error ? err.message : '不明な失敗';
    throw new Error(`Failed to promote test user ${params.email} to aal2: ${reason}`);
  }
}
