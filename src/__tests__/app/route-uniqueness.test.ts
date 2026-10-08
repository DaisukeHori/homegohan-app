// src/__tests__/app/route-uniqueness.test.ts
// App Router のルートグループ ((main) や (org) など) は URL に現れない。そのため
// (main)/org/page.tsx と (org)/org/page.tsx のように、別のルートグループに同じ URL の
// page.tsx / route.ts を置くと next build が失敗する。
// #1143 で /org の旧スタブ画面を (org) 側の入口に置き換えたとき、この衝突が起きないことを確かめる。
// next build は遅く、ローカルでは回さないことも多いので、ファイルの配置だけをここで先に検査する。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = path.resolve(__dirname, '../../app');
const ROUTE_FILE = /^(page|route)\.(tsx|ts|jsx|js)$/;

function collectRouteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectRouteFiles(full));
    } else if (ROUTE_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** page.tsx / route.ts があるフォルダ (src/app からの相対パス) を、実際の URL にする。ルーティング対象外なら null */
function toUrl(relativeDir: string): string | null {
  const segments = relativeDir === '' ? [] : relativeDir.split(path.sep);
  // `_` で始まるフォルダ (private folder) はルーティングの対象外
  if (segments.some((segment) => segment.startsWith('_'))) return null;
  // `(group)` は URL に現れない
  return '/' + segments.filter((segment) => !/^\(.+\)$/.test(segment)).join('/');
}

/** URL → その URL を返す page / route ファイル (src/app からの相対パス) */
function mapUrlsToFiles(): Map<string, string[]> {
  const byUrl = new Map<string, string[]>();
  for (const file of collectRouteFiles(APP_DIR)) {
    const url = toUrl(path.relative(APP_DIR, path.dirname(file)));
    if (url === null) continue;
    byUrl.set(url, [...(byUrl.get(url) ?? []), path.relative(APP_DIR, file)]);
  }
  return byUrl;
}

describe('src/app: 同じ URL を返す page.tsx / route.ts は 1 つだけ (#1143)', () => {
  const byUrl = mapUrlsToFiles();

  it('page / route が見つかること (前提条件)', () => {
    expect(byUrl.size).toBeGreaterThan(0);
    expect(byUrl.has('/')).toBe(true);
  });

  it('ルートグループを外した URL が、別のファイルと重ならないこと', () => {
    const duplicates = [...byUrl.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([url, files]) => ({ url, files }));
    expect(duplicates).toEqual([]);
  });
});
