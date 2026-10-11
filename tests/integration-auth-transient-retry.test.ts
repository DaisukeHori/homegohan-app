// @vitest-environment node
/**
 * tests/integration-auth-transient-retry.test.ts
 *
 * 結合テストのプロセスで、ローカル Supabase の認証 (/auth/v1) へのゲートウェイの一時的な失敗をやり直す仕組み
 * (tests/integration/helpers/auth-transient-retry.ts) の単体テスト。
 *
 * 回帰: 2026-10-11 の local-ci.sh の実走で、integration:security の 2 ファイルの beforeAll が、admin.createUser と
 * signInWithPassword の `{}` というメッセージのエラー (ゲートウェイの 502 / 503 / 504) で落ちた。
 * ここでは本物の supabase-js を、一時的な失敗を挟む偽の fetch の上で動かし、やり直しで作成・サインインが通ること、
 * やり直さない範囲 (アプリへの要求・認証の判定の 4xx・やり尽くしたとき) は今までどおり失敗が見えることを確かめる。
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_RETRY_ATTEMPTS_ENV,
  AUTH_RETRY_BASE_DELAY_ENV,
  AUTH_RETRY_MAX_DELAY_MS,
  DEFAULT_AUTH_RETRY_ATTEMPTS,
  DEFAULT_AUTH_RETRY_BASE_DELAY_MS,
  authRetryDelayMs,
  authRetryOptionsFromEnv,
  installAuthTransientRetry,
  withAuthTransientRetry,
  type AuthRetryOptions,
} from "./integration/helpers/auth-transient-retry";

const ROOT = process.cwd();
const SUPABASE_URL = "http://supabase.test";
const AUTH_BASE = `${SUPABASE_URL}/auth/v1/`;
const APP_URL = "http://app.test/api/health";
const SERVICE_KEY = "service-role-key-for-unit-test";
const TEST_EMAIL = "retry-user@example.test";
const TEST_PASSWORD = "unit-test-password";
const USER_ID = "00000000-0000-4000-8000-000000000001";
/** テストで使う回数と最初の間隔 (既定と違う小さい値なら何でもよい) */
const ATTEMPTS = 3;
const BASE_DELAY_MS = 10;

type Call = { url: string; method: string; headers: Headers; body: RequestInit["body"] };
type Reply = Response | Error;

/** 呼ばれた順に replies を返す偽の fetch (呼び出しを記録する) */
function scriptedFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), body: init?.body });
    const next = replies.shift();
    if (next === undefined) throw new Error(`想定より多く呼ばれた: ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

/** GoTrue が返す応答の形 (エラーの code を auth-js が読むには、API の版のヘッダーが要る) */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } });
}

/** Kong がゲートウェイの失敗で返す応答 (本文は auth-js が読まない) */
function gateway(status: number): Response {
  return new Response("upstream error", { status });
}

const user = { id: USER_ID, aud: "authenticated", role: "authenticated", email: TEST_EMAIL, app_metadata: {}, user_metadata: {}, created_at: "2026-10-11T00:00:00Z" };
const session = { access_token: "access-token", token_type: "bearer", expires_in: 3600, expires_at: 1_791_700_000, refresh_token: "refresh-token", user };
const emailExists = { code: "email_exists", msg: "A user with this email address has already been registered" };

function options(extra: Partial<AuthRetryOptions> = {}) {
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const opts: AuthRetryOptions = {
    authBaseUrl: AUTH_BASE,
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

/** 本物の supabase-js を、グローバルの fetch を差し替えた上で作る (supabase-js は呼ぶたびにグローバルの fetch を引く) */
function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("本物の supabase-js で: 2026-10-11 の落ち方 (beforeAll の `{}`)", () => {
  it("やり直しが無いと、504 で signInWithPassword は `{}` のエラーになる (落ち方の再現)", async () => {
    const fake = scriptedFetch([gateway(504)]);
    vi.stubGlobal("fetch", fake.fn);
    const { data, error } = await adminClient().auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(data.session).toBeNull();
    expect(error?.message).toBe("{}");
    expect(error?.status).toBe(504);
  });

  it("504 → 200 なら、signInWithPassword はやり直しでセッションを得る", async () => {
    const fake = scriptedFetch([gateway(504), json(200, session)]);
    const { opts, sleeps } = options();
    vi.stubGlobal("fetch", withAuthTransientRetry(fake.fn, opts));
    const { data, error } = await adminClient().auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(error).toBeNull();
    expect(data.session?.access_token).toBe(session.access_token);
    expect(fake.calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(fake.calls[1].body).toBe(fake.calls[0].body); // 同じ本文を送り直す
    expect(sleeps).toEqual([BASE_DELAY_MS]);
  });

  it("502 → 接続の失敗 → 200 なら、admin.createUser はやり直しでユーザーを得る", async () => {
    const fake = scriptedFetch([gateway(502), new TypeError("fetch failed"), json(200, user)]);
    const { opts, sleeps } = options();
    vi.stubGlobal("fetch", withAuthTransientRetry(fake.fn, opts));
    const { data, error } = await adminClient().auth.admin.createUser({ email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true });
    expect(error).toBeNull();
    expect(data.user?.id).toBe(USER_ID);
    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toEqual([BASE_DELAY_MS, BASE_DELAY_MS * 2]);
  });

  it("504 のあとのやり直しが 422 (email_exists) なら、1 回目で作られていたユーザーを一覧で探して返す", async () => {
    const fake = scriptedFetch([gateway(504), json(422, emailExists), json(200, { users: [{ ...user, email: "other@example.test" }, user], aud: "authenticated" })]);
    const { opts, warnings } = options();
    vi.stubGlobal("fetch", withAuthTransientRetry(fake.fn, opts));
    const { data, error } = await adminClient().auth.admin.createUser({ email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true });
    expect(error).toBeNull();
    expect(data.user?.id).toBe(USER_ID);
    expect(data.user?.email).toBe(TEST_EMAIL);
    const lookup = fake.calls[2];
    expect(lookup.method).toBe("GET");
    expect(lookup.body).toBeUndefined();
    const lookupUrl = new URL(lookup.url);
    expect(`${lookupUrl.origin}${lookupUrl.pathname}`).toBe(`${AUTH_BASE}admin/users`);
    expect(lookupUrl.searchParams.get("filter")).toBe(TEST_EMAIL);
    // 管理 API の鍵は元の要求のものをそのまま使う
    expect(lookup.headers.get("apikey")).toBe(SERVICE_KEY);
    expect(lookup.headers.get("authorization")).toBe(`Bearer ${SERVICE_KEY}`);
    expect(warnings.some((w) => w.includes("email_exists"))).toBe(true);
  });

  it("一時的な失敗を挟んでいない 422 (email_exists) は、探さずにそのままエラーにする (わざと重複を作るテストを守る)", async () => {
    const fake = scriptedFetch([json(422, emailExists)]);
    const { opts } = options();
    vi.stubGlobal("fetch", withAuthTransientRetry(fake.fn, opts));
    const { data, error } = await adminClient().auth.admin.createUser({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(data.user).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.code).toBe("email_exists");
    expect(fake.calls).toHaveLength(1);
  });

  it("504 のあとの 422 で、一覧に同じメールのユーザーがいなければ、その 422 をそのまま返す", async () => {
    const fake = scriptedFetch([gateway(504), json(422, emailExists), json(200, { users: [{ ...user, email: "other@example.test" }] })]);
    const { opts } = options();
    vi.stubGlobal("fetch", withAuthTransientRetry(fake.fn, opts));
    const { data, error } = await adminClient().auth.admin.createUser({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(data.user).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.code).toBe("email_exists");
  });

  it("やり尽くしたら最後の失敗をそのまま返す (やり直しで緑を作らない)", async () => {
    const fake = scriptedFetch([gateway(503), gateway(503), gateway(504)]);
    const { opts, sleeps } = options();
    vi.stubGlobal("fetch", withAuthTransientRetry(fake.fn, opts));
    const { data, error } = await adminClient().auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(data.session).toBeNull();
    expect(error?.status).toBe(504);
    expect(fake.calls).toHaveLength(ATTEMPTS);
    expect(sleeps).toEqual([BASE_DELAY_MS, BASE_DELAY_MS * 2]);
  });

  it("認証の判定 (400 / 429) はやり直さずにそのまま返す", async () => {
    for (const status of [400, 429]) {
      const fake = scriptedFetch([json(status, { code: "invalid_credentials", msg: "Invalid login credentials" })]);
      const { opts, sleeps } = options();
      vi.stubGlobal("fetch", withAuthTransientRetry(fake.fn, opts));
      const { error } = await adminClient().auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
      expect(error?.status, String(status)).toBe(status);
      expect(fake.calls, String(status)).toHaveLength(1);
      expect(sleeps, String(status)).toEqual([]);
    }
  });
});

describe("withAuthTransientRetry の線引き", () => {
  it("アプリ (認証の URL の外) への 503 はやり直さない (アプリの 503 を検査するテストを守る)", async () => {
    const fake = scriptedFetch([gateway(503)]);
    const { opts } = options();
    const res = await withAuthTransientRetry(fake.fn, opts)(APP_URL);
    expect(res.status).toBe(503);
    expect(fake.calls).toHaveLength(1);
  });

  it("同じ Supabase の認証以外 (REST) への 503 もやり直さない", async () => {
    const fake = scriptedFetch([gateway(503)]);
    const { opts } = options();
    const res = await withAuthTransientRetry(fake.fn, opts)(`${SUPABASE_URL}/rest/v1/user_profiles`);
    expect(res.status).toBe(503);
    expect(fake.calls).toHaveLength(1);
  });

  it("送り直せない本文 (文字列でない) はやり直さない", async () => {
    const fake = scriptedFetch([gateway(503)]);
    const { opts } = options();
    const res = await withAuthTransientRetry(fake.fn, opts)(`${AUTH_BASE}token`, { method: "POST", body: new URLSearchParams({ a: "b" }) });
    expect(res.status).toBe(503);
    expect(fake.calls).toHaveLength(1);
  });

  it("呼び出し側が中断していたら、接続の失敗をやり直さずに投げる", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = scriptedFetch([new Error("aborted")]);
    const { opts } = options();
    await expect(withAuthTransientRetry(fake.fn, opts)(`${AUTH_BASE}user`, { signal: controller.signal })).rejects.toThrow("aborted");
    expect(fake.calls).toHaveLength(1);
  });

  it("やり尽くした接続の失敗は、その例外を投げる", async () => {
    const fake = scriptedFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const { opts } = options();
    await expect(withAuthTransientRetry(fake.fn, opts)(`${AUTH_BASE}user`)).rejects.toThrow("fetch failed");
    expect(fake.calls).toHaveLength(ATTEMPTS);
  });

  it("間隔は倍にしていき、上限で止まる", () => {
    expect(authRetryDelayMs(DEFAULT_AUTH_RETRY_BASE_DELAY_MS, 1)).toBe(DEFAULT_AUTH_RETRY_BASE_DELAY_MS);
    expect(authRetryDelayMs(DEFAULT_AUTH_RETRY_BASE_DELAY_MS, 2)).toBe(DEFAULT_AUTH_RETRY_BASE_DELAY_MS * 2);
    expect(authRetryDelayMs(DEFAULT_AUTH_RETRY_BASE_DELAY_MS, 4)).toBe(AUTH_RETRY_MAX_DELAY_MS);
    expect(authRetryDelayMs(DEFAULT_AUTH_RETRY_BASE_DELAY_MS, 10)).toBe(AUTH_RETRY_MAX_DELAY_MS);
  });
});

describe("設定と取り付け", () => {
  it("既定は 5 回・最初の間隔 2 秒。環境変数で上書きでき、正の整数でなければ止まる", () => {
    expect(authRetryOptionsFromEnv({ NEXT_PUBLIC_SUPABASE_URL: `${SUPABASE_URL}/` })).toEqual({
      authBaseUrl: AUTH_BASE,
      attempts: DEFAULT_AUTH_RETRY_ATTEMPTS,
      baseDelayMs: DEFAULT_AUTH_RETRY_BASE_DELAY_MS,
    });
    expect(DEFAULT_AUTH_RETRY_ATTEMPTS).toBe(5);
    expect(DEFAULT_AUTH_RETRY_BASE_DELAY_MS).toBe(2_000);
    expect(
      authRetryOptionsFromEnv({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, [AUTH_RETRY_ATTEMPTS_ENV]: "1", [AUTH_RETRY_BASE_DELAY_ENV]: "500" }),
    ).toEqual({ authBaseUrl: AUTH_BASE, attempts: 1, baseDelayMs: 500 });
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      expect(() => authRetryOptionsFromEnv({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, [AUTH_RETRY_ATTEMPTS_ENV]: bad }), bad).toThrow(AUTH_RETRY_ATTEMPTS_ENV);
      expect(() => authRetryOptionsFromEnv({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, [AUTH_RETRY_BASE_DELAY_ENV]: bad }), bad).toThrow(AUTH_RETRY_BASE_DELAY_ENV);
    }
    expect(authRetryOptionsFromEnv({})).toBeNull();
  });

  it("回数 1 ならやり直さない", async () => {
    const fake = scriptedFetch([gateway(504)]);
    const { opts } = options({ attempts: 1 });
    const res = await withAuthTransientRetry(fake.fn, opts)(`${AUTH_BASE}user`);
    expect(res.status).toBe(504);
    expect(fake.calls).toHaveLength(1);
  });

  it("installAuthTransientRetry は 1 回だけ差し替え (モジュールを読み直しても)、URL が無ければ差し替えない", async () => {
    const fake = scriptedFetch([gateway(502), json(200, user)]);
    const target = { fetch: fake.fn };
    expect(installAuthTransientRetry({}, target)).toBe(false);
    expect(target.fetch).toBe(fake.fn);
    expect(installAuthTransientRetry({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, [AUTH_RETRY_BASE_DELAY_ENV]: "1" }, target)).toBe(true);
    const wrapped = target.fetch;
    expect(wrapped).not.toBe(fake.fn);
    expect(installAuthTransientRetry({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL }, target)).toBe(false);
    expect(target.fetch).toBe(wrapped);
    // モジュールが評価し直されても (テストのファイルごとに setupFiles が走っても)、差し替え済みの fetch は包み直さない
    vi.resetModules();
    const reloaded = await import("./integration/helpers/auth-transient-retry");
    expect(reloaded.installAuthTransientRetry({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL }, target)).toBe(false);
    expect(target.fetch).toBe(wrapped);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await target.fetch(`${AUTH_BASE}user`);
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(2);
  });

  it("tests/integration/setup.ts は、結合テストのプロセスで差し替えを取り付ける", () => {
    const text = fs.readFileSync(path.join(ROOT, "tests/integration/setup.ts"), "utf8");
    expect(text).toMatch(/^import \{ installAuthTransientRetry \} from '\.\/helpers\/auth-transient-retry';$/m);
    expect(text).toMatch(/^installAuthTransientRetry\(process\.env\);$/m);
    // 取り付けは .env.local を読んだあと (NEXT_PUBLIC_SUPABASE_URL を .env.local から得る場合がある)
    expect(text.indexOf("installAuthTransientRetry(process.env)")).toBeGreaterThan(text.indexOf("dotenvConfig("));
  });

  it("scripts/local-ci.sh は、やり直しの回数と間隔の環境変数を子プロセスに持ち込む", () => {
    const text = fs.readFileSync(path.join(ROOT, "scripts/local-ci.sh"), "utf8");
    const m = /^readonly ENV_ALLOWLIST="([^"]*)"$/m.exec(text);
    expect(m, "ENV_ALLOWLIST が無い").not.toBeNull();
    const names = (m?.[1] ?? "").split(/\s+/);
    expect(names).toContain(AUTH_RETRY_ATTEMPTS_ENV);
    expect(names).toContain(AUTH_RETRY_BASE_DELAY_ENV);
  });
});
