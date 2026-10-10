/**
 * POST /api/auth/login — Web のメールアドレス + パスワードのログイン (#1165)
 *
 * 以前は、ログイン画面がブラウザから Supabase Auth (signInWithPassword) を直接呼んでいて、
 * サーバーが失敗の回数を数える場所が無かった。ここを通すことで、設計 docs/design/cross/01-auth-session.md の
 *   - §3.2 IP アドレスごとの回数制限 (10 回/分。src/lib/rate-limit.ts の auth-login)
 *   - §8   ログイン失敗のロック (3 回 → ボットの確認、5 回 → 15 分、10 回 → 1 時間 + 本人へメール、20 回 → 24 時間 + 運営へ通知)
 * をサーバーで行う。中身は src/lib/auth/guarded-login.ts。
 *
 * リクエスト: { email, password, captchaToken? } (JSON)
 * 応答 (本文は { error: 利用者向けの文言, code, ... }。Cache-Control: no-store):
 *   200 { ok: true }                                  ログインできた。セッションの Cookie を付ける
 *   400 VALIDATION_ERROR                              本文の形が違う
 *   400 AUTH_CAPTCHA_FAILED                           ボットの確認のトークンが無い・偽物
 *   401 AUTH_INVALID_CREDENTIALS { captchaRequired }  メールアドレスかパスワードが違う
 *   403 AUTH_EMAIL_NOT_CONFIRMED                      メールアドレスの確認が済んでいない
 *   403 FORBIDDEN_ORIGIN                              別のサイトから送られた (ログインの CSRF を防ぐ)
 *   423 AUTH_ACCOUNT_LOCKED { retryAfter }            ロック中 (Retry-After ヘッダーも付ける)
 *   429 RATE_LIMITED { retryAfter }                   回数制限 (この API の IP ごとの制限、または Supabase Auth の制限)
 *   503 AUTH_CAPTCHA_UNAVAILABLE                      ボットの確認の API に届かない
 *   500 INTERNAL_ERROR                                ロックの記録を読み書きできない (判定できないので通さない) など
 *
 * 応答の内容は、アカウントが存在するかどうかで変えない (存在しないメールアドレスも同じように数えてロックする)。
 * 通知 (10 回・20 回) は応答を返したあとで送る (waitUntil)。応答の時間からアカウントの有無が分からないように。
 */
import { waitUntil } from '@vercel/functions';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { extractClientIp } from '@/lib/admin/audit';
import { internalError } from '@/lib/api/errors';
import { performGuardedLogin, type GuardedLoginResult } from '@/lib/auth/guarded-login';
import { type LoginLockRpcClient } from '@/lib/auth/login-lock';
import { sendLoginLockNotice } from '@/lib/auth/login-lock-notification';
import { CAPTCHA_FAILED_MESSAGE } from '@/lib/auth/turnstile';
import { TURNSTILE_TOKEN_MAX_LENGTH, verifyTurnstileToken } from '@/lib/auth/turnstile-verify';
import { createLogger } from '@/lib/db-logger';
import { checkRateLimit, getRetryAfterSec, type RateLimitResult } from '@/lib/rate-limit';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/auth/login';

/** メールアドレスの長さの上限 (RFC 5321 のアドレス全体の上限) */
const EMAIL_MAX_LENGTH = 254;
/**
 * パスワードの長さの上限。Supabase Auth (GoTrue) は bcrypt を使い、72 バイトを超えた分は比べない。
 * 画面の入力 (新規登録の上限) より十分に長く、巨大な本文を Supabase へ送らないための上限
 */
const PASSWORD_MAX_LENGTH = 1024;

const LoginBodySchema = z.object({
  email: z.string().max(EMAIL_MAX_LENGTH),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  captchaToken: z.string().min(1).max(TURNSTILE_TOKEN_MAX_LENGTH).optional(),
});
const EmailSchema = z.email();

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

const INVALID_CREDENTIALS_MESSAGE = 'メールアドレスまたはパスワードが正しくありません。';
const ACCOUNT_LOCKED_MESSAGE =
  'ログインに続けて失敗したため、しばらくログインできません。パスワードを再設定すると、すぐにログインできます。';
const RATE_LIMITED_MESSAGE = 'しばらくしてから再度お試しください。';

function json(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function rateLimited(retryAfterSec: number | null) {
  return json(
    { error: RATE_LIMITED_MESSAGE, code: 'RATE_LIMITED', ...(retryAfterSec ? { retryAfter: retryAfterSec } : {}) },
    429,
    retryAfterSec ? { 'Retry-After': String(retryAfterSec) } : {},
  );
}

/**
 * 別のサイトのページから送られたリクエストか。ブラウザは POST の fetch に Origin を付ける。
 * Origin が無いリクエスト (ブラウザ以外) は、ここでは断らない (Cookie を持たないので、ログインの CSRF にならない)。
 */
function isCrossOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.nextUrl.host;
  } catch {
    return true;
  }
}

function toResponse(result: GuardedLoginResult) {
  switch (result.kind) {
    case 'signed-in':
      return json({ ok: true }, 200);
    case 'locked':
      return json(
        { error: ACCOUNT_LOCKED_MESSAGE, code: 'AUTH_ACCOUNT_LOCKED', retryAfter: result.retryAfterSec },
        423,
        { 'Retry-After': String(result.retryAfterSec) },
      );
    case 'invalid-credentials':
      return json(
        { error: INVALID_CREDENTIALS_MESSAGE, code: 'AUTH_INVALID_CREDENTIALS', captchaRequired: result.captchaRequired },
        401,
      );
    case 'captcha-failed':
      return json({ error: CAPTCHA_FAILED_MESSAGE, code: 'AUTH_CAPTCHA_FAILED' }, 400);
    case 'captcha-unavailable':
      return json(
        {
          error: 'ボットではないことの確認を、いま行えません。しばらくしてから再度お試しください。',
          code: 'AUTH_CAPTCHA_UNAVAILABLE',
        },
        503,
      );
    case 'email-not-confirmed':
      return json(
        { error: 'メールアドレスが確認されていません。確認メールをご確認ください。', code: 'AUTH_EMAIL_NOT_CONFIRMED' },
        403,
      );
    case 'upstream-rate-limited':
      return rateLimited(null);
    case 'upstream-error':
      return internalError(ROUTE_NAME, new Error('Supabase Auth がログインの処理に失敗しました'), {
        upstream_code: result.code,
        upstream_status: result.status,
      });
  }
}

export async function POST(request: NextRequest) {
  if (isCrossOrigin(request)) {
    return json({ error: '許可されていないリクエストです。', code: 'FORBIDDEN_ORIGIN' }, 403);
  }

  // 設計 §3.2: IP アドレスごとの回数制限。判定できない (Upstash の例外) ときは通さない (fail-closed)
  const clientIp = extractClientIp(request.headers);
  let rateLimit: RateLimitResult;
  try {
    rateLimit = await checkRateLimit(clientIp ?? 'unknown', 'auth-login');
  } catch (error) {
    return internalError(ROUTE_NAME, error, { stage: 'rate-limit' });
  }
  if (!rateLimit.success) return rateLimited(getRetryAfterSec(rateLimit));

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    rawBody = null;
  }
  const parsedBody = LoginBodySchema.safeParse(rawBody);
  // #288: 大文字のメールアドレスを小文字にそろえる (画面と同じ)
  const email = parsedBody.success ? parsedBody.data.email.trim().toLowerCase() : '';
  if (!parsedBody.success || !EmailSchema.safeParse(email).success) {
    return json({ error: 'メールアドレスとパスワードを入力してください。', code: 'VALIDATION_ERROR' }, 400);
  }

  let admin: ReturnType<typeof getSupabaseAdmin>;
  try {
    admin = getSupabaseAdmin();
  } catch (error) {
    return internalError(ROUTE_NAME, error, { stage: 'admin-client' });
  }
  const lockStore: LoginLockRpcClient = { rpc: (fn, args) => admin.rpc(fn, args) };
  const supabase = createClient();

  try {
    const result = await performGuardedLogin(
      { email, password: parsedBody.data.password, captchaToken: parsedBody.data.captchaToken },
      {
        lockStore,
        signIn: async ({ email: signInEmail, password, captchaToken }) => {
          const { error } = await supabase.auth.signInWithPassword({
            email: signInEmail,
            password,
            ...(captchaToken ? { options: { captchaToken } } : {}),
          });
          return { error: error ? { code: error.code, status: error.status, message: error.message } : null };
        },
        verifyCaptcha: (token) => verifyTurnstileToken(token, clientIp),
        notify: (input) => {
          waitUntil(
            sendLoginLockNotice(lockStore, input).catch((error: unknown) => {
              createLogger('auth/login-lock').error('ロックの通知の処理が失敗しました', error);
            }),
          );
        },
        onClearFailed: (error) => {
          createLogger('auth/login-lock').error('ログインに成功したが、失敗の記録を消せませんでした', error);
        },
        now: () => new Date(),
      },
    );
    return toResponse(result);
  } catch (error) {
    return internalError(ROUTE_NAME, error, { stage: 'guarded-login' });
  }
}
