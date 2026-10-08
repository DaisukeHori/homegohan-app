/**
 * auth-turnstile.spec.ts (#1165)
 *
 * Web のログイン・新規登録・パスワード再設定に出す Cloudflare Turnstile が、
 * 本物のブラウザ・本物の CSP (next.config.mjs)・本物の api.js と、Cloudflare のテスト用サイトキーで動くことを確かめる。
 * 単体テスト (tests/auth-turnstile-*.test.tsx) は window.turnstile の偽物を使うので、
 * CSP が api.js と iframe を止めていないか、本物のウィジェットが実際にトークンを出すかは、ここでしか確かめられない。
 *
 * 前提: 対象のアプリが NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
 *   (Cloudflare 公式の「常に成功」テスト用サイトキー。表示あり) を付けてビルド / 起動されていること。
 *   NEXT_PUBLIC_* はビルド時に埋め込まれるので、起動済みのサーバーには後から効かない。
 *     ローカル:  NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA npx playwright test tests/e2e/auth-turnstile.spec.ts
 *               (起動済みの dev サーバーは再利用されるので、キー無しで起動していたら止めてから)
 *     CI:       .github/workflows/e2e-local.yml が、このキーでビルドして、この spec を回す
 *   次のどちらでもないときは、全部スキップする (本番のように、本物のサイトキーで動くアプリへ向けて走らせてしまわないため。
 *   本物のサイトキーは、自動化したブラウザに操作を求めることがある)。
 *     - このテスト用サイトキーを、実行するコマンドの環境変数 NEXT_PUBLIC_TURNSTILE_SITE_KEY に付けている (ローカル)
 *     - E2E_REQUIRE_TURNSTILE=1 (CI)
 *   サイトキー無しで動いているアプリ (Turnstile は無効) では、これも全部スキップする。
 *   ただし E2E_REQUIRE_TURNSTILE=1 のときは、スキップせずに失敗にする (キーが渡っていないのに緑になるのを防ぐ)。
 *
 * Supabase の Auth API はブラウザの通信を差し替える (page.route) ので、Supabase にも、実在のユーザーにも繋がない。
 * ここで確かめるのは「ウィジェットが出したトークンが、Supabase へのリクエストの gotrue_meta_security.captcha_token に入ること」まで。
 * ローカルの Supabase は CAPTCHA が無効なので、トークンの検証 (Cloudflare への問い合わせ) は、どの環境でもここでは行わない。
 */
import { test, expect, type Page, type Request } from "@playwright/test";
import { generateTestPassword } from "./helpers/credentials";

const REQUIRE_TURNSTILE = process.env.E2E_REQUIRE_TURNSTILE === "1";

/** Cloudflare 公式のテスト用サイトキー「常に成功」(表示あり)。https://developers.cloudflare.com/turnstile/troubleshooting/testing/ */
const CLOUDFLARE_TEST_SITE_KEY = "1x00000000000000000000AA";

/** 本物のウィジェットがトークンを出すまで待つ時間 (Cloudflare への通信を含む) */
const WIDGET_READY_TIMEOUT_MS = 30_000;

// テスト用サイトキーで動くアプリ向けの spec。本番 (本物のサイトキー) に向けた full suite では走らせない
test.skip(
  !REQUIRE_TURNSTILE && process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY !== CLOUDFLARE_TEST_SITE_KEY,
  `Cloudflare のテスト用サイトキー (${CLOUDFLARE_TEST_SITE_KEY}) で起動したアプリ向けの spec。` +
    "ローカルでは NEXT_PUBLIC_TURNSTILE_SITE_KEY にそのキーを付けて実行する (tests/e2e/README.md)",
);

// ログイン済みの storageState があっても、未ログインで /login などを開く
test.use({ storageState: { cookies: [], origins: [] } });

/** ブラウザから Supabase への通信は別オリジンなので、差し替えた応答にも CORS のヘッダーが要る */
function corsHeaders(request: Request): Record<string, string> {
  return {
    "access-control-allow-origin": request.headers()["origin"] ?? "*",
    "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    vary: "Origin",
  };
}

interface AuthRequestBody {
  gotrue_meta_security?: { captcha_token?: string };
  [key: string]: unknown;
}

/**
 * Supabase の Auth API (urlPattern に一致するもの) を、決まった応答に差し替える。
 * 届いたリクエストの本文を、返す配列に記録する (プリフライトの OPTIONS は記録しない)。
 */
async function interceptAuth(page: Page, urlPattern: RegExp, response: { status: number; body: unknown }) {
  const bodies: AuthRequestBody[] = [];
  await page.route(urlPattern, async (route) => {
    const request = route.request();
    const headers = corsHeaders(request);
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    bodies.push(request.postDataJSON() as AuthRequestBody);
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      headers,
      body: JSON.stringify(response.body),
    });
  });
  return bodies;
}

/** ページを開く。Turnstile が無効なアプリなら、スキップする (E2E_REQUIRE_TURNSTILE=1 なら失敗) */
async function openWithWidget(page: Page, path: string) {
  // CSP に止められた通信を集める (api.js の script と、ウィジェットの iframe は、この文書の CSP で止まる)
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      w.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  await page.goto(path);
  // ログイン・新規登録は useSearchParams を Suspense の中で使うので、フォームはハイドレーションのあとに描画される
  // (それまでは「読み込み中...」)。フォームが出てから、ウィジェットの有無を見る
  await page.locator("form button[type=submit]").waitFor({ state: "attached", timeout: 30_000 });

  if ((await page.getByTestId("turnstile").count()) === 0) {
    const reason =
      "このアプリは NEXT_PUBLIC_TURNSTILE_SITE_KEY なしでビルドされている (Turnstile は無効)。" +
      "テスト用サイトキー 1x00000000000000000000AA を付けてビルド / 起動し直すと、この spec が動く";
    if (REQUIRE_TURNSTILE) {
      throw new Error(`${reason} (E2E_REQUIRE_TURNSTILE=1 なので、スキップせず失敗にする)`);
    }
    test.skip(true, reason);
  }
}

/** 本物のウィジェットがトークンを出し、送信できる状態になるのを待つ */
async function waitUntilTokenReady(page: Page) {
  await expect(page.getByTestId("turnstile")).toHaveAttribute("data-turnstile-status", "ready", {
    timeout: WIDGET_READY_TIMEOUT_MS,
  });
}

/** Cloudflare 向けの通信が、この文書の CSP に止められていないこと */
async function expectNoCloudflareCspViolations(page: Page) {
  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
  );
  const cloudflare = violations.filter((v) => v.includes("challenges.cloudflare.com"));
  expect(
    cloudflare,
    `CSP (next.config.mjs の script-src / frame-src) が Cloudflare 向けの通信を止めている: ${cloudflare.join(", ")}`,
  ).toEqual([]);
}

test.describe("Turnstile (Cloudflare のテスト用サイトキー)", () => {
  test("ログイン: 実際のウィジェットがトークンを出すまで送信できず、出たら Supabase へ captcha_token を付けて送る", async ({
    page,
  }) => {
    const requests = await interceptAuth(page, /\/auth\/v1\/token\?grant_type=password/, {
      status: 400,
      body: { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" },
    });
    await openWithWidget(page, "/login");

    await page.locator("#email").fill("turnstile-e2e@example.com");
    await page.locator("#password").fill(generateTestPassword());
    const submit = page.locator("form button[type=submit]");

    // 実際のウィジェットがトークンを出すと、送信ボタンが有効になる (それまでは無効。単体テストで確かめている)
    await waitUntilTokenReady(page);
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect.poll(() => requests.length, { timeout: 10_000 }).toBe(1);
    expect(requests[0].gotrue_meta_security?.captcha_token).toMatch(/\S{10,}/);
    await expect(page.getByText("メールアドレスまたはパスワードが正しくありません。")).toBeVisible();
    await expectNoCloudflareCspViolations(page);
  });

  test("新規登録: 実際のウィジェットがトークンを出すまで送信できず、出たら Supabase へ captcha_token を付けて送る", async ({
    page,
  }) => {
    const requests = await interceptAuth(page, /\/auth\/v1\/signup/, {
      status: 422,
      body: { code: 422, error_code: "user_already_exists", msg: "User already registered" },
    });
    await openWithWidget(page, "/signup");

    await page.locator("#email").fill("turnstile-e2e@example.com");
    await page.locator("#password").fill(generateTestPassword());
    const submit = page.locator("form button[type=submit]");

    await waitUntilTokenReady(page);
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect.poll(() => requests.length, { timeout: 10_000 }).toBe(1);
    expect(requests[0].gotrue_meta_security?.captcha_token).toMatch(/\S{10,}/);
    await expect(page.getByText("このメールアドレスは既に登録されています")).toBeVisible();
    await expectNoCloudflareCspViolations(page);
  });

  test("パスワード再設定: 実際のウィジェットがトークンを出すまで送信できず、出たら Supabase へ captcha_token を付けて送る", async ({
    page,
  }) => {
    const requests = await interceptAuth(page, /\/auth\/v1\/recover/, { status: 200, body: {} });
    await openWithWidget(page, "/auth/forgot-password");

    await page.locator('input[type="email"]').fill("turnstile-e2e@example.com");
    const submit = page.locator("form button[type=submit]");

    await waitUntilTokenReady(page);
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect.poll(() => requests.length, { timeout: 10_000 }).toBe(1);
    expect(requests[0].gotrue_meta_security?.captcha_token).toMatch(/\S{10,}/);
    await expect(page.getByText("メールを送信しました")).toBeVisible();
    await expectNoCloudflareCspViolations(page);
  });

  test("api.js を読み込めないとき (広告ブロッカーなど): エラーを案内して送信できず、読み込めるようになったら「もう一度確認する」で復帰できる", async ({
    page,
  }) => {
    const apiJs = /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/;
    await page.route(apiJs, (route) => route.abort());
    await openWithWidget(page, "/login");

    const widget = page.getByTestId("turnstile");
    const submit = page.locator("form button[type=submit]");
    await expect(widget).toHaveAttribute("data-turnstile-status", "error", { timeout: 10_000 });
    await expect(widget).toContainText("ボットではないことの確認を完了できませんでした");
    await expect(submit).toBeDisabled();

    await page.unroute(apiJs);
    await widget.getByRole("button", { name: "もう一度確認する" }).click();

    await waitUntilTokenReady(page);
    await expect(submit).toBeEnabled();
    await expectNoCloudflareCspViolations(page);
  });
});
