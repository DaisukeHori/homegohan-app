/**
 * #1474 Supabase の CAPTCHA を有効にすると止まる残りの 1 か所に、Turnstile のトークンを付けた結果の単体テスト
 *   - メール確認の再送 (src/app/(auth)/auth/verify/page.tsx)         : supabase.auth.resend
 *
 * (設定 → アカウント → パスワード変更の本人確認 = signInWithPassword は、#1720 段 C でパスワードの変更が API 経由になり、
 *  再認証のサインインが無くなったので、Turnstile の対象から外れた。docs/design/cross/16-auth-history-sessions.md §15・§22 N-26)
 *
 * 確かめること:
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
import { CAPTCHA_FAILED_MESSAGE } from '@/lib/auth/turnstile';
import { AUTH_RATE_LIMITED_MESSAGE } from '@/lib/auth/auth-error-message';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SITE_KEY = '1x00000000000000000000AA';
const EMAIL = 'user@example.com';
const CAPTCHA_ERROR = { code: 'captcha_failed', status: 400, message: 'captcha verification process failed' };

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

    it('回数の制限 (429) は、GoTrue の英語の文を付け足さず「しばらくしてから」の案内を出す (#1917 の続き)', async () => {
      mocks.resend.mockResolvedValue({ data: null, error: { status: 429, message: 'email rate limit exceeded' } });
      await renderPage(VerifyPage);
      await emitToken('tok-resend-1');

      await click(resendButton());

      expect(text()).toContain(AUTH_RATE_LIMITED_MESSAGE);
      expect(text()).not.toContain('email rate limit exceeded');
      expect(text()).not.toContain(CAPTCHA_FAILED_MESSAGE);
    });

    it('CAPTCHA・回数の制限以外の GoTrue の英語の文は出さず、「再送信に失敗しました」の固定の文を出す (#1917 の続き)', async () => {
      mocks.resend.mockResolvedValue({ data: null, error: { status: 422, code: 'email_address_invalid', message: 'Email address "x" is invalid' } });
      await renderPage(VerifyPage);
      await emitToken('tok-resend-1');

      await click(resendButton());

      expect(text()).toContain('再送信に失敗しました。しばらくしてから再度お試しください。');
      expect(text()).not.toContain('is invalid');
    });

    it('resend が例外を投げても、例外の英語の文を出さず「予期せぬエラー」の固定の文を出す (#1917 の続き)', async () => {
      mocks.resend.mockRejectedValue(new Error('Failed to fetch dynamically imported module'));
      await renderPage(VerifyPage);
      await emitToken('tok-resend-1');

      await click(resendButton());

      expect(text()).toContain('予期せぬエラーが発生しました。しばらくしてから再度お試しください。');
      expect(text()).not.toContain('Failed to fetch');
    });
  });
});
