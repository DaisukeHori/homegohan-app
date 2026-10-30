// @vitest-environment node
/**
 * 運営の作成の route が「キーが既にある」(一意の制約の違反 23505) で返す 409 のコードが、エラーコードの一覧
 * (docs/design/operator/02-api-spec.md §23) と operator/01 §6 に、route と同じ名前で載っていることの contract テスト (ソース走査)
 *
 * #2101 (triage-1030b の記録の古さ): A/B テスト・クーポン・機能パッケージ・プランの作成の重複の 409
 * (OP_EXPERIMENT_KEY_DUPLICATE・OP_COUPON_CODE_DUPLICATE・OP_PACKAGE_KEY_DUPLICATE・OP_PLAN_KEY_DUPLICATE) が §23 に無く、
 * §23 と operator/01 §6 はプランの重複を、実コードに無い OP_PLAN_KEY_CONFLICT と書いていた。
 * ここでは、route がそのコードを返していること (コメントを除いた本文に `code: <定数>` か `code: '<コード>'` がある) と、
 * §23 の表にそのコードの行があり HTTP が 409 であること、operator/01 §6 のプランの重複の行が route と同じコードであることを確かめる。
 *
 * 限界: 作成の route を列挙するのはこの表 (DUPLICATE_CODES) で、新しい作成の route の重複のコードは自動では拾わない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPERIMENT_KEY_DUPLICATE_ERROR_CODE } from '@/lib/super-admin/experiments-schemas';
import { stripComments } from './helpers/ai-reach';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const OPERATOR01 = 'docs/design/operator/01-data-model.md';
const OPERATOR02 = 'docs/design/operator/02-api-spec.md';
/** operator/02 のエラーコードの節の見出し (次の `## ` までが範囲) */
const OPERATOR02_ERROR_SECTION_HEADING = '## 23. エラーコード一覧';
/** operator/01 のプランの重複の行 (先頭のセル) */
const OPERATOR01_PLAN_KEY_DUPLICATE_ROW_PREFIX = '| `subscription_plans` の `plan_key` 重複 |';
/** 実コードに無いプランの重複のコード (#2101 で一覧から外した) */
const STALE_PLAN_KEY_CODE = 'OP_PLAN_KEY_CONFLICT';

/** 409 Conflict (作成でキーが既にある) */
const HTTP_CONFLICT = 409;

type DuplicateCodeEntry = {
  /** エラーコード */
  code: string;
  /** そのコードを返す作成の route */
  route: string;
  /** route の本文で `code:` に渡す式 (定数の名前か、リテラル) */
  expression: string;
};

const PLAN_ROUTE = 'src/app/api/super-admin/plans/route.ts';

const DUPLICATE_CODES: readonly DuplicateCodeEntry[] = [
  {
    code: EXPERIMENT_KEY_DUPLICATE_ERROR_CODE,
    route: 'src/app/api/super-admin/experiments/route.ts',
    expression: 'EXPERIMENT_KEY_DUPLICATE_ERROR_CODE',
  },
  { code: 'OP_COUPON_CODE_DUPLICATE', route: 'src/app/api/super-admin/coupons/route.ts', expression: "'OP_COUPON_CODE_DUPLICATE'" },
  {
    code: 'OP_PACKAGE_KEY_DUPLICATE',
    route: 'src/app/api/super-admin/feature-packages/route.ts',
    expression: "'OP_PACKAGE_KEY_DUPLICATE'",
  },
  { code: 'OP_PLAN_KEY_DUPLICATE', route: PLAN_ROUTE, expression: "'OP_PLAN_KEY_DUPLICATE'" },
];

/** 見出し (ちょうどその行) から、次の同じ深さ以上の見出しの手前までの行 */
function sectionLines(relativePath: string, heading: string, nextHeadingPrefix: string): string[] {
  const lines = read(relativePath).split('\n');
  const start = lines.findIndex((line) => line === heading);
  expect(start, `${relativePath} に「${heading}」の見出しがある`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith(nextHeadingPrefix));
  return end < 0 ? rest : rest.slice(0, end);
}

/** 表の行のセル (先頭と末尾の | の外は数えない) */
function cellsOf(row: string): string[] {
  return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** 表の行のうち、1 番目のセル (` / ` で区切った並び) に `code` を持つ行 */
function rowsWithCode(lines: string[], code: string): string[][] {
  return lines
    .filter((line) => line.startsWith('|'))
    .map(cellsOf)
    .filter((cells) => cells[0]?.split(' / ').includes(`\`${code}\``));
}

describe('#2101: 運営の作成の route が返す重複の 409 のコードが、エラーコードの一覧に route と同じ名前で載っている', () => {
  it('判定の見つけ方: 1 番目のセルの ` / ` の並びからコードを見つけ、別のセルの言及は数えない', () => {
    const lines = [
      '| `OP_A` / `OP_B_DUPLICATE` | 409 | 作成でキーが既にある |',
      '| `OP_C` | 409 | `OP_B_DUPLICATE` と同じ |',
    ];
    expect(rowsWithCode(lines, 'OP_B_DUPLICATE')).toHaveLength(1);
    expect(rowsWithCode(lines, 'OP_D')).toHaveLength(0);
  });

  it.each(DUPLICATE_CODES)('$route は $code を返す', ({ route, expression }) => {
    const source = stripComments(read(route));
    expect(source.includes(`code: ${expression}`), `${route} に \`code: ${expression}\` がある`).toBe(true);
  });

  it.each(DUPLICATE_CODES)('operator/02 §23 に $code の行がちょうど 1 行あり、HTTP が 409', ({ code }) => {
    const rows = rowsWithCode(sectionLines(OPERATOR02, OPERATOR02_ERROR_SECTION_HEADING, '## '), code);
    expect(rows, `operator/02 §23 に ${code} の行がちょうど 1 行`).toHaveLength(1);
    // §23 の表は「コード | HTTP | 意味」
    expect(rows[0][1]).toBe(String(HTTP_CONFLICT));
  });

  it(`operator/02 §23 と operator/01 は、実コードに無い ${STALE_PLAN_KEY_CODE} を書かない (route も返さない)`, () => {
    expect(stripComments(read(PLAN_ROUTE)).includes(STALE_PLAN_KEY_CODE)).toBe(false);
    expect(sectionLines(OPERATOR02, OPERATOR02_ERROR_SECTION_HEADING, '## ').join('\n')).not.toContain(STALE_PLAN_KEY_CODE);
    expect(read(OPERATOR01)).not.toContain(STALE_PLAN_KEY_CODE);
  });

  it('operator/01 のプランの重複の行は、プランの作成の route が返すコードを書く', () => {
    const rows = read(OPERATOR01)
      .split('\n')
      .filter((line) => line.startsWith(OPERATOR01_PLAN_KEY_DUPLICATE_ROW_PREFIX));
    expect(rows, `${OPERATOR01} にプランの重複の行がちょうど 1 行`).toHaveLength(1);
    const cells = cellsOf(rows[0]);
    expect(cells[1]).toBe(String(HTTP_CONFLICT));
    expect(cells[2]).toBe('`OP_PLAN_KEY_DUPLICATE`');
  });
});
