/**
 * #1165: Cloudflare Turnstile (モバイル) の部品 (src/lib/turnstile.ts) の単体テスト
 *
 * 確かめること:
 *   - getTurnstileSiteKey: 未設定・空文字・空白だけは null (= Turnstile は無効)。前後の空白は取り除く
 *   - parseTurnstileMessage: WebView から届いた postMessage を、形を確かめてから受け取る
 *     (Android では Cloudflare の iframe を含むどのフレームからも送れるので、形が違うものは捨てる)
 *   - buildTurnstileHtml: サイトキーと action を安全に埋め込み、WebView の中で動くスクリプトが
 *     parseTurnstileMessage が読める形でアプリへ知らせる (HTML と受け取り側の約束が食い違わない)
 *   - isCaptchaFailure: Supabase Auth の CAPTCHA エラーだけを見分ける
 */

import vm from 'node:vm';

import {
  buildTurnstileHtml,
  CAPTCHA_FAILED_MESSAGE,
  getTurnstileSiteKey,
  isCaptchaFailure,
  parseTurnstileMessage,
  TURNSTILE_SCRIPT_URL,
} from '../../src/lib/turnstile';

describe('getTurnstileSiteKey', () => {
  const original = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = original;
  });

  it('未設定なら null (Turnstile は無効)', () => {
    delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
    expect(getTurnstileSiteKey()).toBeNull();
  });

  it('空文字 (env.example の EXPO_PUBLIC_TURNSTILE_SITE_KEY= のまま) や空白だけも null', () => {
    process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = '';
    expect(getTurnstileSiteKey()).toBeNull();
    process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = '   ';
    expect(getTurnstileSiteKey()).toBeNull();
  });

  it('設定されていれば、前後の空白を取り除いて返す', () => {
    process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = ' 1x00000000000000000000AA\n';
    expect(getTurnstileSiteKey()).toBe('1x00000000000000000000AA');
  });
});

describe('parseTurnstileMessage', () => {
  it('token: トークンを受け取る', () => {
    expect(parseTurnstileMessage(JSON.stringify({ type: 'token', token: 'tok-1' }))).toEqual({
      type: 'token',
      token: 'tok-1',
    });
  });

  it('token: 空・文字列でない・長すぎるトークンは捨てる', () => {
    expect(parseTurnstileMessage(JSON.stringify({ type: 'token', token: '' }))).toBeNull();
    expect(parseTurnstileMessage(JSON.stringify({ type: 'token' }))).toBeNull();
    expect(parseTurnstileMessage(JSON.stringify({ type: 'token', token: 123 }))).toBeNull();
    expect(parseTurnstileMessage(JSON.stringify({ type: 'token', token: 'x'.repeat(4097) }))).toBeNull();
    // Turnstile のトークンの上限 (2048 文字) は受け取れる
    expect(parseTurnstileMessage(JSON.stringify({ type: 'token', token: 'x'.repeat(2048) }))).not.toBeNull();
  });

  it('expired: 期限切れ・時間切れ', () => {
    expect(parseTurnstileMessage(JSON.stringify({ type: 'expired' }))).toEqual({ type: 'expired' });
  });

  it('error: エラーコードを受け取る。無ければ unknown。長すぎるコードは切り詰める', () => {
    expect(parseTurnstileMessage(JSON.stringify({ type: 'error', code: '300030' }))).toEqual({
      type: 'error',
      code: '300030',
    });
    expect(parseTurnstileMessage(JSON.stringify({ type: 'error' }))).toEqual({ type: 'error', code: 'unknown' });
    expect(parseTurnstileMessage(JSON.stringify({ type: 'error', code: '' }))).toEqual({
      type: 'error',
      code: 'unknown',
    });
    const long = parseTurnstileMessage(JSON.stringify({ type: 'error', code: 'c'.repeat(500) }));
    expect(long).toEqual({ type: 'error', code: 'c'.repeat(40) });
  });

  it('形の違うものは捨てる (文字列でない・JSON でない・オブジェクトでない・知らない type)', () => {
    expect(parseTurnstileMessage(undefined)).toBeNull();
    expect(parseTurnstileMessage(null)).toBeNull();
    expect(parseTurnstileMessage({ type: 'token', token: 'tok' })).toBeNull();
    expect(parseTurnstileMessage('not json')).toBeNull();
    expect(parseTurnstileMessage('123')).toBeNull();
    expect(parseTurnstileMessage('null')).toBeNull();
    expect(parseTurnstileMessage('[1,2]')).toBeNull();
    expect(parseTurnstileMessage(JSON.stringify({ type: 'something-else', token: 'tok' }))).toBeNull();
    expect(parseTurnstileMessage(JSON.stringify({ token: 'tok' }))).toBeNull();
  });
});

describe('buildTurnstileHtml', () => {
  const SITE_KEY = '1x00000000000000000000AA';

  /** HTML の最初の <script>...</script> (Turnstile の設定と、アプリへ知らせる関数) の中身 */
  function inlineScript(html: string): string {
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    return match![1];
  }

  it('Cloudflare の api.js を explicit モード・onload 付きで読み込み、失敗したらアプリへ知らせる', () => {
    const html = buildTurnstileHtml(SITE_KEY, 'login');

    expect(TURNSTILE_SCRIPT_URL).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js');
    expect(html).toContain(`<script src="${TURNSTILE_SCRIPT_URL}?render=explicit&onload=onTurnstileLoad"`);
    expect(html).toContain('onerror="onTurnstileScriptError()"');
  });

  it('サイトキーと action を JSON として埋め込む', () => {
    const html = buildTurnstileHtml(SITE_KEY, 'password-reset');

    expect(html).toContain(JSON.stringify({ sitekey: SITE_KEY, action: 'password-reset' }));
  });

  it('"<" は \\u003c にして埋め込む (</script> などで HTML が壊れない)', () => {
    const html = buildTurnstileHtml('key</script><script>alert(1)</script>', 'login');

    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
    // 設定の JSON としては、もとの文字列に戻る (スクリプトを実行すると、var CONFIG がサンドボックスに残る)
    const sandbox: Record<string, unknown> = { window: {} };
    vm.runInNewContext(inlineScript(html), sandbox, { timeout: 1000 });
    expect((sandbox.CONFIG as { sitekey: string }).sitekey).toBe('key</script><script>alert(1)</script>');
  });

  describe('WebView の中で動くスクリプト (HTML から取り出して実行する)', () => {
    function run(html: string) {
      const posted: string[] = [];
      const render = jest.fn();
      const sandbox = {
        window: { ReactNativeWebView: { postMessage: (message: string) => posted.push(message) } },
        turnstile: { render },
      };
      const api = vm.runInNewContext(
        `${inlineScript(html)}\n;({ onTurnstileLoad: onTurnstileLoad, onTurnstileScriptError: onTurnstileScriptError })`,
        sandbox,
        { timeout: 1000 },
      ) as { onTurnstileLoad: () => void; onTurnstileScriptError: () => void };
      return { api, posted, render };
    }

    it('読み込めたら、サイトキー・action・日本語・light でウィジェットを描画する (フォームに hidden 欄は足さない)', () => {
      const { api, render } = run(buildTurnstileHtml(SITE_KEY, 'signup'));

      api.onTurnstileLoad();

      expect(render).toHaveBeenCalledTimes(1);
      const [selector, options] = render.mock.calls[0];
      expect(selector).toBe('#widget');
      expect(options).toMatchObject({
        sitekey: SITE_KEY,
        action: 'signup',
        theme: 'light',
        language: 'ja',
        size: 'flexible',
        'response-field': false,
        'refresh-expired': 'auto',
        'refresh-timeout': 'auto',
      });
    });

    it('ウィジェットのコールバックは、parseTurnstileMessage が読める形でアプリへ知らせる', () => {
      const { api, posted, render } = run(buildTurnstileHtml(SITE_KEY, 'login'));
      api.onTurnstileLoad();
      const options = render.mock.calls[0][1];

      options.callback('tok-123');
      options['expired-callback']();
      options['timeout-callback']();
      const handled = options['error-callback'](300030);

      expect(posted.map(parseTurnstileMessage)).toEqual([
        { type: 'token', token: 'tok-123' },
        { type: 'expired' },
        { type: 'expired' },
        { type: 'error', code: '300030' },
      ]);
      // true を返して Turnstile に「処理済み」と伝える
      expect(handled).toBe(true);
    });

    it('描画で例外が出ても (サイトキーの形式が不正など) アプリへ render エラーとして知らせる', () => {
      const { api, posted, render } = run(buildTurnstileHtml(SITE_KEY, 'login'));
      render.mockImplementation(() => {
        throw new Error('Invalid or missing type for parameter "sitekey"');
      });

      api.onTurnstileLoad();

      expect(posted.map(parseTurnstileMessage)).toEqual([{ type: 'error', code: 'render' }]);
    });

    it('api.js を読み込めなかったら、アプリへ script エラーとして知らせる', () => {
      const { api, posted } = run(buildTurnstileHtml(SITE_KEY, 'login'));

      api.onTurnstileScriptError();

      expect(posted.map(parseTurnstileMessage)).toEqual([{ type: 'error', code: 'script' }]);
    });
  });
});

describe('isCaptchaFailure', () => {
  it('error.code が captcha_failed なら true', () => {
    expect(isCaptchaFailure({ code: 'captcha_failed', message: 'x', status: 400 })).toBe(true);
  });

  it('message に captcha を含んでいれば true (大文字小文字は問わない)', () => {
    expect(isCaptchaFailure({ message: 'captcha verification process failed' })).toBe(true);
    expect(isCaptchaFailure(new Error('captcha protection: request disallowed (invalid-input-response)'))).toBe(true);
    expect(isCaptchaFailure({ message: 'CAPTCHA failed' })).toBe(true);
  });

  it('パスワード違い・レート制限・null などは false', () => {
    expect(isCaptchaFailure({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe(false);
    expect(isCaptchaFailure({ code: 'over_request_rate_limit', message: 'For security purposes' })).toBe(false);
    expect(isCaptchaFailure({})).toBe(false);
    expect(isCaptchaFailure(null)).toBe(false);
    expect(isCaptchaFailure(undefined)).toBe(false);
    expect(isCaptchaFailure('captcha')).toBe(false);
  });

  it('利用者向けの文言は、Web と同じ', () => {
    expect(CAPTCHA_FAILED_MESSAGE).toBe('ボットではないことの確認に失敗しました。もう一度お試しください。');
  });
});
