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
//   3. コード・テスト・注 (リポジトリの根の .md と根の lib を含む。設計書 docs/design と、適用済みで書き換えない supabase/migrations を除く) が、
//      無くなった apps/mobile/src/hooks/useHomeData.ts を指さない
//      (設計書は tests/design-doc-removed-mobile-screens.test.ts が見る。hook とそのテストは tests/helpers/mobile-removed-1598.ts の
//      REMOVED_MOBILE_SOURCE_FILES に載せたので、名指しする行は同じ行で消したことを書く)
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
 * 無くなった hook のパスを書いてはいけない場所 (リポジトリの根の .md は ROOT_MARKDOWN_EXTENSION で別に足す)。
 * supabase/migrations は適用済みで書き換えないので見ない
 */
const NO_MENTION_DIRS = ['src', 'tests', 'packages', 'scripts', 'supabase/functions', 'apps/mobile', 'docs', 'lib'] as const;
/**
 * NO_MENTION_DIRS の中で見ない場所。docs/design (設計書) は、1598 の見張り (tests/design-doc-removed-mobile-screens.test.ts) が
 * 消したファイルの名指しを見る (名指しする行は同じ行で消したことを書く。注記できない行は tests/helpers/design-doc-pending-notes-1598.ts の数)
 */
const NO_MENTION_SKIP_PATHS = new Set(['docs/design']);
/** リポジトリの根の文書 (CLAUDE.md・README.md など) の拡張子。根を丸ごと歩くと node_modules などに入るので、根の直下のこの拡張子のファイルだけを見る */
const ROOT_MARKDOWN_EXTENSION = '.md';

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.expo', 'coverage']);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.sql', '.sh', '.yaml', '.yml']);

/** import / require / jest.mock / vi.mock で useHomeData の hook (どの場所のものでも) を指す指定 */
const HOOK_MODULE_SPECIFIER = /\b(?:from|require|mock|import)\s*\(?\s*["'`][^"'`]*\/hooks\/useHomeData["'`]/;

const SELF = path.relative(ROOT, __filename).split(path.sep).join('/');

/**
 * 無くなった hook のパスを、名指しを捕まえる対象として持つ見張り (この見張りのほか)。
 * 1598 の見張りの書き方の検査と、設計書の注記できない名指しの数の一覧
 */
const WATCHERS_OF_REMOVED_HOOK = new Set([
  SELF,
  'tests/design-doc-removed-mobile-screens.test.ts',
  'tests/helpers/design-doc-pending-notes-1598.ts',
]);

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

/** リポジトリの根の直下の .md (サブディレクトリには入らない) */
function rootMarkdownFiles(): string[] {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name) === ROOT_MARKDOWN_EXTENSION)
    .map((entry) => entry.name);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('#2157 R4: アプリのホームは WebView で、使われていないネイティブの hook を置かない', () => {
  const mobileFiles = listFiles(MOBILE_DIRS);
  const mentionFiles = [...new Set([...listFiles(NO_MENTION_DIRS), ...rootMarkdownFiles()])].sort();

  it('走査が空振りしていない (アプリのホームのタブ・Web のホームの hook・根の文書・根の lib を見つけ、設計書は見ない)', () => {
    expect(mobileFiles).toContain(HOME_TAB);
    expect(mentionFiles).toContain('src/hooks/useHomeData.ts');
    expect(mentionFiles).toContain(SELF);
    // 見張りの許可は、いまあって無くなった hook のパスを持つファイルだけ (消えた・パスを持たなくなったファイルを許したまま残さない)
    expect([...WATCHERS_OF_REMOVED_HOOK].filter((rel) => !mentionFiles.includes(rel) || !read(rel).includes(REMOVED_HOOK))).toEqual([]);
    expect(mentionFiles).toContain('CLAUDE.md');
    expect(mentionFiles).toContain('lib/converter.ts');
    expect(mentionFiles.filter((rel) => rel.startsWith('docs/design/'))).toEqual([]);
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
    expect(mentionFiles.filter((rel) => !WATCHERS_OF_REMOVED_HOOK.has(rel) && read(rel).includes(REMOVED_HOOK))).toEqual([]);
  });

  it('import を見る正規表現は、どの書き方でも hook の指定を拾う (検査の空振りを防ぐ)', () => {
    expect(HOOK_MODULE_SPECIFIER.test("import { useHomeData } from '../../src/hooks/useHomeData';")).toBe(true);
    expect(HOOK_MODULE_SPECIFIER.test("jest.mock('../../src/hooks/useHomeData', () => ({}));")).toBe(true);
    expect(HOOK_MODULE_SPECIFIER.test('const m = require("../hooks/useHomeData");')).toBe(true);
    expect(HOOK_MODULE_SPECIFIER.test("const m = await import('../hooks/useHomeData');")).toBe(true);
    expect(HOOK_MODULE_SPECIFIER.test("import { useV4MenuGeneration } from '../../src/hooks/useV4MenuGeneration';")).toBe(false);
  });
});
