// @vitest-environment node
/**
 * billing/01 §16.2 の追随表が operator/03 を指す行の contract テスト (ソース走査。#2128 docs-1031c の R1 指摘 1)
 *
 * billing/01 §16.2 の追随表は、operator/03 §13 の冒頭の注を名前 (「§13 冒頭の注」) で指す。行番号で指すと、
 * operator/03 の行の増減で別の行を指すため、行番号を書くなら §13 の冒頭の注の行を指すことを求める。
 *
 * ここでは、
 *  1. 追随表の operator/03 の行が書く注の文 (「…」) が、operator/03 の §13 の中にちょうど 1 行あり、
 *     その行の「済」などのセルに行番号があれば、どれもその行を指すこと
 *  2. 次の「同」の行 (§26 の設定フォーム) が名前で指す項目 (Webhook の秘密・受け口の URL) が §26 の設定フォームにあり、
 *     外すと書いた「Publishable Key」は設定フォームの項目に無いこと
 * を確かめる。1. の確かめ方が行のずれを見つけることも、ずらした写しで確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const BILLING01 = 'docs/design/billing/01-billing-core.md';
const OPERATOR03 = 'docs/design/operator/03-ui-spec.md';

/** 追随表の operator/03 の行の先頭 */
const OPERATOR03_ROW_PREFIX = '| `docs/design/operator/03-ui-spec.md` |';

/** 表の行の n 番目のセル (1 始まり。先頭の | の前は数えない) */
function cell(row: string, index: number): string {
  return row.split('|')[index]?.trim() ?? '';
}

/** `:N` と `:N-M` を、行番号の並び (範囲は始めと終わりの 2 つ) にする */
function anchorNumbers(text: string): number[] {
  return [...text.matchAll(/:(\d+)(?:-(\d+))?/g)].flatMap(([, start, end]) =>
    end === undefined ? [Number(start)] : [Number(start), Number(end)],
  );
}

/** 見出し `## <n>. ` で始まる節の行の範囲 (0 始まりの [start, end)) */
function sectionRange(lines: string[], sectionNumber: string): { start: number; end: number } {
  const start = lines.findIndex((line) => line.startsWith(`## ${sectionNumber}. `));
  const rest = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  return { start, end: rest === -1 ? lines.length : start + 1 + rest };
}

/** billing/01 の、先頭が prefix の表の行 (ちょうど 1 行) と、その次の行 */
function billing01Row(billing01: string, prefix: string): { row: string; next: string } {
  const lines = billing01.split('\n');
  const hits = lines.flatMap((line, index) => (line.startsWith(prefix) ? [index] : []));
  expect(hits, `${BILLING01} に「${prefix}」で始まる行がちょうど 1 行ある`).toHaveLength(1);
  return { row: lines[hits[0]], next: lines[hits[0] + 1] ?? '' };
}

/**
 * 追随表の operator/03 の §13 の行が指す注の行 (1 始まり) と、行が書く行番号のうちその行を指さないもの。
 * 注の文は行の 3 つめのセルの最初の「…」。注の行は operator/03 の §13 の中にちょうど 1 行あること。
 */
function checkSection13Row(row: string, operator03: string): { noteLine: number; misplaced: number[] } {
  expect(cell(row, 2), '追随表の operator/03 の行は §13 の行').toMatch(/^§13 /);
  const quoted = /「([^」]+)」/.exec(cell(row, 3))?.[1];
  expect(quoted, '追随表の operator/03 の行の 3 つめのセルに注の文 (「…」) がある').toBeTruthy();
  const lines = operator03.split('\n');
  const { start, end } = sectionRange(lines, '13');
  expect(start, `${OPERATOR03} に §13 の見出しがある`).toBeGreaterThanOrEqual(0);
  const hits = lines.flatMap((line, index) => (quoted !== undefined && line.includes(quoted) ? [index] : []));
  expect(hits, `${OPERATOR03} に注の文「${quoted}」の行がちょうど 1 行ある`).toHaveLength(1);
  expect(hits[0] > start && hits[0] < end, '注の行は §13 の中にある').toBe(true);
  const noteLine = hits[0] + 1;
  const cited = [cell(row, 2), cell(row, 4)].flatMap(anchorNumbers);
  return { noteLine, misplaced: cited.filter((lineNumber) => lineNumber !== noteLine) };
}

describe('billing/01 §16.2 の追随表が operator/03 を指す行 (#2128 docs-1031c の R1 指摘 1)', () => {
  it('§13 の行が書く注の文は operator/03 の §13 の中にちょうど 1 行あり、行に行番号があればどれもその注の行を指す', () => {
    const { row } = billing01Row(read(BILLING01), OPERATOR03_ROW_PREFIX);
    expect(checkSection13Row(row, read(OPERATOR03)).misplaced).toEqual([]);
  });

  it('確かめ方が空振りしない: §13 より前の行を減らした写しでは、注の元の行を指す行番号がずれたと分かる', () => {
    const operator03 = read(OPERATOR03);
    const { row } = billing01Row(read(BILLING01), OPERATOR03_ROW_PREFIX);
    const { noteLine } = checkSection13Row(row, operator03);
    const quoted = /「([^」]+)」/.exec(cell(row, 3))?.[1] ?? '';
    const anchored = `${OPERATOR03_ROW_PREFIX} §13 冒頭の注 (:${noteLine}) | 「${quoted}」に直す | 済: operator/03 §13 :${noteLine} |`;
    expect(checkSection13Row(anchored, operator03).misplaced, 'ずらす前は行番号が注の行を指す').toEqual([]);
    const lines = operator03.split('\n');
    const { start } = sectionRange(lines, '13');
    const shifted = [...lines.slice(0, start - 2), ...lines.slice(start)].join('\n');
    expect(checkSection13Row(anchored, shifted).misplaced, '§13 より前を 2 行減らすと行番号が注の行から外れる').toEqual([
      noteLine,
      noteLine,
    ]);
  });

  it('次の「同」の行 (§26 の設定フォーム) が名前で指す項目が §26 の設定フォームにあり、Publishable Key は項目に無い', () => {
    const { next } = billing01Row(read(BILLING01), OPERATOR03_ROW_PREFIX);
    expect(cell(next, 1), 'operator/03 の行の次は「同」の行').toBe('同');
    expect(cell(next, 2), '「同」の行は §26 の設定フォームの行').toMatch(/^§26 .*設定フォーム/);
    const lines = read(OPERATOR03).split('\n');
    const { start, end } = sectionRange(lines, '26');
    expect(start, `${OPERATOR03} に §26 の見出しがある`).toBeGreaterThanOrEqual(0);
    const section26 = lines.slice(start, end);
    expect(section26.some((line) => line.startsWith('**設定フォーム**'))).toBe(true);
    expect(section26).toContain('- Webhook Signing Secret (masked)');
    expect(section26.some((line) => line.startsWith('- Webhook Endpoint: '))).toBe(true);
    expect(section26.filter((line) => /^- .*Publishable Key/.test(line))).toEqual([]);
  });
});
