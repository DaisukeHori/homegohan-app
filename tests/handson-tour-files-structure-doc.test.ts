/**
 * #1659 ハンズオンツアーのファイル構成の設計書 (16-files-structure.md) と、apps/mobile/src/handson-tour/ の実ファイルの突き合わせ
 *
 * §1.3 (Mobile 実装の表) と §5 (ディレクトリ全体図の木) に載っていないファイルが足されると、設計書が「いまの構成」でなくなる
 * (#1625・#1635・#1642 で 4 ファイル、#1660 で 2 ファイルが、表にも木にも載らないまま足された)。ここで落とす。
 *   1. apps/mobile/src/handson-tour/ の直下のファイルは、すべて §1.3 の表に `apps/mobile/src/handson-tour/<名前>` として載っている
 *   2. 同じファイルは、すべて §5 の木の apps/mobile/ → src/ → handson-tour/ の下に載っている
 *   3. 逆に、§1.3 の表と §5 の木が apps/mobile/src/handson-tour/ の下に名指しするファイルは、すべて実在する
 * 行数 (表の右の列) は見積もりと書き足した時点の実数なので突き合わせない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const DESIGN_DOC = 'docs/design/family/09-onboarding-handson-tour/16-files-structure.md';
/** 突き合わせるディレクトリ (リポジトリの根からの相対) */
const TOUR_DIR = 'apps/mobile/src/handson-tour';

/** §1.3 の見出し (この行から次の見出しの手前までを §1.3 とみなす) */
const TABLE_HEADING = '### 1.3 Mobile 実装';
/** §5 の見出し (この行のあとの最初のコードブロックが木) */
const TREE_HEADING = '## 5. ディレクトリ全体図';
/** 次の見出し (§1.3 の終わりを探す) */
const NEXT_HEADING = /^#{1,3} /m;
/** 見出しのあとの最初のコードブロック */
const CODE_FENCE = /```\n([\s\S]*?)\n```/;
/** 表の行の最初の列のパス (`apps/mobile/src/handson-tour/<名前>`) */
const TABLE_PATH = /^\|\s*`([^`]+)`/;
/** 木の行: 字下げ (4 文字ずつ) + 枝 + 名前 (最初の空白の手前まで) */
const TREE_LINE = /^((?:│ {3}| {4})*)[├└]── (\S+)/;
/** 木の字下げ 1 段の幅 (`│   ` / 空白 4 つ) */
const TREE_INDENT_WIDTH = 4;

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** 見出しから次の見出しの手前まで */
function sectionAfter(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  if (start < 0) throw new Error(`${DESIGN_DOC} に「${heading}」が無い`);
  const rest = doc.slice(start + heading.length);
  const next = NEXT_HEADING.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** §1.3 の表が TOUR_DIR の直下に名指しするファイル名 */
function tableFiles(doc: string): string[] {
  return sectionAfter(doc, TABLE_HEADING)
    .split('\n')
    .map((line) => TABLE_PATH.exec(line)?.[1])
    .filter((p): p is string => p !== undefined && path.posix.dirname(p) === TOUR_DIR)
    .map((p) => path.posix.basename(p));
}

/** §5 の木の行を、根 (最初の行) からのパスに直して並べる */
function treePaths(doc: string): string[] {
  const start = doc.indexOf(TREE_HEADING);
  if (start < 0) throw new Error(`${DESIGN_DOC} に「${TREE_HEADING}」が無い`);
  const fence = CODE_FENCE.exec(doc.slice(start));
  if (!fence) throw new Error(`${DESIGN_DOC} §5 に木のコードブロックが無い`);
  const stack: string[] = [];
  const paths: string[] = [];
  for (const line of fence[1].split('\n')) {
    const match = TREE_LINE.exec(line);
    if (!match) continue;
    const depth = match[1].length / TREE_INDENT_WIDTH;
    stack.length = depth;
    stack.push(match[2].replace(/\/$/, ''));
    paths.push(stack.join('/'));
  }
  return paths;
}

/** §5 の木が TOUR_DIR の直下に名指しするファイル名 */
function treeFiles(doc: string): string[] {
  return treePaths(doc)
    .filter((p) => path.posix.dirname(p) === TOUR_DIR)
    .map((p) => path.posix.basename(p));
}

/** TOUR_DIR の直下の実ファイル */
const actualFiles = fs
  .readdirSync(path.join(ROOT, TOUR_DIR), { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();

describe('#1659 16-files-structure.md は apps/mobile/src/handson-tour/ のいまのファイルをすべて載せる', () => {
  it('apps/mobile/src/handson-tour/ にファイルがある', () => {
    expect(actualFiles.length).toBeGreaterThan(0);
  });

  it('§1.3 の表は、実ファイルをすべて載せ、実在しないファイルを載せない', () => {
    expect([...tableFiles(read(DESIGN_DOC))].sort()).toEqual(actualFiles);
  });

  it('§5 の木は、apps/mobile/src/handson-tour/ の下に実ファイルをすべて載せ、実在しないファイルを載せない', () => {
    expect([...treeFiles(read(DESIGN_DOC))].sort()).toEqual(actualFiles);
  });

  it('木の読み方: apps/mobile/ → src/ → handson-tour/ の入れ子をパスに直せる (#1660 のファイルを含む)', () => {
    const paths = treePaths(read(DESIGN_DOC));
    expect(paths).toContain(`${TOUR_DIR}/tour-bubbles.ts`);
    expect(paths).toContain(`${TOUR_DIR}/menu-tour-profile.ts`);
    // Web 側の src/components/handson-tour/ と取り違えない
    expect(paths).toContain('src/components/handson-tour/TourOverlay.tsx');
  });
});
