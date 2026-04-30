/**
 * Auth + Middleware 探索 spec
 *
 * 対象: https://homegohan-app.vercel.app
 * 実行コマンド:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npx playwright test tests/e2e/.exploration/auth-explore.spec.ts --headed
 *
 * バグ判定ポリシー:
 *   - 既知 close 済 #15-#57 (Bug-1〜Bug-38) と重複は filed しない
 *   - 「明らかな期待外」(redirect しない / 真っ白 / console 5xx) のみ
 *   - false-positive 厳禁、判定不明は filed しない
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

// ────────────────────────────────────────────────────────
// 設定
// ────────────────────────────────────────────────────────

test.use({
  trace: "on",
  video: "on",
  screenshot: "on",
});

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://homegohan-app.vercel.app";

// E2E テスト用アカウント（存在しているはずのアカウント）
const VALID_EMAIL = process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local";
const VALID_PASSWORD = process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!";

// 意図的に不正なクレデンシャル
const WRONG_PASSWORD = "WrongPassword999!";
const INVALID_EMAIL = "not-an-email";
const WEAK_PASSWORD = "123";
const DUPLICATE_EMAIL = VALID_EMAIL; // 同一アカウントで重複テスト

// スクリーンショット保存先
const SCREENSHOT_DIR = path.resolve(__dirname, "auth");

// ────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────

/** console + 5xx レスポンスを蓄積するリスナーを page に付与する */
function attachMonitors(page: Page) {
  const consoleLogs: string[] = [];
  const networkErrors: string[] = [];

  page.on("console", (msg) => {
    consoleLogs.push(`[console:${msg.type()}] ${msg.text()}`);
  });

  page.on("response", (res) => {
    if (res.status() >= 500) {
      networkErrors.push(`[5xx] ${res.status()} ${res.url()}`);
    }
  });

  return { consoleLogs, networkErrors };
}

/** スクリーンショットをファイルに保存する（番号付き）*/
async function saveScreenshot(page: Page, name: string) {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

/** Cookie / localStorage / sessionStorage を全てクリアして未認証状態にする */
async function clearSession(context: BrowserContext) {
  await context.clearCookies();
  // localStorage は navigate 後にしか操作できないため、
  // addInitScript で自動クリアするか navigate 時に対処する
}

// ────────────────────────────────────────────────────────
// シナリオ 1: /login
// ────────────────────────────────────────────────────────

test.describe("Scenario 1: /login フォームバリデーション & 正常ログイン", () => {
  test("1-1: 空フォーム submit → フィールドエラーが表示されページ遷移しない", async ({ page }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.goto(`${BASE_URL}/login`);

    // submit ボタンをクリック（何も入力しない）
    await page.locator('button[type="submit"]').click();

    // HTML5 ネイティブバリデーションまたはカスタムエラーが表示される
    // → URL は /login のまま
    await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });

    // email フィールドのバリデーションメッセージが空でないこと
    const emailValMsg = await page.locator("#email").evaluate(
      (el) => (el as HTMLInputElement).validationMessage
    );
    expect(emailValMsg.length).toBeGreaterThan(0);

    await saveScreenshot(page, "01-login-empty-submit");

    if (networkErrors.length > 0) {
      console.warn("5xx errors:", networkErrors);
    }
  });

  test("1-2: 不正 email フォーマット → バリデーションエラー表示", async ({ page }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.goto(`${BASE_URL}/login`);

    await page.locator("#email").fill(INVALID_EMAIL);
    await page.locator("#password").fill("SomePassword1!");
    await page.locator('button[type="submit"]').click();

    // email の typeMismatch バリデーションメッセージ確認
    const emailValMsg = await page.locator("#email").evaluate(
      (el) => (el as HTMLInputElement).validationMessage
    );
    // 不正フォーマットなので validationMessage は空でない
    expect(emailValMsg.length).toBeGreaterThan(0);

    // URL は /login のまま
    await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });

    await saveScreenshot(page, "02-login-invalid-email");

    if (networkErrors.length > 0) {
      console.warn("5xx errors:", networkErrors);
    }
  });

  test("1-3: wrong password → 日本語エラーメッセージが表示される", async ({ page }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.goto(`${BASE_URL}/login`);

    await page.locator("#email").fill(VALID_EMAIL);
    await page.locator("#password").fill(WRONG_PASSWORD);
    await page.locator('button[type="submit"]').click();

    // 修正: role=alert を優先。なければ text コンテンツが空でない [class*="red"] 要素を使う
    // (text-red-500 アイコン要素は textContent が空のためフィルタリングする)
    const alertEl = page.locator('[role="alert"]').first();
    const hasAlert = await alertEl.isVisible({ timeout: 15_000 }).catch(() => false);

    let errorText = "";
    if (hasAlert) {
      errorText = (await alertEl.textContent()) ?? "";
    } else {
      // role=alert がない場合: text コンテンツが非空の [class*="red"] 要素を探す
      const redEls = page.locator('[class*="red"]');
      const count = await redEls.count();
      for (let i = 0; i < count; i++) {
        const text = (await redEls.nth(i).textContent()) ?? "";
        if (text.trim().length > 0) {
          errorText = text;
          await expect(redEls.nth(i)).toBeVisible({ timeout: 5_000 });
          break;
        }
      }
    }

    // 日本語のエラーメッセージが表示されていること
    expect(errorText).toMatch(/パスワード|メールアドレス|ログイン|正しくありません/);

    // URL は /login のまま
    await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });

    await saveScreenshot(page, "03-login-wrong-password");

    if (networkErrors.length > 0) {
      console.warn("5xx errors:", networkErrors);
    }
  });

  test("1-4: 正常ログイン → /home にリダイレクト", async ({ page }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.goto(`${BASE_URL}/login`);

    await page.locator("#email").fill(VALID_EMAIL);
    await page.locator("#password").fill(VALID_PASSWORD);

    await Promise.all([
      page.waitForURL(
        (url) =>
          !url.pathname.startsWith("/login") &&
          !url.pathname.startsWith("/auth"),
        { timeout: 30_000 }
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    // /home またはオンボーディング系ページにいること
    const finalUrl = page.url();
    expect(finalUrl).toMatch(/\/(home|onboarding)/);

    await saveScreenshot(page, "04-login-success-redirect");

    if (networkErrors.length > 0) {
      console.warn("5xx errors:", networkErrors);
    }
  });
});

// ────────────────────────────────────────────────────────
// シナリオ 2: /signup
// ────────────────────────────────────────────────────────

test.describe("Scenario 2: /signup バリデーション & 重複エラー", () => {
  test("2-1: 弱いパスワード [123] → インラインエラーが表示されページ遷移しない", async ({
    page,
  }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.goto(`${BASE_URL}/signup`);

    await page.locator("#email").fill("test-weak-pwd-explore@example.com");
    await page.locator("#password").fill(WEAK_PASSWORD);
    await page.locator('button[type="submit"]').click();

    // パスワードエラーアラート
    const pwdError = page.locator("#password-error, [role='alert']").first();
    await expect(pwdError).toBeVisible({ timeout: 5_000 });

    const errorText = (await pwdError.textContent()) ?? "";
    expect(errorText).toMatch(/8文字以上|英字|数字|強度|パスワード/);

    // /signup のまま
    await expect(page).toHaveURL(/\/signup/, { timeout: 5_000 });

    await saveScreenshot(page, "05-signup-weak-password");

    if (networkErrors.length > 0) {
      console.warn("5xx errors:", networkErrors);
    }
  });

  test("2-2: 重複メールアドレス → 日本語エラーメッセージが表示される", async ({ page }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.goto(`${BASE_URL}/signup`);

    // 既存アカウントのメールアドレスを使う
    await page.locator("#email").fill(DUPLICATE_EMAIL);
    await page.locator("#password").fill("ValidPassword1!");
    await page.locator('button[type="submit"]').click();

    // フォームエラーまたは role=alert の表示を待つ
    const formError = page
      .locator('[role="alert"]')
      .or(page.locator('[class*="red"]'))
      .first();

    await expect(formError).toBeVisible({ timeout: 20_000 });

    const errorText = (await formError.textContent()) ?? "";
    // 重複登録エラーのメッセージが日本語で表示されていること
    // Supabase の "User already registered" → 日本語化済み
    expect(errorText).toMatch(/登録|メールアドレス|既に|重複|duplicate/i);

    // /signup のまま
    await expect(page).toHaveURL(/\/signup/, { timeout: 5_000 });

    await saveScreenshot(page, "06-signup-duplicate-email");

    if (networkErrors.length > 0) {
      console.warn("5xx errors:", networkErrors);
    }
  });

  test("2-3: 正常サインアップフロー → メール確認画面またはオンボーディングへ遷移", async ({
    page,
  }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.goto(`${BASE_URL}/signup`);

    // タイムスタンプ付きユニークアドレス（実際には送信されないテスト用）
    const uniqueEmail = `explore-test-${Date.now()}@example.com`;
    await page.locator("#email").fill(uniqueEmail);
    await page.locator("#password").fill("ExploreTest1!");
    await page.locator('button[type="submit"]').click();

    // /auth/verify または /onboarding への遷移を待つ
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith("/auth/verify") ||
        url.pathname.startsWith("/onboarding"),
      { timeout: 20_000 }
    ).catch(() => {
      // タイムアウトしても続行（実際には失敗チェック）
    });

    const finalUrl = page.url();
    // エラー画面でないこと: /signup のまま残っていてもエラーアラートが出ていないこと
    const hasAlert = await page.locator('[role="alert"]').count();
    if (finalUrl.includes("/signup")) {
      // まだ /signup にいる場合はアラートがないこと
      expect(hasAlert).toBe(0);
    } else {
      expect(finalUrl).toMatch(/\/auth\/verify|\/onboarding/);
    }

    await saveScreenshot(page, "07-signup-normal-flow");

    if (networkErrors.length > 0) {
      console.warn("5xx errors:", networkErrors);
    }
  });
});

// ────────────────────────────────────────────────────────
// シナリオ 3: /auth/forgot-password
// ────────────────────────────────────────────────────────

test.describe("Scenario 3: /auth/forgot-password 画面確認", () => {
  test("3-1: /auth/forgot-password にアクセスできフォームが表示される", async ({ page }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.goto(`${BASE_URL}/auth/forgot-password`);

    // ページが真っ白でないこと
    const body = await page.locator("body").textContent();
    expect(body?.trim().length ?? 0).toBeGreaterThan(0);

    // メールアドレス入力フィールドが表示されていること
    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toBeVisible({ timeout: 10_000 });

    // リセットリンク送信ボタンが表示されていること
    const submitBtn = page.locator('button[type="submit"]');
    await expect(submitBtn).toBeVisible();

    await saveScreenshot(page, "08-forgot-password-page");

    // 5xx エラーがないこと
    expect(networkErrors.filter((e) => e.includes("[5xx]"))).toHaveLength(0);
  });

  test("3-2: 空フォーム submit → バリデーション (ボタン disabled または HTML5 validation)", async ({ page }) => {
    // 実装: メール空欄時にボタンが disabled になる場合と HTML5 native validation の両方に対応
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.goto(`${BASE_URL}/auth/forgot-password`);

    const submitBtn = page.locator('button[type="submit"]');
    const emailInput = page.locator('input[type="email"]');

    // ボタンが disabled か確認
    const isDisabled = await submitBtn.isDisabled().catch(() => false);

    if (isDisabled) {
      // 実装: メール空欄時は disabled — 入力しても空の状態でボタンが有効にならないことを確認
      await expect(submitBtn).toBeDisabled();
      // メール欄が空の状態でフォームが /auth/forgot-password のままであること
      await expect(page).toHaveURL(/forgot-password/, { timeout: 5_000 });
      console.log("[3-2] forgot-password: submit button is disabled when email is empty — correct behavior");
    } else {
      // HTML5 native validation を期待する実装
      await submitBtn.click();
      const emailValMsg = await emailInput.evaluate(
        (el) => (el as HTMLInputElement).validationMessage
      );
      expect(emailValMsg.length).toBeGreaterThan(0);
      await expect(page).toHaveURL(/forgot-password/, { timeout: 5_000 });
    }

    await saveScreenshot(page, "09-forgot-password-empty-submit");
  });

  test("3-3: 有効なメールアドレスを送信 → 成功メッセージが表示される", async ({ page }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.goto(`${BASE_URL}/auth/forgot-password`);

    await page.locator('input[type="email"]').fill(VALID_EMAIL);
    await page.locator('button[type="submit"]').click();

    // 「メールを送信しました」の成功メッセージを待つ
    const successMsg = page.locator("text=メールを送信しました");
    await expect(successMsg).toBeVisible({ timeout: 15_000 });

    await saveScreenshot(page, "10-forgot-password-success");

    if (networkErrors.length > 0) {
      console.warn("5xx errors:", networkErrors);
    }
  });
});

// ────────────────────────────────────────────────────────
// シナリオ 4 (補足): /auth/reset-password
// ────────────────────────────────────────────────────────

test.describe("Scenario 4: /auth/reset-password 画面確認", () => {
  test("4-1: セッションなし状態でアクセス → 「リンクが無効です」メッセージ表示", async ({
    page,
  }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    // Cookie クリアで未認証 (セッションなし) 状態
    await page.context().clearCookies();
    await page.goto(`${BASE_URL}/auth/reset-password`);

    // ローディングスピナーが消えてから判定
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // 修正: .first() を使って strict mode violation を回避 (h1 と p の2要素マッチ対策)
    const invalidMsg = page
      .locator("text=リンクが無効です")
      .or(page.locator("text=無効または期限切れ"))
      .first();
    await expect(invalidMsg).toBeVisible({ timeout: 10_000 });

    await saveScreenshot(page, "11-reset-password-no-session");

    // 5xx エラーがないこと
    expect(networkErrors.filter((e) => e.includes("[5xx]"))).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────
// シナリオ 5: Session expiry (cookie clear → /home → /login?next=/home)
// ────────────────────────────────────────────────────────

test.describe("Scenario 5: セッション切れ → /login?next= にリダイレクト", () => {
  test("5-1: cookie クリア後 /home へアクセス → /login?next=/home にリダイレクト", async ({
    page,
  }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.context().clearCookies();

    await page.goto(`${BASE_URL}/home`);
    await page.waitForURL(/\/login/, { timeout: 20_000 });

    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");

    const nextParam = url.searchParams.get("next");
    expect(nextParam).toBe("/home");

    await saveScreenshot(page, "12-session-expiry-home-redirect");

    // 5xx エラーがないこと
    expect(networkErrors.filter((e) => e.includes("[5xx]"))).toHaveLength(0);
  });

  test("5-2: cookie クリア後 /menus/weekly へアクセス → /login?next=/menus/weekly", async ({
    page,
  }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.context().clearCookies();

    await page.goto(`${BASE_URL}/menus/weekly`);
    await page.waitForURL(/\/login/, { timeout: 20_000 });

    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");

    const nextParam = url.searchParams.get("next");
    expect(nextParam).toBe("/menus/weekly");

    await saveScreenshot(page, "13-session-expiry-menus-weekly-redirect");

    expect(networkErrors.filter((e) => e.includes("[5xx]"))).toHaveLength(0);
  });

  test("5-3: cookie クリア後 /health へアクセス → /login?next=/health", async ({ page }) => {
    const { consoleLogs, networkErrors } = attachMonitors(page);
    await page.context().clearCookies();

    await page.goto(`${BASE_URL}/health`);
    await page.waitForURL(/\/login/, { timeout: 20_000 });

    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");

    const nextParam = url.searchParams.get("next");
    expect(nextParam).toBe("/health");

    await saveScreenshot(page, "14-session-expiry-health-redirect");

    expect(networkErrors.filter((e) => e.includes("[5xx]"))).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────
// シナリオ 6: Public paths — 未認証でも redirect されないこと
// ────────────────────────────────────────────────────────

const PUBLIC_PATHS = [
  "/",
  "/about",
  "/pricing",
  "/faq",
  "/contact",
  "/legal",
  "/guide",
];

test.describe("Scenario 6: Public paths — 未認証時にリダイレクトされない", () => {
  for (const pubPath of PUBLIC_PATHS) {
    test(`6-x: ${pubPath} → /login にリダイレクトされない`, async ({ page }) => {
      const { consoleLogs, networkErrors } = attachMonitors(page);
      await page.context().clearCookies();

      await page.goto(`${BASE_URL}${pubPath}`);

      // /login にリダイレクトされていないこと
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

      // ページが真っ白でないこと
      const bodyText = await page.locator("body").textContent();
      expect(bodyText?.trim().length ?? 0).toBeGreaterThan(0);

      await saveScreenshot(page, `15-public-path-${pubPath.replace(/\//g, "_") || "root"}`);

      // 5xx エラーがないこと
      const fivexxErrors = networkErrors.filter((e) => e.includes("[5xx]"));
      if (fivexxErrors.length > 0) {
        console.warn(`5xx on ${pubPath}:`, fivexxErrors);
      }
      expect(fivexxErrors).toHaveLength(0);
    });
  }
});

// ────────────────────────────────────────────────────────
// シナリオ 7: Protected paths — 未認証時 /login?next= にリダイレクト
// ────────────────────────────────────────────────────────

const PROTECTED_PATHS = [
  "/home",
  "/menus/weekly",
  "/health",
  "/profile",
  "/settings",
];

test.describe("Scenario 7: Protected paths — 未認証時 /login?next= にリダイレクト", () => {
  for (const protectedPath of PROTECTED_PATHS) {
    test(`7-x: ${protectedPath} → /login?next=${protectedPath} にリダイレクト`, async ({
      page,
    }) => {
      const { consoleLogs, networkErrors } = attachMonitors(page);
      await page.context().clearCookies();

      await page.goto(`${BASE_URL}${protectedPath}`);

      // /login に到達するまで待つ
      await page.waitForURL(/\/login/, { timeout: 20_000 });

      const url = new URL(page.url());
      expect(url.pathname).toBe("/login");

      const nextParam = url.searchParams.get("next");
      expect(nextParam).toBe(protectedPath);

      // ログインフォームが表示されること（真っ白でない）
      const emailInput = page.locator("#email, input[type='email']").first();
      await expect(emailInput).toBeVisible({ timeout: 10_000 });

      await saveScreenshot(
        page,
        `16-protected-path-${protectedPath.replace(/\//g, "_")}`
      );

      // 5xx エラーがないこと
      const fivexxErrors = networkErrors.filter((e) => e.includes("[5xx]"));
      if (fivexxErrors.length > 0) {
        console.warn(`5xx on ${protectedPath}:`, fivexxErrors);
      }
      expect(fivexxErrors).toHaveLength(0);
    });
  }
});
