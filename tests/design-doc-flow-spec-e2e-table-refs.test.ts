// @vitest-environment node
/**
 * membership/02 §16 の E2E の表を行番号で指す参照が、表の範囲とずれないことの contract テスト (ソース走査)
 *
 * #2086 (docs-1030a) で §16 の E2E の表に 12・14 の spec の行を足したとき、family/11 §24 の追随表が
 * その表を `§16 (`:429-444`)` と行番号で指していて、表が 2 行伸びたのに番号が追随していなかった
 * (表の最後の 15-self-dissolve の行が範囲から外れる)。
 *
 * ここでは docs/ の全 Markdown から「02-flow-spec.md の §16 を行番号の範囲で指す参照」を拾い、
 * 範囲の始めが §16 の見出し・終わりが §16 の表の最後の行であることを確かめる。名前で指す参照 (行番号なし) は対象外。
 * あわせて、02-flow-spec.md を指す行番号がどれもファイルの中にあることと、
 * family/11 §24 の 02-flow-spec の行が §16 を指し続けていること (取り出しが空振りしないこと) を確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = 'docs';
const FLOW_SPEC = 'docs/design/membership/02-flow-spec.md';
const FAMILY11 = 'docs/design/family/11-self-dissolve.md';
/** §16 の見出し (「## 16. テスト戦略 …」) */
const SECTION16_HEADING = /^## 16\./;
/** family/11 §24 の追随表の、membership/02 §16 を指す行の頭 */
const FAMILY11_FLOW_SPEC_ROW_PREFIX = '| `docs/design/membership/02-flow-spec.md` §16 (';

const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

/** docs/ の下の Markdown (リポジトリの根からの相対) */
function markdownFilesUnder(relativeDir: string): string[] {
  return fs.readdirSync(path.join(ROOT, relativeDir), { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) return markdownFilesUnder(child);
    return entry.isFile() && entry.name.endsWith('.md') ? [child] : [];
  });
}

/** 02-flow-spec.md の §16 の見出しの行と、そのあとの表の最後の行 (どちらも 1 始まり) */
function section16Extent(): { heading: number; lastTableRow: number } {
  const lines = read(FLOW_SPEC).split('\n');
  const headingIndex = lines.findIndex((line) => SECTION16_HEADING.test(line));
  expect(headingIndex, `${FLOW_SPEC} に §16 の見出しがある`).toBeGreaterThanOrEqual(0);
  const tableStart = lines.findIndex((line, index) => index > headingIndex && line.startsWith('|'));
  expect(tableStart, `${FLOW_SPEC} の §16 に表がある`).toBeGreaterThan(headingIndex);
  let tableEnd = tableStart;
  while (tableEnd + 1 < lines.length && lines[tableEnd + 1].startsWith('|')) tableEnd += 1;
  return { heading: headingIndex + 1, lastTableRow: tableEnd + 1 };
}

interface RangeRef {
  file: string;
  start: number;
  end: number;
}

/** 「02-flow-spec.md` §16 (`:N-M`)」の形の参照を全部拾う */
function section16RangeRefs(): RangeRef[] {
  return markdownFilesUnder(DOCS_DIR).flatMap((file) =>
    [...read(file).matchAll(/02-flow-spec\.md`?\s*§16\s*\(`:(\d+)-(\d+)`\)/g)].map(([, start, end]) => ({
      file,
      start: Number(start),
      end: Number(end),
    })),
  );
}

describe('membership/02 §16 の E2E の表を指す参照 (#2086 docs-1030a の R1 指摘 1・2)', () => {
  it('§16 を行番号の範囲で指す参照は、§16 の見出しから表の最後の行までを指す', () => {
    const { heading, lastTableRow } = section16Extent();
    for (const ref of section16RangeRefs()) {
      expect(`${ref.file}: :${ref.start}-${ref.end}`).toBe(`${ref.file}: :${heading}-${lastTableRow}`);
    }
  });

  it('family/11 §24 の 02-flow-spec の行は §16 を指し、行番号を書くなら §16 の範囲とそろう', () => {
    const rows = read(FAMILY11)
      .split('\n')
      .filter((line) => line.startsWith(FAMILY11_FLOW_SPEC_ROW_PREFIX));
    expect(rows, `${FAMILY11} に membership/02 §16 の追随の行がちょうど 1 行ある`).toHaveLength(1);
    const target = rows[0].split('|')[1] ?? '';
    const range = /`:(\d+)-(\d+)`/.exec(target);
    if (range === null) {
      expect(target, '行番号を書かないなら §16 の E2E の表を名前で指す').toContain('E2E の表');
      return;
    }
    const { heading, lastTableRow } = section16Extent();
    expect([Number(range[1]), Number(range[2])]).toEqual([heading, lastTableRow]);
  });

  it('02-flow-spec.md を指す行番号は、どれもファイルの中の行を指す', () => {
    const lineCount = read(FLOW_SPEC).split('\n').length;
    const cited = markdownFilesUnder(DOCS_DIR).flatMap((file) =>
      [...read(file).matchAll(/02-flow-spec\.md[^|\n]*?`:(\d+)(?:-(\d+))?`/g)].flatMap(
        ([, start, end]) => [start, end].filter((n): n is string => n !== undefined).map((n) => ({ file, line: Number(n) })),
      ),
    );
    for (const { file, line } of cited) {
      expect(line, `${file} が ${FLOW_SPEC}:${line} を指す`).toBeLessThanOrEqual(lineCount);
    }
  });
});
