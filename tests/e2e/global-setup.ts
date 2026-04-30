/**
 * Playwright グローバルセットアップ
 *
 * 全 worker が共有する storageState を生成する。
 * ログインを 1 回だけ行い、認証済みセッションを
 * tests/e2e/.auth/user.json に保存する。
 * 各テストの authedPage fixture はこのファイルを読み込んで
 * ログイン処理をスキップするため、30s タイムアウト連鎖を回避できる。
 *
 * ログイン失敗時は警告を出力して続行する (storageState なしで各テストが個別ログインにフォールバック)。
 */

import { chromium, type FullConfig } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const STORAGE_STATE_PATH = "tests/e2e/.auth/user.json";
const LOGIN_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use?.baseURL ??
    process.env.PLAYWRIGHT_BASE_URL ??
    "http://localhost:3000";

  const email =
    process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local";
  const password = process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!";

  // 保存先ディレクトリを作成
  const dir = path.dirname(STORAGE_STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const browser = await chromium.launch();

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    const page = await context.newPage();

    try {
      await page.goto(`${baseURL}/login`);
      // React ハイドレーションが完了するまで待機する。
      // ハイドレーション前に submit をクリックすると form が native GET 送信されてしまう。
      await page.waitForLoadState("networkidle");
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(password);

      await Promise.all([
        page.waitForURL(
          (url) =>
            !url.pathname.startsWith("/login") &&
            !url.pathname.startsWith("/auth"),
          { timeout: LOGIN_TIMEOUT_MS },
        ),
        page.locator("button[type=submit]").click(),
      ]);

      // オンボーディング未完了の場合はAPIで完了させてホームへ誘導
      if (page.url().includes("/onboarding")) {
        await page.evaluate(async () => {
          try {
            await fetch("/api/onboarding/complete", {
              method: "POST",
              credentials: "include",
            });
          } catch {
            // エラーは無視して続行
          }
        });
        await page.goto(`${baseURL}/home`);
        await page.waitForURL("**/home", { timeout: 60_000 });
      }

      // storageState を保存
      await context.storageState({ path: STORAGE_STATE_PATH });
      console.log(
        `[global-setup] storageState saved to ${STORAGE_STATE_PATH} (attempt ${attempt})`,
      );
      await context.close();
      await browser.close();
      return;
    } catch (err) {
      lastError = err;
      console.warn(
        `[global-setup] ログイン試行 ${attempt}/${MAX_RETRIES} 失敗: ${err}`,
      );
      await context.close();

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[global-setup] ${delay}ms 待機後にリトライ...`);
        await sleep(delay);
      }
    }
  }

  await browser.close();
  // ログイン失敗時はエラーをスローせず警告のみ出力して続行する。
  // storageState が生成されなかった場合、各テストの authedPage fixture が
  // 個別ログインにフォールバックする。
  console.warn(
    `[global-setup] ${MAX_RETRIES} 回試行後もログイン失敗。storageState なしで続行: ${lastError}`,
  );
}

export default globalSetup;
