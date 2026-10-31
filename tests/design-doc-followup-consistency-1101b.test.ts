// @vitest-environment node
/**
 * #1139 (docs-1101b) の記録の古さの直しで、設計書の中の数・いまの版・行番号の指し先が実物と食い違わないことの contract テスト (ソース走査)
 *
 * docs-1101b の直し (design-doc.patch) の審査 R1 で、古さを直す直しそのものが新しい食い違いを作っていた:
 *  1. cross/20 §7 の PRIVACY_PROCESSORS に Apple を足して 11 社にしたのに、§11.2 の状態比較表と §15 の新設一覧が「10 社」のまま
 *  2. cross/20 §9.1 の LEGAL_DOCUMENTS を v2026.4 にしたのに、§15 の版の行が「いまの版は `v2026.3`」のまま
 *  3. mobile/08 に 3 行を足して行がずれたのに、cross/21 §17 の追随表の mobile/08 の行が「(行 345)」「(行 633」「行 2182」の
 *     行番号で指したままで、ずれた先はレート制限の行・空行・別のテストの行になっていた
 *
 * ここでは次を確かめる (どれも直す前の設計書 (このブランチの docs) でも、直したあとの設計書でも成り立ち、上の 3 つだけを落とす):
 *  A. cross/20 の「`PRIVACY_PROCESSORS` N 社」「`PRIVACY_PROCESSORS` (N 社」の N は、§7 の正典コードの PRIVACY_PROCESSORS の
 *     行 (`name: '…'`) の数と同じ
 *  B. cross/20 の「いまの版は `vX`」「いまの版 (`vX`)」の vX は、§9 の正典コードの LEGAL_DOCUMENTS の privacy_policy の version と同じ
 *  C. cross/21 §17 の追随表で設計書 (docs/design/…) を行番号 (「行 N」) で指すなら、その行は名指しの中身を持つ:
 *     「`<path>` の行」は `| \`<path>\`` で始まる行、「状態比較表の<X>の行」は `| <X> |` で始まる行、
 *     「§N」は §N の節の中の空でない行。名指しがこの 3 つの形のどれでもない行番号の参照は、それ自体を赤にする (名前で指す)
 *
 * 限界: A・B は改定履歴の節 (## N. 改定履歴 から後) と正典コードの囲みの中を見ない (履歴は当時の値を書くため)。
 * A は「`PRIVACY_PROCESSORS`」に続けて数を書いた形だけを見る (「委託先の表の N 行」のように名前を書かない数は見ない)。
 * C は cross/21 §17 の表だけを見る (ほかの冊の行番号の参照と、root の CLAUDE.md など設計書でない文書への参照は見ない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const TERMS_PRIVACY_DOC = 'docs/design/cross/20-terms-privacy-text.md';
const RECIPE_AUTHOR_DOC = 'docs/design/cross/21-recipe-author-display-name.md';
/** cross/21 の他の文書への追随表の節の番号 (## 17. 他の文書への追随表) */
const RECIPE_AUTHOR_FOLLOWUP_SECTION = 17;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** 「## N. 」の節の行 (見出しの行を含む。次の「## 」の見出しの手前まで) */
function sectionLines(lines: readonly string[], sectionNumber: number): string[] {
  const start = lines.findIndex((line) => line.startsWith(`## ${sectionNumber}. `));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))];
}

/** 改定履歴の節 (「## N. 改定履歴」) より前で、コードの囲みの外の行 (「行番号: 本文」) */
function proseLinesBeforeHistory(lines: readonly string[]): Array<{ line: number; text: string }> {
  const result: Array<{ line: number; text: string }> = [];
  let inFence = false;
  for (const [index, text] of lines.entries()) {
    if (/^## \d+\. 改定履歴/.test(text)) break;
    if (text.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) result.push({ line: index + 1, text });
  }
  return result;
}

/** 正典コードの「export const PRIVACY_PROCESSORS」から「];」までの `name: '…'` の数 (無ければ undefined) */
function processorCountInCanon(lines: readonly string[]): number | undefined {
  const start = lines.findIndex((line) => line.startsWith('export const PRIVACY_PROCESSORS'));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('];'));
  if (end < 0) return undefined;
  return rest.slice(0, end).filter((line) => /^\s*name: '/.test(line)).length;
}

/** 「`PRIVACY_PROCESSORS` N 社」「`PRIVACY_PROCESSORS` (N 社」の N が正典コードの数と違う行 (「:行 N 社」の形) */
function mismatchedProcessorCounts(doc: string): string[] {
  const lines = doc.split('\n');
  const canonCount = processorCountInCanon(lines);
  if (canonCount === undefined) return ['正典コードに PRIVACY_PROCESSORS が無い'];
  return proseLinesBeforeHistory(lines).flatMap(({ line, text }) =>
    [...text.matchAll(/`PRIVACY_PROCESSORS` \(?(\d+) 社/g)]
      .filter(([, count]) => Number(count) !== canonCount)
      .map(([, count]) => `:${line} ${count} 社 (正典コードは ${canonCount} 社)`),
  );
}

/** 正典コードの LEGAL_DOCUMENTS の privacy_policy の version (無ければ undefined) */
function canonPrivacyVersion(doc: string): string | undefined {
  return /^ {2}privacy_policy: \{ version: '([^']+)'/m.exec(doc)?.[1];
}

/** 「いまの版は `vX`」「いまの版 (`vX`)」の vX が正典コードの版と違う行 (「:行 vX」の形) */
function mismatchedCurrentVersions(doc: string): string[] {
  const canonVersion = canonPrivacyVersion(doc);
  if (canonVersion === undefined) return ['正典コードに LEGAL_DOCUMENTS の privacy_policy が無い'];
  return proseLinesBeforeHistory(doc.split('\n')).flatMap(({ line, text }) =>
    [...text.matchAll(/いまの版(?:は |\s?\()`([^`]+)`/g)]
      .filter(([, version]) => version !== canonVersion)
      .map(([, version]) => `:${line} ${version} (正典コードは ${canonVersion})`),
  );
}

/** 括弧の外の「・」で区切る (括弧の中の「・」では区切らない) */
function splitTopLevelItems(cell: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of cell) {
    if (char === '(' || char === '（') depth += 1;
    if (char === ')' || char === '）') depth = Math.max(0, depth - 1);
    if (char === '・' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items;
}

/** 行の位置 (0 始まり) の直前の見出しの行 (無ければ空文字) */
function headingBefore(lines: readonly string[], index: number): string {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (/^#{2,6} /.test(lines[cursor])) return lines[cursor];
  }
  return '';
}

/** 名指し (行番号の前の語) が行番号の先の行と合うか。合わない・名指しの形が分からないときは理由を返す */
function anchorProblem(descriptor: string, targetLines: readonly string[], lineNumber: number): string | undefined {
  const target = targetLines[lineNumber - 1];
  if (target === undefined) return `行 ${lineNumber} は冊の外`;
  const pathAnchor = /`([^`]+)` の行$/.exec(descriptor);
  if (pathAnchor) {
    return target.startsWith(`| \`${pathAnchor[1]}\``) ? undefined : `行 ${lineNumber} は \`${pathAnchor[1]}\` の行ではない`;
  }
  const comparisonRow = /状態比較表の(.+)の行$/.exec(descriptor);
  if (comparisonRow) {
    return target.startsWith(`| ${comparisonRow[1]} |`) ? undefined : `行 ${lineNumber} は ${comparisonRow[1]} の行ではない`;
  }
  const sectionAnchor = /^§(\d+(?:\.\d+)*)$/.exec(descriptor);
  if (sectionAnchor) {
    const heading = headingBefore(targetLines, lineNumber - 1);
    const inSection = new RegExp(`^#{2,6} ${sectionAnchor[1].replace(/\./g, '\\.')}[. ]`).test(heading);
    return inSection && target.trim() !== '' ? undefined : `行 ${lineNumber} は §${sectionAnchor[1]} の中身の行ではない`;
  }
  return `「${descriptor}」は名指しの形が分からない (行番号ではなく名前で指す)`;
}

/** 追随表の行の 1 列目の設計書のパス (「同」は直前の行のパス) */
function followupRowDoc(firstCell: string, previous: string | undefined): string | undefined {
  if (firstCell === '同') return previous;
  return /^`(docs\/design\/[^`]+\.md)`$/.exec(firstCell)?.[1];
}

/** cross/21 §17 の追随表で、設計書を行番号で指す参照のうち、指し先が名指しと合わないもの (「:行 パス 理由」の形) */
function brokenFollowupLineRefs(doc: string, readDoc: (rel: string) => string): string[] {
  const lines = doc.split('\n');
  const section = sectionLines(lines, RECIPE_AUTHOR_FOLLOWUP_SECTION);
  const sectionStart = lines.indexOf(section[0] ?? '');
  const problems: string[] = [];
  let previousDoc: string | undefined;
  for (const [offset, text] of section.entries()) {
    if (!text.startsWith('| ')) continue;
    const cells = text.split(' | ').map((cell) => cell.replace(/^\| /, '').trim());
    const targetDoc = followupRowDoc(cells[0] ?? '', previousDoc);
    previousDoc = targetDoc ?? (cells[0] === '同' ? previousDoc : undefined);
    if (!targetDoc || cells.length < 2) continue;
    const targetLines = readDoc(targetDoc).split('\n');
    for (const item of splitTopLevelItems(cells[1])) {
      const refs = [...item.matchAll(/行 (\d+)/g)].map((match) => Number(match[1]));
      if (refs.length === 0) continue;
      const descriptor = item.split(/\s?\(/)[0].trim();
      for (const lineNumber of refs) {
        const problem = anchorProblem(descriptor, targetLines, lineNumber);
        if (problem) problems.push(`:${sectionStart + offset + 1} ${targetDoc} ${problem}`);
      }
    }
  }
  return problems;
}

describe('A. cross/20: 「`PRIVACY_PROCESSORS` N 社」の N は §7 の正典コードの行の数と同じ', () => {
  const canon = ['```ts', 'export const PRIVACY_PROCESSORS: readonly PrivacyProcessor[] = [', "  {", "    name: 'A',", '  },', "  {", "    name: 'B',", '  },', '];', '```'];

  it('判定の見つけ方: 数が違う行を見つけ、同じ行・履歴の節・括弧つきの形を見分ける', () => {
    const doc = [
      ...canon,
      '| 委託先 | 無い | `PRIVACY_PROCESSORS` 2 社 |',
      '| 定数 | `PRIVACY_PROCESSORS` (1 社。#1930) |',
      '## 19. 改定履歴',
      '| v1.0 | `PRIVACY_PROCESSORS` を 1 社に直した (`PRIVACY_PROCESSORS` 1 社) |',
    ].join('\n');
    expect(mismatchedProcessorCounts(doc)).toEqual([':12 1 社 (正典コードは 2 社)']);
  });

  it('判定の見つけ方: 正典コードが無ければ赤', () => {
    expect(mismatchedProcessorCounts('| 委託先 | `PRIVACY_PROCESSORS` 2 社 |')).toEqual(['正典コードに PRIVACY_PROCESSORS が無い']);
  });

  it('cross/20 の数の宣言は、すべて §7 の正典コードの PRIVACY_PROCESSORS の行の数と同じ', () => {
    expect(mismatchedProcessorCounts(read(TERMS_PRIVACY_DOC))).toEqual([]);
  });

  it('cross/20 は数の宣言を少なくとも 1 つ持つ (宣言の形が変わって検査が空にならない)', () => {
    const declarations = proseLinesBeforeHistory(read(TERMS_PRIVACY_DOC).split('\n')).filter(({ text }) =>
      /`PRIVACY_PROCESSORS` \(?\d+ 社/.test(text),
    );
    expect(declarations.length).toBeGreaterThan(0);
  });
});

describe('B. cross/20: 「いまの版は `vX`」の vX は §9 の正典コードの LEGAL_DOCUMENTS の版と同じ', () => {
  const canon = ['```ts', 'export const LEGAL_DOCUMENTS = {', "  terms_of_service: { version: 'v9.2', effectiveDate: '2026-01-02' },", "  privacy_policy: { version: 'v9.2', effectiveDate: '2026-01-02' },", '};', '```'];

  it('判定の見つけ方: 版が違う行を見つけ、同じ行・括弧の形・履歴の節を見分ける', () => {
    const doc = [
      ...canon,
      '| 版 | `effectiveDate` を公開日 (いまの版は `v9.1`。§9.1) |',
      '5. `LEGAL_DOCUMENTS` のいまの版 (`v9.2`) と全文を確認',
      '## 19. 改定履歴',
      '| v1.0 | いまの版は `v9.0` だった |',
    ].join('\n');
    expect(mismatchedCurrentVersions(doc)).toEqual([':7 v9.1 (正典コードは v9.2)']);
  });

  it('判定の見つけ方: 正典コードが無ければ赤', () => {
    expect(mismatchedCurrentVersions('いまの版は `v9.1`')).toEqual(['正典コードに LEGAL_DOCUMENTS の privacy_policy が無い']);
  });

  it('cross/20 の「いまの版」は、すべて正典コードの LEGAL_DOCUMENTS の版と同じ', () => {
    expect(mismatchedCurrentVersions(read(TERMS_PRIVACY_DOC))).toEqual([]);
  });

  it('cross/20 は「いまの版」の文を少なくとも 1 つ持つ (文の形が変わって検査が空にならない)', () => {
    const statements = proseLinesBeforeHistory(read(TERMS_PRIVACY_DOC).split('\n')).filter(({ text }) =>
      /いまの版(?:は |\s?\()`[^`]+`/.test(text),
    );
    expect(statements.length).toBeGreaterThan(0);
  });
});

describe('C. cross/21 §17: 設計書を行番号で指すなら、その行は名指しの中身を持つ', () => {
  const target = [
    '# 冊',
    '### 7.2 状態比較表',
    '| プライバシーポリシー | 前 | 後 |',
    '### 9.6 プライバシーポリシー',
    '本文',
    '',
    '| `tests/x.test.ts` (段 D) | T-35 |',
    '| レート制限 | 22 種 |',
  ].join('\n');
  const readTarget = (): string => target;
  const followup = (cell: string): string =>
    ['## 17. 他の文書への追随表', '| 文書 | 箇所 | 直す中身 | 期日 |', '|---|---|---|---|', `| \`docs/design/x.md\` | ${cell} | 直す | 同日 |`, '## 18. 次'].join('\n');

  it('判定の見つけ方: 名指しと合う行番号は通す', () => {
    const cell = '§7.2 の状態比較表のプライバシーポリシーの行 (行 3)・§9.6 (行 5。注)・§14.2 の `tests/x.test.ts` の行 (T-35 の数。行 7)';
    expect(brokenFollowupLineRefs(followup(cell), readTarget)).toEqual([]);
  });

  it('判定の見つけ方: 行がずれて別の行・空行を指すと赤', () => {
    const cell = '§7.2 の状態比較表のプライバシーポリシーの行 (行 8)・§9.6 (行 6)・§14.2 の `tests/x.test.ts` の行 (行 8)';
    expect(brokenFollowupLineRefs(followup(cell), readTarget)).toEqual([
      ':4 docs/design/x.md 行 8 は プライバシーポリシー の行ではない',
      ':4 docs/design/x.md 行 6 は §9.6 の中身の行ではない',
      ':4 docs/design/x.md 行 8 は `tests/x.test.ts` の行ではない',
    ]);
  });

  it('判定の見つけ方: 名指しの形が分からない行番号の参照と、冊の外の行番号は赤。名前だけの参照は見ない', () => {
    expect(brokenFollowupLineRefs(followup('冒頭の文 (行 1)・§11.8 (d) (主張の表)'), readTarget)).toEqual([
      ':4 docs/design/x.md 「冒頭の文」は名指しの形が分からない (行番号ではなく名前で指す)',
    ]);
    expect(brokenFollowupLineRefs(followup('§9.6 (行 99)'), readTarget)).toEqual([':4 docs/design/x.md 行 99 は冊の外']);
  });

  it('cross/21 §17 の追随表の、設計書を行番号で指す参照は、すべて名指しの中身の行を指す', () => {
    expect(brokenFollowupLineRefs(read(RECIPE_AUTHOR_DOC), read)).toEqual([]);
  });

  it('cross/21 に §17 の追随表がある (節の番号が変わって検査が空にならない)', () => {
    const section = sectionLines(read(RECIPE_AUTHOR_DOC).split('\n'), RECIPE_AUTHOR_FOLLOWUP_SECTION);
    expect(section[0]).toMatch(/^## 17\. 他の文書への追随表/);
    expect(section.filter((line) => line.startsWith('| `docs/design/')).length).toBeGreaterThan(0);
  });
});
