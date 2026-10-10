/**
 * #1165 ボットの確認を通したログイン (src/lib/auth/guarded-login.ts) の単体テスト
 *
 * ログインに続けて失敗しても、アカウントはロックしない (docs/operations/auth-protection.md §1)。
 *
 * 状態 × 操作の表:
 *
 * | 試行の前の回数 | Turnstile の確認 | Supabase の結果       | 結果                  | 記録                        | Supabase へのトークン |
 * |----------------|------------------|-----------------------|-----------------------|-----------------------------|-----------------------|
 * | 0〜2 回        | (呼ばない)       | 成功                  | signed-in             | 0 回なら触らない / 他は消す | 届いたものをそのまま  |
 * | 0〜2 回        | (呼ばない)       | パスワード違い        | invalid-credentials   | +1                          | 届いたものをそのまま  |
 * | 3 回以上       | 無効             | 成功                  | signed-in             | 消す                        | 届いたものをそのまま  |
 * | 3 回以上       | passed           | 成功                  | signed-in             | 消す                        | 渡さない (使用済み)   |
 * | 3 回以上       | passed / 無効    | パスワード違い        | invalid-credentials   | +1                          | (同上)                |
 * | 3 回以上       | failed           | (呼ばない)            | captcha-failed        | 変えない                    | -                     |
 * | 3 回以上       | unavailable      | (呼ばない)            | captcha-unavailable   | 変えない                    | -                     |
 * | どれでも       | -                | メール未確認          | email-not-confirmed   | 変えない                    |                       |
 * | どれでも       | -                | Supabase の CAPTCHA   | captcha-failed        | 変えない                    |                       |
 * | どれでも       | -                | Supabase の 429       | upstream-rate-limited | 変えない                    |                       |
 * | どれでも       | -                | そのほかのエラー      | upstream-error        | 変えない                    |                       |
 *
 * 回数が何回でも (20 回を超えても)、正しいパスワードなら signed-in。結果に「ロック」は無い。
 * 回数は、最後の失敗から resetAfterMinutes 分が経つと 0 に戻る (確認を求めなくなる)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { performGuardedLogin, type GuardedLoginDeps, type SignInOutcome } from '@/lib/auth/guarded-login';
import { LoginFailureStoreError } from '@/lib/auth/login-failures';
import type { TurnstileVerifyResult } from '@/lib/auth/turnstile-verify';
import { createFakeLoginFailureStore, type FakeLoginFailureStore } from '../helpers/fake-login-failure-store';

const EMAIL = 'user@example.com';
const PASSWORD = 'Passw0rdSecret';
const RESET_MINUTES = 60;
const INVALID: SignInOutcome = { error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } };
const OK: SignInOutcome = { error: null };

let store: FakeLoginFailureStore;
let signIn: ReturnType<typeof vi.fn<GuardedLoginDeps['signIn']>>;
let verifyCaptcha: ReturnType<typeof vi.fn<GuardedLoginDeps['verifyCaptcha']>>;
let onClearFailed: ReturnType<typeof vi.fn<GuardedLoginDeps['onClearFailed']>>;

function deps(): GuardedLoginDeps {
  return { failureStore: store.client, resetAfterMinutes: RESET_MINUTES, signIn, verifyCaptcha, onClearFailed };
}

function login(captchaToken?: string, password = PASSWORD) {
  return performGuardedLogin({ email: EMAIL, password, ...(captchaToken ? { captchaToken } : {}) }, deps());
}

beforeEach(() => {
  store = createFakeLoginFailureStore();
  signIn = vi.fn<GuardedLoginDeps['signIn']>(async () => OK);
  verifyCaptcha = vi.fn<GuardedLoginDeps['verifyCaptcha']>(async (): Promise<TurnstileVerifyResult> => ({ status: 'disabled' }));
  onClearFailed = vi.fn<GuardedLoginDeps['onClearFailed']>();
});

describe('ロックしない', () => {
  it('30 回続けて失敗しても、毎回パスワードを確かめて invalid-credentials (ロックの結果を返さない)', async () => {
    signIn.mockResolvedValue(INVALID);
    for (let i = 1; i <= 30; i += 1) {
      expect(await login('tok')).toEqual({ kind: 'invalid-credentials', captchaRequired: i >= 3 });
    }
    expect(signIn).toHaveBeenCalledTimes(30);
    expect(store.row(EMAIL)?.failure_count).toBe(30);
  });

  it.each([3, 5, 10, 20, 100])('%i 回失敗した後でも、正しいパスワードならログインでき、回数は 0 に戻る', async (count) => {
    store.setFailures(EMAIL, count);

    expect(await login('tok')).toEqual({ kind: 'signed-in' });
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(store.row(EMAIL)).toBeUndefined();
  });

  it('ロックのための古い DB の関数 (状況・期限・アカウントの検索) を呼ばない', async () => {
    signIn.mockResolvedValue(INVALID);
    for (let i = 0; i < 25; i += 1) await login('tok');
    signIn.mockResolvedValue(OK);
    await login('tok');
    const called = new Set(store.calls.map((c) => c.fn));
    expect(called).toEqual(new Set(['auth_login_failure_count', 'auth_login_count_failure', 'auth_login_clear_failures']));
  });
});

describe('連続失敗が 3 回未満', () => {
  it('確認を呼ばず、届いたトークンをそのまま Supabase へ渡す (Supabase の CAPTCHA が有効なときのため)', async () => {
    store.setFailures(EMAIL, 2);

    expect(await login('tok-1')).toEqual({ kind: 'signed-in' });
    expect(verifyCaptcha).not.toHaveBeenCalled();
    expect(signIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD, captchaToken: 'tok-1' });
  });

  it('トークンが無ければ captchaToken のキーごと付けない', async () => {
    await login();
    expect(Object.keys(signIn.mock.calls[0][0])).toEqual(['email', 'password']);
  });

  it('記録が無い (0 回) の成功では、消す RPC を呼ばない (毎回のログインで DB に書かない)', async () => {
    await login();
    expect(store.calls.map((c) => c.fn)).toEqual(['auth_login_failure_count']);
  });

  it('パスワード違いは 1 回数えて invalid-credentials (3 回目からは captchaRequired)', async () => {
    signIn.mockResolvedValue(INVALID);

    expect(await login()).toEqual({ kind: 'invalid-credentials', captchaRequired: false });
    expect(await login()).toEqual({ kind: 'invalid-credentials', captchaRequired: false });
    expect(await login()).toEqual({ kind: 'invalid-credentials', captchaRequired: true });
    expect(store.row(EMAIL)?.failure_count).toBe(3);
  });

  it('読むときも数えるときも、戻すまでの時間 (resetAfterMinutes) を DB の関数へ渡す', async () => {
    signIn.mockResolvedValue(INVALID);
    await login();
    expect(store.calls).toEqual([
      { fn: 'auth_login_failure_count', args: { p_email: EMAIL, p_reset_after_minutes: RESET_MINUTES } },
      { fn: 'auth_login_count_failure', args: { p_email: EMAIL, p_reset_after_minutes: RESET_MINUTES } },
    ]);
  });
});

describe('連続失敗が 3 回以上', () => {
  beforeEach(() => {
    store.setFailures(EMAIL, 3);
  });

  it('確認が無効 (キー未設定) なら、確かめずに通し、トークンは Supabase へ渡す', async () => {
    verifyCaptcha.mockResolvedValue({ status: 'disabled' });

    expect(await login('tok-1')).toEqual({ kind: 'signed-in' });
    expect(verifyCaptcha).toHaveBeenCalledWith('tok-1');
    expect(signIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD, captchaToken: 'tok-1' });
    expect(store.row(EMAIL)).toBeUndefined();
  });

  it('確認が通ったら、使用済みのトークンは Supabase へ渡さない', async () => {
    verifyCaptcha.mockResolvedValue({ status: 'passed' });

    expect(await login('tok-1')).toEqual({ kind: 'signed-in' });
    expect(signIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
  });

  it('確認に失敗したら、パスワードを確かめずに captcha-failed (回数は増やさない)', async () => {
    verifyCaptcha.mockResolvedValue({ status: 'failed', errorCodes: ['invalid-input-response'] });

    expect(await login('forged')).toEqual({ kind: 'captcha-failed' });
    expect(signIn).not.toHaveBeenCalled();
    expect(store.row(EMAIL)?.failure_count).toBe(3);
  });

  it('トークンが無いときも確認に回す (無効でなければ failed になる)', async () => {
    verifyCaptcha.mockResolvedValue({ status: 'failed', errorCodes: ['missing-input-response'] });

    expect(await login()).toEqual({ kind: 'captcha-failed' });
    expect(verifyCaptcha).toHaveBeenCalledWith(undefined);
  });

  it('確認の API に届かなければ captcha-unavailable (通さない・回数は増やさない)', async () => {
    verifyCaptcha.mockResolvedValue({ status: 'unavailable' });

    expect(await login('tok-1')).toEqual({ kind: 'captcha-unavailable' });
    expect(signIn).not.toHaveBeenCalled();
    expect(store.row(EMAIL)?.failure_count).toBe(3);
  });

  it('確認が通ってもパスワード違いなら数える', async () => {
    verifyCaptcha.mockResolvedValue({ status: 'passed' });
    signIn.mockResolvedValue(INVALID);

    expect(await login('tok-1')).toEqual({ kind: 'invalid-credentials', captchaRequired: true });
    expect(store.row(EMAIL)?.failure_count).toBe(4);
  });
});

describe('回数は時間でも 0 に戻る', () => {
  it('最後の失敗から resetAfterMinutes 分が経つと、確認を求めない (トークンはそのまま Supabase へ)', async () => {
    store.setFailures(EMAIL, 8, RESET_MINUTES);

    expect(await login('tok-1')).toEqual({ kind: 'signed-in' });
    expect(verifyCaptcha).not.toHaveBeenCalled();
    expect(signIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD, captchaToken: 'tok-1' });
  });

  it('時間が経ってからの失敗は 1 から数え直す', async () => {
    store.setFailures(EMAIL, 8, RESET_MINUTES);
    signIn.mockResolvedValue(INVALID);

    expect(await login()).toEqual({ kind: 'invalid-credentials', captchaRequired: false });
    expect(store.row(EMAIL)?.failure_count).toBe(1);
  });

  it('時間が経つ 1 分手前なら、まだ確認を求める', async () => {
    store.setFailures(EMAIL, 3, RESET_MINUTES - 1);
    verifyCaptcha.mockResolvedValue({ status: 'failed', errorCodes: ['invalid-input-response'] });

    expect(await login('forged')).toEqual({ kind: 'captcha-failed' });
  });
});

describe('パスワードの間違いではない Supabase のエラーは数えない', () => {
  it.each([
    [{ code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' }, { kind: 'email-not-confirmed' }],
    [{ code: 'captcha_failed', status: 400, message: 'captcha verification process failed' }, { kind: 'captcha-failed' }],
    [{ code: 'over_request_rate_limit', status: 429, message: 'Request rate limit reached' }, { kind: 'upstream-rate-limited' }],
    [
      { code: 'unexpected_failure', status: 500, message: 'Database error querying schema' },
      { kind: 'upstream-error', code: 'unexpected_failure', status: 500 },
    ],
  ])('%o → %o', async (error, expected) => {
    store.setFailures(EMAIL, 1);
    signIn.mockResolvedValue({ error });

    expect(await login()).toEqual(expected);
    expect(store.row(EMAIL)?.failure_count).toBe(1);
  });
});

describe('記録の読み書きに失敗したら通さない', () => {
  it('回数を読めなければ例外 (Supabase を呼ばない)', async () => {
    store.failNext('auth_login_failure_count');

    await expect(login()).rejects.toBeInstanceOf(LoginFailureStoreError);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('成功したのに記録を消せないときは、ログインは成功のまま (セッションはもうある)・onClearFailed に渡す', async () => {
    store.setFailures(EMAIL, 2);
    store.failNext('auth_login_clear_failures');

    expect(await login()).toEqual({ kind: 'signed-in' });
    expect(onClearFailed).toHaveBeenCalledTimes(1);
    expect(onClearFailed.mock.calls[0][0]).toBeInstanceOf(LoginFailureStoreError);
  });

  it('失敗を数えられなければ例外 (invalid-credentials を返して素通りさせない)', async () => {
    signIn.mockResolvedValue(INVALID);
    store.failNext('auth_login_count_failure');

    await expect(login()).rejects.toBeInstanceOf(LoginFailureStoreError);
  });
});
