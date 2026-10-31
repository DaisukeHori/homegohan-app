/**
 * mobile/05 (auth のセッション) §9.1 の auth の呼び出しの閉包の数が、文書の中で食い違わない (#1797 ほかの 10/18 の記録の掃除)
 *
 * #1720 段 C のあと閉包の表を 317 呼び出しに直したとき、§9.13 の「変えないもの」に旧い「全 323 呼び出し」が残った
 * (取り込みの再レビューの指摘)。数を直すたびに、同じ文書の別の節の数が置き去りにならないようにする。
 *   1. §9.1 の太字の合計「**N 呼び出し** (Web W・apps/mobile M = `apps/mobile/src` S と画面 `apps/mobile/app` A)」がちょうど 1 回あり、
 *      W + M = N・S + A = M
 *   2. 閉包の表 (`| 群 | 呼び出し (origin/main の …) | 行数 | …`) の「行数」の和 = N、W-* の行の和 = W、M-* の行の和 = M
 *      (見出しは文書の中にちょうど 1 つ・3 番目の列の名前は「行数」)
 *   3. 文書の「全 K 呼び出し」はどれも K = N (§9.13 の「変えないもの」を含む。1 回以上ある)
 * 実コードとの突き合わせ (git grep の数) は、数えた時点の sha を本文に書く記録なので、ここでは見ない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = 'docs/design/mobile/05-auth-session.md';
/**
 * 閉包の表の見出しの頭。「呼び出し」の列の括弧の中 (参照の書き方。「file:line」→「file:line または名前」#2107) は
 * 記録の直しで変わるので見ない。その代わり、この頭で始まる見出しがちょうど 1 つで、3 番目の列が「行数」であることを確かめる。
 */
const TABLE_HEADER_PREFIX = '| 群 | 呼び出し (origin/main の ';
/** 閉包の表の「行数」の列の位置 (群・呼び出し・行数・扱い の 3 番目) */
const COUNT_COLUMN_INDEX = 2;
const COUNT_COLUMN_NAME = '行数';

const TOTAL_PATTERN =
  /\*\*(\d+) 呼び出し\*\* \(Web (\d+)・apps\/mobile (\d+) = `apps\/mobile\/src` (\d+) と画面 `apps\/mobile\/app` (\d+)\)/g;
const ALL_COUNT_PATTERN = /全 (\d+) 呼び出し/g;

const doc = (): string => fs.readFileSync(path.join(ROOT, DOC_PATH), 'utf-8');

function stated(text: string): { total: number; web: number; mobile: number; mobileSrc: number; mobileApp: number } {
  const matches = [...text.matchAll(TOTAL_PATTERN)];
  expect(matches, '§9.1 の閉包の合計の文がちょうど 1 回').toHaveLength(1);
  const [total, web, mobile, mobileSrc, mobileApp] = matches[0].slice(1).map(Number);
  return { total, web, mobile, mobileSrc, mobileApp };
}

/** 表の 1 行をセルに分ける (先頭の | を外して「 | 」で切る) */
const splitCells = (line: string): string[] => line.replace(/^\|/, '').split(' | ').map((cell) => cell.trim());

/** 閉包の表の行 (群の名前と行数) */
function tableRows(text: string): Array<{ group: string; count: number }> {
  const lines = text.split('\n');
  const headerIndexes = lines.flatMap((line, index) => (line.startsWith(TABLE_HEADER_PREFIX) ? [index] : []));
  expect(headerIndexes, '閉包の表の見出しがちょうど 1 つ').toHaveLength(1);
  const headerIndex = headerIndexes[0];
  const headerCells = splitCells(lines[headerIndex]);
  expect(headerCells[COUNT_COLUMN_INDEX], '3 番目の列が「行数」').toBe(COUNT_COLUMN_NAME);
  const rows: Array<{ group: string; count: number }> = [];
  // 見出しの次は区切りの行 (|---|)。その次から、| で始まる行が続く間が表の本体
  for (let index = headerIndex + 2; index < lines.length && lines[index].startsWith('|'); index += 1) {
    const cells = splitCells(lines[index]);
    const count = Number(cells[COUNT_COLUMN_INDEX]);
    expect(Number.isInteger(count), `行数が整数: ${cells[0]}`).toBe(true);
    rows.push({ group: cells[0].split(' ')[0], count });
  }
  return rows;
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

describe('mobile/05 の auth の呼び出しの閉包の数', () => {
  it('合計の文の内訳が合う (Web + apps/mobile・src + 画面)', () => {
    const { total, web, mobile, mobileSrc, mobileApp } = stated(doc());
    expect(web + mobile).toBe(total);
    expect(mobileSrc + mobileApp).toBe(mobile);
  });

  it('閉包の表の行数の和が、合計の文の数と合う', () => {
    const text = doc();
    const { total, web, mobile } = stated(text);
    const rows = tableRows(text);
    expect(rows.length, '表の行を読めている').toBeGreaterThan(0);
    expect(rows.every((row) => /^[WM]-\d+$/.test(row.group)), '群の名前は W-n か M-n').toBe(true);
    expect(sum(rows.map((row) => row.count))).toBe(total);
    expect(sum(rows.filter((row) => row.group.startsWith('W-')).map((row) => row.count))).toBe(web);
    expect(sum(rows.filter((row) => row.group.startsWith('M-')).map((row) => row.count))).toBe(mobile);
  });

  it('文書の「全 K 呼び出し」はどれも合計の文の数と同じ', () => {
    const text = doc();
    const { total } = stated(text);
    const counts = [...text.matchAll(ALL_COUNT_PATTERN)].map((match) => Number(match[1]));
    expect(counts.length, '「全 K 呼び出し」が 1 回以上ある (§9.13 の変えないもの)').toBeGreaterThan(0);
    expect(counts).toEqual(counts.map(() => total));
  });
});

describe('閉包の表の見つけ方 (見出しの「呼び出し」の列の括弧の中が変わっても同じ行を読む。#2107)', () => {
  const body = ['|---|---|---|---|', '| W-1 Web | `a.ts:1` | 3 | 変わらない |', '| M-1 mobile | 名前 | 2 | 変わらない |'];
  const withHeader = (header: string): string => ['前の段落', '', header, ...body, '', '後の段落'].join('\n');
  const expected = [
    { group: 'W-1', count: 3 },
    { group: 'M-1', count: 2 },
  ];

  it('「file:line」でも「file:line または名前」でも同じ行を読む', () => {
    expect(tableRows(withHeader('| 群 | 呼び出し (origin/main の file:line) | 行数 | 扱い |'))).toEqual(expected);
    expect(tableRows(withHeader('| 群 | 呼び出し (origin/main の file:line または名前) | 行数 | 扱い |'))).toEqual(expected);
  });

  it('見出しが 2 つあれば落ちる (どちらの表を数えたか分からない)', () => {
    const header = '| 群 | 呼び出し (origin/main の file:line) | 行数 | 扱い |';
    const text = [withHeader(header), '', header, ...body].join('\n');
    expect(() => tableRows(text)).toThrow(/ちょうど 1 つ/);
  });

  it('見出しが無ければ落ちる', () => {
    expect(() => tableRows(withHeader('| 群 | ファイル | 行数 | 扱い |'))).toThrow(/ちょうど 1 つ/);
  });

  it('3 番目の列が「行数」でなければ落ちる (列の位置で数を読んでいるため)', () => {
    expect(() => tableRows(withHeader('| 群 | 呼び出し (origin/main の file:line) | 扱い | 行数 |'))).toThrow(/行数/);
  });
});
