/**
 * #2150 Q1-c: 献立の生成の Edge Function (generate-menu-v4 / v5) が AI に渡す文脈を読む問い合わせの並び (ソースの突き合わせ)。
 *
 * 並びの鍵が同じ値の行 (同じ期限のパントリーの品・同じ日時のいいね) の順と、件数で切ったときにどの行が入るかは、
 * 最後に一意の鍵を重ねないと DB 任せになり、同じ条件でも生成のたびに AI への入力が変わりうる。
 * Edge Function は Deno で動き、Next 側の src/lib/api/list-order.ts (LIST_ORDERS) を import できないので、
 * 同じ並びを .order( で直接書く。ここでは v4 / v5 の各問い合わせの .order( の列・向き・順を見る:
 *   - pantry_items: 期限の昇順 → id の昇順 (Next の LIST_ORDERS.pantryItemsByExpiration と同じ並び)
 *   - recipe_likes: いいねした日時の降順 → recipe_id の降順 (主キー (user_id, recipe_id) で、user_id で絞って読む。
 *     id の列には一意の制約が無い)
 *   - health_checkups: 健診の日の降順だけ ((user_id, checkup_date) が一意で、user_id で絞って読むので同じ値の行が出ない。
 *     Next の route も checkup_date だけで並べる — tests/list-order-tiebreak-2134.test.ts の許可の表)
 * 主キー・一意の制約は supabase/migrations/20251126124224_create_meal_planner_tables.sql による。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIST_ORDERS } from '@/lib/api/list-order';

const ROOT = process.cwd();

/** 見る Edge Function の本体 */
const EDGE_FILES = ['supabase/functions/generate-menu-v4/index.ts', 'supabase/functions/generate-menu-v5/index.ts'] as const;

/** .order( の 1 回の呼び出し (列と、昇順か) */
interface OrderCall {
  column: string;
  ascending: boolean;
}

/** 表ごとの、期待する .order( の並び */
const EXPECTED_ORDERS: Record<'pantry_items' | 'recipe_likes' | 'health_checkups', OrderCall[]> = {
  pantry_items: [
    { column: 'expiration_date', ascending: true },
    { column: 'id', ascending: true },
  ],
  recipe_likes: [
    { column: 'created_at', ascending: false },
    { column: 'recipe_id', ascending: false },
  ],
  health_checkups: [{ column: 'checkup_date', ascending: false }],
};

/**
 * 問い合わせの本体: .from("<表>") から、runSupabaseQuery に渡すキャッシュの鍵 (`<表>.context:`) の手前まで。
 * select に複数行の文字列 (`…`) を渡す問い合わせもあるので、最初の ` ではなく鍵の文字列で区切る
 */
function queryBodiesOf(source: string, table: string): string[] {
  const bodies: string[] = [];
  const fromCall = `.from("${table}")`;
  const cacheKey = `\`${table}.context:`;
  let start = source.indexOf(fromCall);
  while (start !== -1) {
    const end = source.indexOf(cacheKey, start);
    expect(end, `${table} のキャッシュの鍵`).toBeGreaterThan(start);
    bodies.push(source.slice(start, end));
    start = source.indexOf(fromCall, end);
  }
  return bodies;
}

/** 行コメント (// …) を外す (コメントの中の .order( を拾わない) */
function stripLineComments(code: string): string {
  return code
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

/**
 * .order("<列>", { ascending: <真偽> }) を書いた順に。この形でない .order( (向きを省いた・ほかの指定を足した・列が式) が
 * 1 つでもあれば赤にする (拾えない .order( を見落とさないため)
 */
function orderCallsOf(code: string): OrderCall[] {
  const stripped = stripLineComments(code);
  const calls = [...stripped.matchAll(/\.order\(\s*"([^"]+)"\s*,\s*\{\s*ascending:\s*(true|false)\s*,?\s*\}\s*,?\s*\)/g)];
  expect(calls.length, '.order( の数と、拾えた .order( の数').toBe(stripped.split('.order(').length - 1);
  return calls.map(([, column, ascending]) => ({ column, ascending: ascending === 'true' }));
}

describe('#2150 Q1-c 献立の生成の Edge Function が文脈を読む並び', () => {
  it('期待する pantry_items の並びは、Next の LIST_ORDERS.pantryItemsByExpiration の列と向きと同じ', () => {
    expect(LIST_ORDERS.pantryItemsByExpiration.keys.map((key) => ({ column: key.column, ascending: key.options.ascending }))).toEqual(
      EXPECTED_ORDERS.pantry_items,
    );
  });

  it.each(EDGE_FILES.flatMap((file) => Object.keys(EXPECTED_ORDERS).map((table) => [file, table] as const)))(
    '%s の %s の問い合わせは、期待する列・向き・順で並べる',
    (file, table) => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const bodies = queryBodiesOf(source, table);
      expect(bodies, `${file}: ${table}`).toHaveLength(1);
      expect(orderCallsOf(bodies[0])).toEqual(EXPECTED_ORDERS[table as keyof typeof EXPECTED_ORDERS]);
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
});
