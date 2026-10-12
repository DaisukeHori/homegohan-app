// @vitest-environment node
/**
 * #1467 Edge Function の応答の本文に、環境変数の名前を出さない (#1182 の「本文に変数名を出さない」を Edge にも当てる)
 *
 * 以前は、必須の環境変数が無いときに変数名入りの文を返したり投げたりしていた。
 *  - _shared/catalog/import-runner.ts: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' を投げ、catch が 500 の本文に返していた
 *  - process-meal-image-jobs: モジュールの読み込み時に 'Missing SUPABASE_URL or service role key' を投げていた (関数が起動できない)
 *  - stripe-price-sync: 503 の本文に 'STRIPE_SECRET_KEY is not configured'
 *  - ほかにも _shared (fast-llm・v4-fast-llm・nutrition-calculator・firecrawl-client・ingredient-matcher) と
 *    埋め込みを使う関数 (generate-menu-v4/v5・knowledge-gpt など)・shared/dataset-embedding.mjs が、
 *    'Missing XAI_API_KEY' / `Missing ${DATASET_EMBEDDING_API_KEY_ENV}` のように変数名を message に入れて投げていた。
 *    呼び出し元の catch が message を本文や記録に入れると、変数名が外に出る。
 *
 * いまは _shared/missing-env.ts の missingEnvError() が、変数名をサーバーのログにだけ残し、message が固定の文の
 * MissingEnvError を返す。応答は固定の文と code (SERVER_CONFIG_MISSING) の 503。
 *
 * ここでは (1) 実際のハンドラに要求を流して本文と状態コードを確かめ、(2) supabase/functions と shared/*.mjs の
 * 全域を構文木で走査して、例外・応答の文字列に環境変数の名前が残っていないことを確かめる。
 *
 * 走査の限界 (見張りであって証明ではない):
 *  - 変数名の一覧は、ソースに名前を書いて読んでいる箇所 (Deno.env.get("X")・readDenoEnv("X")・getEnv("X")・
 *    `const X_ENV = "NAME"`) から集める。名前を組み立てて読む書き方は一覧に入らない。
 *  - 見るのは throw 文・`new XxxError(...)`・応答を作る呼び出し (`new Response(...)`・`Response.json(...)`・
 *    名前が Response / jsonResponse で終わる関数) の引数の中の文字列と、テンプレートに埋め込んだ `*_ENV` の定数だけ。
 *    いったん変数に入れた文を投げる・console に出すだけのもの (ログは対象外) は見ない。
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isMissingEnvError,
  MISSING_ENV_ERROR_CODE,
  MISSING_ENV_ERROR_MESSAGE,
  MISSING_ENV_HTTP_STATUS,
  MISSING_ENV_SERVER_LOG_PREFIX,
  MissingEnvError,
  missingEnvError,
  missingEnvResponseBody,
} from "../supabase/functions/_shared/missing-env.ts";
import {
  DATASET_EMBEDDING_API_KEY_ENV,
  DATASET_EMBEDDING_MISSING_KEY_MESSAGE,
  fetchDatasetEmbeddings,
  getDatasetEmbeddingApiKey,
} from "../shared/dataset-embedding.mjs";

const ROOT = path.resolve(__dirname, "..");

const SERVICE_ROLE_KEY = "test-service-role-key";
const SUPABASE_URL = "http://127.0.0.1:54321";

const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  handlers: [] as Array<(req: Request) => Promise<Response> | Response>,
  createClientCalls: [] as unknown[][],
  googleClients: 0,
}));

// supabase-js: 接続しようとしたことを記録する (設定が足りないときは作らないことを確かめる)
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    h.createClientCalls.push(args);
    return {
      from: () => {
        throw new Error("DB には接続しない (テスト)");
      },
    };
  },
}));

// Deno 用の型定義の import (実行時の中身は無い)
vi.mock("@supabase/functions-js/edge-runtime.d.ts", () => ({}));

// Google の画像生成クライアント: 作られた回数だけ数える
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {};
    constructor() {
      h.googleClients += 1;
    }
  },
  createUserContent: (parts: unknown) => parts,
}));

// ロガーは app_logs へ書き込むので差し替える (https://esm.sh の import も避けられる)
vi.mock("../supabase/functions/_shared/db-logger.ts", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, withUser: () => ({}) }),
  generateRequestId: () => "req_test",
}));

// カタログ取り込みの認証 (CRON_SECRET / service role) は通す。ここで確かめたいのは認証の後の設定の不足
vi.mock("../supabase/functions/_shared/auth.ts", () => ({
  requireServiceRole: async () => null,
}));

beforeAll(() => {
  vi.stubGlobal("Deno", {
    env: { get: (key: string) => h.env[key] },
    serve: (handler: (req: Request) => Promise<Response> | Response) => {
      h.handlers.push(handler);
    },
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.env = {};
  h.createClientCalls.length = 0;
  h.googleClients = 0;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

/** console.error に出た行 (引数を空白でつないだもの) */
function loggedLines(): string[] {
  return consoleError.mock.calls.map((args: unknown[]) => args.map(String).join(" "));
}

/** 本文に、どの環境変数の名前も入っていないこと */
function expectNoEnvNames(text: string, names: readonly string[]): void {
  for (const name of names) expect(text).not.toContain(name);
}

/** 読み込んだ関数の Deno.serve のハンドラ (読み込みのたびに 1 つ増える) */
async function importHandler(modulePath: string): Promise<(req: Request) => Promise<Response> | Response> {
  const before = h.handlers.length;
  await import(/* @vite-ignore */ modulePath);
  expect(h.handlers.length).toBe(before + 1);
  return h.handlers[h.handlers.length - 1];
}

function post(url: string, init: { auth?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.auth !== undefined) headers.authorization = init.auth;
  return new Request(url, { method: "POST", headers, body: JSON.stringify(init.body ?? {}) });
}

// ─────────────────────────────────────────────────────────────────────────────
// _shared/missing-env.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("_shared/missing-env.ts (#1467)", () => {
  it("missingEnvError は変数名をログにだけ残し、message は固定の文。変数名は JSON にしても出てこない", () => {
    const error = missingEnvError(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);

    expect(error).toBeInstanceOf(MissingEnvError);
    expect(isMissingEnvError(error)).toBe(true);
    expect(error.message).toBe(MISSING_ENV_ERROR_MESSAGE);
    expect(error.code).toBe(MISSING_ENV_ERROR_CODE);
    expect(error.envNames).toEqual(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
    expectNoEnvNames(error.message, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
    expectNoEnvNames(JSON.stringify(error), ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
    expectNoEnvNames(JSON.stringify({ ...error }), ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
    expect(loggedLines()).toEqual([`${MISSING_ENV_SERVER_LOG_PREFIX} SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY`]);
  });

  it("応答の本文は固定の文と code だけ・状態コードは 503", () => {
    expect(missingEnvResponseBody()).toEqual({ error: "サーバーの設定が不足しています", code: "SERVER_CONFIG_MISSING" });
    expect(MISSING_ENV_HTTP_STATUS).toBe(503);
  });

  it("名前の似た別の例外は MissingEnvError と見なさない", () => {
    expect(isMissingEnvError(new Error(MISSING_ENV_ERROR_MESSAGE))).toBe(false);
    expect(isMissingEnvError(Object.assign(new Error("x"), { name: "MissingEnvError" }))).toBe(false);
  });
});

describe("shared/dataset-embedding.mjs: API キーが無いときも message に変数名を入れない (#1467)", () => {
  it("message は Edge の MISSING_ENV_ERROR_MESSAGE と同じ文で、MissingEnvError と見なせる", async () => {
    expect(DATASET_EMBEDDING_MISSING_KEY_MESSAGE).toBe(MISSING_ENV_ERROR_MESSAGE);

    let thrown: unknown;
    try {
      getDatasetEmbeddingApiKey(() => undefined);
    } catch (error) {
      thrown = error;
    }
    expect(isMissingEnvError(thrown)).toBe(true);
    expect((thrown as Error).message).toBe(MISSING_ENV_ERROR_MESSAGE);
    expectNoEnvNames(JSON.stringify(thrown), [DATASET_EMBEDDING_API_KEY_ENV]);

    await expect(fetchDatasetEmbeddings("text", { apiKey: "" })).rejects.toMatchObject({
      name: "MissingEnvError",
      message: MISSING_ENV_ERROR_MESSAGE,
    });
    // 変数名はサーバーのログにだけ残る
    expect(loggedLines()).toEqual([
      `${MISSING_ENV_SERVER_LOG_PREFIX} ${DATASET_EMBEDDING_API_KEY_ENV}`,
      `${MISSING_ENV_SERVER_LOG_PREFIX} ${DATASET_EMBEDDING_API_KEY_ENV}`,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 実際のハンドラ
// ─────────────────────────────────────────────────────────────────────────────

describe("stripe-price-sync: STRIPE_SECRET_KEY が無いときの 503 の本文 (#1467)", () => {
  let handler: (req: Request) => Promise<Response> | Response;

  beforeAll(async () => {
    // STRIPE_SECRET_KEY は読み込み時に読む。ここでは設定しないまま読み込む
    h.env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY };
    handler = await importHandler("../supabase/functions/stripe-price-sync/index.ts");
  });

  it("認証の後、503 で固定の文と code を返し、本文に変数名を出さない (変数名はログにだけ残る)", async () => {
    h.env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY };

    const res = await handler(post("http://localhost/functions/v1/stripe-price-sync", { auth: `Bearer ${SERVICE_ROLE_KEY}` }));
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: MISSING_ENV_ERROR_MESSAGE, code: MISSING_ENV_ERROR_CODE });
    expectNoEnvNames(text, ["STRIPE_SECRET_KEY"]);
    expect(loggedLines()).toContain(`${MISSING_ENV_SERVER_LOG_PREFIX} STRIPE_SECRET_KEY`);
  });
});

describe("stripe-price-sync: Supabase の接続情報だけが無いときは 503 にせず、旧 Price の無効化を飛ばして 200 (#1490)", () => {
  // ENV_SETUP.md の案内 (503 SERVER_CONFIG_MISSING は STRIPE_SECRET_KEY が無いときだけ) の裏付け。
  // Supabase の接続情報は旧 Price の ID を読むのにだけ使い、読めなければ無効化を全部スキップする (sync.ts の old_price_fetch_failed)
  const STRIPE_SECRET_KEY_VALUE = "sk_test_dummy";
  const NEW_PRICE_ID = "price_new_month";
  let handler: (req: Request) => Promise<Response> | Response;
  const fetchCalls: string[] = [];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // 環境変数は読み込み時に読むので、Supabase の接続情報を設定しないまま、別の読み込みとして読む
    h.env = { STRIPE_SECRET_KEY: STRIPE_SECRET_KEY_VALUE };
    vi.resetModules();
    handler = await importHandler("../supabase/functions/stripe-price-sync/index.ts");
  });

  beforeEach(() => {
    fetchCalls.length = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ id: NEW_PRICE_ID }), { status: 200 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("新しい Price を作り、旧 Price は読まずに無効化を飛ばして 200。本文に変数名を出さず、ログに名前を残す", async () => {
    h.env = { STRIPE_SECRET_KEY: STRIPE_SECRET_KEY_VALUE };

    const res = await handler(
      post("http://localhost/functions/v1/stripe-price-sync", {
        auth: "Bearer cron-secret",
        body: { plan_id: "plan-1", stripe_product_id: "prod_1", new_monthly_price_jpy: 980 },
      }),
    );
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      success: true,
      month: { new_stripe_price_id: NEW_PRICE_ID, deactivated: false, deactivation_skipped_reason: "old_price_fetch_failed" },
      year: null,
    });
    expectNoEnvNames(text, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY"]);
    // Stripe へは新しい Price の作成 1 回だけ (旧 Price の取り直し・無効化はしない)。DB には接続しない
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatch(/\/prices$/);
    expect(h.createClientCalls).toHaveLength(0);
    expect(loggedLines()).toContain(`${MISSING_ENV_SERVER_LOG_PREFIX} SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY`);
  });

  it("ENV_SETUP.md は、stripe-price-sync の 503 を STRIPE_SECRET_KEY だけとし、Supabase の接続情報だけが無いときの 200 を案内している", () => {
    const doc = fs.readFileSync(path.join(ROOT, "ENV_SETUP.md"), "utf-8");

    expect(doc).toContain("`stripe-price-sync` は `STRIPE_SECRET_KEY` だけです");
    expect(doc).toContain('"deactivation_skipped_reason":"old_price_fetch_failed"');
  });
});

describe("process-meal-image-jobs: 環境変数をリクエストの中で確かめる (#1467)", () => {
  let handler: (req: Request) => Promise<Response> | Response;
  const URL_ = "http://localhost/functions/v1/process-meal-image-jobs";
  const NAMES = ["SUPABASE_URL", "SERVICE_ROLE_JWT", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_AI_STUDIO_API_KEY", "GOOGLE_GEN_AI_API_KEY"];

  beforeAll(async () => {
    // 以前は、環境変数が無いと読み込みの時点で投げていた (読み込めること自体を確かめる)
    h.env = {};
    handler = await importHandler("../supabase/functions/process-meal-image-jobs/index.ts");
  });

  it("Supabase の接続情報が無いと、認証の前に 503 (固定の文と code) を返す。空の鍵と空の Authorization を一致させて通さない", async () => {
    for (const auth of [undefined, "Bearer ", `Bearer ${SERVICE_ROLE_KEY}`]) {
      const res = await handler(post(URL_, { auth }));
      const text = await res.text();

      expect(res.status).toBe(503);
      expect(JSON.parse(text)).toEqual({ error: MISSING_ENV_ERROR_MESSAGE, code: MISSING_ENV_ERROR_CODE });
      expectNoEnvNames(text, NAMES);
    }
    expect(h.createClientCalls).toEqual([]);
    expect(loggedLines()).toContain(`${MISSING_ENV_SERVER_LOG_PREFIX} SUPABASE_URL / SERVICE_ROLE_JWT / SUPABASE_SERVICE_ROLE_KEY`);
  });

  it("ログには足りない変数の名前だけを残す (URL だけが無ければ URL だけ)", async () => {
    h.env = { SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY };

    const res = await handler(post(URL_, { auth: `Bearer ${SERVICE_ROLE_KEY}` }));

    expect(res.status).toBe(503);
    expect(loggedLines()).toEqual([`${MISSING_ENV_SERVER_LOG_PREFIX} SUPABASE_URL`]);
  });

  it("Google AI のキーが無いと、認証の後に 503 (固定の文と code) を返す。認証に通らなければ従来どおり 401", async () => {
    h.env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY };

    const unauthorized = await handler(post(URL_, { auth: "Bearer wrong-key" }));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "Unauthorized" });

    const res = await handler(post(URL_, { auth: `Bearer ${SERVICE_ROLE_KEY}` }));
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: MISSING_ENV_ERROR_MESSAGE, code: MISSING_ENV_ERROR_CODE });
    expectNoEnvNames(text, NAMES);
    expect(h.createClientCalls).toEqual([]);
    expect(h.googleClients).toBe(0);
    expect(loggedLines()).toContain(`${MISSING_ENV_SERVER_LOG_PREFIX} GOOGLE_AI_STUDIO_API_KEY / GOOGLE_GEN_AI_API_KEY`);
  });

  it("設定がそろっていれば、クライアントを作って処理に進む (503 にしない)", async () => {
    h.env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY, GOOGLE_AI_STUDIO_API_KEY: "test-google-key" };

    const res = await handler(post(URL_, { auth: `Bearer ${SERVICE_ROLE_KEY}` }));

    // DB は罠にしてあるので、ジョブの取得で 500 になる (ここでは「設定の不足」の 503 にならないことだけを見る)
    expect(res.status).not.toBe(503);
    expect(h.createClientCalls).toEqual([[SUPABASE_URL, SERVICE_ROLE_KEY]]);
    expect(h.googleClients).toBe(1);
  });
});

describe("カタログ取り込み (_shared/catalog/import-runner.ts): Supabase の接続情報が無いとき (#1467)", () => {
  let handler: (req: Request) => Promise<Response> | Response;

  beforeAll(async () => {
    handler = await importHandler("../supabase/functions/import-seven-eleven-catalog/index.ts");
  });

  it("以前は 500 の本文に 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' を返していた。いまは 503 で固定の文と code", async () => {
    h.env = {};

    const res = await handler(post("http://localhost/functions/v1/import-seven-eleven-catalog", { body: { dryRun: true } }));
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ success: false, error: MISSING_ENV_ERROR_MESSAGE, code: MISSING_ENV_ERROR_CODE });
    expectNoEnvNames(text, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_JWT"]);
    expect(h.createClientCalls).toEqual([]);
    expect(loggedLines()).toContain(`${MISSING_ENV_SERVER_LOG_PREFIX} SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 全域の走査
// ─────────────────────────────────────────────────────────────────────────────

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** 呼び出し先の名前 (`foo` / `a.b`)。それ以外の形は null */
function calleeName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) return `${node.expression.text}.${node.name.text}`;
  return null;
}

/** 変数名を受け取ってログにだけ残す関数 (引数の文字列は本文に出ない) */
const ENV_NAME_LOGGERS = new Set(["missingEnvError", "logMissingEnv"]);

/** 応答を作る呼び出しか (`Response.json`・`jsonResponse` など、名前が Response / jsonResponse で終わるもの) */
function isResponseCall(name: string): boolean {
  return name === "Response.json" || /(Response|jsonResponse)$/.test(name);
}

/** ソースに名前を書いて読んでいる環境変数の名前 */
function collectEnvNames(source: string): string[] {
  const names = new Set<string>();
  const readCall = /\b(?:Deno\.env\.get|readDenoEnv|getEnv|env\.get)\(\s*["'`]([A-Z][A-Z0-9_]+)["'`]/g;
  const envConstant = /\bconst\s+[A-Z0-9_]+_ENV\s*=\s*["'`]([A-Z][A-Z0-9_]+)["'`]/g;
  for (const match of source.matchAll(readCall)) names.add(match[1]);
  for (const match of source.matchAll(envConstant)) names.add(match[1]);
  return [...names];
}

/**
 * 例外 (throw 文・`new XxxError(...)`) と応答を作る呼び出しの引数の中で、環境変数の名前を含む文字列と、
 * テンプレートに埋め込んだ `*_ENV` の定数がある行 (1 始まり)。missingEnvError / logMissingEnv の引数は見ない。
 */
function findEnvNamesInErrorsOrResponses(source: string, names: readonly string[], fileName = "file.ts"): number[] {
  const sf = parse(source, fileName);
  const lines = new Set<number>();
  const namePattern = new RegExp(`\\b(?:${names.join("|")})\\b`);
  const mark = (node: ts.Node) => lines.add(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  const scanStrings = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && ENV_NAME_LOGGERS.has(name)) return;
    }
    const text =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)
        ? node.text
        : null;
    if (text !== null && namePattern.test(text)) mark(node);
    if (ts.isTemplateSpan(node) && ts.isIdentifier(node.expression) && /_ENV$/.test(node.expression.text)) mark(node);
    ts.forEachChild(node, scanStrings);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) scanStrings(node.expression);
    if (ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (name && (/Error$/.test(name) || isResponseCall(name))) node.arguments?.forEach(scanStrings);
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && isResponseCall(name)) node.arguments.forEach(scanStrings);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...lines].sort((a, b) => a - b);
}

function collectFiles(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      files.push(...collectFiles(full, pattern));
    } else if (pattern.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe("走査の仕組みの確認 (検出が空振りしないこと)", () => {
  it("名前を書いて読んだ環境変数と、*_ENV の定数の値を集める", () => {
    const source = [
      'const a = Deno.env.get("SUPABASE_URL") ?? "";',
      "const b = readDenoEnv('XAI_API_KEY');",
      "const c = getEnv(`AIMLAPI_API_KEY`);",
      'export const DATASET_EMBEDDING_API_KEY_ENV = "OTHER_KEY";',
      "const d = Deno.env.get(name);",
    ].join("\n");

    expect(collectEnvNames(source).sort()).toEqual(["AIMLAPI_API_KEY", "OTHER_KEY", "SUPABASE_URL", "XAI_API_KEY"]);
  });

  it("例外・応答の文字列と、埋め込んだ *_ENV を見つけ、ログ・コメント・missingEnvError の引数は見つけない", () => {
    const names = ["SUPABASE_URL", "STRIPE_SECRET_KEY", "XAI_API_KEY"];
    const source = [
      'throw new Error("Missing SUPABASE_URL or service role key");', // 1
      'return jsonResponse({ error: "STRIPE_SECRET_KEY is not configured" }, 503);', // 2
      "throw new Error(`Missing ${DATASET_EMBEDDING_API_KEY_ENV}`);", // 3: 定数の埋め込み
      'return new Response(JSON.stringify({ error: "XAI_API_KEY" }), { status: 500 });', // 4
      'return Response.json({ error: `x ${y} SUPABASE_URL` });', // 5
      'console.error("Missing SUPABASE_URL");', // 6: ログは対象外
      '// throw new Error("XAI_API_KEY")', // 7: コメント
      'throw missingEnvError(["SUPABASE_URL", "XAI_API_KEY"]);', // 8: ログにだけ残す関数の引数
      'throw missingEnvError([DATASET_EMBEDDING_API_KEY_ENV]);', // 9
      'throw new Error("SUPABASE_URL_EXTRA is unrelated");', // 10: 別の名前 (語の境界)
      'logMissingEnv(["STRIPE_SECRET_KEY"]);', // 11
    ].join("\n");

    expect(findEnvNamesInErrorsOrResponses(source, names)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("Edge Function の例外・応答の文字列に環境変数の名前を書かない (#1467)", () => {
  const files = [
    ...collectFiles(path.join(ROOT, "supabase", "functions"), /\.ts$/),
    ...collectFiles(path.join(ROOT, "shared"), /\.mjs$/),
  ];
  const envNames = [...new Set(files.flatMap((file) => collectEnvNames(fs.readFileSync(file, "utf-8"))))];

  it("走査の対象と変数名の一覧が空でない (置き場の名前が変わっても空振りしない)", () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((file) => file.endsWith(path.join("_shared", "catalog", "import-runner.ts")))).toBe(true);
    expect(files.some((file) => file.endsWith(path.join("shared", "dataset-embedding.mjs")))).toBe(true);
    for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "XAI_API_KEY", "OPENAI_API_KEY", "AIMLAPI_API_KEY", "FIRECRAWL_API_KEY"]) {
      expect(envNames).toContain(name);
    }
  });

  it("例外・応答の文字列に、環境変数の名前が 1 つも無い", () => {
    const offenders = files.flatMap((file) => {
      const source = fs.readFileSync(file, "utf-8");
      // 構文木の解析は重いので、変数名も *_ENV の埋め込みも含まないファイルは読み飛ばす
      if (!source.includes("_ENV}") && !envNames.some((name) => source.includes(name))) return [];
      return findEnvNamesInErrorsOrResponses(source, envNames, file).map((line) => `${path.relative(ROOT, file)}:${line}`);
    });

    // 失敗したら、変数名入りの文を投げる・返すのをやめ、_shared/missing-env.ts の missingEnvError()
    // (投げる場所) か logMissingEnv() + missingEnvResponseBody() (応答を返す場所) を使う
    expect(offenders).toEqual([]);
  }, 30_000);

  it("モジュールの読み込み時 (トップレベル) に例外を投げる Edge Function が無い (関数が起動できなくなる)", () => {
    const offenders = files.flatMap((file) => {
      const source = fs.readFileSync(file, "utf-8");
      // 構文木の解析は重いので、行頭 (トップレベルの位置) に throw / if が無いファイルは読み飛ばす
      if (!/^(?:throw|if)\b/m.test(source)) return [];
      const sf = parse(source, file);
      const found: string[] = [];
      for (const statement of sf.statements) {
        const throwsAtTop =
          ts.isThrowStatement(statement) ||
          (ts.isIfStatement(statement) &&
            [statement.thenStatement, statement.elseStatement].some(
              (branch) =>
                !!branch &&
                (ts.isThrowStatement(branch) || (ts.isBlock(branch) && branch.statements.some(ts.isThrowStatement))),
            ));
        if (throwsAtTop) found.push(`${path.relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1}`);
      }
      return found;
    });

    expect(offenders).toEqual([]);
  });
});

describe("ENV_SETUP.md の pg_net の結果の見方が、503 の 2 つの本文を見分けている (#1467)", () => {
  // カタログ取り込み (pg_cron → pg_net) は、必須の secrets が無いと 503 (SERVER_CONFIG_MISSING) を返すようになった。
  // 以前の手順書は「401 / 503 → 値が合っていません」と書いていて、secrets の不足を CRON_SECRET のずれと読み違えさせていた。
  const doc = fs.readFileSync(path.join(ROOT, "ENV_SETUP.md"), "utf-8");
  const authSource = fs.readFileSync(path.join(ROOT, "supabase", "functions", "_shared", "auth.ts"), "utf-8");
  const CRON_SECRET_MISSING_BODY = '{"error":"Service not configured"}';

  it("CRON_SECRET が無いときの 503 の本文は、auth.ts が実際に返す文のまま書いてある", () => {
    // 手順書の本文の文字列が実装から離れたら、ここで気づく
    expect(authSource).toContain('JSON.stringify({ error: "Service not configured" })');
    expect(doc).toContain(CRON_SECRET_MISSING_BODY);
  });

  it("secrets が足りないときの 503 の code と、変数名が出るログの行を案内している", () => {
    expect(doc).toContain(`"code":"${MISSING_ENV_ERROR_CODE}"`);
    expect(doc).toContain(MISSING_ENV_SERVER_LOG_PREFIX);
  });

  it("503 を「値が合っていません」(CRON_SECRET のずれ) と案内する行が無い", () => {
    const offenders = doc.split("\n").filter((line) => line.includes("503") && line.includes("値が合っていません"));
    // 失敗したら、401 (値のずれ) と 503 (secrets の不足。本文で CRON_SECRET か関数の secrets かを見分ける) を分けて書く
    expect(offenders).toEqual([]);
  });

  it("503 を案内する箇条書きは、どちらの 503 かを本文で見分ける書き方になっている", () => {
    const diagnosisLines = doc.split("\n").filter((line) => /^\s*- (?:`status_code` が )?\**503/.test(line));
    // net._http_response の見方 (カタログ取り込み) と、比較ランキングの集計の確かめ方の 2 か所
    expect(diagnosisLines.length).toBeGreaterThanOrEqual(2);
    for (const line of diagnosisLines) {
      expect(line.includes("本文"), line).toBe(true);
    }
  });
});
