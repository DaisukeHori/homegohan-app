/**
 * Bug-25 (#44): 「データをエクスポート」ボタンが完全に未実装 (onClick ハンドラ無し)
 * Bug-26 (#45): 「トレーナーと共有」がクリック不可な <div> 要素として実装されている
 * #1144: 「トレーナーと共有」は、トレーナーなどに共有する機能が無いまま項目だけが画面にあったため、設定画面から外した
 *
 * 確認: エクスポートのボタンは button 要素で、API へ GET してファイルを保存する。
 *       「トレーナーと共有」の項目 (Bug-26 の修正で押すと「近日公開予定」を出すようにしていたもの) は、
 *       設定画面に出ない。
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

    // #1131: 中身はご本人のデータ一式の JSON (形式・打ち切りなし・プロフィールを含む)
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const exported = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(exported.format).toBe("homegohan-personal-data-export");
    expect(exported.summary.complete).toBe(true);
    expect(exported.data.user_profiles).toHaveLength(1);
    expect(exported.data.user_profiles[0].id).toBe(exported.user_id);
  });

  test("trainer share entry is not shown on the settings page (#1144)", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/settings");

    // 設定画面が描画されてから「無い」ことを確かめる (読み込み前に空振りで通らないよう、隣の項目を先に待つ)
    await expect(tourPendingUser.getByRole("button", { name: /データをエクスポート/ })).toBeVisible();
    await expect(tourPendingUser.getByRole("button", { name: /献立をCSVエクスポート/ })).toBeVisible();

    await expect(tourPendingUser.getByRole("button", { name: /トレーナーと共有/ })).toHaveCount(0);
    await expect(tourPendingUser.getByText(/トレーナー/)).toHaveCount(0);
    // 保存済みの値を表していた「記録ON / 記録OFF」の表示も出ない
    await expect(tourPendingUser.getByText(/記録(ON|OFF)/)).toHaveCount(0);
  });
});
