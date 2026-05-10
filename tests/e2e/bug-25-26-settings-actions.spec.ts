/**
 * Bug-25 (#44): 「データをエクスポート」ボタンが完全に未実装 (onClick ハンドラ無し)
 * Bug-26 (#45): 「トレーナーと共有」がクリック不可な <div> 要素として実装されている
 *
 * 確認: 両ボタンが button 要素で、aria-label を持ち、エクスポートは API へ GET、
 *       トレーナー共有は alert() を発火する。
 */
import { test, expect } from "./fixtures/fresh-user";

test.describe("settings data & privacy actions", () => {
  test("export button calls /api/account/export and downloads JSON", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/settings");

    const exportButton = tourPendingUser.getByRole("button", { name: /データをエクスポート/ });
    await expect(exportButton).toBeVisible();

    const requestPromise = tourPendingUser.waitForRequest((req) =>
      req.url().includes("/api/account/export") && req.method() === "GET",
    );
    const downloadPromise = tourPendingUser.waitForEvent("download", { timeout: 30_000 });

    await exportButton.click();
    const request = await requestPromise;
    expect(request).toBeTruthy();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^homegohan-export-.*\.json$/);
  });

  test("trainer share button shows coming-soon alert (not a div)", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/settings");

    const trainerButton = tourPendingUser.getByRole("button", { name: /トレーナーと共有/ });
    await expect(trainerButton).toBeVisible();

    let dialogMessage: string | null = null;
    tourPendingUser.once("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.dismiss();
    });
    await trainerButton.click();
    await expect.poll(() => dialogMessage, { timeout: 5_000 }).toContain("近日公開予定");
  });
});
