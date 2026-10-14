/**
 * #1194 画面に出す問い合わせ先 (support@…) は、環境変数 NEXT_PUBLIC_SUPPORT_EMAIL で決まる (src/lib/site-config.ts)
 *
 * 以前は、招待画面 (.app)・お問い合わせ画面とプライバシーポリシー (.jp) が別々のアドレスを直接書いていて、
 * メールの文面とも食い違っていた。ここでは、3 つの画面が同じ設定に従うことを確かめる。
 *
 * NEXT_PUBLIC_ の環境変数はビルド時に埋め込まれるが、テストでは呼ぶたびに読むので、描画の直前に差し替えられる。
 * このリポジトリには @testing-library/react が無いため、react-dom/server で HTML にして文字列で調べる。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SUPPORT_EMAIL } from '@/lib/site-config';

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

const { InviteLayout } = await import('@/components/membership/InviteLayout');
const { default: PrivacyPage } = await import('@/app/privacy/page');
const { default: ContactPage } = await import('@/app/contact/page');

const SCREENS = [
  {
    name: '招待画面 (InviteLayout) のフッター',
    render: () => renderToStaticMarkup(<InviteLayout scope="family">本文</InviteLayout>),
  },
  { name: 'お問い合わせ画面 (/contact) の連絡先', render: () => renderToStaticMarkup(<ContactPage />) },
  { name: 'プライバシーポリシー (/privacy) の窓口', render: () => renderToStaticMarkup(<PrivacyPage />) },
] as const;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(SCREENS)('$name', ({ render }) => {
  it('NEXT_PUBLIC_SUPPORT_EMAIL を設定すると、そのアドレスを表示する (mailto: リンクがある画面ではリンク先も)', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', 'help@example.test');

    const html = render();

    expect(html).toContain('help@example.test');
    expect(html).not.toContain(DEFAULT_SUPPORT_EMAIL);
    // mailto: のリンクを持つ画面は、リンク先と表示が同じアドレスになっている
    const mailtos = [...html.matchAll(/href="mailto:([^"]*)"/g)].map((m) => m[1]);
    for (const address of mailtos) expect(address).toBe('help@example.test');
  });

  it('未設定なら、従来と同じ既定のアドレス (DEFAULT_SUPPORT_EMAIL) を表示する', () => {
    const html = render();

    expect(html).toContain(DEFAULT_SUPPORT_EMAIL);
    const mailtos = [...html.matchAll(/href="mailto:([^"]*)"/g)].map((m) => m[1]);
    for (const address of mailtos) expect(address).toBe(DEFAULT_SUPPORT_EMAIL);
  });
});

describe('mailto: のリンクを持つ画面', () => {
  it('招待画面とお問い合わせ画面は、設定したアドレス宛の mailto: リンクを出す', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', 'help@example.test');

    for (const { render } of [SCREENS[0], SCREENS[1]]) {
      expect(render()).toContain('href="mailto:help@example.test"');
    }
  });
});
