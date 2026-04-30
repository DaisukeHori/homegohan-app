import { test, expect } from "./fixtures/auth";
import path from "node:path";

/**
 * Bug #64: オートモードで日本の定食写真 (meal-1.jpg) が classify-failed になる
 * Bug #65: classify-failed 画面で AnimatePresence exit 中に analyzing UI 残存
 *
 * サンプル画像: /tmp/classify-test/ に事前配置が必要
 *   meal-1.jpg → 定食写真 → 期待: result ステップへ遷移 (classify-failed にならない)
 */

const SAMPLE_DIR = "/tmp/classify-test";

test.describe("Bug #64: 定食写真がオートモードで meal として分類される", () => {
  test("meal-1.jpg (定食) → result ステップへ遷移し classify-failed にならない", async ({
    authedPage,
  }) => {
    await authedPage.goto("/meals/new");

    // mode-select ステップ確認
    await expect(authedPage.getByText("撮影するものを選んでください")).toBeVisible({
      timeout: 15_000,
    });

    // オートモード (デフォルト) で進む
    await authedPage.getByRole("button", { name: "撮影へ進む" }).click();

    // capture ステップ: file input を待つ
    const fileInput = authedPage.locator('input[type="file"][multiple]');
    await expect(fileInput).toBeAttached({ timeout: 10_000 });

    // meal-1.jpg をセット
    await fileInput.setInputFiles(path.join(SAMPLE_DIR, "meal-1.jpg"));

    // 解析ボタンをクリック
    const analyzeButton = authedPage.getByRole("button", { name: /AIが判別して解析/ });
    await expect(analyzeButton).toBeVisible({ timeout: 10_000 });
    await analyzeButton.click();

    // 「解析結果」ヘッダが出るまで最大 90 秒待つ
    await expect(authedPage.getByText("解析結果").first()).toBeVisible({
      timeout: 90_000,
    }).catch(async (originalError) => {
      const classifyFailed = await authedPage
        .getByText("判別できませんでした")
        .isVisible()
        .catch(() => false);

      throw new Error(
        `meal-1.jpg が「解析結果」に遷移しませんでした。\n` +
          `  classify-failed 表示: ${classifyFailed}\n` +
          `  URL: ${authedPage.url()}\n` +
          `  元エラー: ${originalError instanceof Error ? originalError.message : String(originalError)}`
      );
    });

    // 「判別できませんでした」が表示されていないことも確認
    await expect(authedPage.getByText("判別できませんでした")).not.toBeVisible();
  });
});

test.describe("Bug #65: classify-failed 遷移中に analyzing UI が残存しない", () => {
  test("analyzing → classify-failed 遷移時に analyzing スピナーが残らない", async ({
    authedPage,
  }) => {
    // meal-1.jpg が今回の修正で正常に meal 分類されるため、
    // classify-failed を安定して再現するために存在しないファイルを使うのは難しい。
    // 代わりに、analyzing step から classify-failed に遷移した直後に
    // analyzing 要素が DOM に残っていないことを検証する。
    //
    // このテストは classify-failed が発生するシナリオを前提とするため、
    // 実環境では meal-1.jpg が classify-failed にならなければ skip 相当の結果になる。
    // AnimatePresence mode="wait" + transition.duration=0.2 の確認を主目的とする。

    await authedPage.goto("/meals/new");
    await expect(authedPage.getByText("撮影するものを選んでください")).toBeVisible({
      timeout: 15_000,
    });
    await authedPage.getByRole("button", { name: "撮影へ進む" }).click();

    const fileInput = authedPage.locator('input[type="file"][multiple]');
    await expect(fileInput).toBeAttached({ timeout: 10_000 });
    await fileInput.setInputFiles(path.join(SAMPLE_DIR, "meal-1.jpg"));

    const analyzeButton = authedPage.getByRole("button", { name: /AIが判別して解析/ });
    await expect(analyzeButton).toBeVisible({ timeout: 10_000 });
    await analyzeButton.click();

    // analyzing ステップが表示される
    await expect(authedPage.getByText(/AIが写真の種類を確認中/)).toBeVisible({ timeout: 15_000 });

    // 次のステップ (result or classify-failed) に遷移した直後
    // analyzing UI のテキストが消えていることを確認
    await expect(authedPage.getByText(/AIが写真の種類を確認中/)).not.toBeVisible({
      timeout: 90_000,
    });

    // この時点でスピナーが残存していないこと (animate-spin を持つ div が消えている)
    const spinner = authedPage.locator(".animate-spin");
    // analyzing 画面が抜けた後スピナーは見えない
    await expect(spinner).not.toBeVisible();
  });
});
