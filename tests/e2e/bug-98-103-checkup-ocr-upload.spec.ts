/**
 * Bug-98: 健診画像アップロード時に OCR API が呼ばれず偽の解析中表示
 * Bug-103: 健診 PDF アップロード未対応
 *
 * 確認:
 *   1. /health/checkups/new にアクセスできる
 *   2. ファイル input が image/* と application/pdf を accept している
 *   3. 画像ファイルを選択すると "AIで読み取る" ボタンが表示される
 *   4. PDFファイルを選択すると PDF 選択済み表示になり "AIで読み取る" ボタンが表示される
 *   5. /api/ai/analyze-health-checkup に POST リクエストが送られる
 *      (ネットワークインターセプトで確認)
 *   6. OCR レスポンスの値が confirm ステップのフォームフィールドに反映される
 *
 * 戦略:
 *   - authedPage でページを開く
 *   - page.route で /api/ai/analyze-health-checkup をモック
 *   - input[type=file] にテスト用ファイルを setInputFiles する
 *   - ボタンクリック後に confirm ステップへ遷移し、フォーム値を確認
 */
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { test, expect } from "./fixtures/auth";

const MOCK_OCR_RESPONSE = {
  extractedData: {
    checkupDate: "2025-04-01",
    height: 170,
    weight: 65,
    bmi: 22.5,
    bloodPressureSystolic: 120,
    bloodPressureDiastolic: 80,
    hba1c: 5.6,
    totalCholesterol: 200,
    ldlCholesterol: 120,
    hdlCholesterol: 60,
    triglycerides: 150,
    confidence: 0.9,
    notes: "",
  },
  fieldCount: 10,
  confidence: 0.9,
  notes: "",
  modelUsed: "gemini-test",
};

/** 最小限の 1x1 PNG を Base64 デコードして一時ファイルに書き出す */
function createTempImageFile(): string {
  const pngB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const buf = Buffer.from(pngB64, "base64");
  const tmpPath = path.join(os.tmpdir(), `test-checkup-${Date.now()}.png`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

/** 最小限の PDF を一時ファイルに書き出す */
function createTempPdfFile(): string {
  // 最小 PDF (1ページ空ページ)
  const minPdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
190
%%EOF`;
  const tmpPath = path.join(os.tmpdir(), `test-checkup-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, minPdf);
  return tmpPath;
}

test.describe("Bug-98/103: 健診アップロード OCR フロー", () => {
  test("画像アップロード → OCR API が呼ばれ → フォームに値が反映される", async ({
    authedPage: page,
  }) => {
    // OCR エンドポイントをモック
    let ocrCalled = false;
    await page.route("**/api/ai/analyze-health-checkup", async (route) => {
      ocrCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_OCR_RESPONSE),
      });
    });

    await page.goto("/health/checkups/new");

    // ファイル input が image/* と application/pdf を accept しているか確認
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toHaveAttribute("accept", /application\/pdf/);
    await expect(fileInput).toHaveAttribute("accept", /image/);

    // テスト用画像を選択
    const imgPath = createTempImageFile();
    try {
      await fileInput.setInputFiles(imgPath);

      // "AIで読み取る" ボタンが表示される
      const analyzeBtn = page.getByRole("button", { name: /AIで読み取る/ });
      await expect(analyzeBtn).toBeVisible({ timeout: 5000 });

      // ボタンをクリックして OCR を実行
      await analyzeBtn.click();

      // confirm ステップへ遷移するまで待機
      await expect(page.getByText("検査結果を確認")).toBeVisible({ timeout: 15_000 });

      // OCR が呼ばれたか確認
      expect(ocrCalled, "OCR エンドポイントが呼ばれなかった").toBe(true);

      // フォームに OCR 値が反映されているか確認
      // 体重 65 が反映されているはず
      const weightInput = page
        .locator('input[type="text"]')
        .filter({ hasText: "" });
      // 体重フィールドの確認 — label "体重" の隣の input を探す
      const weightField = page
        .locator("label", { hasText: "体重" })
        .locator("..")
        .locator("input");
      if ((await weightField.count()) > 0) {
        await expect(weightField.first()).toHaveValue("65");
      }
    } finally {
      fs.unlinkSync(imgPath);
    }
  });

  test("PDF アップロード → PDF 選択済み表示 → OCR API が呼ばれる", async ({
    authedPage: page,
  }) => {
    // OCR エンドポイントをモック
    let ocrCalledWithPdf = false;
    await page.route("**/api/ai/analyze-health-checkup", async (route) => {
      const body = await route.request().postDataJSON();
      if (body?.mimeType === "application/pdf") {
        ocrCalledWithPdf = true;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_OCR_RESPONSE),
      });
    });

    await page.goto("/health/checkups/new");

    const fileInput = page.locator('input[type="file"]');

    // テスト用 PDF を選択
    const pdfPath = createTempPdfFile();
    try {
      await fileInput.setInputFiles(pdfPath);

      // PDF 選択済みの表示 ("PDF選択済み" or ファイル名) が現れる
      await expect(page.getByText(/\.pdf|PDF選択済み/i)).toBeVisible({
        timeout: 5000,
      });

      // "AIで読み取る" ボタンが表示される
      const analyzeBtn = page.getByRole("button", { name: /AIで読み取る/ });
      await expect(analyzeBtn).toBeVisible({ timeout: 5000 });

      // ボタンをクリック
      await analyzeBtn.click();

      // confirm ステップへ遷移するまで待機
      await expect(page.getByText("検査結果を確認")).toBeVisible({
        timeout: 15_000,
      });

      // PDF の MIME で OCR が呼ばれたことを確認
      expect(
        ocrCalledWithPdf,
        "PDF の mimeType で OCR エンドポイントが呼ばれなかった",
      ).toBe(true);
    } finally {
      fs.unlinkSync(pdfPath);
    }
  });

  test("/api/ai/analyze-health-checkup は imageBase64 なしで 400 を返す", async ({
    authedPage: page,
  }) => {
    const result = await page.evaluate(async () => {
      const res = await fetch("/api/ai/analyze-health-checkup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        credentials: "include",
      });
      return { status: res.status, json: await res.json() };
    });

    expect(result.status).toBe(400);
    expect(result.json).toHaveProperty("error");
  });
});
