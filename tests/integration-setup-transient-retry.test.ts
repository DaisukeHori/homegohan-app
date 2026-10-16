// @vitest-environment node
/**
 * tests/integration-setup-transient-retry.test.ts
 *
 * 結合テストの準備 (service_role で既知の行を upsert する・行を読む) の REST の問い合わせを、ゲートウェイ (Kong) の
 * 一時的な失敗のときだけやり直す仕組み (tests/integration/helpers/setup-transient-retry.ts。#1779) の単体テスト。
 *
 * 回帰: 2026-10-16 に少なくとも 6 本の枝と PR の結合テストが、Kong の `An invalid response was received from the upstream server`
 * (状態 502) で落ちた。ここでは本物の supabase-js を、その応答を挟む偽の fetch の上で動かし、やり直しで準備が通ること、
 * やり直さない範囲 (DB・PostgREST の判定の 4xx・やり尽くしたとき・渡された db の外の問い合わせ) は今までどおり失敗が見えることを確かめる。
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  AUTH_RETRY_ATTEMPTS_ENV,
  AUTH_RETRY_BASE_DELAY_ENV,
  AUTH_RETRY_MAX_DELAY_MS,
  AUTH_TRANSIENT_STATUSES,
  DEFAULT_AUTH_RETRY_ATTEMPTS,
  DEFAULT_AUTH_RETRY_BASE_DELAY_MS,
} from "./integration/helpers/auth-transient-retry";
import {
  DEFAULT_SETUP_RETRY_ATTEMPTS,
  DEFAULT_SETUP_RETRY_BASE_DELAY_MS,
  SETUP_RETRY_ATTEMPTS_ENV,
  SETUP_RETRY_BASE_DELAY_ENV,
  SETUP_RETRY_MAX_DELAY_MS,
  SETUP_TRANSIENT_STATUSES,
  UPSTREAM_INVALID_RESPONSE_MESSAGE,
  isTransientGatewayResult,
  retryIdempotentSetup,
  setupRetryDelayMs,
  setupRetryOptionsFromEnv,
  type SetupRetryOptions,
} from "./integration/helpers/setup-transient-retry";

const ROOT = process.cwd();
const SUPABASE_URL = "http://supabase.test";
const REST_BASE = `${SUPABASE_URL}/rest/v1/`;
const SERVICE_KEY = "service-role-key-for-unit-test";
const TABLE = "user_profiles";
const ROW_ID = "00000000-0000-4000-8000-000000000001";
const LABEL = "単体テスト: user_profiles の準備";
/** テストで使う回数と最初の間隔 (既定と違う小さい値なら何でもよい) */
const ATTEMPTS = 3;
const BASE_DELAY_MS = 10;
/** 準備の検査で即座に失敗させる、PostgREST・DB の判定の状態 (Bad Request / Unauthorized / Forbidden / Conflict) */
const NON_TRANSIENT_STATUSES = [400, 401, 403, 409] as const;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_GATEWAY_TIMEOUT = 504;

type Call = { url: string; method: string; body: RequestInit["body"] };

/** 呼ばれた順に replies を返す偽の fetch (呼び出しを記録する) */
function scriptedFetch(replies: Response[]) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), body: init?.body });
    const next = replies.shift();
    if (next === undefined) throw new Error(`想定より多く呼ばれた: ${url}`);
    return next;
  };
  return { fn, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Kong が奥 (PostgREST) から不正な応答を受けたときに返すもの (2026-10-16 のログの本文) */
function upstreamInvalid(status: number = HTTP_BAD_GATEWAY): Response {
  return json(status, { message: UPSTREAM_INVALID_RESPONSE_MESSAGE });
}

/** upsert の成功 (Prefer: return=minimal なので本文は空) */
function created(): Response {
  return new Response(null, { status: HTTP_CREATED });
}

const row = { id: ROW_ID, nickname: "retry", age_group: "30s", gender: "other" };

function options(extra: Partial<SetupRetryOptions> = {}) {
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const opts: SetupRetryOptions = {
    attempts: ATTEMPTS,
    baseDelayMs: BASE_DELAY_MS,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    warn: (m) => warnings.push(m),
    ...extra,
  };
  return { opts, sleeps, warnings };
}

/** 本物の supabase-js (service_role の形) を、偽の fetch の上で作る */
function serviceClient(fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchFn },
  });
}

describe("本物の supabase-js で: 2026-10-16 の落ち方 (Kong の upstream の 502)", () => {
  it("やり直しの外でそのまま書いた問い合わせは、502 をそのままエラーにする (落ち方の再現。プロセスの fetch は差し替えない)", async () => {
    const fake = scriptedFetch([upstreamInvalid()]);
    const { data, error, status } = await serviceClient(fake.fn).from(TABLE).select("id").eq("id", ROW_ID);
    expect(data).toBeNull();
    expect(status).toBe(HTTP_BAD_GATEWAY);
    expect(error?.message).toBe(UPSTREAM_INVALID_RESPONSE_MESSAGE);
    expect(fake.calls).toHaveLength(1);
  });

  it("select: 502 → 200 なら、やり直しで準備が成功する。warn に回数と元のエラーが出る", async () => {
    const fake = scriptedFetch([upstreamInvalid(), json(HTTP_OK, [{ id: ROW_ID }])]);
    const { opts, sleeps, warnings } = options();
    const { data, error } = await retryIdempotentSetup(
      serviceClient(fake.fn),
      LABEL,
      (db) => db.from(TABLE).select("id").eq("id", ROW_ID),
      opts,
    );
    expect(error).toBeNull();
    expect(data).toEqual([{ id: ROW_ID }]);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(fake.calls[1].url).toBe(fake.calls[0].url);
    expect(fake.calls[0].url.startsWith(`${REST_BASE}${TABLE}?`)).toBe(true);
    expect(sleeps).toEqual([BASE_DELAY_MS]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(LABEL);
    expect(warnings[0]).toContain(`1/${ATTEMPTS}`);
    expect(warnings[0]).toContain(String(HTTP_BAD_GATEWAY));
    expect(warnings[0]).toContain(UPSTREAM_INVALID_RESPONSE_MESSAGE);
  });

  it("upsert: 504 → 503 → 201 なら、同じ本文を送り直して成功する。single などで絞った select も同じ", async () => {
    const fake = scriptedFetch([upstreamInvalid(HTTP_GATEWAY_TIMEOUT), json(HTTP_SERVICE_UNAVAILABLE, { message: "upstream" }), created()]);
    const { opts, sleeps, warnings } = options();
    const { error, status } = await retryIdempotentSetup(
      serviceClient(fake.fn),
      LABEL,
      (db) => db.from(TABLE).upsert(row, { onConflict: "id" }),
      opts,
    );
    expect(error).toBeNull();
    expect(status).toBe(HTTP_CREATED);
    expect(fake.calls.map((c) => c.method)).toEqual(["POST", "POST", "POST"]);
    expect(fake.calls[1].body).toBe(fake.calls[0].body);
    expect(fake.calls[2].body).toBe(fake.calls[0].body);
    expect(JSON.parse(String(fake.calls[0].body))).toEqual(row);
    expect(sleeps).toEqual([BASE_DELAY_MS, BASE_DELAY_MS * 2]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(`1/${ATTEMPTS}`);
    expect(warnings[0]).toContain(String(HTTP_GATEWAY_TIMEOUT));
    expect(warnings[1]).toContain(`2/${ATTEMPTS}`);
    expect(warnings[1]).toContain(String(HTTP_SERVICE_UNAVAILABLE));

    const single = scriptedFetch([upstreamInvalid(), json(HTTP_OK, { id: ROW_ID })]);
    const one = await retryIdempotentSetup(serviceClient(single.fn), LABEL, (db) => db.from(TABLE).select("id").eq("id", ROW_ID).single(), options().opts);
    expect(one.error).toBeNull();
    expect(one.data).toEqual({ id: ROW_ID });
    expect(single.calls).toHaveLength(2);
  });

  it("状態が 502 / 503 / 504 でなくても、メッセージが Kong の upstream の文ならやり直す。ほかの 500 はやり直さない", async () => {
    const upstream = scriptedFetch([upstreamInvalid(HTTP_INTERNAL_SERVER_ERROR), json(HTTP_OK, [])]);
    const first = options();
    const retried = await retryIdempotentSetup(serviceClient(upstream.fn), LABEL, (db) => db.from(TABLE).select("id"), first.opts);
    expect(retried.error).toBeNull();
    expect(upstream.calls).toHaveLength(2);
    expect(first.sleeps).toEqual([BASE_DELAY_MS]);

    const other = scriptedFetch([json(HTTP_INTERNAL_SERVER_ERROR, { message: "internal error", code: "XX000" })]);
    const second = options();
    const kept = await retryIdempotentSetup(serviceClient(other.fn), LABEL, (db) => db.from(TABLE).select("id"), second.opts);
    expect(kept.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(kept.error?.message).toBe("internal error");
    expect(other.calls).toHaveLength(1);
    expect(second.sleeps).toEqual([]);
    expect(second.warnings).toEqual([]);
  });

  it("400 / 401 / 403 / 409 は、やり直さずに即座にそのエラーを返す", async () => {
    for (const status of NON_TRANSIENT_STATUSES) {
      const fake = scriptedFetch([json(status, { message: `rejected ${status}`, code: "PGRST000" })]);
      const { opts, sleeps, warnings } = options();
      const { error, status: got } = await retryIdempotentSetup(
        serviceClient(fake.fn),
        LABEL,
        (db) => db.from(TABLE).upsert(row, { onConflict: "id" }),
        opts,
      );
      expect(got, String(status)).toBe(status);
      expect(error?.message, String(status)).toBe(`rejected ${status}`);
      expect(fake.calls, String(status)).toHaveLength(1);
      expect(sleeps, String(status)).toEqual([]);
      expect(warnings, String(status)).toEqual([]);
    }
  });

  it("回数の上限までやり尽くしたら、最後の失敗をそのまま返す (やり直しで緑を作らない)", async () => {
    const fake = scriptedFetch([upstreamInvalid(), upstreamInvalid(HTTP_GATEWAY_TIMEOUT), upstreamInvalid()]);
    const { opts, sleeps, warnings } = options();
    const { data, error, status } = await retryIdempotentSetup(
      serviceClient(fake.fn),
      LABEL,
      (db) => db.from(TABLE).select("id"),
      opts,
    );
    expect(data).toBeNull();
    expect(status).toBe(HTTP_BAD_GATEWAY);
    expect(error?.message).toBe(UPSTREAM_INVALID_RESPONSE_MESSAGE);
    expect(fake.calls).toHaveLength(ATTEMPTS);
    expect(sleeps).toEqual([BASE_DELAY_MS, BASE_DELAY_MS * 2]);
    // やり直し 2 回 + やり尽くした 1 回
    expect(warnings).toHaveLength(ATTEMPTS);
    expect(warnings[ATTEMPTS - 1]).toContain(`${ATTEMPTS} 回続いた`);
  });

  it("回数 1 ならやり直さない (警告も出さない)", async () => {
    const fake = scriptedFetch([upstreamInvalid()]);
    const { opts, sleeps, warnings } = options({ attempts: 1 });
    const { status } = await retryIdempotentSetup(serviceClient(fake.fn), LABEL, (db) => db.from(TABLE).select("id"), opts);
    expect(status).toBe(HTTP_BAD_GATEWAY);
    expect(fake.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("本体を包まない形 (渡された db の select / upsert だけをやり直す)", () => {
  it("db には rpc・auth・storage が無く、表には insert・update・delete が無い", async () => {
    const fake = scriptedFetch([json(HTTP_OK, [])]);
    let seen: unknown[] = [];
    const client = serviceClient(fake.fn);
    await retryIdempotentSetup(
      client,
      LABEL,
      (db) => {
        const table = db.from(TABLE);
        seen = [
          Reflect.get(db, "rpc"),
          Reflect.get(db, "auth"),
          Reflect.get(db, "storage"),
          Reflect.get(table, "insert"),
          Reflect.get(table, "update"),
          Reflect.get(table, "delete"),
          "insert" in table,
          "select" in table,
          "upsert" in table,
        ];
        return table.select("id");
      },
      options({ attempts: 1 }).opts,
    );
    expect(seen).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, false, true, true]);
  });

  it("外の client の rpc を返す op は、送る前に Error で止める (状態を変える RPC をやり直さない)", async () => {
    const fake = scriptedFetch([json(HTTP_OK, null)]);
    const client = serviceClient(fake.fn);
    await expect(retryIdempotentSetup(client, LABEL, () => client.rpc("consume_something"), options().opts)).rejects.toThrow(
      /db の select \/ upsert から作った問い合わせ/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("外の client の insert を返す op も、送る前に Error で止める (insert は冪等でない)", async () => {
    const fake = scriptedFetch([created()]);
    const client = serviceClient(fake.fn);
    await expect(retryIdempotentSetup(client, LABEL, () => client.from(TABLE).insert(row), options().opts)).rejects.toThrow(
      /db の select \/ upsert から作った問い合わせ/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("async の op (Promise を返す) は、やり直しの対象にせず Error にする", async () => {
    const fake = scriptedFetch([json(HTTP_OK, [])]);
    await expect(
      retryIdempotentSetup(serviceClient(fake.fn), LABEL, async (db) => db.from(TABLE).select("id"), options().opts),
    ).rejects.toThrow(/await せずにそのまま返してください/);
  });
});

describe("判定・設定と、認証のやり直し (#1475) とのそろえ方", () => {
  it("isTransientGatewayResult: エラーが無ければ状態によらず false", () => {
    expect(isTransientGatewayResult({ error: null, status: HTTP_BAD_GATEWAY, statusText: "" })).toBe(false);
    expect(isTransientGatewayResult({ error: { message: "x" }, status: HTTP_GATEWAY_TIMEOUT, statusText: "" })).toBe(true);
    expect(isTransientGatewayResult({ error: { message: "x" }, status: NON_TRANSIENT_STATUSES[3], statusText: "" })).toBe(false);
  });

  it("既定は 5 回・最初の間隔 2 秒。環境変数で上書きでき、正の整数でなければ止まる", () => {
    expect(setupRetryOptionsFromEnv({})).toEqual({ attempts: 5, baseDelayMs: 2_000 });
    expect(setupRetryOptionsFromEnv({ [SETUP_RETRY_ATTEMPTS_ENV]: "2", [SETUP_RETRY_BASE_DELAY_ENV]: "50" })).toEqual({ attempts: 2, baseDelayMs: 50 });
    expect(() => setupRetryOptionsFromEnv({ [SETUP_RETRY_ATTEMPTS_ENV]: "0" })).toThrow(SETUP_RETRY_ATTEMPTS_ENV);
    expect(() => setupRetryOptionsFromEnv({ [SETUP_RETRY_BASE_DELAY_ENV]: "1.5" })).toThrow(SETUP_RETRY_BASE_DELAY_ENV);
  });

  it("間隔は倍にしていき、上限で止まる", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => setupRetryDelayMs(DEFAULT_SETUP_RETRY_BASE_DELAY_MS, n))).toEqual([
      2_000, 4_000, 8_000, 16_000, 16_000, 16_000,
    ]);
    expect(SETUP_RETRY_MAX_DELAY_MS).toBe(16_000);
  });

  it("状態・回数・間隔は認証のやり直しと同じ値。環境変数の名前は重ならない (それぞれ別に上書きできる)", () => {
    expect(SETUP_TRANSIENT_STATUSES).toEqual([HTTP_BAD_GATEWAY, HTTP_SERVICE_UNAVAILABLE, HTTP_GATEWAY_TIMEOUT]);
    expect(SETUP_TRANSIENT_STATUSES).toEqual(AUTH_TRANSIENT_STATUSES);
    expect(DEFAULT_SETUP_RETRY_ATTEMPTS).toBe(DEFAULT_AUTH_RETRY_ATTEMPTS);
    expect(DEFAULT_SETUP_RETRY_BASE_DELAY_MS).toBe(DEFAULT_AUTH_RETRY_BASE_DELAY_MS);
    expect(SETUP_RETRY_MAX_DELAY_MS).toBe(AUTH_RETRY_MAX_DELAY_MS);
    expect(new Set([SETUP_RETRY_ATTEMPTS_ENV, SETUP_RETRY_BASE_DELAY_ENV, AUTH_RETRY_ATTEMPTS_ENV, AUTH_RETRY_BASE_DELAY_ENV]).size).toBe(4);
  });

  it("scripts/local-ci.sh は、準備のやり直しの回数と間隔の環境変数を子プロセスに持ち込む", () => {
    const text = fs.readFileSync(path.join(ROOT, "scripts/local-ci.sh"), "utf8");
    const m = text.match(/readonly ENV_ALLOWLIST="([^"]*)"/);
    const names = (m?.[1] ?? "").split(/\s+/);
    expect(names).toContain(SETUP_RETRY_ATTEMPTS_ENV);
    expect(names).toContain(SETUP_RETRY_BASE_DELAY_ENV);
  });
});

/** 結合テストの道具 (helpers) のうち、service_role で準備の行を作る・読むもの */
const SETUP_HELPER_FILES = [
  "tests/integration/helpers/supabase.ts",
  "tests/integration/helpers/users.ts",
  "tests/integration/helpers/admin-test-utils.ts",
] as const;

/** 渡された db 以外 (外の client) で、表の select / upsert を始めている箇所 */
const OUTER_CLIENT_SELECT_OR_UPSERT = /\b(?!db\b)[A-Za-z_$][\w$]*(?:\(\))?\s*\.from\(\s*['"][^'"]+['"]\s*\)\s*\.(?:select|upsert)\(/g;

function listTestFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTestFiles(full);
    return entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

/** 準備の問い合わせの後ろに続いてよい、絞り込み・形だけを変える呼び出し (状態を変えない) */
const SETUP_CHAIN_TAIL = new Set([
  "eq", "neq", "in", "is", "match", "select", "single", "maybeSingle", "order", "limit", "range", "filter", "not", "or",
  "gt", "gte", "lt", "lte", "like", "ilike", "contains", "returns", "overrideTypes", "throwOnError", "csv", "abortSignal",
]);
/** 準備のフック (この中の select / upsert は準備) */
const SETUP_HOOKS = new Set(["beforeAll", "beforeEach"]);
/** 検査の本体・後片付け・まとまり (ここで止まれば、外の関数の中ではない) */
const NON_SETUP_BLOCKS = new Set(["it", "test", "afterAll", "afterEach", "describe"]);

type SetupContext = "hook" | "function" | "other";

/** node を囲む一番近いまとまり: 準備のフック / 名前のある関数 (利用者を作る関数など) / それ以外 */
function setupContextOf(node: ts.Node): SetupContext {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.expression : n.expression;
      if (ts.isIdentifier(callee) && SETUP_HOOKS.has(callee.text)) return "hook";
      if (ts.isIdentifier(callee) && NON_SETUP_BLOCKS.has(callee.text)) return "other";
    }
    if (ts.isFunctionDeclaration(n) && n.name) return "function";
    if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      return "function";
    }
  }
  return "other";
}

/**
 * やり直しを通さずに準備をしている箇所 (#1779 の同じ型) を返す。
 * - 準備のフックの中、または名前のある関数の中で、`await <変数>.from(...).upsert(...)` (既知の行の upsert)
 * - 準備のフックの中で、`await <変数>.from(...).select(...)`
 * 受け手が呼び出し (`userClient(jwt)` など、その場で作る本人の client) のものは、検査の本体として数えない。
 * retryIdempotentSetup の op の中 (受け手が db・await されない) は数えない。
 */
function findUnretriedSetupSites(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) {
      const methods: string[] = [];
      let fromCall: ts.CallExpression | null = null;
      let e: ts.Expression = node.expression;
      while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
        methods.unshift(e.expression.name.text);
        if (e.expression.name.text === "from") {
          fromCall = e;
          break;
        }
        e = e.expression.expression;
      }
      const receiver = fromCall && ts.isPropertyAccessExpression(fromCall.expression) ? fromCall.expression.expression : null;
      const kind = methods[1];
      if (
        receiver &&
        (ts.isIdentifier(receiver) || ts.isPropertyAccessExpression(receiver)) &&
        (kind === "upsert" || kind === "select") &&
        methods.slice(2).every((m) => SETUP_CHAIN_TAIL.has(m))
      ) {
        const context = setupContextOf(node);
        if (context === "hook" || (kind === "upsert" && context === "function")) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          found.push(`${fileName}:${line + 1} ${receiver.getText(sf)}.from(...).${kind} (${context})`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("findUnretriedSetupSites (各テストファイルの準備の構造の検査そのもの)", () => {
  it("利用者を作る関数の service_role の user_profiles の upsert (#1758 の parental-consent の形) を拾い、やり直しを通した形は拾わない", () => {
    const before = [
      "async function createUser(label: string) {",
      "  const { error: profileError } = await srAdmin",
      "    .from('user_profiles')",
      "    .upsert({ id: 'x', nickname: label, birth_date: null }, { onConflict: 'id' });",
      "}",
    ].join("\n");
    const after = [
      "async function createUser(label: string) {",
      "  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>",
      "    db.from('user_profiles').upsert({ id: 'x', nickname: label, birth_date: null }, { onConflict: 'id' }));",
      "}",
    ].join("\n");
    expect(findUnretriedSetupSites("a.test.ts", before)).toEqual(["a.test.ts:2 srAdmin.from(...).upsert (function)"]);
    expect(findUnretriedSetupSites("a.test.ts", after)).toEqual([]);
  });

  it("準備のフックの select・upsert を拾い、it の本体と、その場で作る本人の client は拾わない", () => {
    const source = [
      "beforeAll(async () => { const { data } = await admin.from('plans').select('id').eq('code', 'p').single(); });",
      "beforeEach(async () => { await ctx.admin.from('ai_daily_limits').upsert({ user_id: 'u' }); });",
      "it('本体', async () => { await admin.from('plans').select('id'); await admin.from('plans').upsert({ id: 'p' }); });",
      "const register = async (jwt: string) => { await userClient(jwt).from('user_push_tokens').upsert({ token: 't' }); };",
      "function read() { return admin.from('plans').select('id'); }",
    ].join("\n");
    expect(findUnretriedSetupSites("b.test.ts", source)).toEqual([
      "b.test.ts:1 admin.from(...).select (hook)",
      "b.test.ts:2 ctx.admin.from(...).upsert (hook)",
    ]);
  });
});

describe("同じ型を全域で (helpers と各ファイルの準備がやり直しを使う)", () => {
  it("helpers の service_role の準備 (行を作る・読む) は、すべて retryIdempotentSetup の db を通す", () => {
    for (const file of SETUP_HELPER_FILES) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(text.match(OUTER_CLIENT_SELECT_OR_UPSERT) ?? [], file).toEqual([]);
      expect(text, file).toContain("retryIdempotentSetup(");
    }
  });

  it("各テストファイルで、service_role の client が user_profiles を upsert する準備は、すべて retryIdempotentSetup を通す", () => {
    const outerProfileUpsert = /\b(?!db\b)[A-Za-z_$][\w$]*(?:\(\))?\s*\.from\(\s*['"]user_profiles['"]\s*\)\s*\.upsert\(/g;
    const offenders = listTestFiles(path.join(ROOT, "tests/integration")).flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      return (text.match(outerProfileUpsert) ?? []).map((hit) => `${path.relative(ROOT, file)}: ${hit}`);
    });
    expect(offenders).toEqual([]);
  });

  it("各テストファイルで、利用者を作る関数などの upsert と、準備のフックの select / upsert は、すべて retryIdempotentSetup を通す (main から入るファイルも含む)", () => {
    const offenders = listTestFiles(path.join(ROOT, "tests/integration")).flatMap((file) =>
      findUnretriedSetupSites(path.relative(ROOT, file), fs.readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
