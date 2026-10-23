/**
 * Web のログイン画面の「Appleで続ける」(段 B。docs/design/mobile/08-sign-in-with-apple.md §10.2・§12.3・S-34)。
 * このリポジトリには @testing-library/react が無いため、react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const mocks = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  // 描画のたびに同じ値を返す (毎回新しいものを返すと、searchParams に依存する effect が回り続ける)
  useSearchParams: () => mocks.searchParams.current,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth: mocks.signInWithOAuth, getUser: vi.fn() }, from: vi.fn() }),
}));

const { default: LoginPage } = await import('@/app/(auth)/login/page');
const { APPLE_WEB_CALLBACK_ERROR_MESSAGE } = await import('@/lib/auth/apple/web-callback');
const { APPLE_SIGN_IN_BUTTON_HEIGHT_PX, APPLE_SIGN_IN_TITLES } = await import('@/components/auth/AppleSignInButton');
const { APPLE_SIGN_IN_MESSAGES } = await import('@homegohan/shared');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function mount(searchParams = new URLSearchParams()) {
  mocks.searchParams.current = searchParams;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<LoginPage />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.signInWithOAuth.mockResolvedValue({ error: null });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllEnvs();
});

const appleButton = () => container.querySelector<HTMLButtonElement>('[data-testid="login-apple-button"]');
const googleButton = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('Googleで続ける'))!;

describe('ログイン画面: 「Appleで続ける」(スイッチ NEXT_PUBLIC_APPLE_SIGN_IN)', () => {
  it('on: 「Appleで続ける」が Google の前にある (login-apple-button)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', 'on');
    await mount();

    const apple = appleButton();
    expect(apple).not.toBeNull();
    expect(apple!.textContent).toBe(APPLE_SIGN_IN_TITLES.continue);
    expect(apple!.textContent).toBe('Appleで続ける');
    expect(apple!.compareDocumentPosition(googleButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('押すと signInWithOAuth({ provider: apple, redirectTo: …/auth/callback?provider=apple })', async () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', 'on');
    await mount();

    await act(async () => {
      appleButton()!.click();
    });

    expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1);
    const arg = mocks.signInWithOAuth.mock.calls[0][0];
    expect(arg.provider).toBe('apple');
    const redirectTo = new URL(arg.options.redirectTo);
    expect(redirectTo.origin).toBe(window.location.origin);
    expect(redirectTo.pathname).toBe('/auth/callback');
    expect(redirectTo.searchParams.get('provider')).toBe('apple');
    expect(redirectTo.searchParams.has('next')).toBe(false);
  });

  it('?next= は redirectTo の next に入る (安全でない next は入れない)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', 'on');
    await mount(new URLSearchParams({ next: '/invite/abc' }));

    await act(async () => {
      appleButton()!.click();
    });

    const redirectTo = new URL(mocks.signInWithOAuth.mock.calls[0][0].options.redirectTo);
    expect(redirectTo.searchParams.get('provider')).toBe('apple');
    expect(redirectTo.searchParams.get('next')).toBe('/invite/abc');
  });

  it('Google のボタンは今までどおり provider=apple を付けない', async () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', 'on');
    await mount();

    await act(async () => {
      googleButton().click();
    });

    const arg = mocks.signInWithOAuth.mock.calls[0][0];
    expect(arg.provider).toBe('google');
    expect(new URL(arg.options.redirectTo).searchParams.has('provider')).toBe(false);
  });

  it('スイッチ無し: 無い (Google は今までどおりある)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', '');
    await mount();

    expect(appleButton()).toBeNull();
    expect(container.textContent).not.toContain('Apple');
    expect(googleButton()).toBeDefined();
  });

  it('スイッチが off: 無い', async () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', 'off');
    await mount();

    expect(appleButton()).toBeNull();
  });

  it('signInWithOAuth が error を返すと、固定の文のバナー', async () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', 'on');
    mocks.signInWithOAuth.mockResolvedValue({ error: new Error('provider is not enabled') });
    await mount();

    await act(async () => {
      appleButton()!.click();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(APPLE_SIGN_IN_MESSAGES.failed);
    expect(alert?.textContent).toContain('Apple でのログインに失敗しました。しばらくしてからお試しください。');
    expect(alert?.textContent).not.toContain('provider is not enabled');
  });

  it('?error= が APPLE_WEB_CALLBACK_ERROR_MESSAGE のとき、バナーの文が APPLE_WEB_CALLBACK_ERROR_MESSAGE と同じ (S-34)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', 'on');
    await mount(new URLSearchParams({ error: APPLE_WEB_CALLBACK_ERROR_MESSAGE }));

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.querySelector('p')?.textContent).toBe(APPLE_WEB_CALLBACK_ERROR_MESSAGE);
  });

  it('login-google-legal-note は 1 つで文は変わらない (tests/login-google-legal-note.test.tsx も緑)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', 'on');
    await mount();

    const notes = container.querySelectorAll('[data-testid="login-google-legal-note"]');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toBe(
      'はじめての方は、続けたあとに利用規約とプライバシーポリシーへの同意の画面が出ます。',
    );
  });

  it('Google のボタンの style の height は APPLE_SIGN_IN_BUTTON_HEIGHT_PX で、Apple のボタンの style の height と同じ (className に py-6・h-14 が無い)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', 'on');
    await mount();

    const heightPx = `${APPLE_SIGN_IN_BUTTON_HEIGHT_PX}px`;
    expect(googleButton().style.height).toBe(heightPx);
    expect(appleButton()!.style.height).toBe(heightPx);
    for (const button of [googleButton(), appleButton()!]) {
      const classes = button.className.split(/\s+/);
      expect(classes).not.toContain('py-6');
      expect(classes).not.toContain('h-14');
    }
    expect(googleButton().className.split(/\s+/)).toContain('py-0');
  });
});
