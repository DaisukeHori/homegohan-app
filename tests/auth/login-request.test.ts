/**
 * #1165 ログイン画面から POST /api/auth/login を呼ぶ部品 (src/lib/auth/login-request.ts) の単体テスト
 *
 * - 送る本文: { email, password } に、トークンがあるときだけ captchaToken を足す
 * - 応答の読み取り: 200 { ok: true } だけを成功とし、それ以外は code / 文言 / retryAfter を取り出す。
 *   知らない code・JSON でない応答は UNKNOWN
 * - 文言: サーバーの文言を基本にし、無ければ code ごとの既定の文言。ロックはしないので、ロックの code・残り時間の文言は無い
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as loginRequest from '@/lib/auth/login-request';
import { loginErrorMessage, requestLogin } from '@/lib/auth/login-request';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

describe('requestLogin', () => {
  it('POST /api/auth/login に JSON で送り、トークンが無ければ captchaToken を付けない', async () => {
    reply(200, { ok: true });
    expect(await requestLogin({ email: 'a@example.com', password: 'pw', captchaToken: null })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@example.com', password: 'pw' });
  });

  it('トークンがあれば captchaToken を付ける', async () => {
    reply(200, { ok: true });
    await requestLogin({ email: 'a@example.com', password: 'pw', captchaToken: 'tok' });
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      email: 'a@example.com',
      password: 'pw',
      captchaToken: 'tok',
    });
  });

  it('429 の回数制限は code・文言・retryAfter を取り出す', async () => {
    reply(429, { error: 'しばらくしてから再度お試しください。', code: 'RATE_LIMITED', retryAfter: 30 });
    expect(await requestLogin({ email: 'a@example.com', password: 'pw', captchaToken: null })).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      message: 'しばらくしてから再度お試しください。',
      retryAfterSec: 30,
    });
  });

  it('ロックの code (AUTH_ACCOUNT_LOCKED) は知らない code として UNKNOWN にする (ロックはしないので、サーバーは返さない)', async () => {
    reply(423, { error: 'ロック中です', code: 'AUTH_ACCOUNT_LOCKED', retryAfter: 3600 });
    const outcome = await requestLogin({ email: 'a@example.com', password: 'pw', captchaToken: null });
    expect(outcome).toEqual({ ok: false, code: 'UNKNOWN', message: 'ロック中です', retryAfterSec: 3600 });
    if (outcome.ok) throw new Error('unreachable');
    // 残り時間の文言を足さない
    expect(loginErrorMessage(outcome)).toBe('ロック中です');
  });

  it('200 でも ok: true でなければ成功にしない。知らない code・JSON でない応答は UNKNOWN', async () => {
    reply(200, { ok: false });
    expect((await requestLogin({ email: 'a', password: 'b', captchaToken: null })).ok).toBe(false);
    reply(500, { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(await requestLogin({ email: 'a', password: 'b', captchaToken: null })).toEqual({
      ok: false,
      code: 'UNKNOWN',
      message: '処理中にエラーが発生しました',
      retryAfterSec: null,
    });
    reply(502, '<html>Bad Gateway</html>');
    expect(await requestLogin({ email: 'a', password: 'b', captchaToken: null })).toEqual({
      ok: false,
      code: 'UNKNOWN',
      message: null,
      retryAfterSec: null,
    });
  });

  it('通信の失敗は例外のまま投げる', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(requestLogin({ email: 'a', password: 'b', captchaToken: null })).rejects.toThrow('Failed to fetch');
  });
});

describe('loginErrorMessage', () => {
  it('サーバーの文言をそのまま使い、無ければ code ごとの既定の文言', () => {
    expect(loginErrorMessage({ ok: false, code: 'RATE_LIMITED', message: 'しばらく待って。', retryAfterSec: 900 })).toBe(
      'しばらく待って。',
    );
    expect(loginErrorMessage({ ok: false, code: 'AUTH_INVALID_CREDENTIALS', message: null, retryAfterSec: null })).toBe(
      'メールアドレスまたはパスワードが正しくありません。',
    );
    expect(loginErrorMessage({ ok: false, code: 'UNKNOWN', message: null, retryAfterSec: null })).toContain('ログインに失敗しました');
  });

  it('ロックの残り時間を作る部品 (formatRetryAfter) を持たない', () => {
    expect(Object.keys(loginRequest)).not.toContain('formatRetryAfter');
  });
});
