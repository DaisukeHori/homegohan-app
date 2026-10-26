// @vitest-environment node
/**
 * 組織の画面のソースの走査の根 (tests/helpers/org-screen-roots.ts の ORG_SCREEN_ROOTS) が、組織の画面を取りこぼさないことの見張り (#2073)
 *
 * 問題:
 *   #2068 でオーナーの譲渡の承諾の画面を src/app/(org) から src/app/(main)/org へ移したとき、走査の根を
 *   'src/app/(org)' に固定していたテスト 2 本 (tests/org-dashboard-subtitle-copy.test.tsx の ST-5・
 *   tests/org-api-error-japanese.test.ts の「画面が呼ぶ API は走査の対象の route に当たる」) が、移った画面を見なくなった。
 *   根を共通の定数 ORG_SCREEN_ROOTS にまとめ、ここで次を確かめる:
 *   1. URL が /org で始まる画面のディレクトリ (src/app の下・API を除く) は、どれも ORG_SCREEN_ROOTS のどれかの下にある
 *      (組織の画面を 3 か所目に置いたら、ここが赤くなる)
 *   2. ORG_SCREEN_ROOTS の根は、どれも実在し、組織の画面を 1 つ以上含む (使われていない根を残さない)
 *   3. tests の下で、組織の管理画面のルートグループ 'src/app/(org)' を走査の根として直に書いているのは共通の定数だけ
 *      (根を書き写したテストが、次に画面を移したときに取り残されないように)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_SCREEN_ROOTS, isUnderRoot, orgUrlTopDirs } from './helpers/org-screen-roots';

const ROOT = path.resolve(__dirname, '..');
/** 走査の根を定義している共通の定数のファイル */
const HELPER_FILE = 'tests/helpers/org-screen-roots.ts';
/** このテスト (見つけ方の確かめの見本に根の文字列を書いている) */
const SELF_FILE = 'tests/org-screen-roots.test.ts';
/** テストのソースのディレクトリ */
const TESTS_DIR = 'tests';
/** 組織の管理画面のルートグループの根を、文字列の値そのものとして書いたもの ('src/app/(org)'・"src/app/(org)"・`src/app/(org)`) */
const ORG_GROUP_ROOT_LITERAL = /(['"`])src\/app\/\(org\)\1/;

function listTestSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestSources(rel));
    else if (/\.(?:tsx?|jsx?)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe('組織の画面の走査の根 (ORG_SCREEN_ROOTS) が、組織の画面を取りこぼさない (#2073)', () => {
  const orgDirs = orgUrlTopDirs();

  it('URL が /org で始まる画面のディレクトリを集められている (管理画面と、枠の外に置いた承諾の画面の両方)', () => {
    expect(orgDirs).toEqual(expect.arrayContaining(['src/app/(org)/org', 'src/app/(main)/org']));
    expect(orgDirs).not.toContain('src/app/api/org');
  });

  it('URL が /org で始まる画面のディレクトリは、どれも ORG_SCREEN_ROOTS のどれかの下にある', () => {
    const uncovered = orgDirs.filter((dir) => !ORG_SCREEN_ROOTS.some((root) => isUnderRoot(dir, root)));
    expect(uncovered).toEqual([]);
  });

  it('ORG_SCREEN_ROOTS の根は、どれも実在し、組織の画面を 1 つ以上含む', () => {
    for (const root of ORG_SCREEN_ROOTS) {
      expect(fs.existsSync(path.join(ROOT, root)), root).toBe(true);
      expect(orgDirs.some((dir) => isUnderRoot(dir, root)), root).toBe(true);
    }
  });

  it("tests の下で 'src/app/(org)' を走査の根として直に書いているのは、共通の定数のファイルだけ (このテストの見本を除く)", () => {
    expect(listTestSources(TESTS_DIR)).toEqual(expect.arrayContaining([HELPER_FILE, SELF_FILE]));
    const copies = listTestSources(TESTS_DIR).filter(
      (file) => file !== HELPER_FILE && file !== SELF_FILE && ORG_GROUP_ROOT_LITERAL.test(fs.readFileSync(path.join(ROOT, file), 'utf8')),
    );
    expect(copies).toEqual([]);
  });

  it('根の文字列の見つけ方: 根そのものの文字列だけを数え、その下のファイルのパスやコメントの中の説明は数えない', () => {
    expect(ORG_GROUP_ROOT_LITERAL.test("const SCAN_ROOT = 'src/app/(org)';")).toBe(true);
    expect(ORG_GROUP_ROOT_LITERAL.test('listCodeFiles(["src/app/(org)", "src/app/api/org"])')).toBe(true);
    expect(ORG_GROUP_ROOT_LITERAL.test("read('src/app/(org)/org/members/page.tsx')")).toBe(false);
    expect(ORG_GROUP_ROOT_LITERAL.test(' * 組織の管理画面 (src/app/(org) 配下)')).toBe(false);
  });

  it('isUnderRoot は根そのものと根の下だけを含め、名前の頭が同じ別のディレクトリは含めない', () => {
    expect(isUnderRoot('src/app/(main)/org', 'src/app/(main)/org')).toBe(true);
    expect(isUnderRoot('src/app/(main)/org/transfer-accept', 'src/app/(main)/org')).toBe(true);
    expect(isUnderRoot('src/app/(main)/organizations', 'src/app/(main)/org')).toBe(false);
  });
});
