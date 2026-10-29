// @vitest-environment node
/**
 * #2068 組織のオーナーの譲渡を一般メンバー (org_role = member) が承諾できなかった
 *
 * 承諾の画面 /org/transfer-accept/[proposal_id] (メールのリンクの行き先。src/lib/membership/urls.ts) が
 * 組織の管理画面のルートグループ src/app/(org)/ の下にあり、その枠 src/app/(org)/layout.tsx が
 * 組織の管理者 (owner / admin) でない人を /home へ送っていた。オーナーの譲渡の画面の候補には一般メンバーが入るので、
 * 譲渡先が一般メンバーだと承諾の画面を開けなかった。
 *
 * 直したあとは、承諾の画面を管理者の枠の外のルートグループ (家族の譲渡の承諾の画面と同じ src/app/(main)/) に置く。
 * URL は変えない (ルートグループの名前は URL に出ない)。ここではファイルの置き場から Next の App Router と同じ規則で
 * URL と枠 (layout) の並びを組み立てて確かめる:
 *   1. URL /org/transfer-accept/[proposal_id] に当たる画面はちょうど 1 つ (移した先と元が両方残ると next build が失敗する)
 *   2. その画面の枠に組織の管理画面の枠が入っていない (直す前はここが赤)
 *   3. その画面の枠は、家族の譲渡の承諾の画面と同じ (ログインした利用者の枠)
 *   4. /org の下のほかの画面は、どれも今までどおり組織の管理画面の枠の下にある (一般メンバーは /home へ送られる)
 * 描画 (一般メンバーが開ける・管理画面の部品が出ない・承諾のあとの遷移) は tests/org-transfer-accept-member-2068.test.tsx。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/** App Router の根 (リポジトリの根からの相対) */
const APP_DIR = 'src/app';
/** 画面・枠のファイルの拡張子 (Next が読むもの) */
const ROUTE_FILE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
/** 組織の管理画面の枠 (owner / admin でない人を /home へ送る) */
const ORG_ADMIN_LAYOUT = 'src/app/(org)/layout.tsx';
/** 組織のオーナーの譲渡の承諾の画面の URL (メールのリンクの行き先) */
const ORG_TRANSFER_ACCEPT_URL = '/org/transfer-accept/[proposal_id]';
/** 家族の代表者の譲渡の承諾の画面の URL (同じ型の画面。ログインした利用者の枠の下にある) */
const FAMILY_TRANSFER_ACCEPT_URL = '/family/transfer-accept/[proposal_id]';
/** 組織の管理画面の URL の頭 */
const ORG_URL_PREFIX = '/org';
/** 組織の管理画面として今ある画面 (走査が空振りしていないことの確かめに使う。足すのはよいが、ここにあるものは減らさない) */
const KNOWN_ORG_ADMIN_URLS = [
  '/org',
  '/org/dashboard',
  '/org/members',
  '/org/invites',
  '/org/departments',
  '/org/challenges',
  '/org/settings',
  '/org/settings/owner-transfer',
];

/** ルートグループ ((name)) のセグメントか (URL に出ない) */
function isRouteGroup(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')');
}

/** 名前 (拡張子を除く) が base のファイルがディレクトリにあれば、そのリポジトリの根からの相対パス */
function findRouteFile(dir: string, base: string): string | null {
  for (const extension of ROUTE_FILE_EXTENSIONS) {
    const rel = path.posix.join(dir, `${base}${extension}`);
    if (fs.existsSync(path.join(ROOT, rel))) return rel;
  }
  return null;
}

/** src/app の下の画面 (page.*) をすべて */
function listPages(): string[] {
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (ROUTE_FILE_EXTENSIONS.some((extension) => entry.name === `page${extension}`)) pages.push(rel);
    }
  };
  walk(APP_DIR);
  return pages.sort();
}

/** 画面のファイルが受け持つ URL (ルートグループのセグメントを除く) */
function urlOf(pageFile: string): string {
  const segments = path.posix.dirname(path.posix.relative(APP_DIR, pageFile)).split('/');
  const visible = segments.filter((segment) => segment !== '.' && segment !== '' && !isRouteGroup(segment));
  return `/${visible.join('/')}`;
}

/** 画面を包む枠 (layout.*) を外側から順に (src/app から画面のディレクトリまで) */
function layoutChain(pageFile: string): string[] {
  const segments = path.posix.dirname(path.posix.relative(APP_DIR, pageFile)).split('/').filter((s) => s !== '.');
  const chain: string[] = [];
  let dir = APP_DIR;
  const rootLayout = findRouteFile(dir, 'layout');
  if (rootLayout) chain.push(rootLayout);
  for (const segment of segments) {
    dir = path.posix.join(dir, segment);
    const layout = findRouteFile(dir, 'layout');
    if (layout) chain.push(layout);
  }
  return chain;
}

function pagesAt(url: string): string[] {
  return listPages().filter((page) => urlOf(page) === url);
}

describe('走査の仕組み', () => {
  it('ルートグループのセグメントは URL に出ない', () => {
    expect(urlOf('src/app/(org)/org/dashboard/page.tsx')).toBe('/org/dashboard');
    expect(urlOf('src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx')).toBe(FAMILY_TRANSFER_ACCEPT_URL);
    expect(urlOf('src/app/page.tsx')).toBe('/');
  });

  it('組織の管理画面のダッシュボードの枠には、根の枠と組織の管理画面の枠が外側から順に入る', () => {
    expect(layoutChain('src/app/(org)/org/dashboard/page.tsx')).toEqual(['src/app/layout.tsx', ORG_ADMIN_LAYOUT]);
  });
});

describe('#2068 組織のオーナーの譲渡の承諾の画面は、組織の管理画面の枠の外にある', () => {
  it('URL /org/transfer-accept/[proposal_id] に当たる画面はちょうど 1 つ', () => {
    expect(pagesAt(ORG_TRANSFER_ACCEPT_URL)).toHaveLength(1);
  });

  it('その画面の枠に、組織の管理画面の枠 (管理者でない人を /home へ送る) が入っていない', () => {
    const [page] = pagesAt(ORG_TRANSFER_ACCEPT_URL);
    expect(layoutChain(page)).not.toContain(ORG_ADMIN_LAYOUT);
  });

  it('その画面の枠は、家族の譲渡の承諾の画面と同じ (ログインした利用者の枠)', () => {
    const [orgPage] = pagesAt(ORG_TRANSFER_ACCEPT_URL);
    const [familyPage] = pagesAt(FAMILY_TRANSFER_ACCEPT_URL);
    expect(familyPage, '家族の譲渡の承諾の画面が見つからない').toBeDefined();
    expect(layoutChain(orgPage)).toEqual(layoutChain(familyPage));
    expect(layoutChain(orgPage)).toEqual(['src/app/layout.tsx', 'src/app/(main)/layout.tsx']);
  });

  it('/org の下のほかの画面は、どれも今までどおり組織の管理画面の枠の下にある', () => {
    const orgPages = listPages().filter((page) => {
      const url = urlOf(page);
      return (url === ORG_URL_PREFIX || url.startsWith(`${ORG_URL_PREFIX}/`)) && url !== ORG_TRANSFER_ACCEPT_URL;
    });
    const urls = orgPages.map(urlOf);
    for (const known of KNOWN_ORG_ADMIN_URLS) {
      expect(urls, `${known} の画面が見つからない (走査が空振りしている)`).toContain(known);
    }
    const outside = orgPages.filter((page) => !layoutChain(page).includes(ORG_ADMIN_LAYOUT));
    expect(outside).toEqual([]);
  });
});
