/**
 * Web の OAuth (段 B) のコールバックで、Apple の refresh token を保管する (docs/design/mobile/08-sign-in-with-apple.md §9.5)。
 * /auth/callback が code の交換に成功したあとに 1 回呼ぶ。例外を投げない (振り分けを変えない)。token はログに出さない。
 */
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { hasAppleIdentity } from './authorization';
import { readAppleSignInServerConfig } from './config';
import { storeAppleRefreshToken } from './tokens';

export interface WebCallbackLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

/** /auth/callback の ?provider= の値のうち、保管の対象 (?error= のときに固定の文にする対象も同じ) */
export const APPLE_CALLBACK_PROVIDER = 'apple';

/**
 * ?provider=apple の /auth/callback に ?error= が付いて戻ったとき (Apple の画面で取り消した・拒否した、Apple / GoTrue の失敗。S-34) に、
 * ログイン画面 (/login?error=) の赤いバナーに出す固定の文。Apple・GoTrue の英文 (error_description・error の値) を出さない。
 * error の値 (user_cancelled_authorize・access_denied・server_error など。Apple と GoTrue が決める) では分けない (§21 Q-7 の (a))。
 * ログイン画面は ?error= の値をもう 1 回 decodeURIComponent してから出す (src/app/(auth)/login/page.tsx:65) ので、% を含めない
 */
export const APPLE_WEB_CALLBACK_ERROR_MESSAGE = 'Apple でのログインを完了できませんでした。もう一度お試しください。';

/** ?provider= が apple なら APPLE_WEB_CALLBACK_ERROR_MESSAGE、ほかは null (呼ぶ側は provider に関わらない固定の文 AUTH_LINK_ERROR_MESSAGE を使う。#1917 の続き) */
export function appleCallbackErrorMessage(provider: string | null): string | null {
  return provider === APPLE_CALLBACK_PROVIDER ? APPLE_WEB_CALLBACK_ERROR_MESSAGE : null;
}

export async function storeAppleRefreshTokenFromWebCallback(input: {
  provider: string | null;
  user: User | null;
  session: Session | null;
  log: WebCallbackLogger;
  requestId: string;
}): Promise<'stored' | 'skipped'> {
  if (input.provider !== APPLE_CALLBACK_PROVIDER || !input.user || !hasAppleIdentity(input.user)) return 'skipped';
  const refreshToken = input.session?.provider_refresh_token;
  if (!refreshToken) {
    input.log.info('auth/callback: apple sign-in without provider_refresh_token; nothing stored', { request_id: input.requestId });
    return 'skipped';
  }
  const servicesId = readAppleSignInServerConfig()?.servicesId ?? null;
  if (!servicesId) {
    input.log.info('auth/callback: apple services id is not configured; refresh token not stored', { request_id: input.requestId });
    return 'skipped';
  }
  try {
    await storeAppleRefreshToken(getSupabaseAdmin(), { userId: input.user.id, clientId: servicesId, refreshToken });
    return 'stored';
  } catch (error) {
    input.log.warn('auth/callback: could not store the apple refresh token (sign-in continues)', {
      request_id: input.requestId,
      error_name: error instanceof Error ? error.name : 'unknown',
    });
    return 'skipped';
  }
}
