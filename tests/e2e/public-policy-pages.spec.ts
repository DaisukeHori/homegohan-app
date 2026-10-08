/**
 * #1174 (同意の前提): 利用規約・プライバシーポリシーを、ログインしていなくても読める
 *
 * 背景:
 *   サインアップ画面の「続行することで、利用規約およびプライバシーポリシーに同意したものとみなされます」の
 *   リンク (/terms, /privacy)、LP のフッター、ストア審査に出すプライバシー URL は、どれも
 *   未ログインで開くと 307 → /login?next=%2Fprivacy になり、ログイン画面に着地していた
 *   (ページが (main) グループの中にあり、middleware の publicPaths にも無かったため)。
 *   同意の根拠になる文面を読めないまま「同意したものとみなす」状態だった。
 *
 * 確認 (すべて、ログインしていない状態で):
 *   1. /terms・/privacy を直接開くと、ログイン画面へ飛ばされず、見出しが表示される
 *   2. サインアップ画面の同意リンクから、それぞれのページに着地する
 *   3. LP のフッターのリンクから、それぞれのページに着地する
 *   4. ページの戻るリンクはトップ (/) を指す (ログイン後の設定画面 /settings ではない)
 *   5. 保護ページ (/settings) は従来どおりログイン画面へ回る (公開範囲を広げすぎていない)
 *
 * 規約・ポリシーの文面そのものは検査しない (文面の見直しは別タスク)。
 */
import { test, expect } from "@playwright/test";

// playwright.config.ts の共有ログイン状態 (storageState) を引き継がず、未ログインで確かめる
test.use({ storageState: { cookies: [], origins: [] } });

/** dev サーバの初回コンパイルを待てるよう、画面遷移直後の可視性アサーションだけ長めにする */
const NAVIGATION_TIMEOUT = 30_000;

const POLICY_PAGES = [
  { path: "/terms", heading: "利用規約" },
  { path: "/privacy", heading: "プライバシーポリシー" },
] as const;

test.describe("未ログインで利用規約・プライバシーポリシーを読める (#1174)", () => {
  for (const { path, heading } of POLICY_PAGES) {
    test(`${path} を直接開くと、ログイン画面へ飛ばされず見出しが表示される`, async ({ page }) => {
      await page.goto(path);

      await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: NAVIGATION_TIMEOUT });
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({
        timeout: NAVIGATION_TIMEOUT,
      });
      // ログイン画面のフォームが出ていない
      await expect(page.locator("#email")).toHaveCount(0);
    });

    test(`${path} の戻るリンクはトップ (/) を指し、設定画面 (/settings) ではない`, async ({ page }) => {
      await page.goto(path);

      const back = page.getByRole("link", { name: "トップページへ戻る" });
      await expect(back).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
      await expect(back).toHaveAttribute("href", "/");
      await expect(page.locator('a[href="/settings"]')).toHaveCount(0);
    });
  }

  test("サインアップ画面の同意リンクから、利用規約・プライバシーポリシーに着地する", async ({ page }) => {
    for (const { path, heading } of POLICY_PAGES) {
      await page.goto("/signup");
      await page.getByRole("link", { name: heading, exact: true }).click();

      await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: NAVIGATION_TIMEOUT });
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({
        timeout: NAVIGATION_TIMEOUT,
      });
    }
  });

  test("LP のフッターのリンクから、利用規約・プライバシーポリシーに着地する", async ({ page }) => {
    for (const { path, heading } of POLICY_PAGES) {
      await page.goto("/");
      await page.locator("footer").getByRole("link", { name: heading, exact: true }).click();

      await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: NAVIGATION_TIMEOUT });
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({
        timeout: NAVIGATION_TIMEOUT,
      });
    }
  });

  test("保護ページ (/settings) は未ログインなら従来どおりログイン画面へ回る", async ({ page }) => {
    await page.goto("/settings");

    await expect(page).toHaveURL(/\/login\?next=%2Fsettings/, { timeout: NAVIGATION_TIMEOUT });
  });
});
