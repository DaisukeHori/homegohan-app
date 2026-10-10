/**
 * #1165 POST /api/auth/login (src/app/api/auth/login/route.ts) の route テスト
 *
 * 確かめること (応答の表は route.ts の先頭のコメント):
 *   - 別のサイトからの POST は 403 (ログインの CSRF)。Origin が無いもの・同じサイトは通す
 *   - IP アドレスごとの回数制限 (10 回/分、設計 §3.2)。超えたら 429 + Retry-After で、パスワードを確かめない。判定できなければ 500
 *   - 本文の検証 (400)。メールアドレスは小文字・前後の空白なしにそろえて Supabase へ渡す
 *   - ロック (設計 §8): 5 回目の失敗の応答から 423 + Retry-After。ロック中は正しいパスワードでも 423 で、Supabase を呼ばない
 *   - ボットの確認: 3 回以上失敗しているときだけ確かめる。偽物は 400、Cloudflare に届かなければ 503
 *   - Supabase のエラーの対応 (403 / 429 / 500)。500 の本文に Supabase の生のエラー文を出さない
 *   - 10 回目の失敗で、通知を応答の後ろ (waitUntil) へ回す。応答はアカウントの有無で変わらない
 * ロックの記録は DB の関数と同じ規則で動く偽物 (tests/helpers/fake-login-lock-store.ts)。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLoginLockStore, type FakeLoginLockStore } from '../helpers/fake-login-lock-store';

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  adminRpc: vi.fn(),
  waitUntil: vi.fn(),
  sendLoginLockNotice: vi.fn(),
  verifyTurnstileToken: vi.fn(),
  isTurnstileVerificationEnabled: vi.fn(() => false),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { signInWithPassword: mocks.signInWithPassword } }),
  getSupabaseAdmin: () => ({ rpc: mocks.adminRpc }),
}));

vi.mock('@vercel/functions', () => ({ waitUntil: mocks.waitUntil }));

vi.mock('@/lib/auth/login-lock-notification', () => ({ sendLoginLockNotice: mocks.sendLoginLockNotice }));

vi.mock('@/lib/auth/turnstile-verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/turnstile-verify')>();
  return {
    ...actual,
    verifyTurnstileToken: mocks.verifyTurnstileToken,
    isTurnstileVerificationEnabled: mocks.isTurnstileVerificationEnabled,
  };
});

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ ...mocks.logger, withUser: () => mocks.logger }),
  generateRequestId: () => 'req_test',
}));

// 実物のレート制限 (Upstash 未設定 = in-memory) を使い、基盤の障害だけ差し替えられるようにする
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  return { ...actual, checkRateLimit: vi.fn(actual.checkRateLimit) };
});

import { POST } from '@/app/api/auth/login/route';
import { checkRateLimit } from '@/lib/rate-limit';

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'user@example.com';
const PASSWORD = 'Passw0rdSecret';
const INVALID = { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' };

let store: FakeLoginLockStore;
let ipCounter = 0;
/** テストごとに別の IP アドレス (in-memory の回数制限がテストをまたがないように) */
let ip = '';

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': ip, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function post(body: unknown = { email: EMAIL, password: PASSWORD }, headers: Record<string, string> = {}) {
  const response = await POST(request(body, headers));
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  store = createFakeLoginLockStore();
  mocks.adminRpc.mockImplementation((fn: string, args: Record<string, unknown>) => store.client.rpc(fn, args));
  mocks.signInWithPassword.mockResolvedValue({ data: {}, error: null });
  mocks.verifyTurnstileToken.mockResolvedValue({ status: 'disabled' });
  mocks.sendLoginLockNotice.mockResolvedValue(undefined);
  ipCounter += 1;
  ip = `198.51.100.${ipCounter}`;
});

describe('成功', () => {
  it('200 { ok: true }・no-store。メールアドレスを小文字・前後の空白なしにそろえ、トークンが無ければ options を付けない', async () => {
    const res = await post({ email: '  User@Example.COM ', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
  });

  it('失敗が 3 回未満なら、届いたトークンを options.captchaToken で Supabase へ渡す (こちらでは確かめない)', async () => {
    await post({ email: EMAIL, password: PASSWORD, captchaToken: 'tok-1' });

    expect(mocks.verifyTurnstileToken).not.toHaveBeenCalled();
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD, options: { captchaToken: 'tok-1' } });
  });

  it('成功したら失敗の記録を消す', async () => {
    store.rows.set(EMAIL, { failure_count: 4, locked_until: null });
    expect((await post()).status).toBe(200);
    expect(store.row(EMAIL)).toBeUndefined();
  });
});

describe('パスワード違いとロック (設計 §8)', () => {
  beforeEach(() => {
    mocks.signInWithPassword.mockResolvedValue({ data: {}, error: INVALID });
  });

  it('1〜4 回目は 401 AUTH_INVALID_CREDENTIALS。5 回目の応答から 423 AUTH_ACCOUNT_LOCKED + Retry-After (15 分)', async () => {
    for (let i = 1; i <= 4; i += 1) {
      const res = await post();
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'メールアドレスまたはパスワードが正しくありません。',
        code: 'AUTH_INVALID_CREDENTIALS',
        captchaRequired: i >= 3,
      });
    }
    const fifth = await post();
    expect(fifth.status).toBe(423);
    expect(fifth.body.code).toBe('AUTH_ACCOUNT_LOCKED');
    expect(fifth.body.retryAfter).toBe(900);
    expect(fifth.headers.get('retry-after')).toBe('900');
    expect(String(fifth.body.error)).toContain('パスワードを再設定すると');
  });

  it('ロック中は、正しいパスワードでも 423 で、Supabase を呼ばず、回数も増やさない', async () => {
    const lockedUntil = new Date(Date.now() + 600_000).toISOString();
    store.rows.set(EMAIL, { failure_count: 5, locked_until: lockedUntil });
    mocks.signInWithPassword.mockResolvedValue({ data: {}, error: null });

    const res = await post();

    expect(res.status).toBe(423);
    expect(res.body.code).toBe('AUTH_ACCOUNT_LOCKED');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(590);
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(store.row(EMAIL)).toEqual({ failure_count: 5, locked_until: lockedUntil });
  });

  it('10 回目の失敗で、通知を応答の後ろ (waitUntil) へ回す。応答はアカウントの有無で変わらない', async () => {
    store.accounts.set(EMAIL, '00000000-0000-4000-8000-000000000001');
    store.rows.set(EMAIL, { failure_count: 9, locked_until: null });
    store.rows.set('nobody@example.com', { failure_count: 9, locked_until: null });

    const existing = await post();
    const missing = await post({ email: 'nobody@example.com', password: PASSWORD });

    expect(existing.status).toBe(423);
    expect(missing.status).toBe(423);
    expect(Object.keys(existing.body).sort()).toEqual(Object.keys(missing.body).sort());
    expect(existing.body.code).toBe(missing.body.code);
    expect(existing.body.error).toBe(missing.body.error);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(2);
    expect(mocks.sendLoginLockNotice).toHaveBeenCalledTimes(2);
    expect(mocks.sendLoginLockNotice.mock.calls[0][1]).toEqual(
      expect.objectContaining({ email: EMAIL, notice: 'account-owner', failureCount: 10 }),
    );
  });
});

describe('ボットの確認 (3 回以上失敗しているとき)', () => {
  beforeEach(() => {
    store.rows.set(EMAIL, { failure_count: 3, locked_until: null });
  });

  it('偽物のトークンは 400 AUTH_CAPTCHA_FAILED (パスワードを確かめない)', async () => {
    mocks.verifyTurnstileToken.mockResolvedValue({ status: 'failed', errorCodes: ['invalid-input-response'] });

    const res = await post({ email: EMAIL, password: PASSWORD, captchaToken: 'forged' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUTH_CAPTCHA_FAILED');
    expect(mocks.verifyTurnstileToken).toHaveBeenCalledWith('forged', ip);
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it('Cloudflare に届かなければ 503 AUTH_CAPTCHA_UNAVAILABLE', async () => {
    mocks.verifyTurnstileToken.mockResolvedValue({ status: 'unavailable' });
    const res = await post({ email: EMAIL, password: PASSWORD, captchaToken: 'tok' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AUTH_CAPTCHA_UNAVAILABLE');
  });

  it('確認が通ったら、使用済みのトークンを Supabase へ渡さない', async () => {
    mocks.verifyTurnstileToken.mockResolvedValue({ status: 'passed' });
    const res = await post({ email: EMAIL, password: PASSWORD, captchaToken: 'tok' });
    expect(res.status).toBe(200);
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
  });
});

describe('Supabase のエラー', () => {
  it.each([
    [{ code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' }, 403, 'AUTH_EMAIL_NOT_CONFIRMED'],
    [{ code: 'over_request_rate_limit', status: 429, message: 'Request rate limit reached' }, 429, 'RATE_LIMITED'],
    [{ code: 'captcha_failed', status: 400, message: 'captcha verification process failed' }, 400, 'AUTH_CAPTCHA_FAILED'],
    [{ code: 'unexpected_failure', status: 500, message: 'Database error querying schema' }, 500, 'INTERNAL_ERROR'],
  ])('%o → %i %s (回数は増やさない)', async (error, status, code) => {
    mocks.signInWithPassword.mockResolvedValue({ data: {}, error });

    const res = await post();

    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(JSON.stringify(res.body)).not.toContain(error.message);
    expect(store.row(EMAIL)).toBeUndefined();
  });

  it('ロックの記録を読めなければ 500 (判定できないので通さない・Supabase を呼ばない)', async () => {
    store.failNext('auth_login_lock_status');
    const res = await post();
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe('IP アドレスごとの回数制限 (設計 §3.2: 10 回/分)', () => {
  it('同じ IP から 11 回目は 429 + Retry-After で、パスワードを確かめない', async () => {
    for (let i = 0; i < 10; i += 1) expect((await post()).status).toBe(200);
    mocks.signInWithPassword.mockClear();

    const res = await post();

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(checkRateLimit).toHaveBeenLastCalledWith(ip, 'auth-login');
  });

  it('回数制限の基盤が例外を投げたら 500 (通さない)', async () => {
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('upstash down'));
    const res = await post();
    expect(res.status).toBe(500);
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe('ボットの確認が無効なことのログ', () => {
  it('リクエストのたびに、最初に確認の有効・無効を見る (無効ならプロセスで 1 回だけログが出る。3 回失敗していなくても)', async () => {
    await post();
    await post(undefined, { origin: 'https://evil.example' });
    expect(mocks.isTurnstileVerificationEnabled).toHaveBeenCalledTimes(2);
    expect(mocks.verifyTurnstileToken).not.toHaveBeenCalled();
  });
});

describe('入力とオリジン', () => {
  it.each([
    ['JSON でない', 'not-json'],
    ['メールアドレスの形でない', { email: 'not-an-email', password: PASSWORD }],
    ['パスワードが空', { email: EMAIL, password: '' }],
    ['パスワードが無い', { email: EMAIL }],
    ['トークンが空文字', { email: EMAIL, password: PASSWORD, captchaToken: '' }],
  ])('%s → 400 VALIDATION_ERROR (記録にも Supabase にも触れない)', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it('別のサイトの Origin は 403 FORBIDDEN_ORIGIN (回数制限にも数えない)', async () => {
    const res = await post(undefined, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ORIGIN');
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it('Origin が無いリクエスト (ブラウザ以外) は通す', async () => {
    const req = new NextRequest(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect((await POST(req)).status).toBe(200);
  });
});
