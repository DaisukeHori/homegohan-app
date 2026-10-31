// @vitest-environment node
/**
 * #2150 Q1-a: 商品の検索 (searchCatalogProducts。lib/catalog-products.ts) の並び。
 *
 * 候補は更新した日時の新しい順に件数の上限 (40 件) まで読み、そこから点数の高い順に並べ替える (並べ替えは安定)。
 * 以前は updated_at だけで並べていたので、一括の取り込みで同じ更新の日時になった商品のうち、どれが 40 件に入るか・
 * 同じ点数の候補がどの順に出るかが DB 任せだった。いまは最後に id の昇順を重ねる (LIST_ORDERS.catalogProductSearch)。
 *
 * Supabase のクライアントは作り物 (order・limit を実際に当てる。並びと件数を当てない作り物では、どの行が候補に入るかを
 * 確かめられないため)。or の絞り込みは当てない (どの行も検索の語を名前に持つ)。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { searchCatalogProducts } from '../lib/catalog-products';

type Row = Record<string, unknown>;
interface OrderCall {
  column: string;
  ascending: boolean;
  nullsFirst: boolean;
}

/** 検索の語 (どの行の名前にも入れる) */
const QUERY = 'サラダチキン';
/** searchCatalogProducts が読む件数の上限 (lib/catalog-products.ts の SEARCH_FETCH_LIMIT と同じ値を、ここでは手で書く) */
const FETCH_LIMIT = 40;
/** 一括の取り込みで同じになった更新の日時 */
const BULK_UPDATED_AT = '2026-10-01T00:00:00.000Z';
/** それより新しい更新の日時 */
const NEWER_UPDATED_AT = '2026-10-02T00:00:00.000Z';
/** 一括の取り込みで同じ日時になった商品の数 (読む件数の上限より多い) */
const BULK_COUNT = 50;

/** 並びの鍵 1 つで 2 行を比べる (NULL の位置も order の指定どおり) */
function compareBy(a: Row, b: Row, order: OrderCall): number {
  const x = a[order.column];
  const y = b[order.column];
  const xNull = x === null || x === undefined;
  const yNull = y === null || y === undefined;
  if (xNull || yNull) {
    if (xNull && yNull) return 0;
    return xNull === order.nullsFirst ? -1 : 1;
  }
  const sign = order.ascending ? 1 : -1;
  if (String(x) < String(y)) return -sign;
  if (String(x) > String(y)) return sign;
  return 0;
}

/** catalog_products の作り物の問い合わせ。order と limit を当て、読んだ並びと件数を記録する */
function makeSupabase(rows: Row[], reads: Array<{ orders: OrderCall[]; limit: number | null }>): SupabaseClient {
  const orders: OrderCall[] = [];
  let limit: number | null = null;
  const result = () => {
    reads.push({ orders: [...orders], limit });
    let selected = [...rows];
    if (orders.length > 0) {
      selected.sort((a, b) => {
        for (const order of orders) {
          const c = compareBy(a, b, order);
          if (c !== 0) return c;
        }
        return 0;
      });
    }
    if (limit !== null) selected = selected.slice(0, limit);
    return { data: selected, error: null };
  };
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
        }
        if (prop === 'order') {
          return (column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => {
            const ascending = options?.ascending ?? true;
            orders.push({ column, ascending, nullsFirst: options?.nullsFirst ?? !ascending });
            return builder;
          };
        }
        if (prop === 'limit') {
          return (n: number) => {
            limit = n;
            return builder;
          };
        }
        return () => builder;
      },
    },
  );
  const client = { from: (table: string) => (table === 'catalog_products' ? builder : null) };
  return client as unknown as SupabaseClient;
}

/** n 番目の商品の id (文字列の順 = 数の順になるよう 3 桁にそろえる) */
const productId = (n: number) => `prod-${String(n).padStart(3, '0')}`;

/** 商品の行 (検索の語を名前に持つ。点数がそろうよう、名前・ブランドは同じ形にする) */
function productRow(n: number, updatedAt: string): Row {
  return {
    id: productId(n),
    source_id: 'source-1',
    name: `${QUERY} ${String(n).padStart(3, '0')}`,
    brand_name: 'ブランド',
    category_code: null,
    description: null,
    main_image_url: null,
    canonical_url: `https://example.test/${n}`,
    price_yen: null,
    calories_kcal: null,
    protein_g: null,
    fat_g: null,
    carbs_g: null,
    sodium_g: null,
    fiber_g: null,
    sugar_g: null,
    availability_status: 'active',
    updated_at: updatedAt,
    catalog_sources: { code: 'SRC1', brand_name: 'ブランド' },
  };
}

describe('#2150 Q1-a 商品の検索の並び', () => {
  it('更新した日時の新しい順のあと id の昇順で読み、同じ日時の商品のうち id の小さい側が件数の上限に入り、その順に出る', async () => {
    const newer = productRow(999, NEWER_UPDATED_AT);
    // 一括の取り込みで同じ日時になった商品 (上限の件数を超える)。行の配列は id の大きい順に置く
    // (配列の順のまま返ったら、id の大きい側が候補に入ってしまう)
    const bulk = Array.from({ length: BULK_COUNT }, (_, i) => productRow(BULK_COUNT - i, BULK_UPDATED_AT));
    const reads: Array<{ orders: OrderCall[]; limit: number | null }> = [];

    const products = await searchCatalogProducts(makeSupabase([...bulk, newer], reads), QUERY, { limit: FETCH_LIMIT });

    expect(reads).toEqual([
      {
        orders: [
          { column: 'updated_at', ascending: false, nullsFirst: true },
          { column: 'id', ascending: true, nullsFirst: false },
        ],
        limit: FETCH_LIMIT,
      },
    ]);
    // 新しい 1 件と、同じ日時の商品のうち id の小さい側の 39 件 (prod-001〜prod-039) が、読んだ順に出る
    // (どの候補も点数が同じで、点数の並べ替えは安定なので、読んだ順がそのまま残る)
    const ids = products.map((product) => product.id);
    expect(ids).toEqual([productId(999), ...Array.from({ length: FETCH_LIMIT - 1 }, (_, i) => productId(i + 1))]);
    expect(ids).not.toContain(productId(FETCH_LIMIT));
  });
});
