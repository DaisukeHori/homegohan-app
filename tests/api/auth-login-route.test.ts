/**
 * #1165 POST /api/auth/login (src/app/api/auth/login/route.ts) の route テスト
 *
 * 確かめること (応答の表は route.ts の先頭のコメント):
 *   - 別のサイトからの POST は 403 (ログインの CSRF)。Origin が無いもの・同じサイトは通す
 *   - IP アドレスごとの回数制限 (10 回/分、設計 §3.2)。超えたら 429 + Retry-After で、パスワードを確かめない。判定できなければ 500
 *   - 本文の検証 (400)。メールアドレスは小文字・前後の空白なしにそろえて Supabase へ渡す
 *   - ロックしない (docs/operations/auth-protection.md §1): 何回失敗しても 423 は返さず 401。何回失敗した後でも、正しいパスワードなら 200。
 *     応答はアカウントの有無で変わらない
 *   - ボットの確認: 3 回以上失敗しているときだけ確かめる。偽物は 400、Cloudflare に届かなければ 503
 *   - 回数を 0 に戻すまでの時間: 環境変数 AUTH_LOGIN_FAILURE_RESET_MINUTES (未設定・不正なら 1440 分。不正ならプロセスで 1 回 warn)
 *   - Supabase のエラーの対応 (403 / 429 / 500)。500 の本文に Supabase の生のエラー文を出さない
 * 失敗の回数の記録は DB の関数と同じ規則で動く偽物 (tests/helpers/fake-login-failure-store.ts)。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLoginFailureStore, type FakeLoginFailureStore } from '../helpers/fake-login-failure-store';

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  adminRpc: vi.fn(),
  verifyTurnstileToken: vi.fn(),
  isTurnstileVerificationEnabled: vi.fn(() => false),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { signInWithPassword: mocks.signInWithPassword } }),
  getSupabaseAdmin: () => ({ rpc: mocks.adminRpc }),
}));

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

let store: FakeLoginFailureStore;
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
  vi.unstubAllEnvs();
  store = createFakeLoginFailureStore();
  mocks.adminRpc.mockImplementation((fn: string, args: Record<string, unknown>) => store.client.rpc(fn, args));
  mocks.signInWithPassword.mockResolvedValue({ data: {}, error: null });
  mocks.verifyTurnstileToken.mockResolvedValue({ status: 'disabled' });
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
    store.setFailures(EMAIL, 4);
    expect((await post()).status).toBe(200);
    expect(store.row(EMAIL)).toBeUndefined();
  });
});

describe('パスワード違い (ロックしない)', () => {
  beforeEach(() => {
    mocks.signInWithPassword.mockResolvedValue({ data: {}, error: INVALID });
  });

  it('何回続けて失敗しても 401 AUTH_INVALID_CREDENTIALS (423 にならない・Retry-After を付けない)。3 回目から captchaRequired', async () => {
    // IP ごとの回数制限 (10 回/分) に掛からないよう、IP を変えながら 25 回
    for (let i = 1; i <= 25; i += 1) {
      const res = await post(undefined, { 'x-forwarded-for': `203.0.113.${i}` });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'メールアドレスまたはパスワードが正しくありません。',
        code: 'AUTH_INVALID_CREDENTIALS',
        captchaRequired: i >= 3,
      });
      expect(res.headers.get('retry-after')).toBeNull();
    }
    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(25);
    expect(store.row(EMAIL)?.failure_count).toBe(25);
  });

  it('20 回以上失敗した後でも、正しいパスワードなら 200 (Supabase でパスワードを確かめる) で、回数は 0 に戻る', async () => {
    store.setFailures(EMAIL, 20);
    mocks.signInWithPassword.mockResolvedValue({ data: {}, error: null });

    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(store.row(EMAIL)).toBeUndefined();
  });

  it('応答はアカウントの有無で変わらない (登録されていないメールアドレスも同じように数える)', async () => {
    store.setFailures(EMAIL, 9);
    store.setFailures('nobody@example.com', 9);

    const existing = await post();
    const missing = await post({ email: 'nobody@example.com', password: PASSWORD });

    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(existing.body).toEqual(missing.body);
    expect(store.row('nobody@example.com')?.failure_count).toBe(10);
  });
});

describe('回数を 0 に戻すまでの時間 (AUTH_LOGIN_FAILURE_RESET_MINUTES)', () => {
  const resetArgs = () =>
    store.calls.filter((c) => c.fn === 'auth_login_failure_count').map((c) => c.args.p_reset_after_minutes);

  it('未設定なら 1440 分 (24 時間) を DB の関数へ渡す', async () => {
    vi.stubEnv('AUTH_LOGIN_FAILURE_RESET_MINUTES', '');
    await post();
    expect(resetArgs()).toEqual([1440]);
  });

  it('設定すれば、その分数を渡す', async () => {
    vi.stubEnv('AUTH_LOGIN_FAILURE_RESET_MINUTES', '60');
    await post();
    expect(resetArgs()).toEqual([60]);
  });

  it('不正な値なら既定の 1440 分に戻し (ログインは止めない)、変数名だけを warn で残す (値は出さない)', async () => {
    vi.stubEnv('AUTH_LOGIN_FAILURE_RESET_MINUTES', '0');
    const res = await post();
    expect(res.status).toBe(200);
    expect(resetArgs()).toEqual([1440]);
    const warned = mocks.logger.warn.mock.calls.filter((call) =>
      JSON.stringify(call).includes('AUTH_LOGIN_FAILURE_RESET_MINUTES'),
    );
    // プロセスごとに 1 回だけ (このファイルでは、この it が最初の不正な値)
    expect(warned).toHaveLength(1);
    await post();
    expect(
      mocks.logger.warn.mock.calls.filter((call) => JSON.stringify(call).includes('AUTH_LOGIN_FAILURE_RESET_MINUTES')),
    ).toHaveLength(1);
  });
});

describe('ボットの確認 (3 回以上失敗しているとき)', () => {
  beforeEach(() => {
    store.setFailures(EMAIL, 3);
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

  it('失敗の回数を読めなければ 500 (ボットの確認を求めるか判定できないので通さない・Supabase を呼ばない)', async () => {
    store.failNext('auth_login_failure_count');
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
