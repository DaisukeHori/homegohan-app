/**
 * #1165 ログイン画面から POST /api/auth/login を呼ぶ部品 (src/lib/auth/login-request.ts) の単体テスト
 *
 * - 送る本文: { email, password } に、トークンがあるときだけ captchaToken を足す
 * - 応答の読み取り: 200 { ok: true } だけを成功とし、それ以外は code / 文言 / retryAfter を取り出す。
 *   知らない code・JSON でない応答は UNKNOWN
 * - 文言: サーバーの文言を基本にし、ロックには残り時間 (分・時間、切り上げ) を足す
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRetryAfter, loginErrorMessage, requestLogin } from '@/lib/auth/login-request';

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

  it('423 のロックは code・文言・retryAfter を取り出す', async () => {
    reply(423, { error: 'ロック中です', code: 'AUTH_ACCOUNT_LOCKED', retryAfter: 3600 });
    expect(await requestLogin({ email: 'a@example.com', password: 'pw', captchaToken: null })).toEqual({
      ok: false,
      code: 'AUTH_ACCOUNT_LOCKED',
      message: 'ロック中です',
      retryAfterSec: 3600,
    });
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

describe('formatRetryAfter / loginErrorMessage', () => {
  it.each([
    [1, '約 1 分'],
    [60, '約 1 分'],
    [61, '約 2 分'],
    [900, '約 15 分'],
    [3540, '約 59 分'],
    [3600, '約 1 時間'],
    [3601, '約 2 時間'],
    [86400, '約 24 時間'],
  ])('%i 秒 → %s', (sec, expected) => {
    expect(formatRetryAfter(sec)).toBe(expected);
  });

  it('ロックは残り時間を足す。サーバーの文言が無ければ code ごとの既定の文言', () => {
    expect(
      loginErrorMessage({ ok: false, code: 'AUTH_ACCOUNT_LOCKED', message: 'ロック中です。', retryAfterSec: 900 }),
    ).toBe('ロック中です。 (あと約 15 分)');
    expect(loginErrorMessage({ ok: false, code: 'AUTH_INVALID_CREDENTIALS', message: null, retryAfterSec: null })).toBe(
      'メールアドレスまたはパスワードが正しくありません。',
    );
    expect(loginErrorMessage({ ok: false, code: 'UNKNOWN', message: null, retryAfterSec: null })).toContain('ログインに失敗しました');
  });
});
