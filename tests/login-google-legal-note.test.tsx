/**
 * #1435 ログイン画面の「Googleで続ける」と、規約の同意
 *
 * 「Googleで続ける」は、初めての人には新しいアカウントを作る。初回は /auth/callback が必ず同意画面 (/legal-consent) を
 * 通す (tests/auth-callback-legal-consent.test.ts)。ログイン画面では、その流れを先に知らせ、利用規約・プライバシーポリシーの
 * 文面へのリンクを出す。#1174 でやめた「続けると同意したものとみなします」というみなし同意の文面は出さない。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth: vi.fn(), getUser: vi.fn() }, from: vi.fn() }),
}));

const { default: LoginPage } = await import('@/app/(auth)/login/page');

function render() {
  document.body.innerHTML = renderToStaticMarkup(<LoginPage />);
}

describe('ログイン画面: 「Googleで続ける」と規約の同意 (#1435)', () => {
  it('「Googleで続ける」のそばに、初めての人には同意の画面が出ることを知らせる。利用規約 (/terms)・プライバシーポリシー (/privacy) へのリンクつき', () => {
    render();

    const note = document.querySelector('[data-testid="login-google-legal-note"]');
    expect(note, '案内がある').not.toBeNull();
    expect(note!.textContent).toContain('はじめての方');
    expect(note!.textContent).toContain('同意の画面');
    const hrefs = Array.from(note!.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href')]);
    expect(hrefs).toEqual([
      ['利用規約', '/terms'],
      ['プライバシーポリシー', '/privacy'],
    ]);
    expect(document.body.textContent).toContain('Googleで続ける');
  });

  it('★みなし同意の文面 (「同意したものとみなします/みなされます」) は出さない (#1174 でやめた)', () => {
    render();

    expect(document.body.textContent).not.toMatch(/みなし|みなされ/);
  });
});
