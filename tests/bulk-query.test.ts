// @vitest-environment node
//
// #1306: 集計バッチ (aggregate-org-stats / calculate-segment-stats) の PostgREST の読み書きの部品。
// supabase-js をそのまま使うと、(1) 失敗が例外にならず「行が無い」と見分けがつかない、
// (2) 1 回の応答が 1000 行で黙って打ち切られる、(3) .in() の ids で URL が長くなる、で集計値が黙って狂う。

import { describe, expect, it } from "vitest";

import {
  API_MAX_ROWS,
  QueryError,
  chunkArray,
  embeddedOne,
  fetchAllRows,
  throwIfError,
  type PagedQuery,
  type QueryResult,
} from "../supabase/functions/_shared/bulk-query.ts";

interface Row {
  id: number;
}

const rowsOf = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i }));

/**
 * PostgREST の応答を真似るテーブル。1 回の応答は最大 cap 行。
 * range が無ければ先頭から cap 行、range(from, to) があればその範囲 (最大 cap 行)。
 */
function fakeTable(rows: Row[], options: { cap?: number; failOnCall?: number; error?: { message: string; code?: string } } = {}) {
  const { cap = API_MAX_ROWS, failOnCall, error = { message: "boom", code: "XX000" } } = options;
  const log = { queries: 0, orders: [] as string[], ranges: [] as Array<[number, number]> };

  const buildQuery = (): PagedQuery<Row> => {
    log.queries += 1;
    const callNo = log.queries;
    let range: [number, number] | null = null;
    const query: PagedQuery<Row> = {
      order(column) {
        log.orders.push(column);
        return query;
      },
      range(from, to) {
        range = [from, to];
        log.ranges.push([from, to]);
        return query;
      },
      then(onfulfilled, onrejected) {
        const result: QueryResult<Row> =
          failOnCall === callNo
            ? { data: null, error }
            : { data: range ? rows.slice(range[0], Math.min(range[1] + 1, range[0] + cap)) : rows.slice(0, cap), error: null };
        return Promise.resolve(result).then(onfulfilled, onrejected);
      },
    };
    return query;
  };

  return { buildQuery, log };
}

describe("fetchAllRows: 全件を取る (#1306)", () => {
  it("API の上限 (1000 行) 未満なら、クエリを 1 回発行するだけで、order / range は足さない", async () => {
    const table = fakeTable(rowsOf(3));
    await expect(fetchAllRows("t", table.buildQuery)).resolves.toEqual(rowsOf(3));
    expect(table.log).toEqual({ queries: 1, orders: [], ranges: [] });
  });

  it("0 件でも 1 回で終わる", async () => {
    const table = fakeTable([]);
    await expect(fetchAllRows("t", table.buildQuery)).resolves.toEqual([]);
    expect(table.log.queries).toBe(1);
  });

  it("999 件 (上限の 1 つ手前) はそのまま全件", async () => {
    const table = fakeTable(rowsOf(API_MAX_ROWS - 1));
    const rows = await fetchAllRows("t", table.buildQuery);
    expect(rows).toHaveLength(API_MAX_ROWS - 1);
    expect(table.log.queries).toBe(1);
  });

  it("ちょうど 1000 件は、打ち切られたか分からないのでページ送りで取り直す (重複も欠けも無い)", async () => {
    const table = fakeTable(rowsOf(API_MAX_ROWS));
    const rows = await fetchAllRows("t", table.buildQuery);
    expect(rows).toEqual(rowsOf(API_MAX_ROWS));
    // 1 回目 (そのまま) + ページ送り 2 回 (1000 行, 空)
    expect(table.log.queries).toBe(3);
    expect(table.log.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("2500 件は、上限で打ち切られても全件を順番どおりに返す", async () => {
    const table = fakeTable(rowsOf(2500));
    const rows = await fetchAllRows("t", table.buildQuery);
    expect(rows).toHaveLength(2500);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
    expect(table.log.ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [2500, 3499],
    ]);
  });

  it("ページ送りのときだけ order を足す。既定は id、orderColumn で変えられる", async () => {
    // 1200 件: そのまま 1 回 (1000 行) → ページ送り 3 回 (1000 行, 200 行, 空)。order はページ送りの 3 回にだけ付く
    const table = fakeTable(rowsOf(1200));
    await fetchAllRows("t", table.buildQuery);
    expect(table.log.queries).toBe(4);
    expect(table.log.orders).toEqual(["id", "id", "id"]);

    const other = fakeTable(rowsOf(1200));
    await fetchAllRows("t", other.buildQuery, { orderColumn: "created_at" });
    expect(other.log.orders).toEqual(["created_at", "created_at", "created_at"]);
  });

  it("ページ送りの途中で応答の上限が小さくなっても、飛ばしも二重取りもしない", async () => {
    // 1 回目 (そのまま) は 1000 行返る。ページ送りの 2 ページ目から、サーバーが 400 行ずつしか返さなくなる想定
    const rows = rowsOf(1500);
    let call = 0;
    const buildQuery = (): PagedQuery<Row> => {
      call += 1;
      const callNo = call;
      let range: [number, number] | null = null;
      const query: PagedQuery<Row> = {
        order: () => query,
        range(from, to) {
          range = [from, to];
          return query;
        },
        then(onfulfilled, onrejected) {
          const cap = callNo >= 3 ? 400 : 1000;
          const data = range ? rows.slice(range[0], Math.min(range[1] + 1, range[0] + cap)) : rows.slice(0, cap);
          return Promise.resolve({ data, error: null } as QueryResult<Row>).then(onfulfilled, onrejected);
        },
      };
      return query;
    };

    const result = await fetchAllRows("t", buildQuery);
    expect(result.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("1 回目のクエリが失敗したら、ラベルと PostgREST のコードを含む QueryError を投げる", async () => {
    const table = fakeTable(rowsOf(3), { failOnCall: 1, error: { message: "Could not find a relationship", code: "PGRST200" } });
    const error = await fetchAllRows("planned_meals の取得", table.buildQuery).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toBe("planned_meals の取得: Could not find a relationship (PGRST200)");
    expect((error as QueryError).code).toBe("PGRST200");
    expect((error as QueryError).label).toBe("planned_meals の取得");
  });

  it("ページ送りの途中で失敗したら、そこまでの分を返さず例外にする (欠けた集計を使わせない)", async () => {
    const table = fakeTable(rowsOf(2500), { failOnCall: 3 });
    await expect(fetchAllRows("t", table.buildQuery)).rejects.toBeInstanceOf(QueryError);
  });

  it("data が null で error も無い応答は、0 件として扱う", async () => {
    const buildQuery = (): PagedQuery<Row> => {
      const query: PagedQuery<Row> = {
        order: () => query,
        range: () => query,
        then: (onfulfilled, onrejected) => Promise.resolve({ data: null, error: null } as QueryResult<Row>).then(onfulfilled, onrejected),
      };
      return query;
    };
    await expect(fetchAllRows("t", buildQuery)).resolves.toEqual([]);
  });

  it("サーバーが range を無視して同じ行を返し続けても、maxPages で止まる (無限に回らない)", async () => {
    const buildQuery = (): PagedQuery<Row> => {
      const query: PagedQuery<Row> = {
        order: () => query,
        range: () => query,
        then: (onfulfilled, onrejected) =>
          Promise.resolve({ data: rowsOf(API_MAX_ROWS), error: null } as QueryResult<Row>).then(onfulfilled, onrejected),
      };
      return query;
    };
    const error = await fetchAllRows("t", buildQuery, { maxPages: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toContain("3 ページ");
  });
});

describe("throwIfError", () => {
  it("error が無ければ何もしない", () => {
    expect(() => throwIfError("t", null)).not.toThrow();
    expect(() => throwIfError("t", undefined)).not.toThrow();
  });

  it("error があれば QueryError。message にラベルとコード、details / hint も保持する", () => {
    let thrown: unknown;
    try {
      throwIfError("badges の取得", { message: "invalid input syntax for type json", code: "22P02", details: "Token", hint: "h" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toBeInstanceOf(QueryError);
    const error = thrown as QueryError;
    expect(error.name).toBe("QueryError");
    expect(error.message).toBe("badges の取得: invalid input syntax for type json (22P02)");
    expect([error.code, error.details, error.hint]).toEqual(["22P02", "Token", "h"]);
  });

  it("コードが無い error は、message にコードの括弧を付けない", () => {
    expect(() => throwIfError("t", { message: "fetch failed" })).toThrow("t: fetch failed");
    expect(() => throwIfError("t", { message: "fetch failed" })).not.toThrow(/\(/);
  });
});

describe("chunkArray", () => {
  it("size 件ずつに分け、最後は余りの件数", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
    expect(chunkArray([1, 2], 5)).toEqual([[1, 2]]);
  });

  it("空の配列は、チャンクが 0 個 (空の .in() を発行しない)", () => {
    expect(chunkArray([], 100)).toEqual([]);
  });

  it("元の配列を変更しない", () => {
    const items = [1, 2, 3];
    chunkArray(items, 2);
    expect(items).toEqual([1, 2, 3]);
  });

  it("size が 1 未満・小数・NaN なら RangeError", () => {
    for (const size of [0, -1, 1.5, Number.NaN]) {
      expect(() => chunkArray([1], size)).toThrow(RangeError);
    }
  });
});

describe("embeddedOne: 多対一の埋め込みを 1 件にそろえる", () => {
  const ref = { user_id: "u1", day_date: "2026-10-08" };

  it("オブジェクト (PostgREST の実際の応答) はそのまま", () => {
    expect(embeddedOne(ref)).toBe(ref);
  });

  it("配列 (supabase-js の型推定) は先頭の 1 件", () => {
    expect(embeddedOne([ref])).toBe(ref);
  });

  it("null / undefined / 空配列は null", () => {
    expect(embeddedOne(null)).toBeNull();
    expect(embeddedOne(undefined)).toBeNull();
    expect(embeddedOne([])).toBeNull();
  });
});
