/**
 * Bug-16 (#23): バージョン情報が古い「Build 20250125」「© 2025 ほめゴハン」
 *
 * 確認: /settings ページ最下部のバージョン表示が現在年 (2026) を含み、
 *       ハードコードされた「2025」の著作権表示が残っていないこと。
 */
import { test, expect } from "./fixtures/auth";

test.describe("settings version display (Bug-16)", () => {
  test("footer shows current year and not the stale 2025 copyright", async ({ authedPage }) => {
    await authedPage.goto("/settings");

    // ページが読み込まれるまで待機
    await expect(authedPage.getByRole("heading", { name: /設定/ }).first()).toBeVisible({
      timeout: 15_000,
    });

    // バージョン情報テキストを取得
    const versionText = authedPage.getByText(/ほめゴハン/).last();
    await expect(versionText).toBeVisible({ timeout: 10_000 });

    const text = await versionText.innerText();

    // 現在年 2026 が表示されていること
    expect(text).toMatch(/2026/);

    // ハードコードされた古い「© 2025」が残っていないこと
    expect(text).not.toMatch(/© 2025|©2025/);

    // Build 日付が 2025年1月25日のハードコードのままでないこと
    const pageContent = await authedPage.content();
    expect(pageContent).not.toContain("Build 20250125");
  });
});
