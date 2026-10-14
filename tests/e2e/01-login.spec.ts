/**
 * 01-login.spec.ts
 * ログインフローの基本動作確認
 *
 * #1165: ログイン画面は、本物のブラウザから POST /api/auth/login を通り、Cookie を受け取って画面が移るまでを確かめる
 * (auth-turnstile.spec.ts は API を page.route で差し替えるので、本物の API まで通すのはこの spec)。
 * CI と local-ci の e2e は Cloudflare のテスト用サイトキーでビルドするので、ログイン画面には本物の Turnstile のウィジェットが出る。
 * ウィジェットは Cloudflare と通信し続けるので networkidle は待たない (helpers/login-form.ts)。
 * ウィジェットがトークンを出して送信ボタンが押せるようになるのを待ってからログインし、トークンが API の本文に付いて届くことも確かめる。
 * ローカルの Supabase とサーバーは CAPTCHA の秘密キーを持たないので、トークンの検証 (Cloudflare への問い合わせ) はしない。
 */
import { test, expect } from "@playwright/test";
import { requireE2eUserCredentials } from "./helpers/credentials";
import { waitForLoginFormReady } from "./helpers/login-form";

/** CI と local-ci の e2e は、サイトキー付きのビルドでだけ動かす (キーが渡っていないのに緑になるのを防ぐ) */
const REQUIRE_TURNSTILE = process.env.E2E_REQUIRE_TURNSTILE === "1";
/** ログインの API (src/lib/auth/login-request.ts の LOGIN_API_PATH) */
const LOGIN_API_PATH = "/api/auth/login";

test("ログインできる", async ({ page }) => {
  // 認証情報は環境変数 (E2E_USER_EMAIL / E2E_USER_PASSWORD) からだけ取る。未設定ならすぐエラーで止まる (既定値は無い)
  const { email, password } = requireE2eUserCredentials();

  await page.goto("/login");
  // networkidle は待たない (Turnstile のウィジェットが通信し続けるため)。フォームが出て、トークンが出て、送信ボタンが押せるまで待つ
  await waitForLoginFormReady(page, { requireTurnstile: REQUIRE_TURNSTILE });
  const turnstileEnabled = (await page.getByTestId("turnstile").count()) > 0;

  // client-side rate limit key をクリア
  // #1057 (UX1-16 round-2): キーがメールアドレス単位 (`auth_last_fail_ts:<email>`) に
  // 変わったため prefix 一致で全て削除する
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('auth_last_fail_ts'))
      .forEach((k) => localStorage.removeItem(k));
  });

  // React hydration 完了を確認
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('form button[type="submit"], button[type="submit"]');
      if (!btn) return false;
      return Object.keys(btn as Record<string, unknown>).some(
        (k) => k.startsWith("__reactProps") || k.startsWith("__reactFiber") || k.startsWith("__react"),
      );
    },
    { timeout: 20_000 },
  ).catch(async () => {
    // フォールバック: 500ms 追加待機
    await new Promise((r) => setTimeout(r, 500));
  });

  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);

  // waitForURL を先に登録してから click する
  const navPromise = page.waitForURL(
    (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
    { timeout: 30000 },
  );
  const loginRequestPromise = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === LOGIN_API_PATH,
  );
  await page.locator("button[type=submit]").click();
  const loginRequest = await loginRequestPromise;
  await navPromise;

  // Turnstile が有効なビルドでは、ウィジェットが出したトークンが POST /api/auth/login の本文に付いて届く
  const loginBody = loginRequest.postDataJSON() as { captchaToken?: unknown };
  if (turnstileEnabled) {
    expect(loginBody.captchaToken).toEqual(expect.stringMatching(/\S{10,}/));
  } else {
    expect(loginBody.captchaToken).toBeUndefined();
  }

  // ログイン後は /login 以外のページへ遷移する
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });
  // home / menus / onboarding のいずれかに遷移すること
  await expect(page).toHaveURL(/\/(home|menus|onboarding|$)/, { timeout: 15000 });
});
