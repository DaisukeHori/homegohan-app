/**
 * 紹介ページ (`/`) の axe の検査 (E-20) が確かめる状態を、設計書の文とテストの実物でそろえる (#1867 の他の正典への追随)
 *
 * #1867 の追随で cross/05 §7 のテスト方針の表に「a11y (紹介ページ `/`)」の行を足したとき、E-20 の状態を 3 つだけ挙げて
 * 4 つ目の `reducedMotion: 'reduce'` の 1280 px の開いた直後を落とした (R1 の指摘)。読み手は「reduce は axe で見ていない」と取る。
 *   1. marketing/01 §16.3 の E-20 の行が宣言する状態の数 (2 列目の「N つの状態」と 3 列目の「の N つで」) が、
 *      tests/e2e/landing-page.spec.ts の `test('E-20 …')` の数と同じ
 *   2. cross/05 に紹介ページの a11y の行があるなら、その行は 01 §16.3 の E-20 の状態をすべて挙げ、「N つの状態」と数を書く。
 *      行が無いなら、cross/05 は landing-page.spec.ts を指さない (行を言い換えて黙って外れないように)
 *   3. 2 の検査は、指摘された 3 つだけの文を違反として捕まえる (検査が空振りしていない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const E2E_SPEC_PATH = 'tests/e2e/landing-page.spec.ts';
const LANDING_DESIGN_PATH = 'docs/design/marketing/01-landing-site.md';
const A11Y_CANON_PATH = 'docs/design/cross/05-i18n-a11y.md';

/** cross/05 §7 の表で紹介ページの a11y を書く行の頭 */
const A11Y_ROW_HEAD = '| a11y (紹介ページ `/`) |';
/** 01 §16.3 の E-20 の行の頭 */
const E20_ROW_HEAD = '| E-20 |';
/** 状態を区切る記号 (01 §16.3 の E-20 の 3 列目) */
const STATE_SEPARATOR = '・';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

/** landing-page.spec.ts の `test('E-20 …')` の数 (`test.describe('E-20 axe'` は数えない) */
function e2eE20TestCount(): number {
  return (read(E2E_SPEC_PATH).match(/(?<![.\w])test\('E-20 /g) ?? []).length;
}

/** 01 §16.3 の E-20 の行: 2 列目の宣言の数・3 列目の数・3 列目が挙げる状態 */
function designE20(): { declaredInTitle: number; declaredInBody: number; states: string[] } {
  const rows = read(LANDING_DESIGN_PATH)
    .split('\n')
    .filter((line) => line.startsWith(E20_ROW_HEAD));
  expect(rows, `${LANDING_DESIGN_PATH} の E-20 の行`).toHaveLength(1);
  const cells = rows[0].split('|').map((cell) => cell.trim());
  const title = cells[2] ?? '';
  const body = cells[3] ?? '';
  const titleMatch = /axe: (\d+) つの状態/.exec(title);
  const bodyMatch = /^(.*?) の (\d+) つで、/.exec(body);
  expect(titleMatch, `E-20 の 2 列目「${title}」に「N つの状態」`).not.toBeNull();
  expect(bodyMatch, `E-20 の 3 列目に「… の N つで、」`).not.toBeNull();
  return {
    declaredInTitle: Number(titleMatch?.[1]),
    declaredInBody: Number(bodyMatch?.[2]),
    states: (bodyMatch?.[1] ?? '').split(STATE_SEPARATOR).map((state) => state.trim()),
  };
}

/** cross/05 の紹介ページの a11y の行が、E-20 の状態をすべて挙げ数を書いているか。足りないものを返す */
function a11yRowProblems(row: string, states: readonly string[]): string[] {
  const problems = states.filter((state) => !row.includes(state)).map((state) => `状態「${state}」が無い`);
  if (!row.includes(`${states.length} つの状態`)) problems.push(`「${states.length} つの状態」が無い`);
  return problems;
}

describe('#1867 紹介ページの axe (E-20) の状態の数', () => {
  it('01 §16.3 の E-20 の行が宣言する状態の数は、landing-page.spec.ts の E-20 のテストの数と同じ', () => {
    const design = designE20();
    const testCount = e2eE20TestCount();
    expect(testCount, 'E-20 のテストが 1 つ以上ある').toBeGreaterThan(0);
    expect(design.declaredInTitle).toBe(testCount);
    expect(design.declaredInBody).toBe(testCount);
    expect(design.states).toHaveLength(testCount);
  });

  it('cross/05 の紹介ページの a11y の行は E-20 の状態をすべて挙げる (行が無いなら landing-page.spec.ts を指さない)', () => {
    const { states } = designE20();
    const canon = read(A11Y_CANON_PATH);
    const rows = canon.split('\n').filter((line) => line.startsWith(A11Y_ROW_HEAD));
    if (rows.length === 0) {
      expect(canon.includes(E2E_SPEC_PATH), `${A11Y_CANON_PATH} が ${E2E_SPEC_PATH} を指すのに「${A11Y_ROW_HEAD}」の行が無い`).toBe(false);
      return;
    }
    expect(rows).toHaveLength(1);
    expect(a11yRowProblems(rows[0], states)).toEqual([]);
  });

  it('検査は reduce の状態を落とした 3 つだけの行を捕まえ、4 つをそろえた行を通す', () => {
    const { states } = designE20();
    const reduceState = states.find((state) => state.includes('reducedMotion'));
    expect(reduceState, '01 §16.3 の E-20 に reducedMotion の状態がある').toBeDefined();
    const withoutReduce = states.filter((state) => state !== reduceState);
    const droppedRow = `${A11Y_ROW_HEAD} violations = 0。E-20 が確かめる (${withoutReduce.join(STATE_SEPARATOR)}。タグは …) | @axe-core/playwright |`;
    const fullRow = `${A11Y_ROW_HEAD} violations = 0。E-20 が確かめる (${states.join(STATE_SEPARATOR)} の ${states.length} つの状態。タグは …) | @axe-core/playwright |`;
    expect(a11yRowProblems(droppedRow, states)).toEqual([
      `状態「${reduceState}」が無い`,
      `「${states.length} つの状態」が無い`,
    ]);
    expect(a11yRowProblems(fullRow, states)).toEqual([]);
  });
});
