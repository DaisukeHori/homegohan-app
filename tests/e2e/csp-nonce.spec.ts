/**
 * #1169: 本番の CSP (nonce 方式) と違反の報告の受け口を、本物のブラウザと本番ビルド (next build && next start) で確かめる
 * (docs/design/cross/18-csp-nonce.md §8.2・§15・§21)。
 *
 * 方針の正本は src/lib/security/csp.ts で、src/proxy.ts が毎リクエスト nonce を作って応答とリクエストヘッダーに載せる。
 * Next はリクエストヘッダーの方針から nonce を読み、自分が出すインラインスクリプトに付ける。ここでは次を見る。
 *   1. / の応答の Content-Security-Policy は 1 つだけ (next.config.mjs と二重に付いていない) で、nonce を持ち 'unsafe-inline' を持たない
 *   2. nonce は要求ごとに違う
 *   3. / と /login で CSP 違反が 0 件で、src の無い <script> はすべて nonce を持つ (ハイドレーションも動く)
 *   4. Turnstile (script-src / frame-src) の許可が残っている
 *   5. 受け口 POST /api/csp-report の 204 / 415 / 400 / 413
 *
 * PR の e2e の門 (.github/workflows/e2e-local.yml の 1 本目の npx playwright test と、それを写した scripts/local-ci.sh の PW_ARGS) で流す
 * (tests/e2e-csp-nonce-suite.test.ts が一覧から外れないことを見張る)。CSP_REPORT_ONLY は付けずに起動する (強制を期待する)。
 * 方針の語と受け口のパスは csp.ts から読む (csp.ts は何も import しないので Next の依存を連れてこない)。
 */
import { test, expect, type Page } from "@playwright/test";
import { CSP_HEADER, CSP_REPORT_PATH, cspDirectivesOf } from "../../src/lib/security/csp";
import { serveTurnstileOffline } from "./helpers/turnstile-offline";

// playwright.config.ts の共有ログイン状態 (storageState) を引き継がず、未ログインで確かめる (/login がホームへ回されない)
test.use({ storageState: { cookies: [], origins: [] } });

/** 本番ビルドの初回の描画を待てるよう、画面の要素の待ちだけ長めにする */
const NAVIGATION_TIMEOUT = 30_000;
/** Cloudflare Turnstile のオリジン (src/lib/auth/turnstile.ts の TURNSTILE_SCRIPT_SRC) */
const CLOUDFLARE_ORIGIN = "https://challenges.cloudflare.com";
/** 受け口の本文の上限 (src/lib/security/csp-report.ts の CSP_REPORT_MAX_BYTES = 8 KiB) を超える大きさ */
const OVERSIZED_REPORT_BYTES = 9 * 1024;
/** 受け口の応答 */
const STATUS_ACCEPTED = 204;
const STATUS_BAD_REQUEST = 400;
const STATUS_PAYLOAD_TOO_LARGE = 413;
const STATUS_UNSUPPORTED_MEDIA_TYPE = 415;
/** ログイン画面の入力に入れる見本のメールアドレス (送信はしない) */
const SAMPLE_EMAIL = "csp-nonce@example.com";

/** ブラウザが送る形の報告の見本 */
const SAMPLE_REPORT = {
  "csp-report": {
    "document-uri": "http://localhost/home",
    "blocked-uri": "inline",
    "effective-directive": "script-src-elem",
    "violated-directive": "script-src-elem",
    disposition: "enforce",
    "status-code": 200,
    "script-sample": "alert(1)",
  },
};

/** 方針の script-src の 'nonce-…' の値 */
function nonceOf(policy: string): string | undefined {
  const source = cspDirectivesOf(policy)
    .get("script-src")
    ?.find((token) => token.startsWith("'nonce-"));
  return source?.slice("'nonce-".length, -1);
}

/** ページの CSP 違反を集める (addInitScript は CDP から入るので、ページの CSP の対象外) */
async function collectCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      w.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

async function cspViolationsOf(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

/** src の無い <script> の nonce (ブラウザは属性を隠すので script.nonce で読む) */
async function inlineScriptNonces(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLScriptElement>("script:not([src])")).map((script) => script.nonce),
  );
}

test.describe("#1169 CSP の nonce 方式", () => {
  test("/ の応答の Content-Security-Policy は 1 つだけ (headersArray) で、script-src は 'nonce-…' を持ち 'unsafe-inline' を持たない", async ({
    request,
  }) => {
    const response = await request.get("/");
    expect(response.ok()).toBe(true);

    const policies = response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === CSP_HEADER.toLowerCase())
      .map((header) => header.value);
    expect(policies).toHaveLength(1);

    const scriptSrc = cspDirectivesOf(policies[0]).get("script-src") ?? [];
    expect(nonceOf(policies[0])).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  test("2 回の要求で nonce が違う", async ({ request }) => {
    const first = (await request.get("/")).headers()[CSP_HEADER.toLowerCase()] ?? "";
    const second = (await request.get("/")).headers()[CSP_HEADER.toLowerCase()] ?? "";

    expect(nonceOf(first)).toBeDefined();
    expect(nonceOf(second)).toBeDefined();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  test("/ と /login を開くと securitypolicyviolation が 0 件で、src の無い <script> はすべて nonce を持つ (script.nonce)", async ({
    page,
  }) => {
    await collectCspViolations(page);
    await serveTurnstileOffline(page);

    const top = await page.goto("/");
    await page.waitForLoadState("load");
    const topNonce = nonceOf(top?.headers()[CSP_HEADER.toLowerCase()] ?? "");
    const topNonces = await inlineScriptNonces(page);
    expect(topNonces.length).toBeGreaterThan(0);
    expect(topNonces.every((nonce) => nonce === topNonce)).toBe(true);
    expect(await cspViolationsOf(page)).toEqual([]);

    const login = await page.goto("/login");
    await page.waitForLoadState("load");
    await page.locator("#email").waitFor({ state: "attached", timeout: NAVIGATION_TIMEOUT });
    const loginNonce = nonceOf(login?.headers()[CSP_HEADER.toLowerCase()] ?? "");
    const loginNonces = await inlineScriptNonces(page);
    expect(loginNonces.length).toBeGreaterThan(0);
    expect(loginNonces.every((nonce) => nonce === loginNonce)).toBe(true);
    expect(await cspViolationsOf(page)).toEqual([]);
  });

  test("/login でメールアドレスを入力すると値が残る (ハイドレーションが動く)", async ({ page }) => {
    await serveTurnstileOffline(page);
    await page.goto("/login");
    await page.waitForLoadState("load");

    // ログイン画面のフォームは useSearchParams を Suspense の中で使うので、ハイドレーションのあとに描画される
    const email = page.locator("#email");
    await email.waitFor({ state: "visible", timeout: NAVIGATION_TIMEOUT });
    await email.fill(SAMPLE_EMAIL);
    await expect(email).toHaveValue(SAMPLE_EMAIL);
  });

  test("script-src と frame-src に https://challenges.cloudflare.com がある", async ({ request }) => {
    const policy = (await request.get("/")).headers()[CSP_HEADER.toLowerCase()] ?? "";
    const directives = cspDirectivesOf(policy);

    expect(directives.get("script-src")).toContain(CLOUDFLARE_ORIGIN);
    expect(directives.get("frame-src")).toContain(CLOUDFLARE_ORIGIN);
  });

  test("POST /api/csp-report: application/csp-report は 204、text/plain は 415、JSON でない本文は 400、9 KiB の本文は 413", async ({
    request,
  }) => {
    const accepted = await request.post(CSP_REPORT_PATH, {
      headers: { "content-type": "application/csp-report" },
      data: JSON.stringify(SAMPLE_REPORT),
    });
    expect(accepted.status()).toBe(STATUS_ACCEPTED);

    const wrongType = await request.post(CSP_REPORT_PATH, {
      headers: { "content-type": "text/plain" },
      data: JSON.stringify(SAMPLE_REPORT),
    });
    expect(wrongType.status()).toBe(STATUS_UNSUPPORTED_MEDIA_TYPE);
    expect((await wrongType.json()).code).toBe("CSP_REPORT_UNSUPPORTED_MEDIA_TYPE");

    const notJson = await request.post(CSP_REPORT_PATH, {
      headers: { "content-type": "application/csp-report" },
      data: "not json",
    });
    expect(notJson.status()).toBe(STATUS_BAD_REQUEST);
    expect((await notJson.json()).code).toBe("CSP_REPORT_INVALID");

    const oversized = await request.post(CSP_REPORT_PATH, {
      headers: { "content-type": "application/csp-report" },
      data: JSON.stringify({ "csp-report": { "script-sample": "a".repeat(OVERSIZED_REPORT_BYTES) } }),
    });
    expect(oversized.status()).toBe(STATUS_PAYLOAD_TOO_LARGE);
    expect((await oversized.json()).code).toBe("CSP_REPORT_TOO_LARGE");
  });
});
