/**
 * Apple の交換 (/auth/token) と失効 (/auth/revoke) の呼び出し (docs/design/mobile/08-sign-in-with-apple.md §11.3)。
 * fetch は引数で差し替えられる (テストは本物の Apple に繋がない)。応答の本文・secret・token はログに出さない。
 */
import { APPLE_API_TIMEOUT_MS, APPLE_REVOKE_ENDPOINT, APPLE_TOKEN_ENDPOINT } from './config';
import { AppleErrorResponseSchema, AppleTokenResponseSchema } from './schemas';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type AppleTokenExchangeResult =
  | { ok: true; refreshToken: string }
  /** Apple が invalid_grant (期限切れ・使用済み・別の client のコード)。利用者側の 400 */
  | { ok: false; reason: 'invalid_code'; status: number; error: string }
  /** 届かない・時間切れ・5xx・本文が壊れている */
  | { ok: false; reason: 'unavailable'; status: number | null; error: string | null };

export type AppleRevokeResult = { ok: true } | { ok: false; status: number | null; error: string | null };

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const INVALID_GRANT = 'invalid_grant';

/** timeoutMs を過ぎたら fetch (と本文の読み取り) を打ち切る */
async function postForm(fetchImpl: FetchLike, url: string, form: Record<string, string>, timeoutMs: number): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** 4xx の本文の error (無ければ null)。error_description は読まない (ログにも出さない) */
async function appleErrorOf(response: Response): Promise<string | null> {
  const parsed = AppleErrorResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : null;
}

/** 認可コードを refresh token に替える (grant_type=authorization_code。ネイティブは redirect_uri を渡さない) */
export async function exchangeAppleAuthorizationCode(
  input: { clientId: string; clientSecret: string; code: string },
  fetchImpl: FetchLike = fetch,
): Promise<AppleTokenExchangeResult> {
  let response: Response;
  try {
    response = await postForm(
      fetchImpl,
      APPLE_TOKEN_ENDPOINT,
      {
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        grant_type: 'authorization_code',
      },
      APPLE_API_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: 'unavailable', status: null, error: null };
  }
  if (response.status === HTTP_OK) {
    const parsed = AppleTokenResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return { ok: false, reason: 'unavailable', status: response.status, error: null };
    return { ok: true, refreshToken: parsed.data.refresh_token };
  }
  const error = await appleErrorOf(response);
  if (response.status === HTTP_BAD_REQUEST && error === INVALID_GRANT) {
    return { ok: false, reason: 'invalid_code', status: response.status, error };
  }
  return { ok: false, reason: 'unavailable', status: response.status, error };
}

/**
 * refresh token を失効させる (token_type_hint=refresh_token)。200 は既に無効な token でも返る (F-14)。
 * timeoutMs: 待つ最長 (ミリ秒)。省略すると APPLE_API_TIMEOUT_MS。退会の段階 (revocation.ts) は締め切りまでの残りとの短いほうを渡す
 */
export async function revokeAppleRefreshToken(
  input: { clientId: string; clientSecret: string; refreshToken: string; timeoutMs?: number },
  fetchImpl: FetchLike = fetch,
): Promise<AppleRevokeResult> {
  let response: Response;
  try {
    response = await postForm(
      fetchImpl,
      APPLE_REVOKE_ENDPOINT,
      {
        client_id: input.clientId,
        client_secret: input.clientSecret,
        token: input.refreshToken,
        token_type_hint: 'refresh_token',
      },
      input.timeoutMs ?? APPLE_API_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, status: null, error: null };
  }
  if (response.status === HTTP_OK) return { ok: true };
  return { ok: false, status: response.status, error: await appleErrorOf(response) };
}
