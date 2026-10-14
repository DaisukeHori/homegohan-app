// @vitest-environment node
/**
 * #1522 カタログの取り込み (_shared/catalog/import-runner.ts) の run の行が 'running' のまま残らない
 *
 * 以前は、catalog_import_runs に status 'running' の行を入れたあと、一覧ページの取得で例外が出ると
 * (Firecrawl の鍵が無いときの MissingEnvError・Firecrawl の失敗など)、外側の catch が 503 / 500 を返すだけで、
 * 行は 'running' のまま残っていた。いまは応答を返す前に、行を 'failed' (表の CHECK 制約にある語彙) にし、
 * completed_at と件数と error_log を書く。error_log は 'partial' のときと同じ形 (JSON の配列。各要素は
 * { categoryCode, url, error })。
 *
 * DB は実際には使わず、supabase-js の createClient を差し替えて、どの表にどんな書き込みをしたかを記録する。
 *
 * #1540 で足した見張り:
 * - 完了の更新 ('completed' / 'partial') が例外を投げても、済んだ取り込みを 'failed' に書き換えず 200 を返す
 *   (以前は完了の更新が try の中にあり、例外が外の catch に届くと markImportRunFailed が呼ばれていた)。
 * - カテゴリの last_crawled_at の更新の失敗を黙って捨てず、ログに残す (取り込みは続ける)。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MISSING_ENV_ERROR_CODE,
  MISSING_ENV_ERROR_MESSAGE,
  MISSING_ENV_HTTP_STATUS,
} from "../supabase/functions/_shared/missing-env.ts";

const SERVICE_ROLE_KEY = "test-service-role-key";
const SUPABASE_URL = "http://127.0.0.1:54321";
const RUN_ID = "run-1";
/** Firecrawl が失敗を返すときの状態コード (Firecrawl 側の障害) */
const FIRECRAWL_FAILURE_STATUS = 500;
/** 外側の catch が、設定の不足以外の失敗に返す状態コード */
const INTERNAL_ERROR_STATUS = 500;

type Write = { table: string; kind: "insert" | "update"; payload: Record<string, unknown>; eq?: [string, unknown] };

const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  handlers: [] as Array<(req: Request) => Promise<Response> | Response>,
  /** 表の名前 → select で返す行 */
  tables: {} as Record<string, unknown[]>,
  writes: [] as Array<{ table: string; kind: "insert" | "update"; payload: Record<string, unknown>; eq?: [string, unknown] }>,
  /** catalog_import_runs の update が返すエラー (null なら成功) */
  runUpdateError: null as { message: string } | null,
  /** catalog_import_runs の update が投げる例外 (null なら投げない。#1540) */
  runUpdateThrows: null as Error | null,
  /** catalog_source_categories の update が返すエラー (null なら成功。#1540) */
  categoryUpdateError: null as { message: string } | null,
  loggedErrors: [] as string[],
  /** logger.error に渡された文と付帯情報 (#1540) */
  loggedErrorEntries: [] as Array<{ message: string; metadata: Record<string, unknown> | undefined }>,
}));

type QueryResult = { data: unknown; error: unknown };

function selectQuery(rows: unknown[]) {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: async (): Promise<QueryResult> => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve, reject),
  };
  return query;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      ...selectQuery(h.tables[table] ?? []),
      insert: (payload: Record<string, unknown>) => {
        h.writes.push({ table, kind: "insert", payload });
        const result: QueryResult = { data: null, error: null };
        return {
          select: () => ({ single: async (): Promise<QueryResult> => ({ data: { id: RUN_ID }, error: null }) }),
          then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject),
        };
      },
      update: (payload: Record<string, unknown>) => ({
        eq: async (column: string, value: unknown): Promise<QueryResult> => {
          h.writes.push({ table, kind: "update", payload, eq: [column, value] });
          if (table === "catalog_import_runs" && h.runUpdateThrows) throw h.runUpdateThrows;
          if (table === "catalog_source_categories") return { data: null, error: h.categoryUpdateError };
          return { data: null, error: table === "catalog_import_runs" ? h.runUpdateError : null };
        },
      }),
    }),
  }),
}));

vi.mock("@supabase/functions-js/edge-runtime.d.ts", () => ({}));

// ロガーは app_logs へ書き込むので差し替える。error の文だけを記録する
vi.mock("../supabase/functions/_shared/db-logger.ts", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, _error?: unknown, metadata?: Record<string, unknown>) => {
      h.loggedErrors.push(message);
      h.loggedErrorEntries.push({ message, metadata });
    },
    withUser: () => ({}),
  }),
  generateRequestId: () => "req_test",
}));

// 認証は通す。ここで確かめたいのは認証の後の run の行の扱い
vi.mock("../supabase/functions/_shared/auth.ts", () => ({
  requireServiceRole: async () => null,
}));

const SOURCE_ROW = { id: "source-1", code: "seven_eleven_jp", brand_name: "セブン-イレブン", is_active: true, metadata_json: {} };
const ONIGIRI = {
  id: "category-1",
  category_code: "onigiri",
  category_name: "おにぎり",
  list_url: "https://www.sej.co.jp/products/a/onigiri/",
  crawl_priority: 1,
};
const BENTO = {
  id: "category-2",
  category_code: "bento",
  category_name: "お弁当",
  list_url: "https://www.sej.co.jp/products/a/bento/",
  crawl_priority: 2,
};
const ITEM_URL = "https://www.sej.co.jp/products/a/item/040123/";

let handler: (req: Request) => Promise<Response> | Response;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;
/** Firecrawl への呼び出しごとに返す応答 (先頭から順に使う。尽きたら「何も見つからない」) */
let firecrawlResponses: Array<() => Response>;
const fetchCalls: string[] = [];

function firecrawlOk(json: Record<string, unknown>): () => Response {
  return () => new Response(JSON.stringify({ success: true, data: { json } }), { status: 200 });
}

function firecrawlFailure(): () => Response {
  return () => new Response(JSON.stringify({ success: false, error: "upstream" }), { status: FIRECRAWL_FAILURE_STATUS });
}

beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: (key: string) => h.env[key] },
    serve: (fn: (req: Request) => Promise<Response> | Response) => {
      h.handlers.push(fn);
    },
  });
  await import("../supabase/functions/import-seven-eleven-catalog/index.ts");
  expect(h.handlers).toHaveLength(1);
  handler = h.handlers[0];
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  h.env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY, FIRECRAWL_API_KEY: "fc-key" };
  h.tables = { catalog_sources: [SOURCE_ROW], catalog_source_categories: [ONIGIRI] };
  h.writes.length = 0;
  h.runUpdateError = null;
  h.runUpdateThrows = null;
  h.categoryUpdateError = null;
  h.loggedErrors.length = 0;
  h.loggedErrorEntries.length = 0;
  fetchCalls.length = 0;
  firecrawlResponses = [];
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    const next = firecrawlResponses.shift();
    return next ? next() : firecrawlOk({ itemUrls: [], categoryUrls: [] })();
  });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  consoleError.mockRestore();
});

function runImport(body: Record<string, unknown> = {}): Promise<Response> {
  return Promise.resolve(
    handler(
      new Request("http://localhost/functions/v1/import-seven-eleven-catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

function runWrites(): Write[] {
  return h.writes.filter((write) => write.table === "catalog_import_runs");
}

/** run の行への書き込みが「'running' で入れて、1 回だけ更新した」形であること。更新の中身を返す */
function expectInsertedThenUpdatedOnce(): Record<string, unknown> {
  const writes = runWrites();
  expect(writes.map((write) => write.kind)).toEqual(["insert", "update"]);
  expect(writes[0].payload.status).toBe("running");
  expect(writes[1].eq).toEqual(["id", RUN_ID]);
  return writes[1].payload;
}

describe("run の行を入れたあとに一覧ページの取得で失敗したら、行を 'failed' にしてから応答する (#1522)", () => {
  it("Firecrawl の鍵が無い: 503 (固定の文と code) を返し、行は 'failed'。error_log に変数名を入れない", async () => {
    h.env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY };

    const res = await runImport();

    expect(res.status).toBe(MISSING_ENV_HTTP_STATUS);
    expect(await res.json()).toEqual({ success: false, error: MISSING_ENV_ERROR_MESSAGE, code: MISSING_ENV_ERROR_CODE });
    expect(fetchCalls).toEqual([]);

    const update = expectInsertedThenUpdatedOnce();
    expect(update.status).toBe("failed");
    expect(typeof update.completed_at).toBe("string");
    expect(Number.isNaN(Date.parse(String(update.completed_at)))).toBe(false);
    expect(update).toMatchObject({
      pages_total: 0,
      products_seen: 0,
      products_inserted: 0,
      products_updated: 0,
      products_unchanged: 0,
      products_discontinued: 0,
    });
    expect(JSON.parse(String(update.error_log))).toEqual([
      { categoryCode: ONIGIRI.category_code, url: null, error: MISSING_ENV_ERROR_MESSAGE },
    ]);
    for (const name of ["FIRECRAWL_API_KEY", "FIRECRAWL_AUTH_TOKEN", "FIRECRAWL_BASE_URL"]) {
      expect(String(update.error_log)).not.toContain(name);
    }
  });

  it("Firecrawl が失敗を返す: 500 を返し、行は 'failed'。error_log には応答の本文と同じ文が入る", async () => {
    firecrawlResponses = [firecrawlFailure()];

    const res = await runImport();
    const body = (await res.json()) as { success: boolean; error: string };

    expect(res.status).toBe(INTERNAL_ERROR_STATUS);
    expect(body.success).toBe(false);
    expect(body.error).toContain(`Firecrawl scrape failed (${FIRECRAWL_FAILURE_STATUS})`);

    const update = expectInsertedThenUpdatedOnce();
    expect(update.status).toBe("failed");
    expect(JSON.parse(String(update.error_log))).toEqual([
      { categoryCode: ONIGIRI.category_code, url: null, error: body.error },
    ]);
  });

  it("それまでの商品ごとの失敗は残し、そのあとに run を止めた失敗を足す ('partial' のときと同じ形)", async () => {
    h.tables = { catalog_sources: [SOURCE_ROW], catalog_source_categories: [ONIGIRI, BENTO] };
    firecrawlResponses = [
      // おにぎりの一覧: 商品が 1 つ
      firecrawlOk({ itemUrls: [ITEM_URL], categoryUrls: [] }),
      // その商品の詳細: 失敗 (商品ごとの失敗として数え、取り込みは続ける)
      firecrawlFailure(),
      // お弁当の一覧: 失敗 (run を止める)
      firecrawlFailure(),
    ];

    const res = await runImport();

    expect(res.status).toBe(INTERNAL_ERROR_STATUS);
    expect(fetchCalls).toHaveLength(3);
    const update = expectInsertedThenUpdatedOnce();
    expect(update.status).toBe("failed");
    expect(update).toMatchObject({ pages_total: 1, products_seen: 1, products_inserted: 0 });
    const entries = JSON.parse(String(update.error_log)) as Array<{ categoryCode: string | null; url: string | null; error: string }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ categoryCode: ONIGIRI.category_code, url: ITEM_URL });
    expect(entries[0].error).toContain(`Firecrawl scrape failed (${FIRECRAWL_FAILURE_STATUS})`);
    expect(entries[1]).toMatchObject({ categoryCode: BENTO.category_code, url: null });
    expect(entries[1].error).toContain(`Firecrawl scrape failed (${FIRECRAWL_FAILURE_STATUS})`);
  });

  it("行を 'failed' にする更新が失敗しても、元の失敗の応答 (503) を返し、更新の失敗をログに残す", async () => {
    h.env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY };
    h.runUpdateError = { message: "update failed" };

    const res = await runImport();

    expect(res.status).toBe(MISSING_ENV_HTTP_STATUS);
    expect(await res.json()).toEqual({ success: false, error: MISSING_ENV_ERROR_MESSAGE, code: MISSING_ENV_ERROR_CODE });
    expect(expectInsertedThenUpdatedOnce().status).toBe("failed");
    expect(h.loggedErrors).toContain("Failed to mark catalog import run as failed");
  });
});

describe("失敗しなかったときの run の行は以前のまま (#1522 の回帰の見張り)", () => {
  it("何も見つからずに終わったら 200 で 'completed'・error_log は null", async () => {
    const res = await runImport();

    expect(res.status).toBe(200);
    const update = expectInsertedThenUpdatedOnce();
    expect(update.status).toBe("completed");
    expect(update.error_log).toBeNull();
  });

  it("商品ごとの失敗だけなら 200 で 'partial'・error_log は商品ごとの失敗の配列", async () => {
    firecrawlResponses = [firecrawlOk({ itemUrls: [ITEM_URL], categoryUrls: [] }), firecrawlFailure()];

    const res = await runImport();

    expect(res.status).toBe(200);
    const update = expectInsertedThenUpdatedOnce();
    expect(update.status).toBe("partial");
    const entries = JSON.parse(String(update.error_log)) as Array<{ categoryCode: string; url: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ categoryCode: ONIGIRI.category_code, url: ITEM_URL });
  });

  it("完了の更新が失敗しても応答は 200 のまま。行が残ったことをログに残す", async () => {
    h.runUpdateError = { message: "update failed" };

    const res = await runImport();

    expect(res.status).toBe(200);
    expect(expectInsertedThenUpdatedOnce().status).toBe("completed");
    expect(h.loggedErrors).toContain("Failed to mark catalog import run as finished");
  });

  it("dryRun は run の行を入れないので、失敗しても更新しない", async () => {
    h.env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY };

    const res = await runImport({ dryRun: true });

    expect(res.status).toBe(MISSING_ENV_HTTP_STATUS);
    expect(runWrites()).toEqual([]);
  });
});

describe("完了の記録の失敗は、取り込みの失敗として扱わない (#1540)", () => {
  /** 完了の更新が投げる例外の文 (手で書いた値) */
  const COMPLETE_UPDATE_THROW_MESSAGE = "network down while marking finished";

  it("完了の更新が例外を投げても 200 のまま。行を 'failed' に書き換えず、記録しようとした status をログに残す", async () => {
    h.runUpdateThrows = new Error(COMPLETE_UPDATE_THROW_MESSAGE);

    const res = await runImport();
    const body = (await res.json()) as { success: boolean; importRunId: string | null };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, importRunId: RUN_ID });
    // 'running' の挿入と完了の更新の 1 回だけ。'failed' への更新 (markImportRunFailed) は無い
    expect(expectInsertedThenUpdatedOnce().status).toBe("completed");
    expect(runWrites().some((write) => write.payload.status === "failed")).toBe(false);
    expect(h.loggedErrors).toContain("Failed to mark catalog import run as finished");
    expect(h.loggedErrors).not.toContain("Failed to mark catalog import run as failed");
    expect(h.loggedErrors).not.toContain("Convenience catalog import failed");
    const entry = h.loggedErrorEntries.find((e) => e.message === "Failed to mark catalog import run as finished");
    expect(entry?.metadata).toEqual({ importRunId: RUN_ID, status: "completed" });
  });

  it("商品ごとの失敗があり完了の更新が例外を投げても 200 のまま。記録しようとした status は 'partial'", async () => {
    firecrawlResponses = [firecrawlOk({ itemUrls: [ITEM_URL], categoryUrls: [] }), firecrawlFailure()];
    h.runUpdateThrows = new Error(COMPLETE_UPDATE_THROW_MESSAGE);

    const res = await runImport();

    expect(res.status).toBe(200);
    expect(expectInsertedThenUpdatedOnce().status).toBe("partial");
    expect(runWrites().some((write) => write.payload.status === "failed")).toBe(false);
    const entry = h.loggedErrorEntries.find((e) => e.message === "Failed to mark catalog import run as finished");
    expect(entry?.metadata).toEqual({ importRunId: RUN_ID, status: "partial" });
  });
});

describe("カテゴリの last_crawled_at の更新の失敗をログに残す (#1540)", () => {
  it("更新がエラーを返したら、カテゴリを添えてログに残し、取り込みは続けて 'completed' にする", async () => {
    h.categoryUpdateError = { message: "category update failed" };

    const res = await runImport();

    expect(res.status).toBe(200);
    const categoryWrites = h.writes.filter((write) => write.table === "catalog_source_categories");
    expect(categoryWrites).toHaveLength(1);
    expect(categoryWrites[0].eq).toEqual(["id", ONIGIRI.id]);
    expect(typeof categoryWrites[0].payload.last_crawled_at).toBe("string");
    expect(expectInsertedThenUpdatedOnce().status).toBe("completed");
    const entry = h.loggedErrorEntries.find((e) => e.message === "Failed to record catalog category last_crawled_at");
    expect(entry?.metadata).toEqual({ importRunId: RUN_ID, categoryId: ONIGIRI.id, categoryCode: ONIGIRI.category_code });
  });

  it("更新が成功したらログに何も残さない", async () => {
    const res = await runImport();

    expect(res.status).toBe(200);
    expect(h.writes.filter((write) => write.table === "catalog_source_categories")).toHaveLength(1);
    expect(h.loggedErrors).toEqual([]);
  });
});
