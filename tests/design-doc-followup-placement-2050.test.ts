// @vitest-environment node
/**
 * 設計書の文の置き場 (節) と、節を名指す参照が、指す先の中身と食い違わないことの contract テスト (ソース走査)
 *
 * #2050 (docs-1026c) の R1 の指摘から:
 * (1) cross/02 §8 に献立のドメインの節を足した PATCH が、§8.3 Operator ドメインの表と
 *     「運営ロールの MFA (cross/12 §11.4。段 E)…」の段落のあいだに節を差し込み、段落が新しい節の下へ移った。
 *     cross/12 の追随表はこの段落の置き場を「cross/02 §8.3 Operator ドメイン」と記録しているので、
 *     段落のすぐ上の見出しが、cross/12 の追随表が名指す節であることを確かめる。
 * (2) cross/23 §13 (定数一覧) に足した行の根拠の欄が「§11 の表」を指していたが、§11 はシーケンス図の節で、
 *     その定数の行も表も無かった。§13 の根拠の欄が `§X の…表` と書いて指す節は、その定数の名前を表の行に持つこと、
 *     根拠の欄が指す `§X` はどれも cross/23 に見出しとしてあることを確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const CROSS02 = 'docs/design/cross/02-rls-patterns.md';
const CROSS12 = 'docs/design/cross/12-operator-mfa.md';
const CROSS23 = 'docs/design/cross/23-planned-meals-score-integrity.md';

/** cross/02 の運営ロールの MFA の段落の書き出し (cross/12 の追随表が置き場を記録している文) */
const OPERATOR_MFA_PARAGRAPH_START = '運営ロールの MFA (cross/12 §11.4。段 E)';
/** cross/12 の追随表の、cross/02 の行の先頭のセル */
const CROSS12_FOLLOWUP_CROSS02_CELL = '| `docs/design/cross/02-rls-patterns.md` |';
/** cross/12 の追随表の、運営ロールの MFA の段落の行を見分ける語 (逐語の一部) */
const CROSS12_FOLLOWUP_MFA_QUOTE = '「運営ロール (`user_profiles.roles` の super_admin';
/** 追随表のセルの「§8.3 Operator ドメイン」の形 (番号と見出しの名前) */
const DOMAIN_SECTION_REFERENCE = /§(\d+\.\d+) (\S+ ドメイン)/;

/** cross/23 の定数一覧の節と、その次の節の見出しの書き出し */
const CROSS23_CONSTANTS_HEADING = '## 13. ';
const CROSS23_AFTER_CONSTANTS_HEADING = '## 14. ';
/** 見出し `## 9. 表 3 点`・`### 9.3 ③状態遷移表` の番号 */
const NUMBERED_HEADING = /^(#{2,4}) (\d+(?:\.\d+)*)\.? /gm;
/** 根拠の欄の `§9.3 の状態遷移表`・`§10 のエラー表`・`§3.1 の表` (節の中の表を指す参照) */
const SECTION_TABLE_REFERENCE = /§(\d+(?:\.\d+)*) の[^§、・。()|]*?表/g;
const SECTION_REFERENCE = /§(\d+(?:\.\d+)*)/g;
/** 表の区切りの行 (`|---|---|`) */
const TABLE_SEPARATOR_ROW = /^\|(?:\s*:?-+:?\s*\|)+\s*$/;

/** needle で始まる行のすぐ上の見出しの行 (見出しが無ければ null) */
function headingAbove(markdown: string, needle: string): string | null {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => line.startsWith(needle));
  if (index < 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (/^#{1,6} /.test(lines[i] ?? '')) return lines[i] ?? null;
  }
  return null;
}

/** 番号つきの見出しの節の本文 (見出しの行から、同じ深さか浅い次の見出しの手前まで。無ければ null) */
function sectionBody(markdown: string, sectionNumber: string): string | null {
  const headings = [...markdown.matchAll(NUMBERED_HEADING)].map((m) => ({
    start: m.index ?? 0,
    depth: (m[1] ?? '').length,
    number: m[2] ?? '',
  }));
  const at = headings.findIndex((h) => h.number === sectionNumber);
  if (at < 0) return null;
  const own = headings[at];
  if (!own) return null;
  const next = headings.slice(at + 1).find((h) => h.depth <= own.depth);
  return markdown.slice(own.start, next ? next.start : markdown.length);
}

/** 表の行をセルに分ける (バッククォートの中の | では分けない。先頭と末尾の | の外は数えない) */
function tableCells(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (const ch of row.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

type ConstantsRow = { names: string[]; basis: string };

/** 定数一覧の節の表の行 (見出しの行と区切りの行を除く) の、名前の欄のバッククォートの中身と根拠の欄 (最後の欄) */
function constantsRows(constantsSection: string): ConstantsRow[] {
  const rows = constantsSection.split('\n').filter((line) => line.startsWith('|'));
  return rows
    .filter((row, index) => index > 0 && !TABLE_SEPARATOR_ROW.test(row))
    .map((row) => {
      const cells = tableCells(row);
      const names = [...(cells[0] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
      return { names, basis: cells[cells.length - 1] ?? '' };
    });
}

/** 根拠の欄の `§X の…表` が指す節のうち、その定数の名前を表の行に持たないもの / `§X` のうち見出しが無いもの */
function brokenConstantReferences(markdown: string, constantsSection: string): string[] {
  const broken: string[] = [];
  for (const { names, basis } of constantsRows(constantsSection)) {
    for (const [, sectionNumber] of basis.matchAll(SECTION_REFERENCE)) {
      if (sectionNumber && sectionBody(markdown, sectionNumber) === null) {
        broken.push(`${names.join('・')}: §${sectionNumber} の見出しが無い`);
      }
    }
    for (const [reference, sectionNumber] of basis.matchAll(SECTION_TABLE_REFERENCE)) {
      const body = sectionNumber ? sectionBody(markdown, sectionNumber) : null;
      if (body === null) continue;
      const tableRows = body.split('\n').filter((line) => line.startsWith('|'));
      const named = tableRows.some((line) => names.some((name) => line.includes(`\`${name}\``)));
      if (!named) broken.push(`${names.join('・')}: 「${reference}」の節の表に名前の行が無い`);
    }
  }
  return broken;
}

describe('cross/02 の運営ロールの MFA の段落は、cross/12 の追随表が名指す節 (§8.3 Operator ドメイン) の下にある (#2050)', () => {
  it('段落のすぐ上の見出しを取り出せる (別の節を差し込むと、その節の見出しになる)', () => {
    const operator = ['### 8.3 Operator ドメイン', '', '| `admin_audit_logs` | a | b |', '', `${OPERATOR_MFA_PARAGRAPH_START}: …`].join('\n');
    expect(headingAbove(operator, OPERATOR_MFA_PARAGRAPH_START)).toBe('### 8.3 Operator ドメイン');
    const inserted = operator.replace(
      `\n\n${OPERATOR_MFA_PARAGRAPH_START}`,
      `\n\n### 8.4 献立 (meal planner) ドメイン\n\n| \`planned_meals\` | a | b |\n\n${OPERATOR_MFA_PARAGRAPH_START}`,
    );
    expect(headingAbove(inserted, OPERATOR_MFA_PARAGRAPH_START)).toBe('### 8.4 献立 (meal planner) ドメイン');
    expect(headingAbove(operator, '無い文')).toBeNull();
  });

  it('cross/12 の追随表の置き場の節と、cross/02 の段落のすぐ上の見出しが同じ', () => {
    const followupRows = read(CROSS12)
      .split('\n')
      .filter((line) => line.startsWith(CROSS12_FOLLOWUP_CROSS02_CELL) && line.includes(CROSS12_FOLLOWUP_MFA_QUOTE));
    expect(followupRows, `${CROSS12} の追随表に cross/02 の運営ロールの MFA の段落の行がちょうど 1 行ある`).toHaveLength(1);
    const placement = DOMAIN_SECTION_REFERENCE.exec(tableCells(followupRows[0] ?? '')[1] ?? '');
    expect(placement, '追随表の置き場の欄が「§N.M 〜 ドメイン」の形').not.toBeNull();
    const expectedHeading = `### ${placement?.[1]} ${placement?.[2]}`;
    expect(expectedHeading).toBe('### 8.3 Operator ドメイン');
    expect(headingAbove(read(CROSS02), OPERATOR_MFA_PARAGRAPH_START)).toBe(expectedHeading);
  });
});

describe('cross/23 §13 の定数一覧の根拠の欄が指す節は、本書にあり、表を指すならその定数の行を持つ (#2050)', () => {
  const fixture = [
    '## 9. 表 3 点',
    '',
    '### 9.3 ③状態遷移表',
    '',
    '| 前 | 操作 | 後 |',
    '|---|---|---|',
    '| 任意 | 400 (`INVALID_X`) | 変わらず |',
    '',
    '## 10. エラー表',
    '',
    '| 経路 | 応答 |',
    '|---|---|',
    '| Edge | 400 (`INVALID_X`) |',
    '',
    '## 11. シーケンス',
    '',
    '```',
    'INVALID_X は図の中だけ',
    '```',
    '',
    '## 13. 定数一覧',
    '',
    '| 名前 | 値 | 置き場 | 根拠 |',
    '|---|---|---|---|',
    "| `INVALID_X` | `'x'` | `a.ts` | 400 の文 (§11 の表) |",
    '',
    '## 14. 新設一覧',
  ].join('\n');
  const constantsOf = (markdown: string): string =>
    markdown.slice(markdown.indexOf(CROSS23_CONSTANTS_HEADING), markdown.indexOf(CROSS23_AFTER_CONSTANTS_HEADING));

  it('表の無い節を「§X の表」で指すと見分ける (シーケンス図の節)・表に名前の行がある節を指せば通る', () => {
    expect(brokenConstantReferences(fixture, constantsOf(fixture))).toEqual(['INVALID_X: 「§11 の表」の節の表に名前の行が無い']);
    const fixed = fixture.replace('(§11 の表)', '(§9.3 の状態遷移表・§10 のエラー表)');
    expect(brokenConstantReferences(fixed, constantsOf(fixed))).toEqual([]);
  });

  it('本書に見出しの無い §X を根拠に書くと見分ける', () => {
    const missing = fixture.replace('(§11 の表)', '(§12.9)');
    expect(brokenConstantReferences(missing, constantsOf(missing))).toEqual(['INVALID_X: §12.9 の見出しが無い']);
  });

  it('バッククォートの中の | ではセルを分けない', () => {
    expect(tableCells("| `A` | `'a' | 'b'` | 根拠 (§9.3) |")).toEqual(['`A`', "`'a' | 'b'`", '根拠 (§9.3)']);
  });

  it('cross/23 の §13 の行の根拠が指す節は、どれも本書にあり、表を指すならその定数の行を持つ', () => {
    const markdown = read(CROSS23);
    expect(markdown.indexOf(CROSS23_CONSTANTS_HEADING), `${CROSS23} に §13 の見出しがある`).toBeGreaterThanOrEqual(0);
    expect(markdown.indexOf(CROSS23_AFTER_CONSTANTS_HEADING), `${CROSS23} に §14 の見出しがある`).toBeGreaterThan(
      markdown.indexOf(CROSS23_CONSTANTS_HEADING),
    );
    const constants = constantsOf(markdown);
    const rows = constantsRows(constants);
    expect(rows.length, '§13 の表の行を取り出せる').toBeGreaterThan(0);
    expect(rows.some(({ basis }) => [...basis.matchAll(SECTION_REFERENCE)].length > 0), '§13 の根拠の欄に §X の参照がある (走査が空でない)').toBe(true);
    expect(brokenConstantReferences(markdown, constants)).toEqual([]);
  });
});
