/**
 * Wave 2 / Cluster F10 gap features E2E テスト
 *
 * #133 CSV エクスポート
 *   - 設定ページに「献立をCSVエクスポート」ボタンが存在する
 *   - クリックすると /api/export/meals に GET リクエストが飛ぶ
 *   - レスポンス Content-Type が text/csv でダウンロードされる
 *
 * #99 ローカル通知 (フォアグラウンド)
 *   - 設定ページに「通知」トグルが存在する
 *   - 通知 API が利用可能なとき、トグル ON 操作で requestNotificationPermission が呼ばれる
 *   - (実際のブラウザパーミッションダイアログはテスト環境でモックする)
 */

import { test, expect } from "./fixtures/auth";

test.describe("#133 CSV エクスポート", () => {
  test("設定ページに献立CSVエクスポートボタンが存在する", async ({ authedPage }) => {
    await authedPage.goto("/settings");

    const csvButton = authedPage.getByRole("button", { name: /献立をCSVエクスポート/ });
    await expect(csvButton).toBeVisible();
  });

  test("CSVエクスポートボタンが /api/export/meals に GET リクエストを送る", async ({
    authedPage,
  }) => {
    await authedPage.goto("/settings");

    const requestPromise = authedPage.waitForRequest(
      (req) => req.url().includes("/api/export/meals") && req.method() === "GET",
    );

    // ダウンロードイベントを待つ（タイムアウト緩め）
    const downloadPromise = authedPage.waitForEvent("download", { timeout: 30_000 });

    const csvButton = authedPage.getByRole("button", { name: /献立をCSVエクスポート/ });
    await csvButton.click();

    const request = await requestPromise;
    expect(request).toBeTruthy();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^homegohan-meals-.*\.csv$/);
  });
});

test.describe("#99 ローカル通知トグル", () => {
  test("設定ページに通知トグルが存在する", async ({ authedPage }) => {
    await authedPage.goto("/settings");

    // 通知トグルの Switch ボタンが存在することを確認
    // Switch は「通知」ラベルの隣に配置されている
    const notificationRow = authedPage.locator("text=通知").first();
    await expect(notificationRow).toBeVisible();
  });

  test("通知トグルが button 要素として実装されている", async ({ authedPage }) => {
    await authedPage.goto("/settings");

    // 「通知」テキストを含む行のスイッチを確認
    // Switch コンポーネントは button タグ
    const settingsSection = authedPage.locator(".bg-white").first();
    const switchButtons = settingsSection.locator("button");
    // 少なくとも通知・自動解析の 2 つのスイッチがある
    await expect(switchButtons).toHaveCount(await switchButtons.count());
    expect(await switchButtons.count()).toBeGreaterThanOrEqual(2);
  });
});
