/**
 * 組織の画面のソースを走査するテストが共通で使う、走査の根 (#2073)
 *
 * 組織の画面は 2 か所にある:
 *   - src/app/(org): 組織の管理画面のルートグループ (枠 src/app/(org)/layout.tsx が owner / admin でない人を /home へ送る)
 *   - src/app/(main)/org: 管理画面の枠の外に置いた組織の画面 (オーナーの譲渡の承諾の画面 /org/transfer-accept/[proposal_id]。
 *     一般メンバーも開くので、ログインした利用者の枠 (main) に置く。#2068)
 *
 * #2068 で承諾の画面を (main)/org へ移したとき、走査の根を (org) に固定していたテストのうち 2 本
 * (tests/org-dashboard-subtitle-copy.test.tsx・tests/org-api-error-japanese.test.ts) が移った画面を見なくなった。
 * 根を各テストに書き写さず、ここの 1 つの定数から取る。URL が /org で始まる画面がどれもこの根の下にあることは
 * tests/org-screen-roots.test.ts が確かめる (組織の画面を 3 か所目に置いたら、そこで赤くなる)。
 */
import fs from 'node:fs';
import path from 'node:path';

/** リポジトリの根 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** App Router の根 (リポジトリの根からの相対) */
const APP_DIR = 'src/app';
/** API の route の根 (画面ではないので組織の画面の走査に入れない。/api/org は route 側の走査が見る) */
const API_DIR = 'src/app/api';
/** 組織の画面の URL の最初の区切り */
const ORG_URL_SEGMENT = 'org';

/** 組織の画面のソースの走査の根 (リポジトリの根からの相対) */
export const ORG_SCREEN_ROOTS: readonly string[] = ['src/app/(org)', 'src/app/(main)/org'];

/** ルートグループ ((name)) のセグメントか (URL に出ない) */
function isRouteGroup(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')');
}

/**
 * src/app の下 (API を除く) で、URL の最初の区切りが org になるディレクトリのうち、いちばん上のもの。
 * 例: src/app/(org)/org・src/app/(main)/org。ルートグループのセグメントは URL に出ないので数えない
 */
export function orgUrlTopDirs(): string[] {
  const found: string[] = [];
  const walk = (dir: string, visibleSegments: readonly string[]) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = path.posix.join(dir, entry.name);
      if (rel === API_DIR) continue;
      const visible = isRouteGroup(entry.name) ? visibleSegments : [...visibleSegments, entry.name];
      if (visible.length === 1 && visible[0] === ORG_URL_SEGMENT) {
        found.push(rel);
        continue;
      }
      // URL の最初の区切りが org 以外に決まったディレクトリの下は見ない
      if (visible.length === 0) walk(rel, visible);
    }
  };
  walk(APP_DIR, []);
  return found.sort();
}

/** file が根 root の下 (根そのものを含む) にあるか */
export function isUnderRoot(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}/`);
}
