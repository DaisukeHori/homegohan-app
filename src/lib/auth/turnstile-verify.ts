/**
 * Cloudflare Turnstile のトークンを、サーバーで確かめる (#1165)。サーバー専用。
 *
 * POST /api/auth/login が、ログインに 3 回続けて失敗したメールアドレス (src/lib/auth/login-failures.ts の
 * CAPTCHA_REQUIRED_FAILURE_COUNT) の次のログインで呼ぶ。ログインに続けて失敗しても、アカウントはロックしない。
 *
 * - 有効になるのは、秘密キー TURNSTILE_SECRET_KEY とサイトキー NEXT_PUBLIC_TURNSTILE_SITE_KEY の両方が設定されているときだけ。
 *   どちらかが無ければ「無効」で、トークンを確かめずに通す。
 *   - 秘密キーが無いとき: src/lib/env.ts の getOptionalEnv が、サーバーのプロセスごとに 1 回だけ警告のログを出す
 *     (サーバーが起動してから最初のログインの要求で。POST /api/auth/login が isTurnstileVerificationEnabled を最初に呼ぶ)。
 *   - サイトキーが無いのに秘密キーだけあるとき: 画面にウィジェットが出ず、トークンを取る手段が無い。
 *     確かめると 3 回失敗した人が、回数が 0 に戻るまで (成功するか、時間が経つまで) ログインできなくなるので、無効として扱い、プロセスごとに 1 回だけ警告のログを出す。
 * - Cloudflare に届かない・応答が壊れているときは 'unavailable' (呼び出し側は通さない)。
 * - トークンは 1 回しか使えない。ここで確かめたトークンは、Supabase へは渡さない (渡すと使用済みで断られる)。
 */
import { z } from 'zod';
import { createLogger } from '@/lib/db-logger';
import { getOptionalEnv } from '@/lib/env';
import { getTurnstileSiteKey } from '@/lib/auth/turnstile';

/** Cloudflare の確認の API。https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare の応答を待つ最長時間 (ミリ秒)。ふだんは数百ミリ秒で返る。
 * 超えたら 'unavailable' にして、ログインの応答を待たせ続けない。
 */
export const TURNSTILE_VERIFY_TIMEOUT_MS = 5000;

/** Cloudflare の決まり: トークンは最大 2048 文字 */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

export type TurnstileVerifyResult =
  /** 確認は無効 (キーが未設定)。確かめずに通す */
  | { status: 'disabled' }
  /** 確かめて、通った */
  | { status: 'passed' }
  /** トークンが無い・期限切れ・使用済み・偽物 */
  | { status: 'failed'; errorCodes: string[] }
  /** Cloudflare に届かない・応答が壊れている */
  | { status: 'unavailable' };

const SiteverifyResponseSchema = z.object({
  success: z.boolean(),
  'error-codes': z.array(z.string()).optional(),
});

let warnedSecretWithoutSiteKey = false;

/** テスト用: 「1 回だけ出す警告」の記録を忘れる */
export function resetTurnstileVerifyWarningsForTest(): void {
  warnedSecretWithoutSiteKey = false;
}

/** 確認に使う秘密キー。無効なら null */
function getActiveSecretKey(): string | null {
  const secret = getOptionalEnv('TURNSTILE_SECRET_KEY')?.trim();
  if (!secret) return null;
  if (!getTurnstileSiteKey()) {
    if (!warnedSecretWithoutSiteKey) {
      warnedSecretWithoutSiteKey = true;
      createLogger('auth/turnstile').warn(
        'TURNSTILE_SECRET_KEY はあるが NEXT_PUBLIC_TURNSTILE_SITE_KEY が無いため、Turnstile の確認は無効です (画面にウィジェットが出ず、トークンを取れないため)',
      );
    }
    return null;
  }
  return secret;
}

/**
 * Turnstile の確認が有効か (キーが両方そろっているか)。
 * 無効なら、その旨の警告のログを、サーバーのプロセスごとに 1 回だけ出す (getOptionalEnv と、組になっていないときの警告)。
 * POST /api/auth/login が、リクエストのたびに最初に呼ぶ (サーバーが起動してから最初のログインの要求で 1 回だけログが出る)。
 * ビルド時 (route の読み込み) には呼ばない (ビルドの途中で app_logs へ書こうとしないため)。
 */
export function isTurnstileVerificationEnabled(): boolean {
  return getActiveSecretKey() !== null;
}

/**
 * トークンを確かめる。
 * @param token 画面のウィジェットが出したトークン。無ければ 'failed' (確認が有効なとき)
 * @param remoteIp 利用者の IP アドレス (Cloudflare への参考情報。無ければ送らない)
 */
export async function verifyTurnstileToken(
  token: string | undefined,
  remoteIp: string | null,
): Promise<TurnstileVerifyResult> {
  const secret = getActiveSecretKey();
  if (!secret) return { status: 'disabled' };
  if (!token) return { status: 'failed', errorCodes: ['missing-input-response'] };
  if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) return { status: 'failed', errorCodes: ['invalid-input-response'] };

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  let json: unknown;
  try {
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(TURNSTILE_VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      createLogger('auth/turnstile').warn('Turnstile の確認の API がエラーを返しました', { status: response.status });
      return { status: 'unavailable' };
    }
    json = await response.json();
  } catch (error) {
    createLogger('auth/turnstile').warn('Turnstile の確認の API に届きませんでした', {
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return { status: 'unavailable' };
  }

  const parsed = SiteverifyResponseSchema.safeParse(json);
  if (!parsed.success) {
    createLogger('auth/turnstile').warn('Turnstile の確認の API の応答を読めませんでした');
    return { status: 'unavailable' };
  }
  if (parsed.data.success) return { status: 'passed' };
  return { status: 'failed', errorCodes: parsed.data['error-codes'] ?? [] };
}
