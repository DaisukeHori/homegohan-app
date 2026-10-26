/**
 * #2050: super_admin の画面へ、サイドバーから辿れること
 *
 * 以前は /super-admin/audit-logs (監査ログ閲覧) の画面と API があるのに、/super-admin のサイドバーにも /admin のサイドバーにも
 * 項目が無く、URL を知らないと開けなかった。#2036 で凍結の通知の結果が読めないときの文 (FREEZE_NOTIFICATION_UNKNOWN_MESSAGE) が
 * この画面を名指すようになったので、名指された人が画面へ辿れない。
 * 同じ型 (画面はあるのにサイドバーに無い) は、機能フラグ (/super-admin/flags)・A/B テスト (/super-admin/experiments)・
 * インフラ監視 (/super-admin/infra)・LLM 使用量 (/super-admin/llm) にもあった。
 * データエクスポート (/super-admin/exports) は未完成の機能なので、画面は 404 にしてサイドバーにも並べない (#1911)。
 *
 * ここでは layout を実際に描画し (ロールの判定だけ差し替える)、サイドバーのリンクを数える。
 *   - 監査ログ閲覧へのリンクがあり、名前は「監査ログ」
 *   - src/app/super-admin の直下の画面 (page.tsx) は、404 にしている画面を除き、すべてサイドバーから辿れる
 *   - サイドバーの /super-admin/... のリンク先には、すべて画面がある (404 にしていない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FREEZE_NOTIFICATION_AUDIT_LOGS_PATH } from '@/lib/admin/freeze-notification-status';
import { stripAllTags } from './helpers/strip-tags';

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

// ロールの判定 (Supabase・MFA) はこのテストの対象ではないので、super_admin が通った結果だけを返す
vi.mock('@/lib/auth/page-guard', () => ({
  requireRoleForPage: async () => ({
    id: 'super-admin-1',
    email: 'super-admin@example.com',
    roles: ['super_admin'],
    assurance: null,
  }),
}));

const { default: SuperAdminLayout } = await import('@/app/super-admin/layout');

const ROOT = path.resolve(__dirname, '..');
const SUPER_ADMIN_APP_DIR = path.join(ROOT, 'src/app/super-admin');
const SUPER_ADMIN_PATH_PREFIX = '/super-admin/';

/** 行コメントとブロックコメントを除いた本文 (コメントの中の語に一致させないため) */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** サイドバー (aside) のリンク。href と、タグを除いた文字 */
async function sidebarLinks(): Promise<Array<{ href: string; text: string }>> {
  const element = (await SuperAdminLayout({ children: <p>本文</p> })) as ReactElement;
  const html = renderToStaticMarkup(element);
  const aside = html.match(/<aside[\s\S]*?<\/aside>/)?.[0] ?? '';
  expect(aside).not.toBe('');
  return [...aside.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: m[1],
    text: stripAllTags(m[2]).trim(),
  }));
}

/** 画面の page.tsx が、開かれたら 404 にする (未完成の機能を画面に出さない。#1911) */
function isHiddenPage(pageFile: string): boolean {
  return /\bnotFound\(\)/.test(withoutComments(fs.readFileSync(pageFile, 'utf8')));
}

/** src/app/super-admin の直下の画面 (動的な段・route group を除く) の URL */
function topLevelPagePaths(): string[] {
  return fs
    .readdirSync(SUPER_ADMIN_APP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('[') && !entry.name.startsWith('('))
    .filter((entry) => fs.existsSync(path.join(SUPER_ADMIN_APP_DIR, entry.name, 'page.tsx')))
    .map((entry) => `${SUPER_ADMIN_PATH_PREFIX}${entry.name}`);
}

function pageFileOf(urlPath: string): string {
  return path.join(ROOT, 'src/app', urlPath, 'page.tsx');
}

describe('super_admin のサイドバー (#2050)', () => {
  it('監査ログ閲覧 (凍結の通知の結果が読めないときの文が名指す画面) へのリンクがあり、名前は「監査ログ」', async () => {
    const links = await sidebarLinks();
    const auditLogs = links.filter((link) => link.href === FREEZE_NOTIFICATION_AUDIT_LOGS_PATH);
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].text).toContain('監査ログ');
  });

  it('直下の画面は、404 にしている画面を除き、すべてサイドバーから辿れる', async () => {
    const hrefs = new Set((await sidebarLinks()).map((link) => link.href));
    const visiblePages = topLevelPagePaths().filter((urlPath) => !isHiddenPage(pageFileOf(urlPath)));
    // 一覧が空だと何も確かめないので、少なくとも監査ログ閲覧が数えられていること
    expect(visiblePages).toContain(FREEZE_NOTIFICATION_AUDIT_LOGS_PATH);
    expect(visiblePages.filter((urlPath) => !hrefs.has(urlPath))).toEqual([]);
  });

  it('同じ型の画面 (機能フラグ・A/B テスト・インフラ監視・LLM 使用量) もサイドバーにある', async () => {
    const links = await sidebarLinks();
    const textOf = (href: string) => links.find((link) => link.href === href)?.text;
    expect(textOf('/super-admin/flags')).toContain('機能フラグ');
    expect(textOf('/super-admin/experiments')).toContain('A/B テスト');
    expect(textOf('/super-admin/infra')).toContain('インフラ監視');
    expect(textOf('/super-admin/llm')).toContain('LLM 使用量');
  });

  it('サイドバーの /super-admin/... のリンク先には画面があり、404 にしている画面 (データエクスポート) は並べない', async () => {
    const superAdminHrefs = (await sidebarLinks())
      .map((link) => link.href)
      .filter((href) => href.startsWith(SUPER_ADMIN_PATH_PREFIX));
    expect(superAdminHrefs.length).toBeGreaterThan(0);
    for (const href of superAdminHrefs) {
      expect(fs.existsSync(pageFileOf(href)), href).toBe(true);
      expect(isHiddenPage(pageFileOf(href)), href).toBe(false);
    }
    expect(isHiddenPage(pageFileOf('/super-admin/exports'))).toBe(true);
    expect(superAdminHrefs).not.toContain('/super-admin/exports');
    // 同じ画面を 2 回並べない
    expect(new Set(superAdminHrefs).size).toBe(superAdminHrefs.length);
  });
});
