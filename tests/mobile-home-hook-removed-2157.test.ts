// @vitest-environment node
//
// #2157 R4: アプリのホームは Web の画面の WebView (apps/mobile/app/(tabs)/home.tsx) で、
// アプリにはホームのデータを読むネイティブの hook (apps/mobile/src/hooks/useHomeData.ts) を置かない。
//
// その hook はアプリの画面 (apps/mobile/app・apps/mobile/src) のどこからも import されておらず、テストからしか使われていなかった。
// 残っていると、直しても利用者に届かない所に手間がかかり、コード・テスト・注がその hook を実在の経路として指す。
// ここでは次を固定する:
//   1. アプリのホームのタブは WebViewScreen で Web の /home を開く (ネイティブで描かない)
//   2. apps/mobile に useHomeData の hook のファイルが無く、アプリのコードとテストがそれを import / mock しない
//   3. コード・テスト・注 (設計書 docs/design と、適用済みで書き換えない supabase/migrations を除く) が、
//      無くなった apps/mobile/src/hooks/useHomeData.ts を指さない
// アプリにホームのデータが要るようになったら、ネイティブの画面と一緒に作り直し、この一覧を直すこと。

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** 無いことを固定する hook (リポジトリの根からの相対パス) */
const REMOVED_HOOK = 'apps/mobile/src/hooks/useHomeData.ts';

/** アプリのホームのタブ */
const HOME_TAB = 'apps/mobile/app/(tabs)/home.tsx';

/** アプリのコードとテストを置く場所 */
const MOBILE_DIRS = ['apps/mobile/app', 'apps/mobile/src', 'apps/mobile/__tests__', 'apps/mobile/__mocks__'] as const;

/**
 * 無くなった hook のパスを書いてはいけない場所。
 * docs/design は設計書 (別に直す)、supabase/migrations は適用済みで書き換えないので、ここでは見ない
 */
const NO_MENTION_DIRS = ['src', 'tests', 'packages', 'scripts', 'supabase/functions', 'apps/mobile', 'docs'] as const;
const NO_MENTION_SKIP_PATHS = new Set(['docs/design']);

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.expo', 'coverage']);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.sql', '.sh', '.yaml', '.yml']);

/** import / require / jest.mock / vi.mock で useHomeData の hook (どの場所のものでも) を指す指定 */
const HOOK_MODULE_SPECIFIER = /\b(?:from|require|mock|import)\s*\(?\s*["'`][^"'`]*\/hooks\/useHomeData["'`]/;

const SELF = path.relative(ROOT, __filename).split(path.sep).join('/');

function walk(relDir: string, out: string[]): void {
  const absDir = path.join(ROOT, relDir);
  if (!fs.existsSync(absDir)) return;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !NO_MENTION_SKIP_PATHS.has(rel)) walk(rel, out);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(rel);
    }
  }
}

function listFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) walk(dir, out);
  return [...new Set(out)].sort();
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('#2157 R4: アプリのホームは WebView で、使われていないネイティブの hook を置かない', () => {
  const mobileFiles = listFiles(MOBILE_DIRS);
  const mentionFiles = listFiles(NO_MENTION_DIRS);

  it('走査が空振りしていない (アプリのホームのタブと、Web のホームの hook を見つけている)', () => {
    expect(mobileFiles).toContain(HOME_TAB);
    expect(mentionFiles).toContain('src/hooks/useHomeData.ts');
    expect(mentionFiles).toContain(SELF);
  });

  it('アプリのホームのタブは WebViewScreen で Web の /home を開く', () => {
    const text = read(HOME_TAB);
    expect(text).toMatch(/<WebViewScreen\b[^>]*\bpath="\/home"/);
    expect(text).not.toMatch(/useHomeData/);
  });

  it('apps/mobile に useHomeData の hook のファイルが無い', () => {
    expect(fs.existsSync(path.join(ROOT, REMOVED_HOOK))).toBe(false);
    expect(mobileFiles.filter((rel) => /(^|\/)useHomeData\.[cm]?[jt]sx?$/.test(path.posix.basename(rel)))).toEqual([]);
  });

  it('アプリのコードとテストは useHomeData の hook を import・mock しない', () => {
    expect(mobileFiles.filter((rel) => HOOK_MODULE_SPECIFIER.test(read(rel)))).toEqual([]);
  });

  it('コード・テスト・注は、無くなった apps/mobile/src/hooks/useHomeData.ts を指さない', () => {
    expect(mentionFiles.filter((rel) => rel !== SELF && read(rel).includes(REMOVED_HOOK))).toEqual([]);
  });

  it('import を見る正規表現は、どの書き方でも hook の指定を拾う (検査の空振りを防ぐ)', () => {
    expect(HOOK_MODULE_SPECIFIER.test("import { useHomeData } from '../../src/hooks/useHomeData';")).toBe(true);
    expect(HOOK_MODULE_SPECIFIER.test("jest.mock('../../src/hooks/useHomeData', () => ({}));")).toBe(true);
    expect(HOOK_MODULE_SPECIFIER.test('const m = require("../hooks/useHomeData");')).toBe(true);
    expect(HOOK_MODULE_SPECIFIER.test("const m = await import('../hooks/useHomeData');")).toBe(true);
    expect(HOOK_MODULE_SPECIFIER.test("import { useV4MenuGeneration } from '../../src/hooks/useV4MenuGeneration';")).toBe(false);
  });
});
