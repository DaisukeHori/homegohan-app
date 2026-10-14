/**
 * 運営コンソールの入口と案内 (/admin, サイドバー, お知らせ管理・組織管理の入口)
 *
 * 従来の問題:
 *   /admin に page.tsx が無く、管理者 (admin / super_admin) がログインした直後の転送先も、
 *   サイドバーの「ダッシュボード」も 404 になっていた。お知らせ・組織の管理は API があるのに画面が無く、
 *   サポートチケット・売上・営業 CRM の画面はサイドバーから入れなかった。
 *
 * 修正後に確かめること:
 *   - /admin: ロールに応じたカードを出す (admin: モデレーション・ユーザー管理など / super_admin: それ + super_admin コンソール /
 *     content_moderator: モデレーションだけ)。ログインしていない人・入れないロールの人は /login へ送る
 *   - サイドバー: 組織管理・お知らせ・サポートチケット・売上・経理・営業 CRM が admin / super_admin に出て、
 *     content_moderator には出ない。サイドバーとカードは同じ機能を案内する
 *   - リンク先の画面がある (404 にならない)。管理者を /admin へ送る転送 (middleware) の先にも画面がある
 *   - お知らせ管理・組織管理: admin / super_admin だけが開ける。content_moderator は /login へ送る
 *   - 運営コンソールに入れるロール (layout.tsx) は広げていない。support / finance / sales は今まで通り入れない
 *
 * requireRole は本物を使い、Supabase のクライアントだけを差し替える (許可するロールの指定を、実際に判定させて確かめる)。
 * このリポジトリには @testing-library/react が無いため、react-dom/server で HTML にして jsdom で読む。
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveOnboardingRedirect } from '../lib/onboarding-routing';

/** ログイン中のユーザー (null = ログインしていない)。failure を入れると、認証の確認そのものが想定外の例外で失敗する */
const session = vi.hoisted(() => ({
  current: null as null | { roles: string[] },
  failure: null as null | Error,
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

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

// requireRole が使う Supabase クライアント: auth.getUser() と user_profiles の 1 行だけを返す
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => {
        if (session.failure) throw session.failure;
        return session.current
          ? { data: { user: { id: 'operator-1', email: 'operator@example.com' } }, error: null }
          : { data: { user: null }, error: { message: 'Auth session missing!' } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              roles: session.current?.roles ?? null,
              organization_id: null,
              frozen_at: null,
              unban_at: null,
            },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

const { default: AdminHomePage } = await import('@/app/admin/page');
const { default: AdminLayout } = await import('@/app/admin/layout');
const { default: AdminAnnouncementsPage } = await import('@/app/admin/announcements/page');
const { default: AnnouncementsManager } = await import('@/app/admin/announcements/AnnouncementsManager');
const { default: AdminOrganizationsPage } = await import('@/app/admin/organizations/page');
const { default: OrganizationsManager } = await import('@/app/admin/organizations/OrganizationsManager');

const ROOT = path.resolve(__dirname, '..');

/** admin / super_admin に出す機能 (モデレーション以外) */
const ADMIN_ONLY_SECTIONS = [
  '/admin/users',
  '/admin/organizations',
  '/admin/support',
  '/admin/finance',
  '/admin/sales',
  '/admin/announcements',
];

/** ロールごとの、サイドバーとカードに出る機能 (ダッシュボード = /admin を除く) */
const SECTIONS_BY_ROLE: Array<{ role: string; sections: string[] }> = [
  { role: 'admin', sections: [...ADMIN_ONLY_SECTIONS, '/admin/moderation'] },
  { role: 'super_admin', sections: [...ADMIN_ONLY_SECTIONS, '/admin/moderation', '/super-admin'] },
  { role: 'content_moderator', sections: ['/admin/moderation'] },
];

/** 運営コンソールに入れないロール (入れるロールを広げていないことの確認) */
const NON_CONSOLE_ROLES = ['user', 'support', 'finance', 'sales', 'org_admin'];

beforeEach(() => {
  session.current = null;
  session.failure = null;
});

function login(...roles: string[]) {
  session.current = { roles };
}

function mount(element: ReactElement) {
  document.body.innerHTML = renderToStaticMarkup(element);
}

const hrefs = (selector: string) =>
  Array.from(document.querySelectorAll(selector)).map((a) => a.getAttribute('href') ?? '');

/** 入口の画面 (カード) のリンク */
async function cardHrefs() {
  mount(await AdminHomePage());
  return hrefs('ul a');
}

/** サイドバーのメニューのリンク (ロゴへのリンクは含めない) */
async function sidebarHrefs() {
  mount(await AdminLayout({ children: <p id="page-body">本文</p> }));
  return hrefs('aside nav a');
}

const sorted = (values: string[]) => [...values].sort();

/** URL のパスに対応する page.tsx があるか (ルートグループを使わない画面だけを確かめる) */
const hasPage = (href: string) => fs.existsSync(path.join(ROOT, 'src/app', href, 'page.tsx'));

// ─────────────────────────────────────────────────────────────────────────────
// /admin
// ─────────────────────────────────────────────────────────────────────────────

describe('/admin (運営コンソールの入口)', () => {
  it('page.tsx がある (従来は無く、管理者のログイン直後の転送先が 404 だった)', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/app/admin/page.tsx'))).toBe(true);
  });

  it.each(SECTIONS_BY_ROLE)('$role には、使える機能のカードだけを出す', async ({ role, sections }) => {
    login(role);
    expect(sorted(await cardHrefs())).toEqual(sorted(sections));
  });

  it('content_moderator にはモデレーションだけを出す (ユーザー管理・組織管理・お知らせなどは出さない)', async () => {
    login('content_moderator');
    const links = await cardHrefs();
    expect(links).toEqual(['/admin/moderation']);
    expect(document.body.textContent).toContain('モデレーション');
    for (const label of ['ユーザー管理', '組織管理', 'お知らせ', 'サポートチケット', '売上・経理', '営業 CRM', 'super_admin']) {
      expect(document.body.textContent).not.toContain(label);
    }
  });

  it('admin には super_admin コンソールを出さない。super_admin には出す', async () => {
    login('admin');
    expect(await cardHrefs()).not.toContain('/super-admin');

    login('super_admin');
    expect(await cardHrefs()).toContain('/super-admin');
  });

  it('カードには機能名と説明を出し、見出し (h1) は「管理コンソール」', async () => {
    login('super_admin');
    await cardHrefs();
    expect(document.querySelector('h1')?.textContent).toBe('管理コンソール');
    const cards = Array.from(document.querySelectorAll('ul a'));
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.querySelector('h2')?.textContent?.trim(), `${card.getAttribute('href')} の機能名`).toBeTruthy();
      expect(card.querySelector('p')?.textContent?.trim(), `${card.getAttribute('href')} の説明`).toBeTruthy();
    }
  });

  it('ログインしていない人は /login へ送る', async () => {
    await expect(AdminHomePage()).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it.each(NON_CONSOLE_ROLES)('運営コンソールに入れないロール (%s) の人は /login へ送る', async (role) => {
    login(role);
    await expect(AdminHomePage()).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('認証の確認が想定外の理由で失敗したときは、/login へ送らず例外をそのまま投げる', async () => {
    login('admin');
    session.failure = new Error('supabase is down');
    await expect(AdminHomePage()).rejects.toThrow('supabase is down');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// サイドバー
// ─────────────────────────────────────────────────────────────────────────────

describe('サイドバー (admin/layout.tsx)', () => {
  it('admin / super_admin には、ダッシュボードと各機能へのリンクを出す', async () => {
    login('admin');
    expect(sorted(await sidebarHrefs())).toEqual(sorted(['/admin', ...ADMIN_ONLY_SECTIONS, '/admin/moderation']));

    login('super_admin');
    expect(sorted(await sidebarHrefs())).toEqual(
      sorted(['/admin', ...ADMIN_ONLY_SECTIONS, '/admin/moderation', '/super-admin']),
    );
  });

  it('組織管理・お知らせ・サポートチケット・売上・経理・営業 CRM のリンクを出す (admin)', async () => {
    login('admin');
    await sidebarHrefs();
    const labelOf = (href: string) => document.querySelector(`aside nav a[href="${href}"]`)?.textContent?.trim();
    expect(labelOf('/admin/organizations')).toBe('組織管理');
    expect(labelOf('/admin/announcements')).toBe('お知らせ');
    expect(labelOf('/admin/support')).toBe('サポートチケット');
    expect(labelOf('/admin/finance')).toBe('売上・経理');
    expect(labelOf('/admin/sales')).toBe('営業 CRM');
  });

  it('content_moderator には、モデレーションだけを出す (新しいリンクは出さない)', async () => {
    login('content_moderator');
    expect(await sidebarHrefs()).toEqual(['/admin/moderation']);
  });

  it('ページの本文 (children) を表示する', async () => {
    login('admin');
    await sidebarHrefs();
    expect(document.querySelector('main #page-body')?.textContent).toBe('本文');
  });

  it('ログインしていない人、運営コンソールに入れないロールの人は /login へ送る (入れるロールを広げていない)', async () => {
    await expect(AdminLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT:/login');
    for (const role of NON_CONSOLE_ROLES) {
      login(role);
      await expect(AdminLayout({ children: null }), `${role} が運営コンソールに入れてしまう`).rejects.toThrow(
        'NEXT_REDIRECT:/login',
      );
    }
  });
});

describe('サイドバーとカードは、同じ機能を案内する', () => {
  it.each(SECTIONS_BY_ROLE)('$role: サイドバー (ダッシュボードを除く) とカードのリンクが一致する', async ({ role }) => {
    login(role);
    const cards = await cardHrefs();
    const sidebar = (await sidebarHrefs()).filter((href) => href !== '/admin');
    expect(sorted(sidebar)).toEqual(sorted(cards));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// リンク先の画面
// ─────────────────────────────────────────────────────────────────────────────

describe('リンク先の画面がある (404 にならない)', () => {
  it.each(SECTIONS_BY_ROLE)('$role のサイドバーとカードのリンク先に page.tsx がある', async ({ role }) => {
    login(role);
    const links = new Set([...(await cardHrefs()), ...(await sidebarHrefs())]);
    expect(links.size).toBeGreaterThan(0);
    for (const href of links) {
      expect(hasPage(href), `${href} の画面 (src/app${href}/page.tsx) が無い`).toBe(true);
    }
  });

  it('管理者をコンソールへ送る転送 (middleware) の先に、画面がある', () => {
    const redirectPaths = ['/', '/home', '/onboarding/welcome'].map((pathname) =>
      resolveOnboardingRedirect({ pathname, roles: ['admin'] }),
    );
    expect(new Set(redirectPaths)).toEqual(new Set(['/admin']));
    for (const target of redirectPaths) {
      expect(hasPage(target as string), `${target} の画面が無い`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// お知らせ管理・組織管理の入口 (サーバー側のロール確認)
// ─────────────────────────────────────────────────────────────────────────────

describe.each([
  { path: '/admin/announcements', Page: AdminAnnouncementsPage, Body: AnnouncementsManager },
  { path: '/admin/organizations', Page: AdminOrganizationsPage, Body: OrganizationsManager },
])('$path の入口 (サーバー側のロール確認)', ({ Page, Body }) => {
  it.each(['admin', 'super_admin'])('%s は開ける (画面の本体を返す)', async (role) => {
    login(role);
    const element = (await Page()) as ReactElement;
    expect(element.type).toBe(Body);
  });

  it('content_moderator は開けない: 壊れた画面を見せず、/login へ送る', async () => {
    login('content_moderator');
    await expect(Page()).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('ログインしていない人は /login へ送る', async () => {
    await expect(Page()).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it.each(NON_CONSOLE_ROLES)('ほかのロール (%s) の人も /login へ送る', async (role) => {
    login(role);
    await expect(Page()).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('admin と content_moderator の両方を持つ人は開ける (admin を持っていれば足りる)', async () => {
    login('content_moderator', 'admin');
    const element = (await Page()) as ReactElement;
    expect(element.type).toBe(Body);
  });

  it('認証の確認が想定外の理由で失敗したときは、/login へ送らず例外をそのまま投げる', async () => {
    login('admin');
    session.failure = new Error('supabase is down');
    await expect(Page()).rejects.toThrow('supabase is down');
  });
});
