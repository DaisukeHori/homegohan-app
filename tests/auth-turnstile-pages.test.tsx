/**
 * #1165 ログイン・新規登録・パスワード再設定の画面に Turnstile をつないだ結果の単体テスト
 * (src/app/(auth)/login, signup, auth/forgot-password の各 page.tsx)
 *
 * 確かめること (3 画面とも):
 *   - サイトキー未設定 (Turnstile 無効): 何も足さない。送信ボタンは押せて、
 *     今までと同じ引数 (captchaToken も options も付けない) で送る
 *   - ログインは、ブラウザから Supabase を直接呼ばず、サーバーの POST /api/auth/login へ送る
 *     (ロック・回数制限・ボットの確認をサーバーで行うため。本文は { email, password, captchaToken? })
 *   - サイトキーあり: トークンが無い間は送信ボタンが無効 (「トークン無し → 送信ボタン無効」)
 *   - トークンは、正しい場所に付けて渡す
 *       ログイン (POST /api/auth/login) : 本文の captchaToken
 *       signUp                          : options.captchaToken
 *       resetPasswordForEmail       : 第 2 引数の直下の captchaToken (options の中に入れても Supabase には届かない)
 *   - 送信したらトークンを捨ててウィジェットを取り直し、新しいトークンが届くまで送信できない (トークンは 1 回しか使えない)
 *   - 入力の検証 (パスワード強度) やクールダウンで弾いたときは、使っていないトークンを捨てない
 *   - Supabase が CAPTCHA の確認を断ったら、英語の生のエラー文ではなく日本語の文言を出す。
 *     ログインでは、パスワード違いと違ってクールダウン (30 秒) を付けない
 *
 * @testing-library/react は未インストールのため、他のコンポーネントテストと同じく
 * react-dom/client + act で実際に描画する。Cloudflare の api.js は読み込まず、window.turnstile の偽物を使う。
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── モック (vi.hoisted: vi.mock のファクトリから参照するため) ────────────────────
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signInWithPassword: vi.fn(),
  fetch: vi.fn(),
  signUp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  signInWithOAuth: vi.fn(),
  getUser: vi.fn(),
  from: vi.fn(),
  searchParams: new URLSearchParams(''),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  useSearchParams: () => mocks.searchParams,
}));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: mocks.signInWithPassword,
      signUp: mocks.signUp,
      resetPasswordForEmail: mocks.resetPasswordForEmail,
      signInWithOAuth: mocks.signInWithOAuth,
      getUser: mocks.getUser,
    },
    from: mocks.from,
  }),
}));

// framer-motion はアニメーション完了待ちが jsdom で不安定なので素通しにする
vi.mock('framer-motion', async () => {
  const react = await import('react');
  const cache: Record<string, unknown> = {};
  const passthrough = (tag: string) =>
    function Passthrough({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...rest
    }: Record<string, unknown> & { children?: ReactNode }) {
      return react.createElement(tag, rest, children);
    };
  return {
    motion: new Proxy({}, { get: (_target, tag: string) => (cache[tag] ??= passthrough(tag)) }),
    AnimatePresence: ({ children }: { children?: ReactNode }) =>
      react.createElement(react.Fragment, null, children),
  };
});

import LoginPage from '@/app/(auth)/login/page';
import SignupPage from '@/app/(auth)/signup/page';
import ForgotPasswordPage from '@/app/(auth)/auth/forgot-password/page';
import { CAPTCHA_FAILED_MESSAGE } from '@/lib/auth/turnstile';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SITE_KEY = '1x00000000000000000000AA';
const EMAIL = 'user@example.com';
const PASSWORD = 'Passw0rdSecret';
const CAPTCHA_ERROR = { code: 'captcha_failed', status: 400, message: 'captcha verification process failed' };

// ── Turnstile の偽物 ────────────────────────────────────────────────────────────
interface RenderCall {
  widgetId: string;
  options: { callback: (token: string) => void; 'error-callback': (code: string) => boolean | void };
}

let renders: RenderCall[];
let turnstileApi: { render: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };

function installFakeTurnstile() {
  renders = [];
  turnstileApi = {
    render: vi.fn((_container: HTMLElement, options: RenderCall['options']) => {
      const widgetId = `widget-${renders.length + 1}`;
      renders.push({ widgetId, options });
      return widgetId;
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  (window as unknown as { turnstile?: unknown }).turnstile = turnstileApi;
}

/** 最後に描画されたウィジェットに、トークンが届いたことにする */
async function emitToken(token: string) {
  await act(async () => {
    renders[renders.length - 1].options.callback(token);
  });
}

// ── 描画と操作のヘルパー ───────────────────────────────────────────────────────
let container: HTMLDivElement;
let root: Root;

async function renderPage(Page: () => ReactNode) {
  await act(async () => {
    root.render(<Page />);
  });
  // ウィジェット (loadTurnstileApi の Promise) が描画されるまで進める
  await act(async () => {});
}

const text = () => container.textContent ?? '';
const submitButton = () => container.querySelector('form button[type="submit"]') as HTMLButtonElement;
const alertText = () => Array.from(container.querySelectorAll('[role="alert"]')).map((el) => el.textContent).join('\n');

function typeInto(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLInputElement;
  expect(input, `入力欄が見つからない: ${selector}`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit() {
  await act(async () => {
    submitButton().click();
  });
  // 送信後の非同期処理 (Supabase の応答、エラー表示) を待つ
  await act(async () => {});
}

const tokenOf = (call: unknown[]) => JSON.stringify(call);

/** POST /api/auth/login の応答 */
function loginResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** ログインの API へ送った本文 (呼ばれた順) */
function loginRequests(): Array<{ url: string; method: string; body: Record<string, unknown> }> {
  return mocks.fetch.mock.calls.map(([url, init]: [string, RequestInit]) => ({
    url,
    method: String(init?.method),
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.signInWithPassword.mockResolvedValue({ data: {}, error: null });
  mocks.signUp.mockResolvedValue({ data: { user: { identities: [{}] }, session: null }, error: null });
  mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  mocks.fetch.mockImplementation(async () => loginResponse(200, { ok: true }));
  vi.stubGlobal('fetch', mocks.fetch);
  installFakeTurnstile();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  delete (window as unknown as { turnstile?: unknown }).turnstile;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────────
describe('ログイン (/login)', () => {
  async function fillAndReady() {
    typeInto('#email', EMAIL);
    typeInto('#password', PASSWORD);
  }

  it('ブラウザから Supabase の signInWithPassword を直接呼ばず、POST /api/auth/login へ送る (#1165)', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    await renderPage(LoginPage);
    await fillAndReady();

    await submit();

    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    const requests = loginRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/auth/login');
    expect(requests[0].method).toBe('POST');
    // 成功したら、今までどおりセッションのユーザーを見て行き先を決める
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
  });

  describe('Turnstile 無効 (サイトキー未設定)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    });

    it('ウィジェットを出さず、送信ボタンは押せて、captchaToken を付けずに送る', async () => {
      await renderPage(LoginPage);
      expect(container.querySelector('[data-testid="turnstile"]')).toBeNull();
      expect(submitButton().disabled).toBe(false);
      await fillAndReady();

      await submit();

      const requests = loginRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].body).toEqual({ email: EMAIL, password: PASSWORD });
      // captchaToken というキー自体が無いこと (undefined を入れただけではない)
      expect(Object.keys(requests[0].body)).toEqual(['email', 'password']);
      expect(turnstileApi.render).not.toHaveBeenCalled();
    });
  });

  describe('Turnstile 有効 (サイトキーあり)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    });

    it('トークンが無い間は送信ボタンが無効で、押しても送らない', async () => {
      await renderPage(LoginPage);
      await fillAndReady();

      expect(renders).toHaveLength(1);
      expect(submitButton().disabled).toBe(true);
      await submit();
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('トークンが届くと送信できて、本文の captchaToken に付けて送る。送信後はトークンを捨てて取り直す', async () => {
      await renderPage(LoginPage);
      await fillAndReady();
      await emitToken('tok-login-1');
      expect(submitButton().disabled).toBe(false);

      await submit();

      const requests = loginRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].body).toEqual({ email: EMAIL, password: PASSWORD, captchaToken: 'tok-login-1' });
      // トークンは 1 回しか使えない: ウィジェットを取り直し、新しいトークンが届くまで送信できない
      expect(turnstileApi.reset).toHaveBeenCalledWith('widget-1');
      expect(submitButton().disabled).toBe(true);
      await emitToken('tok-login-2');
      expect(submitButton().disabled).toBe(false);
    });

    it('Enter キーなどでボタンを通らずに submit されても、トークンが無ければ送らない', async () => {
      await renderPage(LoginPage);
      await fillAndReady();

      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(alertText()).toContain('ボットではないことの確認が終わるまで');
    });

    it('サーバーが CAPTCHA の確認を断ったら日本語の文言を出し、パスワード違いのクールダウン (30 秒) は付けない', async () => {
      mocks.fetch.mockImplementation(async () =>
        loginResponse(400, { error: CAPTCHA_FAILED_MESSAGE, code: 'AUTH_CAPTCHA_FAILED' }),
      );
      await renderPage(LoginPage);
      await fillAndReady();
      await emitToken('tok-login-1');

      await submit();

      expect(alertText()).toContain(CAPTCHA_FAILED_MESSAGE);
      expect(window.localStorage.length).toBe(0);
      expect(turnstileApi.reset).toHaveBeenCalledTimes(1);
      expect(mocks.getUser).not.toHaveBeenCalled();
    });

    it('パスワード違いは今までどおりの文言とクールダウンで、トークンは使い切りとして捨てる', async () => {
      mocks.fetch.mockImplementation(async () =>
        loginResponse(401, {
          error: 'メールアドレスまたはパスワードが正しくありません。',
          code: 'AUTH_INVALID_CREDENTIALS',
          captchaRequired: false,
        }),
      );
      await renderPage(LoginPage);
      await fillAndReady();
      await emitToken('tok-login-1');

      await submit();

      expect(alertText()).toContain('メールアドレスまたはパスワードが正しくありません。');
      expect(window.localStorage.getItem(`auth_last_fail_ts:${EMAIL}`)).toBeTruthy();
      expect(turnstileApi.reset).toHaveBeenCalledTimes(1);
      expect(submitButton().disabled).toBe(true);
      expect(mocks.push).not.toHaveBeenCalled();
    });

    it('クールダウン中は送信せず、使っていないトークンは捨てない (ウィジェットを取り直さない)', async () => {
      window.localStorage.setItem(`auth_last_fail_ts:${EMAIL}`, String(Date.now()));
      await renderPage(LoginPage);
      await fillAndReady();
      await emitToken('tok-login-1');

      await submit();

      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(alertText()).toContain('しばらくしてから再度お試しください');
      expect(turnstileApi.reset).not.toHaveBeenCalled();
      expect(submitButton().disabled).toBe(false);
    });
  });

  describe('ログインに続けて失敗したとき (ロックはしない)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    });

    it('続けて失敗していても (401・captchaRequired)、パスワード違いの文言だけを出し、ロックや残り時間の案内は出さない', async () => {
      mocks.fetch.mockImplementation(async () =>
        loginResponse(401, {
          error: 'メールアドレスまたはパスワードが正しくありません。',
          code: 'AUTH_INVALID_CREDENTIALS',
          captchaRequired: true,
        }),
      );
      await renderPage(LoginPage);
      await fillAndReady();

      await submit();

      expect(alertText()).toContain('メールアドレスまたはパスワードが正しくありません。');
      expect(alertText()).not.toContain('しばらくログインできません');
      expect(alertText()).not.toContain('パスワードを再設定すると');
      expect(alertText()).not.toMatch(/あと約/);
      expect(mocks.getUser).not.toHaveBeenCalled();
      expect(mocks.push).not.toHaveBeenCalled();
    });

    it('サーバーの回数制限 (429) はクールダウンを付けて「しばらくしてから」を出す', async () => {
      mocks.fetch.mockImplementation(async () =>
        loginResponse(429, { error: 'しばらくしてから再度お試しください。', code: 'RATE_LIMITED', retryAfter: 30 }),
      );
      await renderPage(LoginPage);
      await fillAndReady();

      await submit();

      expect(alertText()).toContain('しばらくしてから再度お試しください。');
      expect(window.localStorage.getItem(`auth_last_fail_ts:${EMAIL}`)).toBeTruthy();
    });

    it('通信に失敗したら「予期せぬエラー」を出す', async () => {
      mocks.fetch.mockImplementation(async () => {
        throw new TypeError('Failed to fetch');
      });
      await renderPage(LoginPage);
      await fillAndReady();

      await submit();

      expect(alertText()).toContain('予期せぬエラーが発生しました');
      expect(window.localStorage.length).toBe(0);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe('新規登録 (/signup)', () => {
  /** 入力し、規約に同意する (#1174: 同意するまで登録のボタンは押せない) */
  async function fill(password = PASSWORD) {
    typeInto('#email', EMAIL);
    typeInto('#password', password);
    const agree = container.querySelector('#agree-legal') as HTMLInputElement;
    expect(agree, '規約の同意のチェックボックスが見つからない').toBeTruthy();
    if (!agree.checked) {
      await act(async () => {
        agree.click();
      });
    }
    expect(agree.checked).toBe(true);
  }

  describe('Turnstile 無効 (サイトキー未設定)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    });

    it('ウィジェットを出さず、signUp へ今までと同じ引数 (options は emailRedirectTo だけ) で渡す', async () => {
      await renderPage(SignupPage);
      expect(container.querySelector('[data-testid="turnstile"]')).toBeNull();
      // 規約に同意するまでは押せない (#1174)。同意すれば、トークンを待たずに押せる
      expect(submitButton().disabled).toBe(true);
      await fill();
      expect(submitButton().disabled).toBe(false);

      await submit();

      expect(mocks.signUp).toHaveBeenCalledTimes(1);
      const [credentials] = mocks.signUp.mock.calls[0];
      expect(Object.keys(credentials.options)).toEqual(['emailRedirectTo']);
      expect(credentials.email).toBe(EMAIL);
      expect(credentials.password).toBe(PASSWORD);
    });
  });

  describe('Turnstile 有効 (サイトキーあり)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    });

    it('トークンが無い間は送信ボタンが無効で、押しても Supabase を呼ばない', async () => {
      await renderPage(SignupPage);
      await fill();

      expect(renders).toHaveLength(1);
      expect(submitButton().disabled).toBe(true);
      await submit();
      expect(mocks.signUp).not.toHaveBeenCalled();
    });

    it('トークンが届くと、options.captchaToken (emailRedirectTo と同じ階層) に付けて渡し、送信後はトークンを取り直す', async () => {
      await renderPage(SignupPage);
      await fill();
      await emitToken('tok-signup-1');
      expect(submitButton().disabled).toBe(false);

      await submit();

      expect(mocks.signUp).toHaveBeenCalledTimes(1);
      const [credentials] = mocks.signUp.mock.calls[0];
      expect(credentials.email).toBe(EMAIL);
      expect(credentials.password).toBe(PASSWORD);
      expect(credentials.options.captchaToken).toBe('tok-signup-1');
      expect(credentials.options.emailRedirectTo).toContain('/auth/callback');
      expect(turnstileApi.reset).toHaveBeenCalledWith('widget-1');
    });

    it('パスワードの強度で弾いたときは、使っていないトークンを捨てない', async () => {
      await renderPage(SignupPage);
      await fill('short');
      await emitToken('tok-signup-1');

      await submit();

      expect(mocks.signUp).not.toHaveBeenCalled();
      expect(turnstileApi.reset).not.toHaveBeenCalled();
      expect(submitButton().disabled).toBe(false);
    });

    it('Supabase が CAPTCHA の確認を断ったら、英語の生のエラー文ではなく日本語の文言を出す', async () => {
      mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error: CAPTCHA_ERROR });
      await renderPage(SignupPage);
      await fill();
      await emitToken('tok-signup-1');

      await submit();

      expect(alertText()).toContain(CAPTCHA_FAILED_MESSAGE);
      expect(text()).not.toContain('captcha verification process failed');
      expect(submitButton().disabled).toBe(true); // 新しいトークンが届くまで
    });

    it('登録できたら確認メール画面へ進む (Turnstile を入れても流れは変わらない)', async () => {
      await renderPage(SignupPage);
      await fill();
      await emitToken('tok-signup-1');

      await submit();

      expect(mocks.push).toHaveBeenCalledTimes(1);
      expect(mocks.push.mock.calls[0][0]).toContain('/auth/verify?email=');
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe('パスワード再設定 (/auth/forgot-password)', () => {
  const REDIRECT_TO = `${window.location.origin}/auth/reset-password`;

  describe('Turnstile 無効 (サイトキー未設定)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    });

    it('ウィジェットを出さず、resetPasswordForEmail へ今までと同じ引数 (redirectTo だけ) で渡す', async () => {
      await renderPage(ForgotPasswordPage);
      expect(container.querySelector('[data-testid="turnstile"]')).toBeNull();
      typeInto('input[type="email"]', EMAIL);
      expect(submitButton().disabled).toBe(false);

      await submit();

      expect(mocks.resetPasswordForEmail).toHaveBeenCalledTimes(1);
      const [email, options] = mocks.resetPasswordForEmail.mock.calls[0];
      expect(email).toBe(EMAIL);
      expect(options).toEqual({ redirectTo: REDIRECT_TO });
      expect(Object.keys(options)).toEqual(['redirectTo']);
    });
  });

  describe('Turnstile 有効 (サイトキーあり)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    });

    it('メールアドレスを入れても、トークンが無い間は送信ボタンが無効', async () => {
      await renderPage(ForgotPasswordPage);
      typeInto('input[type="email"]', EMAIL);

      expect(renders).toHaveLength(1);
      expect(submitButton().disabled).toBe(true);
      await submit();
      expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
    });

    it('トークンが届いてもメールアドレスが空なら送信できない (今までの条件も保つ)', async () => {
      await renderPage(ForgotPasswordPage);
      await emitToken('tok-reset-1');

      expect(submitButton().disabled).toBe(true);
    });

    it('captchaToken は第 2 引数の直下 (redirectTo と同じ階層) に渡す。options の中には入れない', async () => {
      await renderPage(ForgotPasswordPage);
      typeInto('input[type="email"]', ` ${EMAIL.toUpperCase()} `);
      await emitToken('tok-reset-1');
      expect(submitButton().disabled).toBe(false);

      await submit();

      expect(mocks.resetPasswordForEmail).toHaveBeenCalledTimes(1);
      const [email, options] = mocks.resetPasswordForEmail.mock.calls[0];
      expect(email).toBe(EMAIL); // 今までどおり、前後の空白と大文字を直す
      expect(options).toEqual({ redirectTo: REDIRECT_TO, captchaToken: 'tok-reset-1' });
      // supabase-js は options.options.captchaToken を読まない。入れると黙って無視されて CAPTCHA を通らなくなる
      expect(options).not.toHaveProperty('options');
      expect(tokenOf(mocks.resetPasswordForEmail.mock.calls[0])).toContain('tok-reset-1');
      expect(turnstileApi.reset).toHaveBeenCalledWith('widget-1');
    });

    it('Supabase が CAPTCHA の確認を断ったら、英語の生のエラー文ではなく日本語の文言を出す', async () => {
      mocks.resetPasswordForEmail.mockResolvedValue({ data: null, error: CAPTCHA_ERROR });
      await renderPage(ForgotPasswordPage);
      typeInto('input[type="email"]', EMAIL);
      await emitToken('tok-reset-1');

      await submit();

      expect(text()).toContain(CAPTCHA_FAILED_MESSAGE);
      expect(text()).not.toContain('captcha verification process failed');
      expect(submitButton().disabled).toBe(true); // 新しいトークンが届くまで
    });

    it('送信できたら完了画面になり、「別のメールアドレスで試す」で戻ると、ウィジェットを描き直して新しいトークンを待つ', async () => {
      await renderPage(ForgotPasswordPage);
      typeInto('input[type="email"]', EMAIL);
      await emitToken('tok-reset-1');

      await submit();

      expect(text()).toContain('メールを送信しました');
      expect(container.querySelector('[data-testid="turnstile"]')).toBeNull();
      expect(turnstileApi.remove).toHaveBeenCalledWith('widget-1');

      const again = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('別のメールアドレスで試す'),
      )!;
      await act(async () => {
        again.click();
      });
      await act(async () => {});

      expect(renders).toHaveLength(2);
      typeInto('input[type="email"]', 'other@example.com');
      expect(submitButton().disabled).toBe(true); // 前のトークンは使えない
      await emitToken('tok-reset-2');
      expect(submitButton().disabled).toBe(false);
    });
  });
});
