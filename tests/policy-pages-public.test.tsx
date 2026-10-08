/**
 * #1174 (同意の前提): 利用規約 (/terms) とプライバシーポリシー (/privacy) のページ
 *
 * 従来は (main) グループ (ログイン後の画面) の中にあり、未ログインで開くと /login へ飛ばされていた
 * (サインアップ画面・LP フッターの同意リンク、ストア審査に出すプライバシー URL がすべてログイン画面に着地)。
 *
 * 未ログインで開けるようにするのは lib/supabase/middleware.ts の publicPaths (middleware のテストが検査)。
 * ここでは、ページ自体について次を確かめる。
 *   - (main) の外 (src/app/terms, src/app/privacy) にある。(main) の layout はアプリ用のナビ・AI チャットを
 *     付けて、ログインしていない人にも見せてしまうため
 *   - 見出しが出る。戻るリンクは設定画面 (/settings) ではなくトップ (/)
 *
 * 規約・ポリシーの文面そのものはここでは検査しない (文面の見直しは別タスクで、そのたびにこのテストを直したくないため)。
 *
 * このリポジトリには @testing-library/react が無いため、react-dom/server で HTML にして jsdom で読む。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const root = process.cwd();

const { default: PrivacyPage, metadata: privacyMetadata } = await import('@/app/privacy/page');
const { default: TermsPage, metadata: termsMetadata } = await import('@/app/terms/page');

const pages = [
  { url: '/privacy', title: 'プライバシーポリシー', Page: PrivacyPage, metadata: privacyMetadata },
  { url: '/terms', title: '利用規約', Page: TermsPage, metadata: termsMetadata },
];

describe.each(pages)('$url のページ (#1174)', ({ url, title, Page, metadata }) => {
  beforeEach(() => {
    document.body.innerHTML = renderToStaticMarkup(<Page />);
  });

  it('(main) グループの外にある (未ログインの人にアプリ用のナビを見せない)', () => {
    expect(existsSync(path.join(root, `src/app${url}/page.tsx`))).toBe(true);
    expect(existsSync(path.join(root, `src/app/(main)${url}`))).toBe(false);
  });

  it(`見出し (h1) に「${title}」が出る`, () => {
    const headings = document.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe(title);
  });

  it('ブラウザのタブ名にもページ名が出る (metadata.title)', () => {
    expect(metadata.title).toBe(title);
  });

  it('戻るリンクはトップ (/) を指し、設定画面 (/settings) を指さない', () => {
    const back = document.querySelector('header a');
    expect(back?.getAttribute('href')).toBe('/');
    // アイコンだけのリンクなので、スクリーンリーダー向けの名前を付ける
    expect(back?.getAttribute('aria-label')).toBeTruthy();
    expect(document.querySelector('a[href="/settings"]')).toBeNull();
  });

  it('本文は <main> の中にあり、条文の見出し (h3) が並ぶ', () => {
    const main = document.querySelector('main');
    expect(main).not.toBeNull();
    expect(main?.querySelectorAll('h3').length).toBeGreaterThan(0);
  });
});
