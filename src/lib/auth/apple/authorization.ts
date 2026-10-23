/**
 * POST /api/auth/apple/authorization の本体 (docs/design/mobile/08-sign-in-with-apple.md §9.2)。
 * 認可コード → (client_secret) → /auth/token → refresh_token を保管。route は入口の確認と応答への変換だけ。
 */
import type { User } from '@supabase/supabase-js';
import { createAppleClientSecret } from './client-secret';
import {
  APPLE_CLIENT_SECRET_TTL_SECONDS,
  APPLE_SIGN_IN_NATIVE_CLIENT_ID,
  readAppleSignInServerConfig,
} from './config';
import { exchangeAppleAuthorizationCode, type FetchLike } from './rest';
import { storeAppleRefreshToken, type AppleTokenStore } from './tokens';

export type RegisterAppleAuthorizationResult =
  | { status: 'stored' }
  | { status: 'not_configured' }
  /** 秘密鍵が壊れていて client_secret を作れない (createPrivateKey・sign が投げた。error は呼ぶ側が internalError に渡す) */
  | { status: 'secret_failed'; error: unknown }
  | { status: 'invalid_code'; appleStatus: number; appleError: string }
  | { status: 'unavailable'; appleStatus: number | null; appleError: string | null }
  /** DB の失敗 (error は呼ぶ側が internalError に渡す) */
  | { status: 'store_failed'; error: unknown };

/** この利用者が Apple で入っているか (identities に provider 'apple' がある) */
export function hasAppleIdentity(user: Pick<User, 'identities'>): boolean {
  return (user.identities ?? []).some((identity) => identity.provider === 'apple');
}

const MS_PER_SECOND = 1000;

export async function registerAppleAuthorization(
  input: { admin: AppleTokenStore; userId: string; authorizationCode: string; now?: () => Date; fetchImpl?: FetchLike },
): Promise<RegisterAppleAuthorizationResult> {
  const config = readAppleSignInServerConfig();
  if (!config) return { status: 'not_configured' };
  const issuedAt = Math.floor((input.now?.() ?? new Date()).getTime() / MS_PER_SECOND);
  let clientSecret: string;
  try {
    clientSecret = createAppleClientSecret({
      teamId: config.teamId,
      keyId: config.keyId,
      privateKeyPem: config.privateKeyPem,
      clientId: APPLE_SIGN_IN_NATIVE_CLIENT_ID,
      issuedAtSeconds: issuedAt,
      ttlSeconds: APPLE_CLIENT_SECRET_TTL_SECONDS,
    });
  } catch (error) {
    return { status: 'secret_failed', error };
  }
  const exchanged = await exchangeAppleAuthorizationCode(
    { clientId: APPLE_SIGN_IN_NATIVE_CLIENT_ID, clientSecret, code: input.authorizationCode },
    input.fetchImpl,
  );
  if (!exchanged.ok) {
    return exchanged.reason === 'invalid_code'
      ? { status: 'invalid_code', appleStatus: exchanged.status, appleError: exchanged.error }
      : { status: 'unavailable', appleStatus: exchanged.status, appleError: exchanged.error };
  }
  try {
    await storeAppleRefreshToken(input.admin, {
      userId: input.userId,
      clientId: APPLE_SIGN_IN_NATIVE_CLIENT_ID,
      refreshToken: exchanged.refreshToken,
      now: input.now,
    });
  } catch (error) {
    return { status: 'store_failed', error };
  }
  return { status: 'stored' };
}
