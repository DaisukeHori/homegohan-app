/**
 * Bug #72, #78: 不正 URL parameter で HTTP 500 → 404 にする error boundary 整備
 *
 * #72: /health/checkups/<script> 等の非 UUID ID で 500 + React error #438 が発生
 *   -> UUID バリデーション → notFound() により 404 ページが返る
 *
 * #78: /menus/weekly/[invalid-id] 直叩きで白抜け (動的ルートなし → 該当なし / スキップ)
 *
 * 検証シナリオ:
 *   1. /health/checkups/abc-xss-test に直接アクセス → 404 ページ (status 404)
 *   2. /health/checkups/<script>alert(1)</script> に直接アクセス → 404 ページ
 *   3. /health/checkups/not-a-uuid に直接アクセス → 404 ページ
 *   4. /some-totally-random-nonexistent-path → 404 ページ
 *   5. /health/checkups/00000000-0000-0000-0000-000000000000 (valid UUID) → 500 にならない
 */
import { expect, test } from "@playwright/test";
import { test as authTest } from "./fixtures/auth";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

// /health/checkups/[id] はログイン必須のルート。
// UUID バリデーション (notFound) はミドルウェアの認証リダイレクトより後に動作するため、
// 認証済みセッションで UUID 検証の 404 を確認する。
test.describe("Bug #72: 不正 checkup ID → 404 (500 にならない)", () => {
  authTest("非 UUID の ID (abc-xss-test) で 404 ページが返る", async ({ authedPage }) => {
    const response = await authedPage.goto(`${BASE_URL}/health/checkups/abc-xss-test`);
    // HTTP ステータスが 404 であること
    expect(response?.status()).toBe(404);
    // 404 ページのテキストが表示されること
    await expect(
      authedPage.locator("text=ページが見つかりません").or(authedPage.locator("text=404"))
    ).toBeVisible({ timeout: 10_000 });
  });

  authTest("XSS 試行 URL (<script>タグ含む) で 404 ページが返る", async ({ authedPage }) => {
    const response = await authedPage.goto(
      `${BASE_URL}/health/checkups/%3Cscript%3Ealert(1)%3C%2Fscript%3E`
    );
    // 404 または Next.js がそもそも reject する (< 500 であること)
    const status = response?.status() ?? 0;
    expect(status).toBeLessThan(500);
    // 500 エラーページが表示されていないこと
    await expect(authedPage.locator("text=Application error")).not.toBeVisible();
  });

  authTest("非 UUID の ID (not-a-uuid) で 404 ページが返る", async ({ authedPage }) => {
    const response = await authedPage.goto(`${BASE_URL}/health/checkups/not-a-uuid`);
    expect(response?.status()).toBe(404);
  });

  authTest("有効な UUID 形式の ID では 500 にならない", async ({ authedPage }) => {
    // 存在しない UUID でも 500 にはならない (404 または認証リダイレクト)
    const response = await authedPage.goto(
      `${BASE_URL}/health/checkups/00000000-0000-0000-0000-000000000000`
    );
    const status = response?.status() ?? 0;
    expect(status).toBeLessThan(500);
  });
});

// 404 ページの基本動作: 認証が必要なルートは authTest を使用
test.describe("404 ページの基本動作", () => {
  authTest("存在しないパスで 404 ページが返る", async ({ authedPage }) => {
    const response = await authedPage.goto(
      `${BASE_URL}/random-nonexistent-page-xyz-9999`
    );
    expect(response?.status()).toBe(404);
  });

  authTest("404 ページに「ホームへ戻る」リンクが表示される", async ({ authedPage }) => {
    await authedPage.goto(`${BASE_URL}/health/checkups/invalid-id-for-test`);
    await expect(
      authedPage.locator("a[href='/home'], a[href='/']").or(
        authedPage.locator("text=ホームへ戻る")
      )
    ).toBeVisible({ timeout: 10_000 });
  });
});
