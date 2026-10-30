/**
 * #2128 V1: 運営の画面のサイドバーのロールの札と、super_admin の見出し・リンク
 *
 * 以前の問題:
 *   - V1-1: /admin の全画面の左下 (サイドバーの下) に、ログイン中の運営自身のロールが英字の内部値 (super_admin など) の
 *     font-mono の札で出ていた。利用者の一覧・詳細 (admin/users) は #2120 W3 で表示名 (運営最上位・運営管理者など) になっており、
 *     同じ値が 2 通りに表示されていた
 *   - V1-2: /admin のサイドバーの見出し「super_admin」・リンク「super_admin コンソール」、/super-admin のサイドバーの見出し
 *     「Super Admin」が英字のまま。ロールの表示名「運営最上位」にそろえる (見出し「運営最上位」・リンク「運営最上位の画面」・
 *     /super-admin の見出し「運営最上位の画面」)。語は OPERATOR_ROLE_LABELS から引く
 *
 * 確かめること:
 *   - /admin のサイドバー: ロールの札は表示名 (title に内部の値・font-mono なし)。表に無い値は内部の値をそのまま出す
 *   - /admin のサイドバー: super_admin には見出し「運営最上位」とリンク「運営最上位の画面」(/super-admin) を出し、英字の super_admin は出さない
 *   - /super-admin のサイドバー: 見出しは「運営最上位の画面」で、英字の Super Admin / super_admin は出さない
 *   - /admin の入口のカード: /super-admin のカードの名前はサイドバーのリンクと同じ「運営最上位の画面」
 *   - 凍結のフォーム: 永久 BAN の選択肢の注記は「運営最上位のみ」
 *   - 同じ型: 運営の画面 (src/app/admin・src/app/super-admin・src/components/admin) のソースに、画面に出る文字として
 *     英字の super_admin / Super Admin が残っていない (ロールの判定に使う 'super_admin' そのものの文字列は除く)
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAllTags } from './helpers/strip-tags';

/** ログイン中の運営のロール (requireRoleForPage の結果) */
const session = vi.hoisted(() => ({ roles: ['super_admin'] as string[] }));

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
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// ロールの判定 (Supabase・MFA) はこのテストの対象ではないので、通った結果だけを返す
vi.mock('@/lib/auth/page-guard', () => ({
  requireRoleForPage: async () => ({
    id: 'operator-1',
    email: 'operator@example.com',
    roles: session.roles,
    assurance: null,
  }),
}));

const { default: AdminLayout } = await import('@/app/admin/layout');
const { default: SuperAdminLayout } = await import('@/app/super-admin/layout');
const { default: AdminHomePage } = await import('@/app/admin/page');
const { default: UserFreezeForm } = await import('@/components/admin/UserFreezeForm');

const ROOT = path.resolve(__dirname, '..');

beforeEach(() => {
  session.roles = ['super_admin'];
});

function mount(element: ReactElement) {
  document.body.innerHTML = renderToStaticMarkup(element);
}

/** 画面に出る文字 (タグを除く) */
function visibleText(selector: string): string {
  const html = document.querySelector(selector)?.innerHTML ?? '';
  return stripAllTags(html, ' ');
}

async function mountAdminLayout(...roles: string[]) {
  session.roles = roles;
  mount((await AdminLayout({ children: <p id="page-body">本文</p> })) as ReactElement);
}

/** /admin のサイドバーの下のロールの札 (メールアドレスの下の札) */
function roleBadges(): Array<{ text: string; title: string | null; className: string }> {
  return Array.from(document.querySelectorAll('aside > div:last-child .flex-wrap > span')).map((badge) => ({
    text: badge.textContent ?? '',
    title: badge.getAttribute('title'),
    className: badge.getAttribute('class') ?? '',
  }));
}

describe('/admin のサイドバー: ログイン中の運営のロールの札 (V1-1)', () => {
  it('super_admin は「運営最上位」の札で出し、title に内部の値。英字の super_admin は画面に出さない', async () => {
    await mountAdminLayout('super_admin');
    expect(roleBadges()).toEqual([{ text: '運営最上位', title: 'super_admin', className: expect.any(String) }]);
    expect(roleBadges()[0].className).not.toContain('font-mono');
    expect(visibleText('aside')).not.toContain('super_admin');
  });

  it('複数のロールはそれぞれ表示名で出す (admin・content_moderator)', async () => {
    await mountAdminLayout('admin', 'content_moderator');
    expect(roleBadges().map(({ text, title }) => ({ text, title }))).toEqual([
      { text: '運営管理者', title: 'admin' },
      { text: 'モデレーター', title: 'content_moderator' },
    ]);
    expect(visibleText('aside')).not.toMatch(/\badmin\b|content_moderator/);
  });

  it('表に無い値は内部の値をそのまま出す (運営が原因を追えるように)', async () => {
    await mountAdminLayout('admin', 'legacy_role');
    expect(roleBadges().map(({ text, title }) => ({ text, title }))).toEqual([
      { text: '運営管理者', title: 'admin' },
      { text: 'legacy_role', title: 'legacy_role' },
    ]);
  });
});

describe('/admin のサイドバー: super_admin の見出しとリンク (V1-2)', () => {
  it('super_admin には見出し「運営最上位」と、/super-admin へのリンク「運営最上位の画面」を出す', async () => {
    await mountAdminLayout('super_admin');
    const link = document.querySelector('aside nav a[href="/super-admin"]');
    expect(link?.textContent?.trim()).toBe('運営最上位の画面');
    const heading = link?.parentElement?.querySelector('p');
    expect(heading?.textContent?.trim()).toBe('運営最上位');
    expect(visibleText('aside nav')).not.toMatch(/super_admin|Super Admin/);
  });

  it('admin には見出しもリンクも出さない', async () => {
    await mountAdminLayout('admin');
    expect(document.querySelector('aside nav a[href="/super-admin"]')).toBeNull();
    expect(visibleText('aside nav')).not.toContain('運営最上位');
  });
});

describe('/super-admin のサイドバー (V1-2)', () => {
  it('見出しは「運営最上位の画面」で、英字の Super Admin / super_admin は出さない', async () => {
    mount((await SuperAdminLayout({ children: <p>本文</p> })) as ReactElement);
    const headerTexts = Array.from(document.querySelectorAll('aside > div:first-child p')).map((p) => p.textContent?.trim());
    expect(headerTexts[0]).toBe('運営最上位の画面');
    expect(visibleText('aside')).not.toMatch(/super_admin|Super Admin/);
  });
});

describe('/admin の入口のカード (V1-2 と同じ型)', () => {
  it('/super-admin のカードの名前はサイドバーのリンクと同じ「運営最上位の画面」で、英字の super_admin は出さない', async () => {
    session.roles = ['super_admin'];
    mount((await AdminHomePage()) as ReactElement);
    const card = document.querySelector('ul a[href="/super-admin"]');
    expect(card?.querySelector('h2')?.textContent?.trim()).toBe('運営最上位の画面');
    expect(card?.querySelector('p')?.textContent).toBe('プラン・機能パッケージ・クーポン・アプリログなど (運営最上位のみ)');
    expect(visibleText('ul')).not.toMatch(/super_admin|Super Admin/);
  });
});

describe('凍結のフォームの永久 BAN の注記 (V1-2 と同じ型)', () => {
  it('super_admin に出す永久 BAN の選択肢は「永久 BAN (運営最上位のみ)」', () => {
    mount(<UserFreezeForm userId="00000000-0000-4000-8000-000000000001" isBanned={false} isSuperAdmin />);
    const label = document.querySelector('input[value="permanent"]')?.closest('label');
    expect(label?.textContent?.trim()).toBe('永久 BAN (運営最上位のみ)');
    expect(visibleText('body')).not.toMatch(/super_admin|Super Admin/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 同じ型: 運営の画面のソースに、画面に出る文字として英字の super_admin / Super Admin が残っていない
// ─────────────────────────────────────────────────────────────────────────────

/** 調べる運営の画面 (#2128 の範囲) */
const SCANNED_DIRS = ['src/app/admin', 'src/app/super-admin', 'src/components/admin'];

/** 画面に出す文字としての英字の super_admin / Super Admin */
const ENGLISH_SUPER_ADMIN = /super_admin|super admin/i;

/** ロールの判定・ロールの一覧に使う、ロールの値そのものの文字列 (画面の文字ではない) */
const ROLE_VALUE = 'super_admin';

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * ソースの中の、画面に出うる文字 (JSX の文字・文字列・テンプレート文字列) のうち、英字の super_admin / Super Admin を含むもの。
 * コメントは構文木に入らないので見ない。import の指定子と、ロールの値そのものの文字列 ('super_admin') は除く
 */
function englishSuperAdminTexts(source: string, fileName: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Array<{ line: number; text: string }> = [];
  const add = (node: ts.Node, text: string) => {
    if (!ENGLISH_SUPER_ADMIN.test(text)) return;
    found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim() });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    // JSX の文字はそのまま画面に出るので、'super_admin' だけでも数える
    if (ts.isJsxText(node)) add(node, node.text);
    // 文字列は、ロールの値そのもの ('super_admin'。ロールの判定・一覧) を除く
    else if (ts.isStringLiteralLike(node)) {
      if (node.text !== ROLE_VALUE) add(node, node.text);
    }
    else if (ts.isTemplateExpression(node)) {
      add(node.head, node.head.text);
      for (const span of node.templateSpans) add(span.literal, span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('同じ型: 運営の画面のソースに英字の super_admin / Super Admin の表示が残っていない', () => {
  it('走査が機能している: 英字の見出し・注記を検出し、ロールの値そのものとコメントは数えない', () => {
    const sample = [
      "import x from '@/super_admin/x';",
      "const ok = roles.includes('super_admin');",
      '// super_admin のコメント',
      'const a = <p>super_admin</p>;',
      "const b = 'この画面を見る権限がありません (super_admin のみ)';",
      'const c = <p className="x">Super Admin</p>;',
      'const d = `永久 BAN (${note}) super_admin`;',
    ].join('\n');
    expect(englishSuperAdminTexts(sample, 'sample.tsx').map(({ line }) => line)).toEqual([4, 5, 6, 7]);
  });

  it('src/app/admin・src/app/super-admin・src/components/admin に、画面に出る英字の super_admin / Super Admin が無い', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(SCANNED_DIRS.length);
    const violations = files.flatMap((file) =>
      englishSuperAdminTexts(fs.readFileSync(file, 'utf8'), file).map(
        ({ line, text }) => `${path.relative(ROOT, file)}:${line} ${text}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
