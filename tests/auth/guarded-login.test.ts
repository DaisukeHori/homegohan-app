/**
 * #1165 ロックとボットの確認を通したログイン (src/lib/auth/guarded-login.ts) の単体テスト
 *
 * 状態 × 操作の表 (設計 docs/design/cross/01-auth-session.md §3.2・§8・§15):
 *
 * | 試行の前の状態            | Turnstile の確認 | Supabase の結果       | 結果                  | 記録                        | Supabase へのトークン |
 * |---------------------------|------------------|-----------------------|-----------------------|-----------------------------|-----------------------|
 * | ロック中                  | (呼ばない)       | (呼ばない)            | locked                | 変えない                    | -                     |
 * | 0〜2 回                   | (呼ばない)       | 成功                  | signed-in             | 0 回なら触らない / 他は消す | 届いたものをそのまま  |
 * | 0〜2 回                   | (呼ばない)       | パスワード違い        | invalid / locked      | +1 (段に届けば期限)         | 届いたものをそのまま  |
 * | 3 回以上 (ロックなし)     | 無効             | 成功                  | signed-in             | 消す                        | 届いたものをそのまま  |
 * | 3 回以上 (ロックなし)     | passed           | 成功                  | signed-in             | 消す                        | 渡さない (使用済み)   |
 * | 3 回以上 (ロックなし)     | failed           | (呼ばない)            | captcha-failed        | 変えない                    | -                     |
 * | 3 回以上 (ロックなし)     | unavailable      | (呼ばない)            | captcha-unavailable   | 変えない                    | -                     |
 * | どれでも (ロックなし)     | -                | メール未確認          | email-not-confirmed   | 変えない                    |                       |
 * | どれでも (ロックなし)     | -                | Supabase の CAPTCHA   | captcha-failed        | 変えない                    |                       |
 * | どれでも (ロックなし)     | -                | Supabase の 429       | upstream-rate-limited | 変えない                    |                       |
 * | どれでも (ロックなし)     | -                | そのほかのエラー      | upstream-error        | 変えない                    |                       |
 *
 * 通知: パスワード違いで 10 回目 (本人)・20 回目 (運営) にちょうど届いたときだけ、notify を 1 回呼ぶ。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { performGuardedLogin, type GuardedLoginDeps, type SignInOutcome } from '@/lib/auth/guarded-login';
import { LoginLockStoreError } from '@/lib/auth/login-lock';
import type { TurnstileVerifyResult } from '@/lib/auth/turnstile-verify';
import { createFakeLoginLockStore, type FakeLoginLockStore } from '../helpers/fake-login-lock-store';

const NOW = new Date('2026-10-10T03:00:00.000Z');
const EMAIL = 'user@example.com';
const PASSWORD = 'Passw0rdSecret';
const INVALID: SignInOutcome = { error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } };
const OK: SignInOutcome = { error: null };
const plusSec = (sec: number) => new Date(NOW.getTime() + sec * 1000).toISOString();

let store: FakeLoginLockStore;
let signIn: ReturnType<typeof vi.fn<GuardedLoginDeps['signIn']>>;
let verifyCaptcha: ReturnType<typeof vi.fn<GuardedLoginDeps['verifyCaptcha']>>;
let notify: ReturnType<typeof vi.fn<GuardedLoginDeps['notify']>>;
let onClearFailed: ReturnType<typeof vi.fn<GuardedLoginDeps['onClearFailed']>>;

function deps(): GuardedLoginDeps {
  return { lockStore: store.client, signIn, verifyCaptcha, notify, onClearFailed, now: () => NOW };
}

function login(captchaToken?: string) {
  return performGuardedLogin({ email: EMAIL, password: PASSWORD, ...(captchaToken ? { captchaToken } : {}) }, deps());
}

beforeEach(() => {
  store = createFakeLoginLockStore();
  signIn = vi.fn<GuardedLoginDeps['signIn']>(async () => OK);
  verifyCaptcha = vi.fn<GuardedLoginDeps['verifyCaptcha']>(async (): Promise<TurnstileVerifyResult> => ({ status: 'disabled' }));
  notify = vi.fn<GuardedLoginDeps['notify']>();
  onClearFailed = vi.fn<GuardedLoginDeps['onClearFailed']>();
});

describe('ロック中', () => {
  it('正しいパスワードでも Supabase を呼ばずに断り、回数を増やさない (残り秒数を返す)', async () => {
    store.rows.set(EMAIL, { failure_count: 5, locked_until: plusSec(600) });

    const result = await login('tok');

    expect(result).toEqual({ kind: 'locked', retryAfterSec: 600 });
    expect(signIn).not.toHaveBeenCalled();
    expect(verifyCaptcha).not.toHaveBeenCalled();
    expect(store.row(EMAIL)).toEqual({ failure_count: 5, locked_until: plusSec(600) });
  });

  it('期限が過ぎていれば、ふつうにログインできて記録が消える', async () => {
    store.rows.set(EMAIL, { failure_count: 5, locked_until: plusSec(-1) });

    expect(await login()).toEqual({ kind: 'signed-in' });
    expect(store.row(EMAIL)).toBeUndefined();
  });
});

describe('連続失敗が 3 回未満', () => {
  it('確認を呼ばず、届いたトークンをそのまま Supabase へ渡す (Supabase の CAPTCHA が有効なときのため)', async () => {
    store.rows.set(EMAIL, { failure_count: 2, locked_until: null });

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
    expect(store.calls.map((c) => c.fn)).toEqual(['auth_login_lock_status']);
  });

  it('パスワード違いは 1 回数えて invalid-credentials (3 回目からは captchaRequired)', async () => {
    signIn.mockResolvedValue(INVALID);

    expect(await login()).toEqual({ kind: 'invalid-credentials', captchaRequired: false });
    expect(await login()).toEqual({ kind: 'invalid-credentials', captchaRequired: false });
    expect(await login()).toEqual({ kind: 'invalid-credentials', captchaRequired: true });
    expect(store.row(EMAIL)?.failure_count).toBe(3);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('連続失敗が 3 回以上 (ロックなし)', () => {
  beforeEach(() => {
    store.rows.set(EMAIL, { failure_count: 3, locked_until: null });
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

describe('ロックへ進む失敗と通知', () => {
  beforeEach(() => {
    signIn.mockResolvedValue(INVALID);
    verifyCaptcha.mockResolvedValue({ status: 'passed' });
  });

  it('5 回目の失敗で、その応答から locked (15 分) になる。通知はしない', async () => {
    store.rows.set(EMAIL, { failure_count: 4, locked_until: null });

    expect(await login('tok')).toEqual({ kind: 'locked', retryAfterSec: 900 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('10 回目で本人への通知を 1 回、20 回目で運営への通知を 1 回 (期限つき)', async () => {
    store.rows.set(EMAIL, { failure_count: 9, locked_until: null });
    expect(await login('tok')).toEqual({ kind: 'locked', retryAfterSec: 3600 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith({
      email: EMAIL,
      notice: 'account-owner',
      failureCount: 10,
      lockedUntil: new Date(plusSec(3600)),
    });

    store.rows.set(EMAIL, { failure_count: 19, locked_until: null });
    expect(await login('tok')).toEqual({ kind: 'locked', retryAfterSec: 86400 });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ notice: 'admin', failureCount: 20 }));

    // 21 回目 (期限切れ後) は通知しない
    store.rows.set(EMAIL, { failure_count: 20, locked_until: null });
    await login('tok');
    expect(notify).toHaveBeenCalledTimes(2);
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
    store.rows.set(EMAIL, { failure_count: 1, locked_until: null });
    signIn.mockResolvedValue({ error });

    expect(await login()).toEqual(expected);
    expect(store.row(EMAIL)?.failure_count).toBe(1);
  });
});

describe('記録の読み書きに失敗したら通さない', () => {
  it('状況を読めなければ例外 (Supabase を呼ばない)', async () => {
    store.failNext('auth_login_lock_status');

    await expect(login()).rejects.toBeInstanceOf(LoginLockStoreError);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('成功したのに記録を消せないときは、ログインは成功のまま (セッションはもうある)・onClearFailed に渡す', async () => {
    store.rows.set(EMAIL, { failure_count: 2, locked_until: null });
    store.failNext('auth_login_clear_failures');

    expect(await login()).toEqual({ kind: 'signed-in' });
    expect(onClearFailed).toHaveBeenCalledTimes(1);
    expect(onClearFailed.mock.calls[0][0]).toBeInstanceOf(LoginLockStoreError);
  });

  it('失敗を数えられなければ例外 (invalid-credentials を返して素通りさせない)', async () => {
    signIn.mockResolvedValue(INVALID);
    store.failNext('auth_login_record_failure');

    await expect(login()).rejects.toBeInstanceOf(LoginLockStoreError);
  });
});
