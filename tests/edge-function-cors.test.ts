/**
 * #1167 Edge Function の CORS (許可オリジンの絞り込み) のテスト
 *
 * 以前は 16 本以上の Edge Function が Access-Control-Allow-Origin: '*' を返していた。
 * Authorization ヘッダー (Bearer トークン) を受け付ける関数なので、どのサイトのページからでも
 * ブラウザ経由で呼べる状態だった。次の 4 つを確かめる。
 *
 *   1. 共有ヘルパー (_shared/cors.ts): 許可したオリジンにだけ Access-Control-Allow-* を返す
 *      (許可 / 不許可 / Origin なし / 'null' / 部分一致 / 環境変数 ALLOWED_ORIGINS)
 *   2. ソース走査: '*' を返す関数が無い。CORS ヘッダーの文字列は _shared/cors.ts にだけある。
 *      バッチ専用の関数には CORS が無い。使う関数は、ハンドラの中で getCorsHeaders(req) を作っている
 *   3. バッチ専用の関数 (aggregate-org-stats / calculate-segment-stats) の実際のハンドラ:
 *      許可したオリジンからでも CORS ヘッダーを返さない
 *   4. 利用者向けの関数 (generate-hint) の実際のハンドラ: 許可したオリジンにだけ返す
 *      (analyze-fridge は analyze-fridge-handler.test.ts で確かめる)
 *
 * 新しい関数を足してこのテストが落ちたら、CORS ヘッダーを自分で書かず、
 * 利用者の JWT で認証する関数は getCorsHeaders(req) を、バッチ専用の関数は CORS 自体を付けない。
 * 走査は TypeScript の構文木で行うので、コメントの中の文字列には反応しない。
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ALLOWED_ORIGINS,
  getAllowedOrigins,
  getCorsHeaders,
  withCors,
} from "../supabase/functions/_shared/cors.ts";

// ─────────────────────────────────────────────
// 1. 共有ヘルパー
// ─────────────────────────────────────────────

let env: Record<string, string | undefined> = {};

function stubDeno(extra: Record<string, unknown> = {}) {
  vi.stubGlobal("Deno", { env: { get: (key: string) => env[key] }, ...extra });
}

beforeEach(() => {
  env = {};
  stubDeno();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ENDPOINT = "https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/example";

function requestFrom(origin?: string): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: origin === undefined ? {} : { Origin: origin },
  });
}

describe("getCorsHeaders: 許可したオリジンにだけ CORS ヘッダーを返す (#1167)", () => {
  it("CORS-1: 既定の許可オリジンは自社の 2 つだけ", () => {
    expect([...DEFAULT_ALLOWED_ORIGINS]).toEqual(["https://homegohan.app", "https://homegohan-app.vercel.app"]);
    expect(getAllowedOrigins()).toEqual(["https://homegohan.app", "https://homegohan-app.vercel.app"]);
  });

  it.each(["https://homegohan.app", "https://homegohan-app.vercel.app"])(
    "CORS-2: 許可したオリジン (%s) には、そのオリジンをそのまま返す",
    (origin) => {
      const headers = getCorsHeaders(requestFrom(origin));
      expect(headers["Access-Control-Allow-Origin"]).toBe(origin);
      expect(headers["Access-Control-Allow-Headers"]).toBe("authorization, x-client-info, apikey, content-type");
      expect(headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
      expect(headers.Vary).toBe("Origin");
    },
  );

  it("CORS-3: 許可していないオリジンには Access-Control-Allow-* を返さない (Vary: Origin だけ)", () => {
    const headers = getCorsHeaders(requestFrom("https://evil.example.com"));
    expect(headers).toEqual({ Vary: "Origin" });
  });

  it("CORS-4: Origin ヘッダーが無い (サーバー間の呼び出し・curl) ときも Access-Control-Allow-* を返さない", () => {
    const headers = getCorsHeaders(requestFrom());
    expect(headers).toEqual({ Vary: "Origin" });
  });

  it("CORS-5: Origin が 'null' (サンドボックス化された iframe など) は許可しない", () => {
    expect(getCorsHeaders(requestFrom("null"))).toEqual({ Vary: "Origin" });
  });

  it.each([
    ["サブドメインを足したもの", "https://evil.homegohan.app"],
    ["ドメインの後ろに足したもの", "https://homegohan.app.evil.com"],
    ["スキームが違う", "http://homegohan.app"],
    ["ポートが違う", "https://homegohan.app:8443"],
    ["末尾にスラッシュ", "https://homegohan.app/"],
    ["大文字 (ブラウザは小文字で送る)", "HTTPS://HOMEGOHAN.APP"],
    ["別のベンダーのドメイン", "https://homegohan-app.vercel.app.evil.com"],
    ["許可オリジンを含む別の URL", "https://evil.example.com/?https://homegohan.app"],
    ["空文字", ""],
  ])("CORS-6: 完全一致しないオリジンは許可しない (%s: %s)", (_label, origin) => {
    expect(getCorsHeaders(requestFrom(origin))["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("CORS-7: どの入力でも Access-Control-Allow-Origin が '*' になることは無い", () => {
    const origins = [undefined, "null", "*", "https://evil.example.com", "https://homegohan.app"];
    for (const origin of origins) {
      expect(getCorsHeaders(requestFrom(origin))["Access-Control-Allow-Origin"]).not.toBe("*");
    }
  });
});

describe("ALLOWED_ORIGINS (環境変数)", () => {
  it("CORS-8: 設定すると既定値を置き換える (カンマ区切り・空白・末尾スラッシュ・大文字をならす)", () => {
    env.ALLOWED_ORIGINS = " https://staging.example.com ,https://App.Example.com/, ,";
    expect(getAllowedOrigins()).toEqual(["https://staging.example.com", "https://app.example.com"]);

    expect(getCorsHeaders(requestFrom("https://staging.example.com"))["Access-Control-Allow-Origin"]).toBe(
      "https://staging.example.com",
    );
    expect(getCorsHeaders(requestFrom("https://app.example.com"))["Access-Control-Allow-Origin"]).toBe(
      "https://app.example.com",
    );
    // 置き換わるので、既定の自社オリジンは許可されなくなる
    expect(getCorsHeaders(requestFrom("https://homegohan.app"))["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("CORS-9: ローカル開発用に localhost を足せる", () => {
    env.ALLOWED_ORIGINS = "https://homegohan.app,http://localhost:3000";
    expect(getCorsHeaders(requestFrom("http://localhost:3000"))["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:3000",
    );
    expect(getCorsHeaders(requestFrom("http://localhost:3001"))["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("CORS-10: '*' はワイルドカードとして扱わず無視する (他に有効な値が無ければ既定に戻る)", () => {
    env.ALLOWED_ORIGINS = "*";
    expect(getAllowedOrigins()).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    expect(getCorsHeaders(requestFrom("https://evil.example.com"))["Access-Control-Allow-Origin"]).toBeUndefined();

    env.ALLOWED_ORIGINS = "*, https://staging.example.com";
    expect(getAllowedOrigins()).toEqual(["https://staging.example.com"]);
    expect(getCorsHeaders(requestFrom("https://evil.example.com"))["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("CORS-10b: 'null' も許可しない (設定に書いても無視する。サンドボックス化された iframe などの Origin)", () => {
    env.ALLOWED_ORIGINS = "null";
    expect(getAllowedOrigins()).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    expect(getCorsHeaders(requestFrom("null"))["Access-Control-Allow-Origin"]).toBeUndefined();

    env.ALLOWED_ORIGINS = "null, https://staging.example.com";
    expect(getAllowedOrigins()).toEqual(["https://staging.example.com"]);
    expect(getCorsHeaders(requestFrom("null"))["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it.each([["空文字", ""], ["空白だけ", "   "], ["カンマだけ", " , ,"]])(
    "CORS-11: 値が実質空 (%s) なら既定の許可リストを使う",
    (_label, value) => {
      env.ALLOWED_ORIGINS = value;
      expect(getAllowedOrigins()).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    },
  );

  it("CORS-12: 環境変数を読めない実行環境 (Deno.env.get が例外 / Deno が無い) でも、既定の許可リストで動く", () => {
    stubDeno({
      env: {
        get: () => {
          throw new Error("PermissionDenied: Requires env access");
        },
      },
    });
    expect(getAllowedOrigins()).toEqual([...DEFAULT_ALLOWED_ORIGINS]);

    vi.unstubAllGlobals();
    expect(typeof (globalThis as { Deno?: unknown }).Deno).toBe("undefined");
    expect(getAllowedOrigins()).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    expect(getCorsHeaders(requestFrom("https://homegohan.app"))["Access-Control-Allow-Origin"]).toBe(
      "https://homegohan.app",
    );
  });
});

describe("withCors: 認証ヘルパーが返した 401 などに CORS ヘッダーを付け直す", () => {
  const unauthorized = () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

  it("CORS-13: 許可したオリジンなら、状態・本文・既存のヘッダーを保ったまま CORS ヘッダーを付ける", async () => {
    const res = withCors(unauthorized(), requestFrom("https://homegohan.app"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://homegohan.app");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("authorization");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("CORS-14: 許可していないオリジン / Origin なしには Access-Control-Allow-* を付けない (Vary: Origin だけ)", async () => {
    for (const origin of ["https://evil.example.com", undefined]) {
      const res = withCors(unauthorized(), requestFrom(origin));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
      expect(res.headers.get("Vary")).toBe("Origin");
    }
  });

  it("CORS-15: 既存の Vary を消さずに Origin を足す。すでに Origin があれば重ねない", () => {
    const withVary = new Response("x", { headers: { Vary: "Accept-Encoding" } });
    expect(withCors(withVary, requestFrom("https://homegohan.app")).headers.get("Vary")).toBe(
      "Accept-Encoding, Origin",
    );

    const alreadyOrigin = new Response("x", { headers: { Vary: "Accept-Encoding, Origin" } });
    expect(withCors(alreadyOrigin, requestFrom("https://homegohan.app")).headers.get("Vary")).toBe(
      "Accept-Encoding, Origin",
    );

    const star = new Response("x", { headers: { Vary: "*" } });
    expect(withCors(star, requestFrom("https://homegohan.app")).headers.get("Vary")).toBe("*");
  });
});

// ─────────────────────────────────────────────
// 2. ソース走査
// ─────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const FUNCTIONS_DIR = "supabase/functions";
const CORS_HELPER = "supabase/functions/_shared/cors.ts";

/**
 * ブラウザから呼ばれないバッチ専用の関数。CORS (ヘルパーの利用も含む) を付けてはいけない。
 * service role key / CRON_SECRET で認証するので、ブラウザは鍵を持てず、呼べるのはサーバー (pg_cron・Next.js の API ルート) だけ。
 */
const BATCH_ONLY_SOURCES = [
  "supabase/functions/aggregate-org-stats/index.ts",
  "supabase/functions/calculate-segment-stats/index.ts",
  "supabase/functions/regenerate-embeddings/index.ts",
  "supabase/functions/stripe-price-sync/index.ts",
  "supabase/functions/backfill-ingredient-embeddings/index.ts",
  "supabase/functions/create-derived-recipe/index.ts",
  // import-*-catalog (6 関数) の共通ハンドラ
  "supabase/functions/_shared/catalog/import-runner.ts",
  "supabase/functions/import-convenience-catalog/index.ts",
  "supabase/functions/import-familymart-catalog/index.ts",
  "supabase/functions/import-lawson-catalog/index.ts",
  "supabase/functions/import-ministop-catalog/index.ts",
  "supabase/functions/import-natural-lawson-catalog/index.ts",
  "supabase/functions/import-seven-eleven-catalog/index.ts",
];

/** 利用者の JWT で認証し、ブラウザからも呼ばれうる関数。許可したオリジンにだけ CORS を返す */
const USER_FACING_SOURCES = [
  "supabase/functions/analyze-fridge/index.ts",
  "supabase/functions/analyze-health-photo/index.ts",
  "supabase/functions/analyze-meal-photo/index.ts",
  "supabase/functions/generate-health-insights/index.ts",
  "supabase/functions/generate-hint/index.ts",
  "supabase/functions/generate-menu-v4/index.ts",
  "supabase/functions/generate-menu-v5/index.ts",
  "supabase/functions/knowledge-gpt/index.ts",
  "supabase/functions/normalize-shopping-list/index.ts",
  "supabase/functions/regenerate-shopping-list-v2/index.ts",
];

const CORS_IDENTIFIERS = ["corsHeaders", "getCorsHeaders", "withCors"];

interface CorsFacts {
  /** 'Access-Control-' で始まる文字列リテラル */
  accessControlLiterals: string[];
  /** Access-Control-Allow-Origin に '*' を設定している箇所 (プロパティ / headers.set) */
  wildcardOrigin: boolean;
  /** _shared/cors.ts を import している */
  importsCors: boolean;
  /** CORS_IDENTIFIERS のいずれかの識別子を使っている (コメント・文字列は含まない) */
  usedCorsIdentifiers: string[];
  /** getCorsHeaders(...) を呼んでいる */
  callsGetCorsHeaders: boolean;
  /** corsHeaders をモジュールの最上位 (関数の外) で宣言している */
  declaresCorsHeadersAtTopLevel: boolean;
  /** requireServiceRole(...) を呼んでいる */
  callsRequireServiceRole: boolean;
  /** withCors(<応答>, req) の形で、リクエストを渡して呼んでいる */
  callsWithCorsWithRequest: boolean;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function stringValue(node: ts.Node | undefined): string | null {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return null;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function analyzeCors(source: string): CorsFacts {
  const sf = ts.createSourceFile("file.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const facts: CorsFacts = {
    accessControlLiterals: [],
    wildcardOrigin: false,
    importsCors: false,
    usedCorsIdentifiers: [],
    callsGetCorsHeaders: false,
    declaresCorsHeadersAtTopLevel: false,
    callsRequireServiceRole: false,
    callsWithCorsWithRequest: false,
  };

  const visit = (node: ts.Node) => {
    const literal = stringValue(node);
    if (literal !== null && /^access-control-/i.test(literal)) facts.accessControlLiterals.push(literal);

    if (ts.isImportDeclaration(node)) {
      const spec = stringValue(node.moduleSpecifier);
      if (spec !== null && /(^|\/)cors(\.ts)?$/.test(spec)) facts.importsCors = true;
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyNameText(node.name);
      if (name?.toLowerCase() === "access-control-allow-origin" && stringValue(node.initializer) === "*") {
        facts.wildcardOrigin = true;
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text === "getCorsHeaders") facts.callsGetCorsHeaders = true;
        if (callee.text === "requireServiceRole") facts.callsRequireServiceRole = true;
        if (
          callee.text === "withCors" &&
          node.arguments.length === 2 &&
          ts.isIdentifier(node.arguments[1]) &&
          node.arguments[1].text === "req"
        ) {
          facts.callsWithCorsWithRequest = true;
        }
      }
      // headers.set("Access-Control-Allow-Origin", "*") / append(...)
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === "set" || callee.name.text === "append") &&
        stringValue(node.arguments[0])?.toLowerCase() === "access-control-allow-origin" &&
        stringValue(node.arguments[1]) === "*"
      ) {
        facts.wildcardOrigin = true;
      }
    }

    if (ts.isIdentifier(node) && CORS_IDENTIFIERS.includes(node.text)) {
      // import { corsHeaders } の宣言側も 1 回として数える (使っているかどうかは importsCors と合わせて見る)
      if (!facts.usedCorsIdentifiers.includes(node.text)) facts.usedCorsIdentifiers.push(node.text);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "corsHeaders") {
      let insideFunction = false;
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (isFunctionLike(parent)) {
          insideFunction = true;
          break;
        }
      }
      if (!insideFunction) facts.declaresCorsHeadersAtTopLevel = true;
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

function listFunctionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...listFunctionSources(rel));
    } else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const allSources = listFunctionSources(FUNCTIONS_DIR);
const factsByFile = new Map(
  allSources.map((file) => [file, analyzeCors(fs.readFileSync(path.join(ROOT, file), "utf8"))] as const),
);

describe("構文木の走査が正しく働いていること (analyzeCors の自己検査)", () => {
  it("CORS-S0: '*' の設定 / 最上位の corsHeaders / import を検出し、コメントや文字列の中は無視する", () => {
    const wildcard = analyzeCors(`const h = { "Access-Control-Allow-Origin": "*" };`);
    expect(wildcard.wildcardOrigin).toBe(true);
    expect(wildcard.accessControlLiterals).toEqual(["Access-Control-Allow-Origin"]);

    const viaSet = analyzeCors(`res.headers.set('access-control-allow-origin', '*');`);
    expect(viaSet.wildcardOrigin).toBe(true);

    const specific = analyzeCors(`const h = { "Access-Control-Allow-Origin": origin };`);
    expect(specific.wildcardOrigin).toBe(false);

    const topLevel = analyzeCors(`const corsHeaders = getCorsHeaders(undefined as never);`);
    expect(topLevel.declaresCorsHeadersAtTopLevel).toBe(true);

    const inHandler = analyzeCors(`Deno.serve((req) => { const corsHeaders = getCorsHeaders(req); });`);
    expect(inHandler.declaresCorsHeadersAtTopLevel).toBe(false);
    expect(inHandler.callsGetCorsHeaders).toBe(true);

    const imported = analyzeCors(`import { getCorsHeaders } from "../_shared/cors.ts";`);
    expect(imported.importsCors).toBe(true);

    const commentOnly = analyzeCors(`// Access-Control-Allow-Origin: '*' corsHeaders\nconst x = "plain";`);
    expect(commentOnly.wildcardOrigin).toBe(false);
    expect(commentOnly.accessControlLiterals).toEqual([]);
    expect(commentOnly.usedCorsIdentifiers).toEqual([]);

    const batch = analyzeCors(`const e = requireServiceRole(req);`);
    expect(batch.callsRequireServiceRole).toBe(true);

    expect(analyzeCors(`return withCors(authResult, req);`).callsWithCorsWithRequest).toBe(true);
    expect(analyzeCors(`return withCors(authResult);`).callsWithCorsWithRequest).toBe(false);
  });

  it("CORS-S1: 走査の対象に、既知の Edge Function がすべて含まれている (ディレクトリの読み違いを防ぐ)", () => {
    for (const file of [CORS_HELPER, ...BATCH_ONLY_SOURCES, ...USER_FACING_SOURCES]) {
      expect(allSources, `${file} が走査の対象に無い (削除・改名した場合は、このテストの一覧も直す)`).toContain(file);
    }
  });
});

describe("Edge Function のソース: CORS の規約 (#1167)", () => {
  it("CORS-S2: Access-Control-Allow-Origin に '*' を設定している関数が無い", () => {
    const violations = [...factsByFile].filter(([, facts]) => facts.wildcardOrigin).map(([file]) => file);
    expect(violations, "全オリジン許可 ('*') は使わない。getCorsHeaders(req) を使うこと").toEqual([]);
  });

  it("CORS-S3: Access-Control-* の文字列を書いてよいのは _shared/cors.ts だけ (ほかは getCorsHeaders を通す)", () => {
    const violations = [...factsByFile]
      .filter(([file, facts]) => file !== CORS_HELPER && facts.accessControlLiterals.length > 0)
      .map(([file, facts]) => `${file}: ${facts.accessControlLiterals.join(", ")}`);
    expect(violations).toEqual([]);
  });

  it.each(BATCH_ONLY_SOURCES)("CORS-S4: バッチ専用の %s には CORS が無い", (file) => {
    const facts = factsByFile.get(file)!;
    expect(facts.importsCors, "バッチ専用の関数は _shared/cors.ts を import しない").toBe(false);
    expect(facts.usedCorsIdentifiers, "バッチ専用の関数は CORS ヘッダーを使わない").toEqual([]);
    expect(facts.accessControlLiterals).toEqual([]);
  });

  it("CORS-S5: requireServiceRole で認証する関数は、すべて上のバッチ専用の一覧に載っている (CORS を付け忘れ・付けすぎを防ぐ)", () => {
    const callers = [...factsByFile]
      .filter(([, facts]) => facts.callsRequireServiceRole)
      .map(([file]) => file);
    const unlisted = callers.filter((file) => !BATCH_ONLY_SOURCES.includes(file));
    expect(unlisted, "バッチ専用の関数は BATCH_ONLY_SOURCES に足して、CORS を付けないこと").toEqual([]);
  });

  it.each(USER_FACING_SOURCES)("CORS-S6: 利用者向けの %s は、ハンドラの中で getCorsHeaders(req) を作っている", (file) => {
    const facts = factsByFile.get(file)!;
    expect(facts.importsCors).toBe(true);
    expect(facts.callsGetCorsHeaders, "getCorsHeaders(req) を呼んでいない").toBe(true);
    expect(
      facts.declaresCorsHeadersAtTopLevel,
      "corsHeaders をモジュールの最上位で作ると、リクエストの Origin を見られない。ハンドラの先頭で作ること",
    ).toBe(false);
  });

  it("CORS-S6b: 認証ヘルパーが返した 401 に CORS を付け直す withCors を import する関数は、リクエストを渡して呼んでいる", () => {
    const importers = USER_FACING_SOURCES.filter((file) => {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      return /import\s*\{[^}]*\bwithCors\b[^}]*\}\s*from/.test(source);
    });
    // 現在は normalize-shopping-list と regenerate-shopping-list-v2。増減したときは、このテストの意図に合うか見直す
    expect(importers.sort()).toEqual([
      "supabase/functions/normalize-shopping-list/index.ts",
      "supabase/functions/regenerate-shopping-list-v2/index.ts",
    ]);
    for (const file of importers) {
      expect(
        factsByFile.get(file)!.callsWithCorsWithRequest,
        `${file}: withCors(res, req) の形で呼ぶこと (req を渡さないと Origin を判定できない)`,
      ).toBe(true);
    }
  });

  it("CORS-S7: _shared/cors.ts を import しているのは、利用者向けの関数だけ", () => {
    const importers = [...factsByFile]
      .filter(([file, facts]) => file !== CORS_HELPER && facts.importsCors)
      .map(([file]) => file)
      .sort();
    expect(importers).toEqual([...USER_FACING_SOURCES].sort());
  });
});

// ─────────────────────────────────────────────
// 3 / 4. 実際のハンドラ
// ─────────────────────────────────────────────

type Handler = (req: Request) => Promise<Response>;

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createCompletion: vi.fn(),
  upsert: vi.fn(),
  orgSelect: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// supabase-js の偽物: 組織の一覧 (aggregate-org-stats) と upsert (generate-hint) だけ答える
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => mocks.orgSelect(table),
      upsert: (...args: unknown[]) => mocks.upsert(table, ...args),
    }),
  }),
}));
vi.mock("../supabase/functions/_shared/db-logger.ts", () => ({
  createLogger: () => ({ ...mocks.logger, withUser: () => mocks.logger }),
  generateRequestId: () => "req_test",
}));
// requireServiceRole は本物 (_shared/auth.ts) を使い、requireAuth だけ差し替える
vi.mock("../supabase/functions/_shared/auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../supabase/functions/_shared/auth.ts")>()),
  requireAuth: mocks.requireAuth,
}));
vi.mock("../supabase/functions/_shared/fast-llm.ts", () => ({
  createFastLLMClient: () => ({ chat: { completions: { create: mocks.createCompletion } } }),
  getFastLLMModel: () => "test-model",
}));

const handlers: Record<string, Handler> = {};

const BATCH_SECRET = "batch-secret-for-test";
const ALLOWED = "https://homegohan-app.vercel.app";
const DISALLOWED = "https://evil.example.com";

async function loadHandler(name: string, load: () => Promise<unknown>) {
  stubDeno({
    serve: (fn: Handler) => {
      handlers[name] = fn;
    },
  });
  await load();
}

beforeEach(async () => {
  env = { CRON_SECRET: BATCH_SECRET };
  mocks.requireAuth.mockReset();
  mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
  mocks.createCompletion.mockReset();
  mocks.createCompletion.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ hint: "ok" }) } }] });
  mocks.upsert.mockReset();
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.orgSelect.mockReset();
  mocks.orgSelect.mockResolvedValue({ data: [], error: null });

  if (!handlers["aggregate-org-stats"]) {
    await loadHandler("aggregate-org-stats", () => import("../supabase/functions/aggregate-org-stats/index.ts"));
    await loadHandler("calculate-segment-stats", () => import("../supabase/functions/calculate-segment-stats/index.ts"));
    await loadHandler("generate-hint", () => import("../supabase/functions/generate-hint/index.ts"));
  }
  stubDeno();
});

function call(fn: string, init: { method?: string; origin?: string; auth?: string; body?: unknown }): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.origin !== undefined) headers.Origin = init.origin;
  if (init.auth !== undefined) headers.Authorization = init.auth;
  return handlers[fn](
    new Request(`${ENDPOINT.replace("example", fn)}`, {
      method: init.method ?? "POST",
      headers,
      body: init.method === "OPTIONS" ? undefined : JSON.stringify(init.body ?? {}),
    }),
  );
}

function corsResponseHeaders(res: Response): string[] {
  return [...res.headers.keys()].filter((key) => key.toLowerCase().startsWith("access-control-"));
}

describe.each(["aggregate-org-stats", "calculate-segment-stats"])(
  "バッチ専用の %s: 許可したオリジンからでも CORS ヘッダーを返さない (#1167)",
  (fn) => {
    it("CORS-H1: ブラウザの事前確認 (OPTIONS) は認証で 401 になり、CORS ヘッダーが無い (= ブラウザ側で止まる)", async () => {
      const res = await call(fn, { method: "OPTIONS", origin: ALLOWED });
      expect(res.status).toBe(401);
      expect(corsResponseHeaders(res)).toEqual([]);
    });

    it("CORS-H2: 認証に失敗した POST も、許可 / 不許可どちらのオリジンからでも CORS ヘッダーが無い", async () => {
      for (const origin of [ALLOWED, DISALLOWED, undefined]) {
        const res = await call(fn, { origin, auth: "Bearer wrong-secret" });
        expect(res.status).toBe(401);
        expect(res.headers.get("Content-Type")).toBe("application/json");
        expect(corsResponseHeaders(res)).toEqual([]);
      }
    });
  },
);

describe("バッチ専用の aggregate-org-stats: 認証に成功した応答にも CORS ヘッダーが無い", () => {
  it("CORS-H3: サーバーからの呼び出し (CRON_SECRET) は従来どおり 200 で動く", async () => {
    const res = await call("aggregate-org-stats", { origin: ALLOWED, auth: `Bearer ${BATCH_SECRET}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, processed: [] });
    expect(corsResponseHeaders(res)).toEqual([]);
  });
});

describe("利用者向けの generate-hint: 許可したオリジンにだけ CORS ヘッダーを返す (#1167)", () => {
  it("CORS-H4: 許可したオリジンの OPTIONS には、そのオリジンを返す", async () => {
    const res = await call("generate-hint", { method: "OPTIONS", origin: ALLOWED });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("authorization");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("CORS-H5: 許可していないオリジンの OPTIONS には Access-Control-Allow-* を返さない", async () => {
    const res = await call("generate-hint", { method: "OPTIONS", origin: DISALLOWED });
    expect(res.status).toBe(200);
    expect(corsResponseHeaders(res)).toEqual([]);
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("CORS-H6: 成功 (200) の応答は、許可したオリジンにだけ Access-Control-Allow-Origin を付ける", async () => {
    const allowed = await call("generate-hint", { origin: ALLOWED, auth: "Bearer user-token" });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ hint: "ok" });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);

    const denied = await call("generate-hint", { origin: DISALLOWED, auth: "Bearer user-token" });
    expect(denied.status).toBe(200);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // Origin が無い (サーバー間の呼び出し) 場合も、関数としては従来どおり動く
    const server = await call("generate-hint", { auth: "Bearer user-token" });
    expect(server.status).toBe(200);
    expect(await server.json()).toEqual({ hint: "ok" });
    expect(server.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("CORS-H7: 認証失敗 (401) の応答も、ブラウザが中身を読めるよう許可したオリジンには CORS ヘッダーを付ける", async () => {
    mocks.requireAuth.mockResolvedValue(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));

    const allowed = await call("generate-hint", { origin: ALLOWED });
    expect(allowed.status).toBe(401);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);

    const denied = await call("generate-hint", { origin: DISALLOWED });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
