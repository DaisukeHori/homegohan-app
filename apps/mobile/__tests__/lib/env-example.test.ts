/**
 * #1049 F7-19: アプリのソースが読む EXPO_PUBLIC_* の環境変数が、すべて apps/mobile/env.example に書かれていることを確かめる。
 *
 * EXPO_PUBLIC_WEB_URL (WebView が開く Web の基点。src/lib/webBaseUrl.ts) が env.example に無く、
 * 開発者が変数の存在に気づけなかった (EXPO_PUBLIC_API_BASE_URL を変えても WebView の向き先は変わらない)。
 *
 * 読む変数は、ソース (app/ と src/) の `process.env.EXPO_PUBLIC_XXX` を拾う
 * (Metro がビルド時に値へ置き換えるのはこの書き方だけなので、ソースはこの形で読む。src/lib/env.ts の説明)。
 * コメントの中の例 (EXPO_PUBLIC_X など) は拾わない。env.example にはコメントアウトした例 (`# NAME=…`) でもよい。
 */

import fs from 'fs';
import path from 'path';

import { DEFAULT_WEB_URL } from '../../src/lib/webBaseUrl';

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SOURCE_DIRS = ['app', 'src'].map((dir) => path.join(MOBILE_ROOT, dir));
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** 行コメントとブロックコメントを外す (文字列の中の // は、このソースの読み方には出てこないので区別しない) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function envNamesReadBySource(): string[] {
  const names = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(dir)) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const match of code.matchAll(/process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g)) names.add(match[1]);
    }
  }
  return [...names].sort();
}

function envNamesInExample(): Set<string> {
  const example = fs.readFileSync(path.join(MOBILE_ROOT, 'env.example'), 'utf8');
  const names = new Set<string>();
  for (const match of example.matchAll(/^#?\s*(EXPO_PUBLIC_[A-Z0-9_]+)=/gm)) names.add(match[1]);
  return names;
}

describe('apps/mobile/env.example (#1049 F7-19)', () => {
  it('ソースが読む EXPO_PUBLIC_* を拾えている (拾い方が壊れて 0 件で通らないように)', () => {
    const names = envNamesReadBySource();
    expect(names).toEqual(expect.arrayContaining(['EXPO_PUBLIC_API_BASE_URL', 'EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_WEB_URL']));
    // コメントの中の例は拾わない
    expect(names).not.toContain('EXPO_PUBLIC_X');
    expect(names).not.toContain('EXPO_PUBLIC_XXX');
  });

  it('ソースが読む EXPO_PUBLIC_* が、すべて env.example に書かれている', () => {
    const inExample = envNamesInExample();
    const missing = envNamesReadBySource().filter((name) => !inExample.has(name));
    // 失敗したら、足した変数を env.example に書く (必須か任意か、無いと何が起きるか、既定値を添える)
    expect(missing).toEqual([]);
  });

  it('EXPO_PUBLIC_WEB_URL は代入の行 (コメントアウトでない) として 1 回だけ、既定と同じ Web の URL の例で書かれている', () => {
    const example = fs.readFileSync(path.join(MOBILE_ROOT, 'env.example'), 'utf8');
    const assignments = example.match(/^EXPO_PUBLIC_WEB_URL=.*$/gm) ?? [];
    expect(assignments).toEqual([`EXPO_PUBLIC_WEB_URL=${DEFAULT_WEB_URL}`]);
  });

  it('EXPO_PUBLIC_API_BASE_URL の例は、いまアプリが動いている Web の URL (既定の Web と同じ。#1573)', () => {
    // 以前は https://homegohan.com と書いていたが、homegohan.com はサイトを移すまで別のサービスを指している
    const example = fs.readFileSync(path.join(MOBILE_ROOT, 'env.example'), 'utf8');
    const assignments = example.match(/^EXPO_PUBLIC_API_BASE_URL=.*$/gm) ?? [];
    expect(assignments).toEqual([`EXPO_PUBLIC_API_BASE_URL=${DEFAULT_WEB_URL}`]);
  });

  it('同じ変数を 2 回代入しない (後の行が前の行を黙って上書きする)', () => {
    const example = fs.readFileSync(path.join(MOBILE_ROOT, 'env.example'), 'utf8');
    const names = [...example.matchAll(/^(EXPO_PUBLIC_[A-Z0-9_]+)=/gm)].map((match) => match[1]);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });
});
