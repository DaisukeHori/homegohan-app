// @vitest-environment node
/**
 * tests/e2e-test-session.test.ts (#1547)
 *
 * Supabase の CAPTCHA を有効にすると、トークンの無いパスワードのログイン (/auth/v1/token?grant_type=password) は断られる。
 * e2e・デプロイ後の動作確認 (--with-auth)・Maestro の補助スクリプトは、パスワードのログインを使わず、
 * 管理用の鍵 (service_role) でセッションを作るように変えた。ここでは次を確かめる。
 *
 *   1. 共通の補助関数 tests/e2e/helpers/test-session.ts の createTestSession が呼ぶのは、
 *      POST /auth/v1/admin/generate_link (service_role) → POST /auth/v1/verify (anon key) の 2 つだけで、
 *      パスワードのログインを呼ばないこと (呼び出しの検査)。失敗の段・ステータスの報告と、鍵を出さないこと
 *   2. Issue に挙がった e2e の各所が、この補助関数を使うこと (自分でパスワードのログインを呼ばない)
 *   3. テストの道具 (tests/e2e・scripts・apps/mobile/maestro) のコード (コメントを除く) に、パスワードのログインが戻ってこないこと
 *   4. Maestro の apps/mobile/maestro/flows/scripts/reset-onboarding.js を、Maestro の http を差し替えて動かしたときの呼び出し
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
  TEST_SESSION_ENV_NAMES,
  TEST_SESSION_LINK_TYPE,
  TEST_SESSION_NO_HTTP_STATUS,
  createTestSession,
  describeTestSessionFailure,
  missingTestSessionEnv,
  readTestSessionConfig,
  type TestSessionConfig,
} from "./e2e/helpers/test-session";

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

describe("createTestSession (tests/e2e/helpers/test-session.ts)", () => {
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
    expect(await createTestSession(EMAIL, { config: CONFIG, fetchImpl: expired.fetchImpl })).toMatchObject({
      ok: false,
      step: "verify",
      status: 403,
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

  it("通信できないときは例外にせず、HTTP の応答が無いことを status で返す", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await createTestSession(EMAIL, { config: CONFIG, fetchImpl });

    expect(result).toMatchObject({ ok: false, step: "generate_link", status: TEST_SESSION_NO_HTTP_STATUS });
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

  it("e2e の各所は、共通の補助関数 (helpers/test-session.ts の createTestSession) でセッションを作る", () => {
    for (const f of [
      "tests/e2e/global-setup.ts",
      "tests/e2e/fixtures/auth.ts",
      "tests/e2e/fixtures/fresh-user.ts",
      "tests/e2e/helpers/seed-roles.ts",
      "tests/e2e/tour/helpers.ts",
      "tests/e2e/tour/01-eligibility.spec.ts",
      "tests/e2e/membership/02-org-invite-new-user.spec.ts",
    ]) {
      const code = stripComments(f, fs.readFileSync(path.join(ROOT, f), "utf8"));
      expect(code, f).toMatch(/from ["'](?:\.\.?\/)+(?:helpers\/)?test-session["']/);
      expect(code, f).toMatch(/\bcreateTestSession\(/);
    }
  });

  it("e2e の中で、セッションを作るための /auth/v1/admin/generate_link・/auth/v1/verify を直接呼ぶのは共通の補助関数だけ (同じ処理を各所に写さない)", () => {
    const owners = files
      .filter((rel) => rel.startsWith(path.join("tests/e2e")))
      .filter((rel) => /\/auth\/v1\/(?:admin\/generate_link|verify)\b/.test(stripComments(rel, fs.readFileSync(path.join(ROOT, rel), "utf8"))));
    expect(owners).toEqual([path.join("tests/e2e/helpers/test-session.ts")]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Maestro の補助スクリプト (Maestro の http を差し替えて、node の vm で動かす)
// ───────────────────────────────────────────────────────────────────────────

const MAESTRO_SCRIPT = path.join(ROOT, "apps/mobile/maestro/flows/scripts/reset-onboarding.js");
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
  return { calls, output: sandbox.output as Record<string, unknown>, error };
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
    expect(link.body).toEqual({ type: "recovery", email: EMAIL });
    expect(verify.headers.apikey).toBe(ANON_KEY);
    expect(verify.headers.Authorization).toBeUndefined();
    expect(verify.body).toEqual({ type: "recovery", token_hash: TOKEN_HASH });
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
    expect(verifyFailed.calls.map((c) => c.url)).toEqual([GENERATE_LINK_URL, VERIFY_URL]);
    for (const failed of [linkFailed, verifyFailed]) {
      for (const secret of [SERVICE_ROLE_KEY, ANON_KEY, TOKEN_HASH]) expect(failed.error?.message ?? "").not.toContain(secret);
    }
  });

  it("Maestro の共通のフローは、パスワードを渡さず、Supabase の値をシェルの MAESTRO_ 付きの環境変数から渡す", () => {
    const yaml = fs.readFileSync(path.join(ROOT, "apps/mobile/maestro/flows/_shared/login-for-onboarding.yaml"), "utf8");
    const runScript = yaml.slice(yaml.indexOf('file: "../scripts/reset-onboarding.js"'));
    const envBlock = runScript.slice(0, runScript.indexOf("- launchApp"));
    expect(envBlock).not.toContain("E2E_USER_PASSWORD");
    for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      expect(envBlock).toContain(`${name}: "\${typeof MAESTRO_${name} !== 'undefined' ? MAESTRO_${name} : ''}"`);
    }
  });
});
