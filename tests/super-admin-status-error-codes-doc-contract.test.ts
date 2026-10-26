// @vitest-environment node
/**
 * 運営のクーポン・機能パッケージ・A/B テストの route が返すエラーコードが、エラーコードの一覧
 * (docs/design/cross/04-api-conventions.md §4.2 の「OP 系」と docs/design/operator/02-api-spec.md §23) に載っていることの contract テスト (ソース走査)
 *
 * #2073 (triage-1027a の記録の古さ): #2064 で route が返すようになった遷移表外の 409 (OP_COUPON_INVALID_TRANSITION・
 * OP_FEATURE_PACKAGE_INVALID_TRANSITION) と A/B テストの OP_EXPERIMENT_INVALID_TRANSITION が operator/02 §23 の表に無く、
 * クーポン・機能パッケージの 404 (OP_COUPON_NOT_FOUND・OP_PACKAGE_NOT_FOUND) が cross/04 §4.2 に無かった。
 * ここでは、route がそのコードを返していること (コメントを除いた本文に `code: <定数>` か `code: '<コード>'` がある) と、
 * 一覧の表にそのコードの行があり HTTP の値が route と同じことを確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COUPON_INVALID_TRANSITION_ERROR_CODE } from '@/lib/super-admin/coupons-schemas';
import { EXPERIMENT_INVALID_TRANSITION_ERROR_CODE } from '@/lib/super-admin/experiments-schemas';
import { FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE } from '@/lib/super-admin/feature-packages-schemas';
import { stripComments } from './helpers/ai-reach';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const CROSS04 = 'docs/design/cross/04-api-conventions.md';
const OPERATOR02 = 'docs/design/operator/02-api-spec.md';
/** cross/04 §4.2 の運営のコードの小節の見出し (次の `#### ` までが範囲) */
const CROSS04_OP_SECTION_HEADING = '#### OP 系';
/** operator/02 のエラーコードの節の見出し (次の `## ` までが範囲) */
const OPERATOR02_ERROR_SECTION_HEADING = '## 23. エラーコード一覧';

const COUPON_ROUTE = 'src/app/api/super-admin/coupons/[id]/route.ts';
const FEATURE_PACKAGE_ROUTE = 'src/app/api/super-admin/feature-packages/[id]/route.ts';
const EXPERIMENT_ROUTE = 'src/app/api/super-admin/experiments/[id]/route.ts';

/** 409 Conflict (遷移表に無い状態の変更) */
const HTTP_CONFLICT = 409;
/** 404 Not Found (行が無い) */
const HTTP_NOT_FOUND = 404;

type CodeEntry = {
  /** エラーコード */
  code: string;
  /** そのコードを返す route */
  route: string;
  /** route の本文で `code:` に渡す式 (定数の名前か、リテラル) */
  expression: string;
  /** route が返す HTTP ステータス */
  status: number;
};

const INVALID_TRANSITION_CODES: readonly CodeEntry[] = [
  {
    code: EXPERIMENT_INVALID_TRANSITION_ERROR_CODE,
    route: EXPERIMENT_ROUTE,
    expression: 'EXPERIMENT_INVALID_TRANSITION_ERROR_CODE',
    status: HTTP_CONFLICT,
  },
  {
    code: COUPON_INVALID_TRANSITION_ERROR_CODE,
    route: COUPON_ROUTE,
    expression: 'COUPON_INVALID_TRANSITION_ERROR_CODE',
    status: HTTP_CONFLICT,
  },
  {
    code: FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE,
    route: FEATURE_PACKAGE_ROUTE,
    expression: 'FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE',
    status: HTTP_CONFLICT,
  },
];

const NOT_FOUND_CODES: readonly CodeEntry[] = [
  { code: 'OP_COUPON_NOT_FOUND', route: COUPON_ROUTE, expression: "'OP_COUPON_NOT_FOUND'", status: HTTP_NOT_FOUND },
  { code: 'OP_PACKAGE_NOT_FOUND', route: FEATURE_PACKAGE_ROUTE, expression: "'OP_PACKAGE_NOT_FOUND'", status: HTTP_NOT_FOUND },
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

/** 表の行のうち、1 番目のセルに `code` を持つ行 */
function rowsWithCode(lines: string[], code: string): string[][] {
  return lines
    .filter((line) => line.startsWith('|'))
    .map(cellsOf)
    .filter((cells) => cells[0]?.split(' / ').includes(`\`${code}\``));
}

describe('#2073: 運営のクーポン・機能パッケージ・A/B テストの route が返すコードが、エラーコードの一覧に載っている', () => {
  it.each([...INVALID_TRANSITION_CODES, ...NOT_FOUND_CODES])('$route は $code を返す', ({ route, expression }) => {
    const source = stripComments(read(route));
    expect(source.includes(`code: ${expression}`), `${route} に \`code: ${expression}\` がある`).toBe(true);
  });

  it.each([...INVALID_TRANSITION_CODES, ...NOT_FOUND_CODES])('cross/04 §4.2 の OP 系に $code の行があり、HTTP が $status', ({ code, status }) => {
    const rows = rowsWithCode(sectionLines(CROSS04, CROSS04_OP_SECTION_HEADING, '#### '), code);
    expect(rows, `cross/04 の OP 系に ${code} の行がちょうど 1 行`).toHaveLength(1);
    // OP 系の表は「コード | 説明 | HTTP」
    expect(rows[0][rows[0].length - 1]).toBe(String(status));
  });

  it.each(INVALID_TRANSITION_CODES)('operator/02 §23 に $code の行があり、HTTP が $status', ({ code, status }) => {
    const rows = rowsWithCode(sectionLines(OPERATOR02, OPERATOR02_ERROR_SECTION_HEADING, '## '), code);
    expect(rows, `operator/02 §23 に ${code} の行がちょうど 1 行`).toHaveLength(1);
    // §23 の表は「コード | HTTP | 意味」
    expect(rows[0][1]).toBe(String(status));
  });
});
