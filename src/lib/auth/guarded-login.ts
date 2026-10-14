/**
 * ボットの確認を通したログイン (#1165)。サーバー専用。POST /api/auth/login の中身。
 *
 * ログインに続けて失敗しても、アカウントはロックしない (docs/operations/auth-protection.md §1)。
 * 何回失敗していても、正しいパスワードならログインできる。失敗が続いたら、ボットの確認を求めるだけ。
 *
 * 順番:
 *   1. 連続失敗が 3 回以上なら、ボットの確認 (Turnstile) のトークンを確かめる。
 *      確認が無効 (キーが未設定) なら確かめずに通す。トークンが無い・偽物なら断る (回数は増やさない)。
 *   2. Supabase Auth でパスワードを確かめる。
 *      - 失敗 (メールアドレスかパスワードが違う): 回数を 1 増やす (最後の失敗から一定の時間が経っていれば 1 からやり直す)。
 *      - 成功: 失敗の記録を消す。
 *   (IP アドレスごとの回数制限は、この前に route が行う)
 *
 * トークンの扱い: Turnstile のトークンは 1 回しか使えない。1 でこちらが確かめたトークンは Supabase へ渡さない。
 * 確かめなかったトークン (連続失敗が 3 回未満、または確認が無効) は、今までどおり Supabase へ captchaToken として渡す
 * (Supabase のダッシュボードで CAPTCHA を有効にしたときは、Supabase が確かめる。docs/operations/auth-protection.md)。
 *
 * この関数は副作用 (DB・Supabase Auth) をすべて deps から受け取る。テストでは偽物を渡す。
 */
import {
  clearLoginFailures,
  readLoginFailureState,
  recordLoginFailure,
  type LoginFailureRpcClient,
} from '@/lib/auth/login-failures';
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
  /** 失敗の回数の記録 (service_role の client) */
  failureStore: LoginFailureRpcClient;
  /** 連続失敗の回数を 0 に戻すまでの、最後の失敗からの時間 (分。src/lib/auth/login-failures.ts の resolveLoginFailureResetMinutes) */
  resetAfterMinutes: number;
  /** パスワードを確かめ、成功ならセッションを作る (Cookie を付ける) */
  signIn(input: { email: string; password: string; captchaToken?: string }): Promise<SignInOutcome>;
  /** Turnstile のトークンを確かめる */
  verifyCaptcha(token: string | undefined): Promise<TurnstileVerifyResult>;
  /** ログインに成功したのに、失敗の記録を消せなかったとき (ログに残す) */
  onClearFailed(error: unknown): void;
}

export type GuardedLoginResult =
  | { kind: 'signed-in' }
  /** メールアドレスかパスワードが違う。captchaRequired は、次のログインでボットの確認を求めるか */
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
 * ボットの確認を通してログインする。
 * 失敗の回数の読み書きに失敗したときは LoginFailureStoreError を投げる
 * (ボットの確認を求めるかを判定できない・失敗を数えられないので、ログインは通さない)。
 */
export async function performGuardedLogin(input: GuardedLoginInput, deps: GuardedLoginDeps): Promise<GuardedLoginResult> {
  const before = await readLoginFailureState(deps.failureStore, input.email, deps.resetAfterMinutes);

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
    if (before.failureCount > 0) {
      // セッションはもう作られている (Cookie を付けた)。記録を消せなくてもログインは成功のまま返す
      // (500 にすると、ログインできているのに「失敗」と見える)。残った回数は次の成功か、時間で消える
      try {
        await clearLoginFailures(deps.failureStore, input.email);
      } catch (clearError) {
        deps.onClearFailed(clearError);
      }
    }
    return { kind: 'signed-in' };
  }

  if (isInvalidCredentials(error)) {
    const recorded = await recordLoginFailure(deps.failureStore, input.email, deps.resetAfterMinutes);
    return { kind: 'invalid-credentials', captchaRequired: recorded.captchaRequired };
  }

  // パスワードの間違いではないものは、回数に数えない
  if (isEmailNotConfirmed(error)) return { kind: 'email-not-confirmed' };
  if (isCaptchaFailure(error)) return { kind: 'captcha-failed' };
  if (isUpstreamRateLimit(error)) return { kind: 'upstream-rate-limited' };
  return { kind: 'upstream-error', code: error.code ?? null, status: error.status ?? null };
}
