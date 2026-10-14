// @vitest-environment node
/**
 * tests/e2e-test-session.test.ts (#1547)
 *
 * Supabase の CAPTCHA を有効にすると、トークンの無いパスワードのログイン (/auth/v1/token?grant_type=password) は断られる。
 * e2e・デプロイ後の動作確認 (--with-auth)・Maestro の補助スクリプトは、パスワードのログインを使わず、
 * 管理用の鍵 (service_role) でセッションを作るように変えた。ここでは次を確かめる。
 *
 *   1. 共通の補助関数 tests/e2e/helpers/test-session.mjs の createTestSession が呼ぶのは、
 *      POST /auth/v1/admin/generate_link (service_role) → POST /auth/v1/verify (anon key) の 2 つだけで、
 *      パスワードのログインを呼ばないこと (呼び出しの検査)。失敗の段・ステータスの報告と、鍵を出さないこと。
 *      同じメールアドレスで並行に呼ばれて /verify が 403 になったら、generate_link からやり直すこと
 *   2. Issue に挙がった e2e の各所が、この補助関数を使うこと (自分でパスワードのログインを呼ばない)
 *   3. テストの道具 (tests/e2e・scripts・apps/mobile/maestro) のコード (コメントを除く) に、パスワードのログインが戻ってこないこと。
 *      /auth/v1/admin/generate_link・/auth/v1/verify を直接呼ぶのは、共通の補助関数と、import できない Maestro のスクリプトだけであること
 *      (--with-auth の scripts/lib/smoke.mjs も、補助関数を import して使う。同じ処理を写さない)
 *   4. Maestro の apps/mobile/maestro/flows/scripts/reset-onboarding.js を、Maestro の http を差し替えて動かしたときの呼び出し
 *      (確認が otp_expired のときのやり直しを含む)。やり直す回数の解釈が補助関数と同じであること (同じ入力で突き合わせる)
 *      (Maestro そのものは手元では動かせない。実機・シミュレーターが要る)
 *
 * ローカルの Supabase (local-ci) は CAPTCHA が無効なので、e2e が緑でも「CAPTCHA が有効でも通る」ことは示せない。
 * CAPTCHA の対象外の経路 (/admin/generate_link と /verify) だけを呼ぶことを、ここで呼び出しの形で固定する。
 *
 * fetch は差し替える。実際のネットワーク・Supabase には接続しない。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  TEST_SESSION_DEFAULT_MAX_ATTEMPTS,
  TEST_SESSION_ENV_NAMES,
  TEST_SESSION_LINK_TYPE,
  TEST_SESSION_MAX_ATTEMPTS_ENV,
  TEST_SESSION_NO_HTTP_STATUS,
  TEST_SESSION_RETRY_BASE_DELAY_MS,
  TEST_SESSION_VERIFY_RETRY_STATUS,
  createTestSession,
  describeTestSessionFailure,
  missingTestSessionEnv,
  readTestSessionConfig,
  testSessionMaxAttempts,
  type TestSessionConfig,
} from "./e2e/helpers/test-session.mjs";

const ROOT = path.resolve(__dirname, "..");

// 実在の鍵やアカウントに見えないテスト用の値 (出力に出てはいけない目印)
const SUPABASE_URL = "https://test-session-project.supabase.co";
const ANON_KEY = "test-anon-key-should-never-be-printed";
const SERVICE_ROLE_KEY = "test-service-role-key-should-never-be-printed";
const TOKEN_HASH = "test-token-hash-should-never-be-printed";
const ACCESS_TOKEN = "test-access-token";
const EMAIL = "someone@example.test";

const CONFIG: TestSessionConfig = { supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY };

const GENERATE_LINK_URL = `${SUPABASE_URL}/auth/v1/admin/generate_link`;
const VERIFY_URL = `${SUPABASE_URL}/auth/v1/verify`;

const SESSION = {
  access_token: ACCESS_TOKEN,
  refresh_token: "test-refresh-token",
  expires_at: 1_900_000_000,
  expires_in: 3600,
  token_type: "bearer",
  user: { id: "user-1", email: EMAIL },
};

type Handler = (init: RequestInit) => Response | Promise<Response>;

/** URL ごとに応答を返す fetch。呼ばれた URL・メソッド・ヘッダー・本文を記録する */
function makeFetch(overrides: Partial<Record<string, Handler>> = {}) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
    const handler = overrides[url];
    if (handler) return handler(init);
    if (url === GENERATE_LINK_URL) {
      return Response.json({ id: "user-1", email: EMAIL, hashed_token: TOKEN_HASH, verification_type: "recovery" });
    }
    if (url === VERIFY_URL) return Response.json(SESSION);
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, mock: fetchImpl };
}

describe("createTestSession (tests/e2e/helpers/test-session.mjs)", () => {
  it("generate_link (service_role) → verify (anon key) の 2 つだけを呼び、セッションをそのまま返す", async () => {
    const { fetchImpl, calls } = makeFetch();

    const result = await createTestSession(EMAIL, { config: CONFIG, fetchImpl });

    expect(result).toEqual({ ok: true, session: SESSION });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${GENERATE_LINK_URL}`, `POST ${VERIFY_URL}`]);

    const [link, verify] = calls;
    expect(link.headers.get("apikey")).toBe(SERVICE_ROLE_KEY);
    expect(link.headers.get("authorization")).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
    expect(link.body).toEqual({ type: "recovery", email: EMAIL });

    // /verify には公開用の anon key だけ。管理用の鍵は送らない。token_hash にメールアドレスを添えない (Auth が断るため)
    expect(verify.headers.get("apikey")).toBe(ANON_KEY);
    expect(verify.headers.get("authorization")).toBeNull();
    expect(verify.body).toEqual({ type: "recovery", token_hash: TOKEN_HASH });
  });

  it("パスワードのログイン (/auth/v1/token) は呼ばない。パスワードも送らない (#1547)", async () => {
    const { fetchImpl, calls } = makeFetch();

    await createTestSession(EMAIL, { config: CONFIG, fetchImpl });

    expect(calls.some((c) => c.url.includes("/auth/v1/token"))).toBe(false);
    expect(calls.some((c) => c.url.includes("grant_type"))).toBe(false);
    for (const call of calls) expect(Object.keys(call.body as Record<string, unknown>)).not.toContain("password");
    // CAPTCHA が掛かる経路 (/signup /recover /resend /magiclink /otp) も呼ばない
    for (const route of ["/auth/v1/signup", "/auth/v1/recover", "/auth/v1/resend", "/auth/v1/magiclink", "/auth/v1/otp"]) {
      expect(calls.some((c) => c.url.includes(route)), route).toBe(false);
    }
  });

  it("type は recovery (ユーザーがいなければ作らずに 404 で止まる。magiclink はユーザーを作ってしまう)", () => {
    expect(TEST_SESSION_LINK_TYPE).toBe("recovery");
  });

  it("ユーザーがいない (generate_link が 404) なら、確認 (/verify) に進まず、段とステータスを返す", async () => {
    const { fetchImpl, calls } = makeFetch({
      [GENERATE_LINK_URL]: () => Response.json({ code: 404, error_code: "user_not_found" }, { status: 404 }),
    });

    const result = await createTestSession(EMAIL, { config: CONFIG, fetchImpl });

    expect(result).toMatchObject({ ok: false, step: "generate_link", status: 404 });
    expect(calls).toHaveLength(1);
  });

  it("generate_link の応答に hashed_token が無ければ、確認に進まずに失敗する", async () => {
    const { fetchImpl, calls } = makeFetch({ [GENERATE_LINK_URL]: () => Response.json({ id: "user-1" }) });

    const result = await createTestSession(EMAIL, { config: CONFIG, fetchImpl });

    expect(result).toMatchObject({ ok: false, step: "generate_link", status: 200 });
    expect(calls).toHaveLength(1);
  });

  it("確認 (/verify) の失敗・access_token の無い応答は、段 verify とステータスを返す", async () => {
    const expired = makeFetch({
      [VERIFY_URL]: () => Response.json({ error_code: "otp_expired" }, { status: 403 }),
    });
    expect(
      await createTestSession(EMAIL, { config: CONFIG, fetchImpl: expired.fetchImpl, sleepImpl: async () => {} }),
    ).toMatchObject({
      ok: false,
      step: "verify",
      status: 403,
    });

    const unauthorized = makeFetch({ [VERIFY_URL]: () => new Response("bad", { status: 401 }) });
    expect(await createTestSession(EMAIL, { config: CONFIG, fetchImpl: unauthorized.fetchImpl })).toMatchObject({
      ok: false,
      step: "verify",
      status: 401,
    });

    const empty = makeFetch({ [VERIFY_URL]: () => Response.json({}) });
    const result = await createTestSession(EMAIL, { config: CONFIG, fetchImpl: empty.fetchImpl });
    expect(result).toMatchObject({ ok: false, step: "verify", status: 200 });
    if (!result.ok) expect(result.detail).toContain("access_token");
  });

  it("429 (rate limit) は status 429 で返す (呼び出し側がやり直しを決める)", async () => {
    const { fetchImpl } = makeFetch({ [VERIFY_URL]: () => new Response("rate limited", { status: 429 }) });

    expect(await createTestSession(EMAIL, { config: CONFIG, fetchImpl })).toMatchObject({
      ok: false,
      step: "verify",
      status: 429,
    });
  });

  it("通信できないときは例外にせず、HTTP の応答が無いことを status で返し、投げられた例外を cause に添える", async () => {
    const thrown = new TypeError("fetch failed");
    const fetchImpl = vi.fn(async () => {
      throw thrown;
    }) as unknown as typeof fetch;

    const result = await createTestSession(EMAIL, { config: CONFIG, fetchImpl });

    expect(result).toMatchObject({ ok: false, step: "generate_link", status: TEST_SESSION_NO_HTTP_STATUS });
    // 呼び出し側 (smoke) が、時間切れなどを自分の書き方で説明できるように、例外そのものを渡す
    if (!result.ok) expect(result.cause).toBe(thrown);

    // 確認 (/verify) で通信できなかったときも同じ
    const verifyThrown = new TypeError("fetch failed");
    const verifyDown = makeFetch({
      [VERIFY_URL]: () => {
        throw verifyThrown;
      },
    });
    const verifyResult = await createTestSession(EMAIL, { config: CONFIG, fetchImpl: verifyDown.fetchImpl });
    expect(verifyResult).toMatchObject({ ok: false, step: "verify", status: TEST_SESSION_NO_HTTP_STATUS });
    if (!verifyResult.ok) expect(verifyResult.cause).toBe(verifyThrown);
  });

  it("HTTP の応答があった失敗には cause を付けない (通信できなかったものと見分けられる)", async () => {
    const { fetchImpl } = makeFetch({ [GENERATE_LINK_URL]: () => new Response("error", { status: 500 }) });

    const result = await createTestSession(EMAIL, { config: CONFIG, fetchImpl });

    expect(result.ok).toBe(false);
    expect("cause" in result).toBe(false);
  });

  it("環境変数が足りなければ、どこにも接続せずに段 config で返し、足りない名前だけを報告する (値は出さない)", async () => {
    const { fetchImpl, mock } = makeFetch();

    const result = await createTestSession(EMAIL, { config: null, fetchImpl });

    expect(result).toMatchObject({ ok: false, step: "config", status: TEST_SESSION_NO_HTTP_STATUS });
    expect(mock).not.toHaveBeenCalled();
  });

  it("失敗の説明に、鍵・トークンの値を含めない (応答の本文に入っていても、段・ステータスと本文の先頭だけ)", async () => {
    const { fetchImpl } = makeFetch({
      [GENERATE_LINK_URL]: () => new Response("x".repeat(1_000), { status: 500 }),
    });

    const result = await createTestSession(EMAIL, { config: CONFIG, fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = describeTestSessionFailure(result);
    for (const secret of [SERVICE_ROLE_KEY, ANON_KEY, TOKEN_HASH]) expect(text).not.toContain(secret);
    expect(text).toContain("generate_link");
    expect(text).toContain("HTTP 500");
    // 長い本文で出力が埋まらない
    expect(text.length).toBeLessThan(400);
  });

  it("応答の本文の先頭は detail に入れず responseBodyPreview に分ける (本文を出さない呼び出し側は detail だけを出せる)。e2e の説明には付ける", async () => {
    const marker = "body-marker-from-auth";
    const { fetchImpl } = makeFetch({
      [VERIFY_URL]: () => new Response(`${marker} ${"y".repeat(1_000)}`, { status: 401 }),
    });

    const result = await createTestSession(EMAIL, { config: CONFIG, fetchImpl });

    expect(result).toMatchObject({ ok: false, step: "verify", status: 401, detail: "HTTP 401" });
    if (result.ok) return;
    expect(result.detail).not.toContain(marker);
    expect(result.responseBodyPreview?.startsWith(marker)).toBe(true);
    expect(result.responseBodyPreview?.length).toBeLessThan(1_000);
    expect(describeTestSessionFailure(result)).toContain(marker);
  });

  // ─── 同じメールアドレスで並行に呼ばれたとき (後の generate_link が先のトークンを消す) ───

  it("/verify が 403 なら、待ってから generate_link からやり直し、新しいトークンでセッションを返す", async () => {
    let issued = 0;
    const { fetchImpl, calls } = makeFetch({
      [GENERATE_LINK_URL]: () => Response.json({ hashed_token: `${TOKEN_HASH}-${++issued}` }),
      [VERIFY_URL]: () =>
        calls.filter((c) => c.url === VERIFY_URL).length === 1
          ? Response.json({ code: 403, error_code: "otp_expired" }, { status: 403 })
          : Response.json(SESSION),
    });
    const sleeps: number[] = [];

    const result = await createTestSession(EMAIL, {
      config: CONFIG,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      randomImpl: () => 0.5,
    });

    expect(result).toEqual({ ok: true, session: SESSION });
    expect(calls.map((c) => c.url)).toEqual([GENERATE_LINK_URL, VERIFY_URL, GENERATE_LINK_URL, VERIFY_URL]);
    // やり直しの確認は、やり直しで発行した新しいトークンで行う (消されたトークンを使い回さない)
    expect(calls[3].body).toEqual({ type: "recovery", token_hash: `${TOKEN_HASH}-2` });
    expect(sleeps).toEqual([Math.floor(0.5 * TEST_SESSION_RETRY_BASE_DELAY_MS)]);
  });

  it("同じメールアドレスで 2 つ同時に呼んでも、どちらもセッションを受け取る (Supabase Auth の消し合いを再現)", async () => {
    // Supabase Auth の動き: 発行するたびに同じ種類の既存のトークンを消す。確認は今のトークンだけを受け付け、使ったら消す
    let issued = 0;
    let current: string | null = null;
    const { fetchImpl, calls } = makeFetch({
      [GENERATE_LINK_URL]: () => {
        current = `${TOKEN_HASH}-${++issued}`;
        return Response.json({ hashed_token: current });
      },
      [VERIFY_URL]: (init) => {
        const { token_hash } = JSON.parse(String(init.body)) as { token_hash: string };
        if (token_hash !== current) return Response.json({ code: 403, error_code: "otp_expired" }, { status: 403 });
        current = null;
        return Response.json(SESSION);
      },
    });
    const options = { config: CONFIG, fetchImpl, sleepImpl: async () => {}, randomImpl: () => 0 };

    const [first, second] = await Promise.all([createTestSession(EMAIL, options), createTestSession(EMAIL, options)]);

    expect(first).toEqual({ ok: true, session: SESSION });
    expect(second).toEqual({ ok: true, session: SESSION });
    // 2 つの発行が先に済み、先の確認が 403 になってから、やり直している (競合が起きたうえで吸収したこと)
    expect(calls.slice(0, 2).map((c) => c.url)).toEqual([GENERATE_LINK_URL, GENERATE_LINK_URL]);
    expect(calls.filter((c) => c.url === GENERATE_LINK_URL).length).toBeGreaterThan(2);
  });

  it("/verify の 403 が続けば、上限の回数で止めて段 verify・403 と試した回数を返す。待ち時間の幅は回数とともに広がる", async () => {
    const { fetchImpl, calls } = makeFetch({
      [VERIFY_URL]: () => Response.json({ error_code: "otp_expired" }, { status: 403 }),
    });
    const sleeps: number[] = [];
    const maxAttempts = 3;

    const result = await createTestSession(EMAIL, {
      config: CONFIG,
      fetchImpl,
      maxAttempts,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      randomImpl: () => 0.5,
    });

    expect(result).toMatchObject({ ok: false, step: "verify", status: TEST_SESSION_VERIFY_RETRY_STATUS });
    if (!result.ok) expect(result.detail).toContain(`${maxAttempts} 回`);
    expect(calls.filter((c) => c.url === GENERATE_LINK_URL)).toHaveLength(maxAttempts);
    expect(calls.filter((c) => c.url === VERIFY_URL)).toHaveLength(maxAttempts);
    expect(sleeps).toEqual([
      Math.floor(0.5 * TEST_SESSION_RETRY_BASE_DELAY_MS * 1),
      Math.floor(0.5 * TEST_SESSION_RETRY_BASE_DELAY_MS * 2),
    ]);
  });

  it("やり直すのは /verify の 403 だけ。generate_link の失敗や /verify の 403 以外 (401・429・500・通信できない) はやり直さない", async () => {
    const cases: Array<[string, Partial<Record<string, Handler>>]> = [
      ["generate_link 403", { [GENERATE_LINK_URL]: () => new Response("forbidden", { status: 403 }) }],
      ["verify 401", { [VERIFY_URL]: () => new Response("bad", { status: 401 }) }],
      ["verify 429", { [VERIFY_URL]: () => new Response("rate limited", { status: 429 }) }],
      ["verify 500", { [VERIFY_URL]: () => new Response("error", { status: 500 }) }],
      [
        "verify 通信できない",
        {
          [VERIFY_URL]: () => {
            throw new TypeError("fetch failed");
          },
        },
      ],
    ];
    for (const [name, overrides] of cases) {
      const { fetchImpl, calls } = makeFetch(overrides);
      const sleepImpl = vi.fn(async () => {});

      const result = await createTestSession(EMAIL, { config: CONFIG, fetchImpl, sleepImpl });

      expect(result.ok, name).toBe(false);
      expect(calls.filter((c) => c.url === GENERATE_LINK_URL), name).toHaveLength(1);
      expect(sleepImpl, name).not.toHaveBeenCalled();
    }
  });

  it("試す回数の上限は、省略すれば環境変数 (1 以上の整数) か既定の値", async () => {
    expect(TEST_SESSION_MAX_ATTEMPTS_ENV).toBe("E2E_TEST_SESSION_MAX_ATTEMPTS");
    expect(testSessionMaxAttempts({})).toBe(TEST_SESSION_DEFAULT_MAX_ATTEMPTS);
    expect(testSessionMaxAttempts({ E2E_TEST_SESSION_MAX_ATTEMPTS: "9" })).toBe(9);
    expect(testSessionMaxAttempts({ E2E_TEST_SESSION_MAX_ATTEMPTS: " 2 " })).toBe(2);
    expect(testSessionMaxAttempts({ E2E_TEST_SESSION_MAX_ATTEMPTS: "1" })).toBe(1);
    for (const invalid of ["", "0", "-1", "1.5", "abc", "99999999999999999999"]) {
      expect(testSessionMaxAttempts({ E2E_TEST_SESSION_MAX_ATTEMPTS: invalid }), invalid).toBe(
        TEST_SESSION_DEFAULT_MAX_ATTEMPTS,
      );
    }

    // createTestSession は maxAttempts を省略すると環境変数を読む
    vi.stubEnv(TEST_SESSION_MAX_ATTEMPTS_ENV, "2");
    try {
      const { fetchImpl, calls } = makeFetch({
        [VERIFY_URL]: () => Response.json({ error_code: "otp_expired" }, { status: 403 }),
      });
      await createTestSession(EMAIL, { config: CONFIG, fetchImpl, sleepImpl: async () => {} });
      expect(calls.filter((c) => c.url === GENERATE_LINK_URL)).toHaveLength(2);

      vi.stubEnv(TEST_SESSION_MAX_ATTEMPTS_ENV, "");
      const defaults = makeFetch({
        [VERIFY_URL]: () => Response.json({ error_code: "otp_expired" }, { status: 403 }),
      });
      await createTestSession(EMAIL, { config: CONFIG, fetchImpl: defaults.fetchImpl, sleepImpl: async () => {} });
      expect(defaults.calls.filter((c) => c.url === GENERATE_LINK_URL)).toHaveLength(TEST_SESSION_DEFAULT_MAX_ATTEMPTS);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("options.env を渡せば、設定と回数の上限を process.env ではなくそこから読む (smoke は自分の env を渡す)", async () => {
    vi.stubEnv(TEST_SESSION_MAX_ATTEMPTS_ENV, "5");
    try {
      const { fetchImpl, calls } = makeFetch({
        [VERIFY_URL]: () => Response.json({ error_code: "otp_expired" }, { status: 403 }),
      });
      const env = {
        NEXT_PUBLIC_SUPABASE_URL: `${SUPABASE_URL}/`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
        [TEST_SESSION_MAX_ATTEMPTS_ENV]: "2",
      };

      const result = await createTestSession(EMAIL, { env, fetchImpl, sleepImpl: async () => {} });

      expect(result).toMatchObject({ ok: false, step: "verify", status: TEST_SESSION_VERIFY_RETRY_STATUS });
      // 末尾の / を落とした env の URL へ送り、env の上限 (2) で止める (process.env の 5 は使わない)
      expect(calls.map((c) => c.url)).toEqual([GENERATE_LINK_URL, VERIFY_URL, GENERATE_LINK_URL, VERIFY_URL]);
      expect(calls[0].headers.get("apikey")).toBe(SERVICE_ROLE_KEY);

      // env に足りないものがあれば、その env で足りない名前だけを返す
      const missing = await createTestSession(EMAIL, {
        env: { NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL },
        fetchImpl,
      });
      expect(missing).toMatchObject({ ok: false, step: "config", status: TEST_SESSION_NO_HTTP_STATUS });
      if (!missing.ok) {
        expect(missing.detail).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
        expect(missing.detail).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("readTestSessionConfig は今までのテストと同じ環境変数を読み、1 つでも無ければ null。URL の末尾の / は落とす", () => {
    expect(TEST_SESSION_ENV_NAMES).toEqual({
      supabaseUrl: "NEXT_PUBLIC_SUPABASE_URL",
      anonKey: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      serviceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
    });
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: `${SUPABASE_URL}/`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    };
    expect(readTestSessionConfig(env)).toEqual(CONFIG);
    expect(readTestSessionConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: "" })).toBeNull();
    expect(missingTestSessionEnv({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL })).toEqual([
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// コードの走査 (コメントを除いてから見る。説明のコメントに経路の名前が出てくるため)
// ───────────────────────────────────────────────────────────────────────────

const CODE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".auth", ".output", ".report"]);

function listCodeFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listCodeFiles(rel));
    else if (CODE_EXT.test(entry.name)) out.push(rel);
  }
  return out;
}

function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** コメントを取り除いたコード (文字列の中の // などは壊さない) */
function stripComments(file: string, text: string): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKindOf(file));
  return ts.createPrinter({ removeComments: true }).printFile(source);
}

/** 共通の補助関数 (セッションを作る手順のただ 1 つの本体) */
const SHARED_HELPER = "tests/e2e/helpers/test-session.mjs";
const SHARED_HELPER_ABS = path.join(ROOT, SHARED_HELPER);
/** import できない Maestro の JavaScript に写した、ただ 1 つの写し */
const MAESTRO_COPY = "apps/mobile/maestro/flows/scripts/reset-onboarding.js";

/** セッションを作る手順 (発行・確認) を直接呼んでいることを示すもの */
const SESSION_ROUTE = /\/auth\/v1\/(?:admin\/generate_link|verify)\b|\.verifyOtp\s*\(/;

/** パスワードのログインの呼び出し (CAPTCHA を有効にすると断られるもの) */
const PASSWORD_LOGIN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/grant_type=password/, "/auth/v1/token?grant_type=password"],
  [/\.signInWithPassword\s*\(/, "signInWithPassword()"],
];

describe("テストの道具が、パスワードのログインを呼ばない (#1547)", () => {
  // 結合テスト (tests/integration) は、ローカルの Supabase (CAPTCHA は常に無効) にだけ向けて動くので対象外
  // (docs/operations/auth-protection.md §4・§8)
  const files = ["tests/e2e", "scripts", "apps/mobile/maestro"].flatMap(listCodeFiles);

  it("走査の対象が空ではない (Issue に挙がったファイルを含む)", () => {
    for (const f of [
      "tests/e2e/global-setup.ts",
      "tests/e2e/fixtures/auth.ts",
      "tests/e2e/fixtures/fresh-user.ts",
      "tests/e2e/helpers/seed-roles.ts",
      "tests/e2e/tour/helpers.ts",
      "tests/e2e/tour/01-eligibility.spec.ts",
      "tests/e2e/membership/02-org-invite-new-user.spec.ts",
      "tests/e2e/helpers/test-session.mjs",
      "scripts/lib/smoke.mjs",
      "apps/mobile/maestro/flows/scripts/reset-onboarding.js",
    ]) {
      expect(files, f).toContain(path.join(f));
    }
  });

  it("コメントを除いたコードに、パスワードのログインが無い", () => {
    const violations: string[] = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      if (!PASSWORD_LOGIN_PATTERNS.some(([pattern]) => pattern.test(text))) continue;
      const code = stripComments(rel, text);
      for (const [pattern, label] of PASSWORD_LOGIN_PATTERNS) {
        if (pattern.test(code)) violations.push(`${rel}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("走査は、コメントの中の名前を拾わず、コードの中の呼び出しを拾う (検査そのものの確認)", () => {
    const sample = [
      "// 以前は /auth/v1/token?grant_type=password を呼んでいた",
      "/* signInWithPassword() も使っていた */",
      'const u = "https://example.test/auth/v1/token?grant_type=password";',
    ].join("\n");
    const code = stripComments("sample.ts", sample);
    expect(PASSWORD_LOGIN_PATTERNS[0][0].test(code)).toBe(true);
    expect(PASSWORD_LOGIN_PATTERNS[1][0].test(code)).toBe(false);
    expect(PASSWORD_LOGIN_PATTERNS[1][0].test(stripComments("s.ts", "await c.auth.signInWithPassword({ email, password });"))).toBe(true);
  });

  it("e2e の各所と --with-auth は、共通の補助関数 (helpers/test-session.mjs の createTestSession) を import してセッションを作る", () => {
    for (const f of [
      "tests/e2e/global-setup.ts",
      "tests/e2e/fixtures/auth.ts",
      "tests/e2e/fixtures/fresh-user.ts",
      "tests/e2e/helpers/seed-roles.ts",
      // tests/e2e/tour の spec (01-eligibility など) は、自分ではセッションを作らず tour/helpers.ts の getAccessToken と
      // fixture を使う (#846)。spec がパスワードのログインを呼ばないことは、上の走査 (tests/e2e 全体) が確かめる
      "tests/e2e/tour/helpers.ts",
      "tests/e2e/membership/02-org-invite-new-user.spec.ts",
      "scripts/lib/smoke.mjs",
    ]) {
      const code = stripComments(f, fs.readFileSync(path.join(ROOT, f), "utf8"));
      // import 先が、実在する tests/e2e/helpers/test-session.mjs であること
      const specifier = code.match(/from ["']((?:\.\.?\/)+(?:[\w-]+\/)*test-session\.mjs)["']/)?.[1];
      expect(specifier, f).toBeDefined();
      expect(path.resolve(path.dirname(path.join(ROOT, f)), specifier ?? ""), f).toBe(SHARED_HELPER_ABS);
      expect(code, f).toMatch(/\bcreateTestSession\(/);
    }
  });

  it("テストの道具 (tests/e2e・scripts・apps/mobile/maestro) で、セッションを作るための /auth/v1/admin/generate_link・/auth/v1/verify・verifyOtp を直接呼ぶのは、共通の補助関数と Maestro のスクリプトだけ (同じ処理を写さない)", () => {
    const owners = files.filter((rel) => {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      // 文字列が無いファイルは、コメントを除く処理 (遅い) を省く
      return SESSION_ROUTE.test(text) && SESSION_ROUTE.test(stripComments(rel, text));
    });
    // Maestro のスクリプトは Maestro の JavaScript (GraalJS) で動き、import できないので、ただ 1 つの写しとして残す
    // (やり直す回数の解釈が補助関数と同じことは、下の「Maestro の reset-onboarding.js」の突き合わせで確かめる)
    expect(owners.sort()).toEqual([SHARED_HELPER, MAESTRO_COPY].map((f) => path.join(f)).sort());
  });

  it("走査の正規表現は、経路の文字列と verifyOtp の呼び出しを拾い、コメントの中の名前は拾わない (検査そのものの確認)", () => {
    for (const code of [
      "await fetch(`${url}/auth/v1/admin/generate_link`, init);",
      "http.post(supabaseUrl + '/auth/v1/verify', options);",
      "await supabase.auth.verifyOtp({ type: 'recovery', token_hash });",
    ]) {
      expect(SESSION_ROUTE.test(stripComments("s.ts", code)), code).toBe(true);
    }
    expect(SESSION_ROUTE.test(stripComments("s.ts", "// POST /auth/v1/verify ({ token_hash })"))).toBe(false);
    // signup の確認の URL を取る admin.generateLink (別の用途。セッションは作らない) は対象外
    expect(SESSION_ROUTE.test(stripComments("s.ts", "await admin.auth.admin.generateLink({ type: 'signup' });"))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Maestro の補助スクリプト (Maestro の http を差し替えて、node の vm で動かす)
// ───────────────────────────────────────────────────────────────────────────

const MAESTRO_SCRIPT = path.join(ROOT, MAESTRO_COPY);
const MAESTRO_PARAMS = {
  E2E_USER_EMAIL: EMAIL,
  SUPABASE_URL: SUPABASE_URL,
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
};
const RESET_URL = "http://localhost:3000/api/e2e/reset-onboarding";

type MaestroResponder = (url: string) => { body: string };

function runMaestroScript(params: Record<string, string>, responder?: MaestroResponder) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const defaultResponder: MaestroResponder = (url) => {
    if (url === GENERATE_LINK_URL) return { body: JSON.stringify({ hashed_token: TOKEN_HASH }) };
    if (url === VERIFY_URL) return { body: JSON.stringify(SESSION) };
    if (url === RESET_URL) return { body: JSON.stringify({ ok: true }) };
    return { body: JSON.stringify({ error: "not found" }) };
  };
  const sandbox: Record<string, unknown> = {
    ...params,
    output: {},
    http: {
      post: (url: string, options: { body: string; headers: Record<string, string> }) => {
        calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
        return (responder ?? defaultResponder)(url);
      },
    },
  };
  let error: Error | null = null;
  try {
    vm.runInNewContext(fs.readFileSync(MAESTRO_SCRIPT, "utf8"), sandbox);
  } catch (err) {
    error = err as Error;
  }
  // スクリプトの最上位の function・var は、vm の global (sandbox) に載る
  return { calls, output: sandbox.output as Record<string, unknown>, error, globals: sandbox };
}

describe("Maestro の reset-onboarding.js (#1547)", () => {
  it("generate_link (service_role) → verify (anon key) → リセットの API (Bearer) の順に呼び、パスワードのログインは呼ばない", () => {
    const { calls, output, error } = runMaestroScript(MAESTRO_PARAMS);

    expect(error).toBeNull();
    expect(output.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([GENERATE_LINK_URL, VERIFY_URL, RESET_URL]);

    const [link, verify, reset] = calls;
    expect(link.headers.apikey).toBe(SERVICE_ROLE_KEY);
    expect(link.headers.Authorization).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
    // type は補助関数と同じ (TEST_SESSION_LINK_TYPE)
    expect(link.body).toEqual({ type: TEST_SESSION_LINK_TYPE, email: EMAIL });
    expect(verify.headers.apikey).toBe(ANON_KEY);
    expect(verify.headers.Authorization).toBeUndefined();
    expect(verify.body).toEqual({ type: TEST_SESSION_LINK_TYPE, token_hash: TOKEN_HASH });
    expect(reset.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(calls.some((c) => c.url.includes("/auth/v1/token"))).toBe(false);
  });

  it("URL の末尾の / は落とし、API_BASE_URL を渡せばリセットの API はその URL へ送る", () => {
    const apiBase = "http://127.0.0.1:3999";
    const { calls, error } = runMaestroScript(
      { ...MAESTRO_PARAMS, SUPABASE_URL: `${SUPABASE_URL}/`, API_BASE_URL: apiBase },
      (url) => {
        if (url === GENERATE_LINK_URL) return { body: JSON.stringify({ hashed_token: TOKEN_HASH }) };
        if (url === VERIFY_URL) return { body: JSON.stringify(SESSION) };
        return { body: JSON.stringify({ ok: url === `${apiBase}/api/e2e/reset-onboarding` }) };
      },
    );

    expect(error).toBeNull();
    expect(calls.map((c) => c.url)).toEqual([GENERATE_LINK_URL, VERIFY_URL, `${apiBase}/api/e2e/reset-onboarding`]);
  });

  it("Supabase の URL・anon key・管理用の鍵が渡されていなければ、どこにも接続せずに止め、足りない名前だけを出す (値は出さない)", () => {
    for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "E2E_USER_EMAIL"] as const) {
      const params: Record<string, string> = { ...MAESTRO_PARAMS };
      delete params[name];
      const { calls, error } = runMaestroScript(params);

      expect(calls, name).toEqual([]);
      expect(error?.message, name).toContain(name);
      for (const secret of [SERVICE_ROLE_KEY, ANON_KEY]) expect(error?.message ?? "").not.toContain(secret);
    }
  });

  it("置き換えられなかった値 (空・\"undefined\"・${...} のまま) は、渡されていないものとして止める", () => {
    for (const unresolved of ["", "undefined", "${MAESTRO_SUPABASE_SERVICE_ROLE_KEY}"]) {
      const { calls, error } = runMaestroScript({ ...MAESTRO_PARAMS, SUPABASE_SERVICE_ROLE_KEY: unresolved });
      expect(calls, unresolved).toEqual([]);
      expect(error?.message, unresolved).toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
  });

  it("本番の Supabase の URL・鍵を既定値として持たない", () => {
    const code = stripComments(MAESTRO_SCRIPT, fs.readFileSync(MAESTRO_SCRIPT, "utf8"));
    expect(code).not.toMatch(/supabase\.co/);
    expect(code).not.toMatch(/eyJhbGciOi/);
  });

  it("トークンの発行・確認に失敗したら止め、エラーの code だけを出す (鍵・トークンは出さない)。リセットの API は呼ばない", () => {
    const linkFailed = runMaestroScript(MAESTRO_PARAMS, (url) =>
      url === GENERATE_LINK_URL
        ? { body: JSON.stringify({ code: 404, error_code: "user_not_found", msg: "User with this email not found" }) }
        : { body: "{}" },
    );
    expect(linkFailed.error?.message).toContain("generate_link");
    expect(linkFailed.error?.message).toContain("user_not_found");
    expect(linkFailed.calls.map((c) => c.url)).toEqual([GENERATE_LINK_URL]);

    const verifyFailed = runMaestroScript(MAESTRO_PARAMS, (url) =>
      url === GENERATE_LINK_URL
        ? { body: JSON.stringify({ hashed_token: TOKEN_HASH }) }
        : { body: JSON.stringify({ error_code: "otp_expired" }) },
    );
    expect(verifyFailed.error?.message).toContain("otp_expired");
    // otp_expired は発行からやり直し、上限の回数 (渡されなければスクリプトの既定 MAX_ATTEMPTS_DEFAULT = 補助関数の既定と同じ) で止める
    expect(verifyFailed.error?.message).toContain(`${TEST_SESSION_DEFAULT_MAX_ATTEMPTS} 回`);
    expect(verifyFailed.calls.map((c) => c.url)).toEqual(
      Array.from({ length: TEST_SESSION_DEFAULT_MAX_ATTEMPTS }, () => [GENERATE_LINK_URL, VERIFY_URL]).flat(),
    );

    // otp_expired 以外の確認の失敗はやり直さない
    const verifyRejected = runMaestroScript(MAESTRO_PARAMS, (url) =>
      url === GENERATE_LINK_URL
        ? { body: JSON.stringify({ hashed_token: TOKEN_HASH }) }
        : { body: JSON.stringify({ error_code: "bad_jwt" }) },
    );
    expect(verifyRejected.error?.message).toContain("bad_jwt");
    expect(verifyRejected.calls.map((c) => c.url)).toEqual([GENERATE_LINK_URL, VERIFY_URL]);
    for (const failed of [linkFailed, verifyFailed, verifyRejected]) {
      for (const secret of [SERVICE_ROLE_KEY, ANON_KEY, TOKEN_HASH]) expect(failed.error?.message ?? "").not.toContain(secret);
    }
  });

  it("確認が otp_expired (同時に作った相手にトークンを消された) なら、発行からやり直し、新しいトークンでリセットまで進む", () => {
    let issued = 0;
    let verified = 0;
    const { calls, output, error } = runMaestroScript(MAESTRO_PARAMS, (url) => {
      if (url === GENERATE_LINK_URL) return { body: JSON.stringify({ hashed_token: `${TOKEN_HASH}-${++issued}` }) };
      if (url === VERIFY_URL) {
        return ++verified === 1
          ? { body: JSON.stringify({ code: 403, error_code: "otp_expired" }) }
          : { body: JSON.stringify(SESSION) };
      }
      return { body: JSON.stringify({ ok: url === RESET_URL }) };
    });

    expect(error).toBeNull();
    expect(output.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([GENERATE_LINK_URL, VERIFY_URL, GENERATE_LINK_URL, VERIFY_URL, RESET_URL]);
    expect(calls[3].body).toEqual({ type: "recovery", token_hash: `${TOKEN_HASH}-2` });
  });

  it("発行からやり直す回数の上限は、runScript の env の補助関数と同じ名前 (TEST_SESSION_MAX_ATTEMPTS_ENV) で上書きでき、それ以外の値は既定に戻る", () => {
    const alwaysExpired: MaestroResponder = (url) =>
      url === GENERATE_LINK_URL
        ? { body: JSON.stringify({ hashed_token: TOKEN_HASH }) }
        : { body: JSON.stringify({ error_code: "otp_expired" }) };
    const issuedCount = (calls: Array<{ url: string }>) => calls.filter((c) => c.url === GENERATE_LINK_URL).length;

    // 上書きが効く (前後の空白は無視する。補助関数の testSessionMaxAttempts と同じ規則)
    for (const [raw, expected] of [
      ["1", 1],
      ["2", 2],
      [" 3 ", 3],
      [String(TEST_SESSION_DEFAULT_MAX_ATTEMPTS + 4), TEST_SESSION_DEFAULT_MAX_ATTEMPTS + 4],
    ] as const) {
      const { calls, error } = runMaestroScript({ ...MAESTRO_PARAMS, [TEST_SESSION_MAX_ATTEMPTS_ENV]: raw }, alwaysExpired);
      expect(issuedCount(calls), raw).toBe(expected);
      expect(error?.message, raw).toContain(`${expected} 回`);
      expect(calls.some((c) => c.url === RESET_URL), raw).toBe(false);
    }

    // 不正な値・置き換えられなかった値は無視して既定 (補助関数の既定と同じ回数) を使う
    for (const invalid of [
      "",
      "0",
      "-1",
      "1.5",
      "abc",
      "99999999999999999999",
      "undefined",
      "${MAESTRO_E2E_TEST_SESSION_MAX_ATTEMPTS}",
    ]) {
      const { calls } = runMaestroScript({ ...MAESTRO_PARAMS, [TEST_SESSION_MAX_ATTEMPTS_ENV]: invalid }, alwaysExpired);
      expect(issuedCount(calls), invalid).toBe(TEST_SESSION_DEFAULT_MAX_ATTEMPTS);
    }

    // 上限より前に確認が通れば、上書きした上限まで回らずにリセットへ進む
    let verified = 0;
    const recovered = runMaestroScript({ ...MAESTRO_PARAMS, [TEST_SESSION_MAX_ATTEMPTS_ENV]: "3" }, (url) => {
      if (url === GENERATE_LINK_URL) return { body: JSON.stringify({ hashed_token: TOKEN_HASH }) };
      if (url === VERIFY_URL) {
        return ++verified < 3 ? { body: JSON.stringify({ error_code: "otp_expired" }) } : { body: JSON.stringify(SESSION) };
      }
      return { body: JSON.stringify({ ok: url === RESET_URL }) };
    });
    expect(recovered.error).toBeNull();
    expect(recovered.output.ok).toBe(true);
    expect(issuedCount(recovered.calls)).toBe(3);
  });

  it("Maestro の共通のフローは、パスワードを渡さず、Supabase の値とやり直す回数の上限をシェルの MAESTRO_ 付きの環境変数から渡す", () => {
    const yaml = fs.readFileSync(path.join(ROOT, "apps/mobile/maestro/flows/_shared/login-for-onboarding.yaml"), "utf8");
    const runScript = yaml.slice(yaml.indexOf('file: "../scripts/reset-onboarding.js"'));
    const envBlock = runScript.slice(0, runScript.indexOf("- launchApp"));
    expect(envBlock).not.toContain("E2E_USER_PASSWORD");
    for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", TEST_SESSION_MAX_ATTEMPTS_ENV]) {
      expect(envBlock).toContain(`${name}: "\${typeof MAESTRO_${name} !== 'undefined' ? MAESTRO_${name} : ''}"`);
    }
  });

  it("やり直す回数の解釈 (readMaxAttempts) は、補助関数の testSessionMaxAttempts と同じ入力に同じ値を返す (import できない写しの突き合わせ)", () => {
    const { error, globals } = runMaestroScript(MAESTRO_PARAMS);
    expect(error).toBeNull();
    const readMaxAttempts = globals.readMaxAttempts as (value: unknown) => number;
    expect(typeof readMaxAttempts).toBe("function");

    // 渡されない (undefined) ・空・空白・境界の整数・不正な値・Maestro で置き換えられなかった値
    const inputs: Array<string | undefined> = [
      undefined,
      "",
      " ",
      "0",
      "1",
      "2",
      " 3 ",
      "007",
      String(TEST_SESSION_DEFAULT_MAX_ATTEMPTS),
      String(TEST_SESSION_DEFAULT_MAX_ATTEMPTS + 4),
      "-1",
      "+5",
      "1.5",
      "1e3",
      "abc",
      String(Number.MAX_SAFE_INTEGER),
      "9007199254740992",
      "99999999999999999999",
      "undefined",
      "null",
      "${MAESTRO_E2E_TEST_SESSION_MAX_ATTEMPTS}",
    ];
    for (const raw of inputs) {
      const env = raw === undefined ? {} : { [TEST_SESSION_MAX_ATTEMPTS_ENV]: raw };
      expect(readMaxAttempts(raw), JSON.stringify(raw)).toBe(testSessionMaxAttempts(env));
    }
    // 既定の回数も同じ
    expect(readMaxAttempts(undefined)).toBe(TEST_SESSION_DEFAULT_MAX_ATTEMPTS);
  });
});
