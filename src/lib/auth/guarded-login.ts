/**
 * ロックとボットの確認を通したログイン (#1165)。サーバー専用。POST /api/auth/login の中身。
 *
 * 順番 (設計 docs/design/cross/01-auth-session.md §3.2・§8・§15):
 *   1. ロック中なら、パスワードを確かめずに断る (正しいパスワードでも)。回数は増やさない。
 *   2. 連続失敗が 3 回以上なら、ボットの確認 (Turnstile) のトークンを確かめる。
 *      確認が無効 (キーが未設定) なら確かめずに通す。トークンが無い・偽物なら断る (回数は増やさない)。
 *   3. Supabase Auth でパスワードを確かめる。
 *      - 失敗 (メールアドレスかパスワードが違う): 回数を 1 増やし、届いた段のロックをかける。段にちょうど届いたら通知する。
 *      - 成功: 失敗の記録を消す。
 *   (IP アドレスごとの回数制限は、この前に route が行う)
 *
 * トークンの扱い: Turnstile のトークンは 1 回しか使えない。2 でこちらが確かめたトークンは Supabase へ渡さない。
 * 確かめなかったトークン (連続失敗が 3 回未満、または確認が無効) は、今までどおり Supabase へ captchaToken として渡す
 * (Supabase のダッシュボードで CAPTCHA を有効にしたときは、Supabase が確かめる。docs/operations/auth-protection.md)。
 *
 * この関数は副作用 (DB・Supabase Auth・通知) をすべて deps から受け取る。テストでは偽物を渡す。
 */
import {
  clearLoginFailures,
  readLoginLockState,
  recordLoginFailure,
  type LoginLockNotice,
  type LoginLockRpcClient,
} from '@/lib/auth/login-lock';
import { isCaptchaFailure } from '@/lib/auth/turnstile';
import type { TurnstileVerifyResult } from '@/lib/auth/turnstile-verify';

export interface GuardedLoginInput {
  /** 小文字・前後の空白なしのメールアドレス */
  email: string;
  password: string;
  captchaToken?: string;
}

/** Supabase Auth の signInWithPassword の結果のうち、使うものだけ */
export interface SignInOutcome {
  error: { code?: string; status?: number; message: string } | null;
}

export interface GuardedLoginDeps {
  /** ロックの記録 (service_role の client) */
  lockStore: LoginLockRpcClient;
  /** パスワードを確かめ、成功ならセッションを作る (Cookie を付ける) */
  signIn(input: { email: string; password: string; captchaToken?: string }): Promise<SignInOutcome>;
  /** Turnstile のトークンを確かめる */
  verifyCaptcha(token: string | undefined): Promise<TurnstileVerifyResult>;
  /** 段にちょうど届いたときの通知 (待たずに後ろで動かしてよい) */
  notify(input: { email: string; notice: LoginLockNotice; failureCount: number; lockedUntil: Date }): void;
  now(): Date;
}

export type GuardedLoginResult =
  | { kind: 'signed-in' }
  /** ロック中 (この試行の前から、またはこの失敗でロックした) */
  | { kind: 'locked'; retryAfterSec: number }
  /** メールアドレスかパスワードが違う (まだロックしていない) */
  | { kind: 'invalid-credentials'; captchaRequired: boolean }
  /** ボットの確認が必要なのに、トークンが無い・偽物 (こちらの確認、または Supabase の CAPTCHA) */
  | { kind: 'captcha-failed' }
  /** ボットの確認の API に届かない */
  | { kind: 'captcha-unavailable' }
  /** パスワードは合っているが、メールアドレスの確認が済んでいない */
  | { kind: 'email-not-confirmed' }
  /** Supabase Auth の回数制限 */
  | { kind: 'upstream-rate-limited' }
  /** そのほかの Supabase Auth のエラー */
  | { kind: 'upstream-error'; code: string | null; status: number | null };

function isInvalidCredentials(error: NonNullable<SignInOutcome['error']>): boolean {
  return error.code === 'invalid_credentials' || error.message.includes('Invalid login credentials');
}

function isEmailNotConfirmed(error: NonNullable<SignInOutcome['error']>): boolean {
  return error.code === 'email_not_confirmed' || error.message.includes('Email not confirmed');
}

function isUpstreamRateLimit(error: NonNullable<SignInOutcome['error']>): boolean {
  return (
    error.status === 429 ||
    error.code === 'over_request_rate_limit' ||
    error.code === 'over_email_send_rate_limit' ||
    error.message.includes('For security purposes') ||
    error.message.toLowerCase().includes('too many requests')
  );
}

/**
 * ロックとボットの確認を通してログインする。
 * ロックの記録の読み書きに失敗したときは LoginLockStoreError を投げる (判定できないので、ログインは通さない)。
 */
export async function performGuardedLogin(input: GuardedLoginInput, deps: GuardedLoginDeps): Promise<GuardedLoginResult> {
  const before = await readLoginLockState(deps.lockStore, input.email, deps.now());
  if (before.locked) return { kind: 'locked', retryAfterSec: before.retryAfterSec };

  let captchaTokenForSupabase = input.captchaToken;
  if (before.captchaRequired) {
    const verified = await deps.verifyCaptcha(input.captchaToken);
    if (verified.status === 'failed') return { kind: 'captcha-failed' };
    if (verified.status === 'unavailable') return { kind: 'captcha-unavailable' };
    // こちらで確かめたトークンは使用済み。Supabase へは渡さない
    if (verified.status === 'passed') captchaTokenForSupabase = undefined;
  }

  const { error } = await deps.signIn({
    email: input.email,
    password: input.password,
    ...(captchaTokenForSupabase ? { captchaToken: captchaTokenForSupabase } : {}),
  });

  if (!error) {
    if (before.failureCount > 0) await clearLoginFailures(deps.lockStore, input.email);
    return { kind: 'signed-in' };
  }

  if (isInvalidCredentials(error)) {
    const now = deps.now();
    const recorded = await recordLoginFailure(deps.lockStore, input.email, now);
    if (recorded.notice !== 'none' && recorded.lockedUntil) {
      deps.notify({
        email: input.email,
        notice: recorded.notice,
        failureCount: recorded.failureCount,
        lockedUntil: recorded.lockedUntil,
      });
    }
    if (recorded.locked) return { kind: 'locked', retryAfterSec: recorded.retryAfterSec };
    return { kind: 'invalid-credentials', captchaRequired: recorded.captchaRequired };
  }

  // パスワードの間違いではないものは、回数に数えない
  if (isEmailNotConfirmed(error)) return { kind: 'email-not-confirmed' };
  if (isCaptchaFailure(error)) return { kind: 'captcha-failed' };
  if (isUpstreamRateLimit(error)) return { kind: 'upstream-rate-limited' };
  return { kind: 'upstream-error', code: error.code ?? null, status: error.status ?? null };
}
