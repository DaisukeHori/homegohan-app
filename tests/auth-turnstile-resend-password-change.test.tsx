/**
 * #1474 Supabase の CAPTCHA を有効にすると止まる残りの 2 か所に、Turnstile のトークンを付けた結果の単体テスト
 *   - メール確認の再送 (src/app/(auth)/auth/verify/page.tsx)         : supabase.auth.resend
 *   - 設定 → アカウント → パスワード変更の本人確認
 *     (src/app/(main)/settings/account/page.tsx)                      : supabase.auth.signInWithPassword
 *
 * 確かめること (2 画面とも):
 *   - サイトキー未設定 (Turnstile 無効): ウィジェットを出さず、ボタンは押せて、今までと同じ引数 (captchaToken を付けない) で送る
 *   - サイトキーあり: トークンが届くまでボタンは無効で、押しても Supabase を呼ばない
 *   - トークンは options.captchaToken に付けて渡す (resend・signInWithPassword とも options の中)
 *   - 送信したらトークンを捨ててウィジェットを取り直し、新しいトークンが届くまで送れない (トークンは 1 回しか使えない)
 *   - 入力の検証で弾いたときは、使っていないトークンを捨てない
 *   - Supabase が CAPTCHA の確認を断ったら、英語の生のエラー文ではなく日本語の文言を出す
 *
 * tests/auth-turnstile-pages.test.tsx (ログイン・新規登録・パスワード再設定) と同じく、
 * react-dom/client + act で実際に描画し、Cloudflare の api.js は読み込まず window.turnstile の偽物を使う。
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── モック (vi.hoisted: vi.mock のファクトリから参照するため) ────────────────────
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  resend: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  getUser: vi.fn(),
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
      resend: mocks.resend,
      signInWithPassword: mocks.signInWithPassword,
      updateUser: mocks.updateUser,
      signOut: mocks.signOut,
      getUser: mocks.getUser,
    },
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

import VerifyPage from '@/app/(auth)/auth/verify/page';
import AccountSettingsPage from '@/app/(main)/settings/account/page';
import { CAPTCHA_FAILED_MESSAGE } from '@/lib/auth/turnstile';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SITE_KEY = '1x00000000000000000000AA';
const EMAIL = 'user@example.com';
const CURRENT_PASSWORD = 'Passw0rdCurrent';
const NEW_PASSWORD = 'Passw0rdNewOne';
const CAPTCHA_ERROR = { code: 'captcha_failed', status: 400, message: 'captcha verification process failed' };
const WAIT_FOR_CAPTCHA_MESSAGE = 'ボットではないことの確認が終わるまで';

// ── Turnstile の偽物 ────────────────────────────────────────────────────────────
interface RenderCall {
  widgetId: string;
  options: { action?: string; callback: (token: string) => void };
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
  // 非同期の読み込み (getUser) と、ウィジェット (loadTurnstileApi の Promise) の描画まで進める
  await act(async () => {});
  await act(async () => {});
}

const text = () => container.textContent ?? '';

function typeInto(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLInputElement;
  expect(input, `入力欄が見つからない: ${selector}`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
  // 送信後の非同期処理 (Supabase の応答、エラー表示) を待つ
  await act(async () => {});
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchParams = new URLSearchParams('');
  mocks.resend.mockResolvedValue({ data: {}, error: null });
  mocks.signInWithPassword.mockResolvedValue({ data: {}, error: null });
  mocks.updateUser.mockResolvedValue({ data: {}, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.getUser.mockResolvedValue({
    data: { user: { email: EMAIL, app_metadata: { provider: 'email' } } },
    error: null,
  });
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
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────────
describe('メール確認の再送 (/auth/verify)', () => {
  const REDIRECT_TO = `${window.location.origin}/auth/callback`;
  const resendButton = () =>
    container.querySelector('[data-testid="resend-confirmation-button"]') as HTMLButtonElement;

  beforeEach(() => {
    mocks.searchParams = new URLSearchParams({ email: EMAIL });
  });

  describe('Turnstile 無効 (サイトキー未設定)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    });

    it('ウィジェットを出さず、再送のボタンは押せて、resend へ今までと同じ引数 (options は emailRedirectTo だけ) で渡す', async () => {
      await renderPage(VerifyPage);
      expect(container.querySelector('[data-testid="turnstile"]')).toBeNull();
      expect(resendButton().disabled).toBe(false);

      await click(resendButton());

      expect(mocks.resend).toHaveBeenCalledTimes(1);
      expect(mocks.resend.mock.calls[0][0]).toEqual({
        type: 'signup',
        email: EMAIL,
        options: { emailRedirectTo: REDIRECT_TO },
      });
      // captchaToken というキー自体が無いこと
      expect(Object.keys(mocks.resend.mock.calls[0][0].options)).toEqual(['emailRedirectTo']);
      expect(turnstileApi.render).not.toHaveBeenCalled();
      expect(text()).toContain('確認メールを再送信しました');
    });
  });

  describe('Turnstile 有効 (サイトキーあり)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    });

    it('ウィジェットを action=resend-confirmation で出し、トークンが無い間は再送のボタンが無効で、押しても resend を呼ばない', async () => {
      await renderPage(VerifyPage);

      expect(renders).toHaveLength(1);
      expect(renders[0].options.action).toBe('resend-confirmation');
      expect(resendButton().disabled).toBe(true);
      await click(resendButton());
      expect(mocks.resend).not.toHaveBeenCalled();
    });

    it('トークンが届くと押せて、options.captchaToken (emailRedirectTo と同じ階層) に付けて渡す。送信後はトークンを捨てて取り直す', async () => {
      await renderPage(VerifyPage);
      await emitToken('tok-resend-1');
      expect(resendButton().disabled).toBe(false);

      await click(resendButton());

      expect(mocks.resend).toHaveBeenCalledTimes(1);
      expect(mocks.resend.mock.calls[0][0]).toEqual({
        type: 'signup',
        email: EMAIL,
        options: { emailRedirectTo: REDIRECT_TO, captchaToken: 'tok-resend-1' },
      });
      // トークンは 1 回しか使えない: ウィジェットを取り直し、新しいトークンが届くまで再送できない
      expect(turnstileApi.reset).toHaveBeenCalledWith('widget-1');
      expect(resendButton().disabled).toBe(true);
      await emitToken('tok-resend-2');
      expect(resendButton().disabled).toBe(false);

      await click(resendButton());
      expect(mocks.resend).toHaveBeenCalledTimes(2);
      expect(mocks.resend.mock.calls[1][0].options.captchaToken).toBe('tok-resend-2');
    });

    it('招待の行き先 (redirect) があるときも、emailRedirectTo の next を保ったまま captchaToken を足す', async () => {
      mocks.searchParams = new URLSearchParams({ email: EMAIL, redirect: '/invite/abc' });
      await renderPage(VerifyPage);
      await emitToken('tok-resend-1');

      await click(resendButton());

      expect(mocks.resend.mock.calls[0][0].options).toEqual({
        emailRedirectTo: `${REDIRECT_TO}?next=${encodeURIComponent('/invite/abc')}`,
        captchaToken: 'tok-resend-1',
      });
    });

    it('メールアドレスが無いときは resend を呼ばず、使っていないトークンを捨てない', async () => {
      mocks.searchParams = new URLSearchParams('');
      await renderPage(VerifyPage);
      await emitToken('tok-resend-1');

      await click(resendButton());

      expect(mocks.resend).not.toHaveBeenCalled();
      expect(text()).toContain('メールアドレスが見つかりません');
      expect(turnstileApi.reset).not.toHaveBeenCalled();
      expect(resendButton().disabled).toBe(false);
    });

    it('Supabase が CAPTCHA の確認を断ったら、英語の生のエラー文ではなく日本語の文言を出す', async () => {
      mocks.resend.mockResolvedValue({ data: null, error: CAPTCHA_ERROR });
      await renderPage(VerifyPage);
      await emitToken('tok-resend-1');

      await click(resendButton());

      expect(text()).toContain(CAPTCHA_FAILED_MESSAGE);
      expect(text()).not.toContain('captcha verification process failed');
      expect(resendButton().disabled).toBe(true); // 新しいトークンが届くまで
    });

    it('CAPTCHA 以外のエラーは、今までどおり「再送信に失敗しました」を出す', async () => {
      mocks.resend.mockResolvedValue({ data: null, error: { status: 429, message: 'email rate limit exceeded' } });
      await renderPage(VerifyPage);
      await emitToken('tok-resend-1');

      await click(resendButton());

      expect(text()).toContain('再送信に失敗しました: email rate limit exceeded');
      expect(text()).not.toContain(CAPTCHA_FAILED_MESSAGE);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe('設定 → アカウント → パスワード変更の本人確認 (/settings/account)', () => {
  const form = () => container.querySelector('[data-testid="password-change-form"]') as HTMLFormElement;
  const submitButton = () => form().querySelector('button[type="submit"]') as HTMLButtonElement;

  function fillPasswords(confirm = NEW_PASSWORD) {
    typeInto('#current-password', CURRENT_PASSWORD);
    typeInto('#new-password', NEW_PASSWORD);
    typeInto('#confirm-password', confirm);
  }

  describe('Turnstile 無効 (サイトキー未設定)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    });

    it('ウィジェットを出さず、変更のボタンは押せて、signInWithPassword へ今までと同じ引数 (options を付けない) で渡す', async () => {
      await renderPage(AccountSettingsPage);
      expect(form()).toBeTruthy();
      expect(form().querySelector('[data-testid="turnstile"]')).toBeNull();
      expect(submitButton().disabled).toBe(false);
      fillPasswords();

      await click(submitButton());

      expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
      expect(mocks.signInWithPassword.mock.calls[0][0]).toEqual({ email: EMAIL, password: CURRENT_PASSWORD });
      expect(Object.keys(mocks.signInWithPassword.mock.calls[0][0])).toEqual(['email', 'password']);
      expect(mocks.updateUser).toHaveBeenCalledWith({ password: NEW_PASSWORD });
      expect(turnstileApi.render).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="password-change-success"]')).not.toBeNull();
    });
  });

  describe('Turnstile 有効 (サイトキーあり)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    });

    it('フォームの中にウィジェットを action=password-change で出し、トークンが無い間は変更のボタンが無効で、押しても本人確認を呼ばない', async () => {
      await renderPage(AccountSettingsPage);
      fillPasswords();

      expect(renders).toHaveLength(1);
      expect(renders[0].options.action).toBe('password-change');
      expect(form().querySelector('[data-testid="turnstile"]')).not.toBeNull();
      expect(submitButton().disabled).toBe(true);
      await click(submitButton());
      expect(mocks.signInWithPassword).not.toHaveBeenCalled();
      expect(mocks.updateUser).not.toHaveBeenCalled();
    });

    it('Enter キーなどでボタンを通らずに submit されても、トークンが無ければ本人確認を呼ばない', async () => {
      await renderPage(AccountSettingsPage);
      fillPasswords();

      await act(async () => {
        form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(mocks.signInWithPassword).not.toHaveBeenCalled();
      expect(text()).toContain(WAIT_FOR_CAPTCHA_MESSAGE);
    });

    it('トークンが届くと押せて、本人確認の signInWithPassword の options.captchaToken に付けて渡す。送信後はトークンを捨てて取り直す', async () => {
      await renderPage(AccountSettingsPage);
      fillPasswords();
      await emitToken('tok-change-1');
      expect(submitButton().disabled).toBe(false);

      await click(submitButton());

      expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
      expect(mocks.signInWithPassword.mock.calls[0][0]).toEqual({
        email: EMAIL,
        password: CURRENT_PASSWORD,
        options: { captchaToken: 'tok-change-1' },
      });
      // 新しいパスワードの保存 (updateUser) は CAPTCHA の対象外。トークンは付けない
      expect(mocks.updateUser).toHaveBeenCalledWith({ password: NEW_PASSWORD });
      expect(container.querySelector('[data-testid="password-change-success"]')).not.toBeNull();
      // トークンは 1 回しか使えない: ウィジェットを取り直し、新しいトークンが届くまで送れない
      expect(turnstileApi.reset).toHaveBeenCalledWith('widget-1');
      expect(submitButton().disabled).toBe(true);
      await emitToken('tok-change-2');
      expect(submitButton().disabled).toBe(false);
    });

    it('入力の検証 (確認用のパスワードの不一致) で弾いたときは、使っていないトークンを捨てない', async () => {
      await renderPage(AccountSettingsPage);
      fillPasswords('Passw0rdMismatch');
      await emitToken('tok-change-1');

      await click(submitButton());

      expect(mocks.signInWithPassword).not.toHaveBeenCalled();
      expect(text()).toContain('一致しません');
      expect(turnstileApi.reset).not.toHaveBeenCalled();
      expect(submitButton().disabled).toBe(false);

      // 直して送り直すと、取っておいたトークンを使う
      typeInto('#confirm-password', NEW_PASSWORD);
      await click(submitButton());
      expect(mocks.signInWithPassword.mock.calls[0][0].options).toEqual({ captchaToken: 'tok-change-1' });
    });

    it('Supabase が CAPTCHA の確認を断ったら、パスワード違いではなく日本語のボットの確認の文言を出し、パスワードは変えない', async () => {
      mocks.signInWithPassword.mockResolvedValue({ data: null, error: CAPTCHA_ERROR });
      await renderPage(AccountSettingsPage);
      fillPasswords();
      await emitToken('tok-change-1');

      await click(submitButton());

      expect(text()).toContain(CAPTCHA_FAILED_MESSAGE);
      expect(text()).not.toContain('captcha verification process failed');
      expect(text()).not.toContain('現在のパスワードが正しくありません');
      expect(mocks.updateUser).not.toHaveBeenCalled();
      expect(submitButton().disabled).toBe(true); // 新しいトークンが届くまで
    });
  });
});
