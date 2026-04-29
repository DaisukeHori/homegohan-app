import { test, expect } from "./fixtures/auth";
import path from "node:path";

/**
 * 画像分類フロー (オートモード) の UI 経由 E2E 検証
 *
 * 本番 https://homegohan-app.vercel.app の /meals/new ページで
 * 「AIが判別して解析」ボタンを経由した分類フローを検証する。
 *
 * サンプル画像: /tmp/classify-test/ に事前配置が必要
 *   meal-1.jpg, meal-2.jpg    → 食事写真   (expected step: result)
 *   fridge-1.jpg, fridge-2.jpg → 冷蔵庫   (expected step: fridge-result)
 *   health-1.jpg, health-2.jpg → 健康診断 (expected step: health-result)
 *   weight-1.jpg, weight-2.jpg → 体重計   (expected step: weight-result)
 */

const SAMPLE_DIR = "/tmp/classify-test";

const SAMPLES = [
  { file: "meal-1.jpg",   expected: "meal",           expectedStep: "result"        },
  { file: "meal-2.jpg",   expected: "meal",           expectedStep: "result"        },
  { file: "fridge-1.jpg", expected: "fridge",         expectedStep: "fridge-result" },
  { file: "fridge-2.jpg", expected: "fridge",         expectedStep: "fridge-result" },
  { file: "health-1.jpg", expected: "health_checkup", expectedStep: "health-result" },
  { file: "health-2.jpg", expected: "health_checkup", expectedStep: "health-result" },
  { file: "weight-1.jpg", expected: "weight_scale",   expectedStep: "weight-result" },
  { file: "weight-2.jpg", expected: "weight_scale",   expectedStep: "weight-result" },
] as const;

// 各結果ステップで header に表示されるテキスト (page.tsx line 989-993)
const STEP_HEADINGS: Record<string, string> = {
  "result":        "解析結果",
  "fridge-result": "冷蔵庫の中身",
  "health-result": "健康診断結果",
  "weight-result": "体重計読み取り結果",
};

for (const sample of SAMPLES) {
  test(`auto classify: ${sample.file} → ${sample.expected}`, async ({ authedPage }) => {
    // 1. /meals/new に移動
    await authedPage.goto("/meals/new");

    // 2. mode-select ステップが表示されるまで待つ
    await expect(authedPage.getByText("撮影するものを選んでください")).toBeVisible({
      timeout: 15_000,
    });

    // 3. デフォルトの photoMode は 'auto' (オート) なのでそのまま「撮影へ進む」をクリック
    await authedPage.getByRole("button", { name: "撮影へ進む" }).click();

    // 4. capture ステップへ遷移確認
    const fileInput = authedPage.locator('input[type="file"][multiple]');
    await expect(fileInput).toBeAttached({ timeout: 10_000 });

    // 5. gallery 用 file input (multiple 属性付き) にファイルをセット
    await fileInput.setInputFiles(path.join(SAMPLE_DIR, sample.file));

    // 6. プレビュー出現後に「AIが判別して解析」ボタンが表示されるまで待ってクリック
    const analyzeButton = authedPage.getByRole("button", { name: /AIが判別して解析/ });
    await expect(analyzeButton).toBeVisible({ timeout: 10_000 });
    await analyzeButton.click();

    // 7. 期待する結果ステップのヘッダが表示されるまで待つ (AI 解析のため最大 90 秒)
    const expectedHeadingText = STEP_HEADINGS[sample.expectedStep];

    await expect(authedPage.getByText(expectedHeadingText).first()).toBeVisible({
      timeout: 90_000,
    }).catch(async (originalError) => {
      // 失敗時のデバッグ情報収集
      const failedVisible = await authedPage
        .getByText("判別できませんでした")
        .isVisible()
        .catch(() => false);

      const otherStepVisible = await Promise.all(
        Object.entries(STEP_HEADINGS)
          .filter(([k]) => k !== sample.expectedStep)
          .map(async ([k, v]) => ({
            step: k,
            visible: await authedPage.getByText(v).isVisible().catch(() => false),
          }))
      );

      const actualStep = otherStepVisible.find((s) => s.visible)?.step ?? "不明";

      throw new Error(
        `[${sample.file}] 期待ステップ「${sample.expectedStep}」(${expectedHeadingText}) に遷移しませんでした。\n` +
          `  classify-failed 表示: ${failedVisible}\n` +
          `  実際に表示されたステップ: ${actualStep}\n` +
          `  URL: ${authedPage.url()}\n` +
          `  元エラー: ${originalError instanceof Error ? originalError.message : String(originalError)}`
      );
    });
  });
}
