/**
 * #2157 R3・#2166 X5: Edge Function が件数の上限つき・offset のページ送りで取り出す問い合わせの並び (ソースの突き合わせ)。
 *
 * 並びの鍵が同じ値の行 (同じ優先度・同じ作成時刻の料理画像のジョブ、同じ優先度のカタログのカテゴリ) のどれを
 * 件数の上限までに取るかは、最後に一意の鍵を重ねないと DB 任せになり、実行ごとに変わりうる。
 * 並びを書かない問い合わせ (埋め込みの再生成のページ送り、栄養の検証のフォールバックの献立の候補) は、
 * ページの境目の行が重なる・抜ける、見る候補が問い合わせごとに変わるので、主キー id の昇順で並べる。
 * Edge Function は Deno で動き、Next 側の src/lib/api/list-order.ts (LIST_ORDERS) を import できないので、
 * 同じ並びを .order( で直接書く (cross/04 §6.2.1)。ここでは次の問い合わせの .order( の列・向き・順を見る:
 *   - 料理画像のジョブ (process-meal-image-jobs の fetchPendingJobs の meal_image_jobs):
 *     優先度の降順 → 作成時刻の昇順 → id の昇順
 *   - カタログの取り込みのカテゴリ (_shared/catalog/import-runner.ts の catalog_source_categories の一覧):
 *     取り込みの優先度の昇順 → id の昇順
 *   - 埋め込みの再生成 (regenerate-embeddings の dataset_ingredients / dataset_recipes / dataset_menu_sets の
 *     offset のページ送り): id の昇順
 *   - 栄養の検証のフォールバック (_shared/nutrition-calculator.ts の dataset_menu_sets を料理名で絞った候補): id の昇順
 * どの表も id が主キー (supabase/migrations/20251126124224_create_meal_planner_tables.sql の
 * meal_image_jobs_pkey・catalog_source_categories_pkey・dataset_ingredients_pkey・dataset_recipes_pkey・
 * dataset_menu_sets_pkey)。
 * 各ファイルの .order( はこの問い合わせの中にしか無いことも見る (同じファイルに並びを書く問い合わせが増えたら、
 * ここに期待する並びを足す)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** .order( の 1 回の呼び出し (列と、昇順か) */
interface OrderCall {
  column: string;
  ascending: boolean;
}

/** 見る問い合わせ: ファイルと、問い合わせの本体の始まりと終わりの目印、期待する .order( の並び */
interface QueryCase {
  name: string;
  file: string;
  /** 本体の始まり (ファイルに 1 回だけ現れる文字列) */
  startMarker: string;
  /** 本体の終わり (始まりのあとで最初に現れる文字列。本体はこの手前まで) */
  endMarker: string;
  expected: OrderCall[];
}

const QUERY_CASES: readonly QueryCase[] = [
  {
    name: '料理画像のジョブ (meal_image_jobs) の取り出し',
    file: 'supabase/functions/process-meal-image-jobs/index.ts',
    startMarker: 'async function fetchPendingJobs(',
    endMarker: '.limit(limit)',
    expected: [
      { column: 'priority', ascending: false },
      { column: 'created_at', ascending: true },
      { column: 'id', ascending: true },
    ],
  },
  {
    name: 'カタログの取り込みのカテゴリ (catalog_source_categories) の一覧',
    file: 'supabase/functions/_shared/catalog/import-runner.ts',
    startMarker: 'let categoryQuery = supabase',
    endMarker: '.limit(maxCategories)',
    expected: [
      { column: 'crawl_priority', ascending: true },
      { column: 'id', ascending: true },
    ],
  },
  {
    name: '埋め込みの再生成 (dataset_ingredients / dataset_recipes / dataset_menu_sets) の offset のページ送り',
    file: 'supabase/functions/regenerate-embeddings/index.ts',
    startMarker: 'let query = supabase',
    endMarker: '.range(offset, offset + limit - 1)',
    expected: [{ column: 'id', ascending: true }],
  },
  {
    name: '栄養の検証のフォールバックの献立の候補 (dataset_menu_sets) の取り出し',
    file: 'supabase/functions/_shared/nutrition-calculator.ts',
    startMarker: '.from("dataset_menu_sets")',
    endMarker: '.limit(5)',
    expected: [{ column: 'id', ascending: true }],
  },
];

/** 始まりの目印から終わりの目印の手前まで。始まりの目印はファイルに 1 回だけ、終わりの目印はそのあとにあること */
function queryBodyOf(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `始まりの目印 ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(startMarker, start + startMarker.length), `始まりの目印 ${startMarker} は 1 回だけ`).toBe(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `終わりの目印 ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** 行コメント (// …) を外す (コメントの中の .order( を拾わない) */
function stripLineComments(code: string): string {
  return code
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

/** コメントを外したあとの .order( の数 */
function orderCountOf(code: string): number {
  return stripLineComments(code).split('.order(').length - 1;
}

/**
 * .order("<列>", { ascending: <真偽> }) を書いた順に。この形でない .order( (向きを省いた・ほかの指定を足した・列が式) が
 * 1 つでもあれば赤にする (拾えない .order( を見落とさないため)
 */
function orderCallsOf(code: string): OrderCall[] {
  const stripped = stripLineComments(code);
  const calls = [...stripped.matchAll(/\.order\(\s*"([^"]+)"\s*,\s*\{\s*ascending:\s*(true|false)\s*,?\s*\}\s*,?\s*\)/g)];
  expect(calls.length, '.order( の数と、拾えた .order( の数').toBe(orderCountOf(code));
  return calls.map(([, column, ascending]) => ({ column, ascending: ascending === 'true' }));
}

describe('#2157 R3・#2166 X5 Edge Function が件数・ページで切って取り出す並び', () => {
  it.each(QUERY_CASES.map((queryCase) => [queryCase.name, queryCase] as const))(
    '%s は、期待する列・向き・順で並べ、最後は主キー id の昇順',
    (_name, queryCase) => {
      const source = readFileSync(join(ROOT, queryCase.file), 'utf8');
      const body = queryBodyOf(source, queryCase.startMarker, queryCase.endMarker);
      expect(orderCallsOf(body)).toEqual(queryCase.expected);
    },
  );

  it.each(QUERY_CASES.map((queryCase) => [queryCase.file, queryCase] as const))(
    '%s の .order( は、見ている問い合わせの中にしか無い',
    (_file, queryCase) => {
      const source = readFileSync(join(ROOT, queryCase.file), 'utf8');
      const body = queryBodyOf(source, queryCase.startMarker, queryCase.endMarker);
      expect(orderCountOf(source)).toBe(orderCountOf(body));
    },
  );

  it('.order( の検出は、この形でない .order( (向きを省いた・ほかの指定を足した) があれば赤にする', () => {
    expect(() => orderCallsOf('  .order("a")')).toThrow();
    expect(() => orderCallsOf('  .order("a", { ascending: true, nullsFirst: false })')).toThrow();
  });

  it('.order( の検出は、向きの真偽・複数行の書き方を拾い、行コメントの中は拾わない', () => {
    const sample = [
      '  .order("a", { ascending: true })',
      '  .order(',
      '    "b",',
      '    { ascending: false },',
      '  )',
      '  // .order("commented_out", { ascending: true })',
    ].join('\n');
    expect(orderCallsOf(sample)).toEqual([
      { column: 'a', ascending: true },
      { column: 'b', ascending: false },
    ]);
  });

  it('本体の切り出しは、始まりの目印が 2 回あるか、終わりの目印が無ければ赤にする', () => {
    expect(() => queryBodyOf('x\nx\n.limit(1)', 'x', '.limit(1)')).toThrow();
    expect(() => queryBodyOf('x .order("a", { ascending: true })', 'x', '.limit(1)')).toThrow();
  });
});
