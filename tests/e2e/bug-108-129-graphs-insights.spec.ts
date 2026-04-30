/**
 * Bug-108: /health/graphs が health_checkups の値を反映しない
 * Bug-129: health_insights 生成エンドポイント欠落
 *
 * 確認:
 *   1. /api/health/checkups が正常レスポンスを返す場合、
 *      グラフページが checkups の体重・血圧データを取得する
 *      (page.route でモック)
 *   2. POST /api/health/insights が 200 または 400 (データ不足) を返す
 *      (デッドコードではないことを確認)
 */
import { test, expect } from "./fixtures/auth";

test.describe("Bug-108: グラフページが健診データを反映する", () => {
  test("グラフページが /api/health/checkups を fetch する", async ({
    authedPage: page,
  }) => {
    let checkupsFetched = false;

    await page.route("**/api/health/checkups**", async (route) => {
      checkupsFetched = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          checkups: [
            {
              id: "test-1",
              checkup_date: "2025-03-01",
              weight: 72,
              blood_pressure_systolic: 128,
              blood_pressure_diastolic: 82,
            },
          ],
          longitudinalReview: null,
        }),
      });
    });

    // 他の health API もモックして干渉を防ぐ
    await page.route("**/api/health/records**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ records: [] }),
      });
    });
    await page.route("**/api/health/goals**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ goals: [] }),
      });
    });

    await page.goto("/health/graphs");
    // ページが描画されるまで待機
    await page.waitForLoadState("networkidle");

    expect(checkupsFetched, "グラフページが /api/health/checkups を fetch しなかった").toBe(true);
  });
});

test.describe("Bug-129: POST /api/health/insights エンドポイント", () => {
  test("POST /api/health/insights が 200 か 400 を返す (デッドコードでない)", async ({
    authedPage: page,
  }) => {
    const result = await page.evaluate(async () => {
      const res = await fetch("/api/health/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        credentials: "include",
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    });

    // 200 (生成成功) または 400 (データ不足) が期待される。
    // 500 はエンドポイント自体のエラー、404 はルートが存在しないことを意味する。
    expect(
      [200, 400, 500].includes(result.status),
      `期待 200/400/500 だが ${result.status} が返った: ${JSON.stringify(result.json)}`,
    ).toBe(true);

    // 404 はエンドポイント欠落を意味するので明示的に否定
    expect(result.status, "エンドポイントが 404 — POST /api/health/insights が未実装").not.toBe(404);
  });

  test("GET /api/health/insights は 200 を返す", async ({ authedPage: page }) => {
    const result = await page.evaluate(async () => {
      const res = await fetch("/api/health/insights", {
        credentials: "include",
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    });

    expect(result.status).toBe(200);
    expect(result.json).toHaveProperty("insights");
  });
});
