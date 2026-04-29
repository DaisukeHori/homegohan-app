import { test, expect } from "./fixtures/auth";
import path from "node:path";

/**
 * 画像分類フロー (オートモード) の UI 経由 E2E 検証 — 実写 + 判別不能ケース
 *
 * 本番 https://homegohan-app.vercel.app の /meals/new ページで
 * 「AIが判別して解析」ボタンを経由した分類フローを検証する。
 *
 * サンプル画像: /tmp/classify-real-test/ に事前配置が必要
 *   meal-real-1.jpg, meal-real-2.jpg       → 実写食事   (expected step: result)
 *   fridge-real-1.jpg, fridge-real-2.jpg   → 実写冷蔵庫 (expected step: fridge-result)
 *   health-real-1.jpg, health-real-2.jpg   → 実写健診票 (expected step: health-result)
 *   weight-real-1.jpg, weight-real-2.jpg   → 実写体重計 (expected step: weight-result)
 *   unknown-blank.jpg                      → 白紙       (expected step: classify-failed)
 *   unknown-abstract.jpg                   → 抽象画     (expected step: classify-failed)
 *   unknown-landscape.jpg                  → 風景写真   (expected step: classify-failed)
 *   unknown-animal.jpg                     → 動物写真   (expected step: classify-failed)
 *
 * 画像入手スクリプト例:
 *   mkdir -p /tmp/classify-real-test
 *   # meal
 *   curl -sL "https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=800&q=80" -o /tmp/classify-real-test/meal-real-1.jpg
 *   curl -sL "https://images.unsplash.com/photo-1553621042-f6e147245754?w=800&q=80"    -o /tmp/classify-real-test/meal-real-2.jpg
 *   # fridge
 *   curl -sL "https://images.unsplash.com/photo-1584568694244-14fbdf83bd30?w=800&q=80" -o /tmp/classify-real-test/fridge-real-1.jpg
 *   curl -sL "https://images.unsplash.com/photo-1571781926291-c477ebfd024b?w=800&q=80" -o /tmp/classify-real-test/fridge-real-2.jpg
 *   # health checkup (medical report paper)
 *   curl -sL "https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=800&q=80" -o /tmp/classify-real-test/health-real-1.jpg
 *   curl -sL "https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=800&q=80"    -o /tmp/classify-real-test/health-real-2.jpg
 *   # weight scale
 *   curl -sL "https://images.unsplash.com/photo-1550345332-09e3ac987658?w=800&q=80"    -o /tmp/classify-real-test/weight-real-1.jpg
 *   curl -sL "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800&q=80" -o /tmp/classify-real-test/weight-real-2.jpg
 *   # unknown / unclassifiable
 *   convert -size 800x600 xc:white /tmp/classify-real-test/unknown-blank.jpg  # blank white
 *   curl -sL "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/Tsunami_by_hokusai_19th_century.jpg/800px-Tsunami_by_hokusai_19th_century.jpg" -o /tmp/classify-real-test/unknown-abstract.jpg
 *   curl -sL "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80" -o /tmp/classify-real-test/unknown-landscape.jpg
 *   curl -sL "https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=800&q=80"    -o /tmp/classify-real-test/unknown-animal.jpg
 */

const SAMPLE_DIR = "/tmp/classify-real-test";

const SAMPLES = [
  // 実写 (各カテゴリ 2 枚)
  { file: "meal-real-1.jpg",    expected: "meal",           expectedStep: "result",         note: "実写ラーメン" },
  { file: "meal-real-2.jpg",    expected: "meal",           expectedStep: "result",         note: "実写寿司" },
  { file: "fridge-real-1.jpg",  expected: "fridge",         expectedStep: "fridge-result",  note: "実写冷蔵庫" },
  { file: "fridge-real-2.jpg",  expected: "fridge",         expectedStep: "fridge-result",  note: "実写冷蔵庫" },
  { file: "health-real-1.jpg",  expected: "health_checkup", expectedStep: "health-result",  note: "実写検査票" },
  { file: "health-real-2.jpg",  expected: "health_checkup", expectedStep: "health-result",  note: "実写検査票" },
  { file: "weight-real-1.jpg",  expected: "weight_scale",   expectedStep: "weight-result",  note: "実写体重計" },
  { file: "weight-real-2.jpg",  expected: "weight_scale",   expectedStep: "weight-result",  note: "実写体重計" },
  // 判別不能 (classify-failed 期待)
  { file: "unknown-blank.jpg",    expected: "unknown", expectedStep: "classify-failed", note: "白紙" },
  { file: "unknown-abstract.jpg", expected: "unknown", expectedStep: "classify-failed", note: "抽象画" },
  { file: "unknown-landscape.jpg",expected: "unknown", expectedStep: "classify-failed", note: "風景" },
  { file: "unknown-animal.jpg",   expected: "unknown", expectedStep: "classify-failed", note: "動物" },
] as const;

// 各結果ステップで header (sticky top bar) に表示されるテキスト (page.tsx 行 989-994)
const STEP_HEADINGS: Record<string, string> = {
  "result":          "解析結果",
  "fridge-result":   "冷蔵庫の中身",
  "health-result":   "健康診断結果",
  "weight-result":   "体重計読み取り結果",
  "classify-failed": "判別できませんでした",
};

for (const sample of SAMPLES) {
  test(`auto classify (real): ${sample.note} → ${sample.expectedStep}`, async ({ authedPage }) => {
    test.setTimeout(120_000);

    // 1. /meals/new に移動
    await authedPage.goto("/meals/new");

    // 2. mode-select ステップが表示されるまで待つ
    await expect(authedPage.getByText("撮影するものを選んでください")).toBeVisible({
      timeout: 15_000,
    });

    // 3. デフォルトの photoMode は 'auto' なのでそのまま「撮影へ進む」をクリック
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
      const allStepTexts = await Promise.all(
        Object.entries(STEP_HEADINGS).map(async ([stepKey, heading]) => ({
          step: stepKey,
          visible: await authedPage.getByText(heading).isVisible().catch(() => false),
        }))
      );

      const visibleStep = allStepTexts.find((s) => s.visible);

      throw new Error(
        `[${sample.file}] (${sample.note}) 期待ステップ「${sample.expectedStep}」(${expectedHeadingText}) に遷移しませんでした。\n` +
          `  実際に表示されたステップ: ${visibleStep?.step ?? "不明"}\n` +
          `  URL: ${authedPage.url()}\n` +
          `  元エラー: ${originalError instanceof Error ? originalError.message : String(originalError)}`
      );
    });
  });
}
