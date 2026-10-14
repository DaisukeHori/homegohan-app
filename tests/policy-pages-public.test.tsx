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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_DOCUMENTS, formatLegalEffectiveDate, type LegalDocumentType } from '@homegohan/shared';

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

const pages: Array<{
  url: string;
  title: string;
  type: LegalDocumentType;
  Page: () => React.JSX.Element;
  metadata: { title?: unknown };
}> = [
  { url: '/privacy', title: 'プライバシーポリシー', type: 'privacy_policy', Page: PrivacyPage, metadata: privacyMetadata },
  { url: '/terms', title: '利用規約', type: 'terms_of_service', Page: TermsPage, metadata: termsMetadata },
];

describe.each(pages)('$url のページ (#1174)', ({ url, title, type, Page, metadata }) => {
  beforeEach(() => {
    document.body.innerHTML = renderToStaticMarkup(<Page />);
  });

  it('版と施行日が、同意の記録に使う定数 (packages/shared の LEGAL_DOCUMENTS) から表示される', () => {
    const meta = document.querySelector('[data-testid="legal-document-meta"]');
    expect(meta).not.toBeNull();
    expect(meta?.textContent).toContain(LEGAL_DOCUMENTS[type].version);
    expect(meta?.textContent).toContain(formatLegalEffectiveDate(LEGAL_DOCUMENTS[type].effectiveDate));
  });

  it('版・施行日は <main> の先頭に出る (条文より前)', () => {
    const main = document.querySelector('main');
    expect(main?.firstElementChild?.getAttribute('data-testid')).toBe('legal-document-meta');
  });

  it('冒頭の版・施行日の行を、ページに直接書いていない (最終更新日の直書きに戻さない。改定のたびに定数 1 か所だけを直せばよい)', () => {
    const source = readFileSync(path.join(root, `src/app${url}/page.tsx`), 'utf8');
    expect(source).not.toMatch(/最終更新日/);
    expect(source).toContain('LegalDocumentMeta');
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
