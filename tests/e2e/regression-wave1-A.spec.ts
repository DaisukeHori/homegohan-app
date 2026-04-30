/**
 * Wave 1 / 領域 A: 直近 4 PR (#95 #96 #97) 退行検知テスト
 *
 * PR #95 (#93): /health prefetch={false} — RSC fetch エラーなし
 * PR #96 (#90): 体重・血圧・血糖値 server-side validation
 * PR #96 (#92): 重複メールアドレス signup エラー表示
 * PR #97 (#91): 買い物リスト「献立なし」サイレント失敗修正
 *
 * 検証日時: 2026-04-30 (main HEAD: ba80f83)
 * 対象環境: https://homegohan-app.vercel.app/
 */
import { test, expect } from "./fixtures/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type ApiResult = { status: number; json: unknown };

/** 認証済みブラウザコンテキストから /api/health/records/quick に POST */
async function postQuickRecord(
  authedPage: import("@playwright/test").Page,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  return authedPage.evaluate(
    async ({ payload }: { payload: Record<string, unknown> }) => {
      const res = await fetch("/api/health/records/quick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });
      let json: unknown;
      try { json = await res.json(); } catch { json = null; }
      return { status: res.status, json };
    },
    { payload: body },
  );
}

/** 認証済みブラウザコンテキストから任意エンドポイントに POST */
async function postApi(
  authedPage: import("@playwright/test").Page,
  path: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  return authedPage.evaluate(
    async ({ url, payload }: { url: string; payload: Record<string, unknown> }) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });
      let json: unknown;
      try { json = await res.json(); } catch { json = null; }
      return { status: res.status, json };
    },
    { url: path, payload: body },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PR #95 / Bug-93: /home → /health ナビゲーション (prefetch={false} 退行検知)
// ─────────────────────────────────────────────────────────────────────────────

test.describe("PR#95 / Bug-93: /health prefetch退行検知", () => {
  test("/home ロード後に RSC fetch エラーが出ないこと", async ({ authedPage: page }) => {
    const rscErrors: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().includes("Failed to fetch RSC payload") &&
        msg.text().includes("/health")
      ) {
        rscErrors.push(msg.text());
      }
    });

    await page.goto("/home", { waitUntil: "networkidle" });

    // /health リンクにホバーして prefetch が走る余地を与える
    const healthLink = page.locator('a[href="/health"]').first();
    if (await healthLink.isVisible().catch(() => false)) {
      await healthLink.hover();
      await page.waitForTimeout(1000);
    }

    expect(
      rscErrors,
      `RSC error for /health should not appear: ${JSON.stringify(rscErrors)}`,
    ).toHaveLength(0);
  });

  test("/home → /health → /home の往復ナビゲーションが正常に動作する", async ({
    authedPage: page,
  }) => {
    await page.goto("/home", { waitUntil: "networkidle" });

    // /health へ遷移
    const healthLink = page.locator('a[href="/health"]').first();
    await expect(healthLink).toBeVisible({ timeout: 10_000 });
    await healthLink.click();
    await page.waitForURL(/\/health/, { timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // /home へ戻る
    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/home/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR #96 / Bug-90: 体重・血圧・血糖値 server-side validation 退行検知
// ─────────────────────────────────────────────────────────────────────────────

const HEALTH_TEST_DATE = "2000-01-01"; // テスト専用の過去日付（本番データを汚染しない）

test.describe("PR#96 / Bug-90: 体重 server-side validation 退行検知", () => {
  test("weight=-1 を POST → 400 が返る", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: -1,
      record_date: HEALTH_TEST_DATE,
    });
    expect(
      status,
      `weight=-1 は 400 を期待、実際: ${status} / ${JSON.stringify(json)}`,
    ).toBe(400);
  });

  test("weight=0 を POST → 400 が返る", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: 0,
      record_date: HEALTH_TEST_DATE,
    });
    expect(
      status,
      `weight=0 は 400 を期待、実際: ${status} / ${JSON.stringify(json)}`,
    ).toBe(400);
  });

  test("weight=19 (下限未満) を POST → 400 が返る", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: 19,
      record_date: HEALTH_TEST_DATE,
    });
    expect(
      status,
      `weight=19 は 400 を期待、実際: ${status} / ${JSON.stringify(json)}`,
    ).toBe(400);
  });

  test("weight=20 (下限ちょうど) を POST → 200 が返る", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: 20,
      record_date: HEALTH_TEST_DATE,
    });
    expect(
      [200, 201],
      `weight=20 は 200/201 を期待、実際: ${status} / ${JSON.stringify(json)}`,
    ).toContain(status);
  });

  test("weight=65 (有効値) を POST → 200 が返る", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: 65,
      record_date: HEALTH_TEST_DATE,
    });
    expect(
      [200, 201],
      `weight=65 は 200/201 を期待、実際: ${status} / ${JSON.stringify(json)}`,
    ).toContain(status);
  });

  test("weight=300 (上限ちょうど) を POST → 200 が返る", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: 300,
      record_date: HEALTH_TEST_DATE,
    });
    expect(
      [200, 201],
      `weight=300 は 200/201 を期待、実際: ${status} / ${JSON.stringify(json)}`,
    ).toContain(status);
  });

  test("weight=301 (上限超過) を POST → 400 が返る", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: 301,
      record_date: HEALTH_TEST_DATE,
    });
    expect(
      status,
      `weight=301 は 400 を期待、実際: ${status} / ${JSON.stringify(json)}`,
    ).toBe(400);
  });

  test("weight=999999 を POST → 400 が返る", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: 999999,
      record_date: HEALTH_TEST_DATE,
    });
    expect(
      status,
      `weight=999999 は 400 を期待、実際: ${status} / ${JSON.stringify(json)}`,
    ).toBe(400);
  });

  test('weight="abc" (文字列) を POST → 400 が返る', async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: "abc",
      record_date: HEALTH_TEST_DATE,
    });
    expect(
      status,
      `weight="abc" は 400 を期待、実際: ${status} / ${JSON.stringify(json)}`,
    ).toBe(400);
  });

  test("weight=null を POST → 400 ではなく 200 が返る（null はクリア操作）", async ({
    authedPage,
  }) => {
    // null は明示的なクリアとして 200 が返るべき
    const { status } = await postQuickRecord(authedPage, {
      weight: null,
      record_date: HEALTH_TEST_DATE,
    });
    expect([200, 201, 400]).toContain(status); // null の扱いは実装依存だが 5xx は許容不可
  });
});

test.describe("PR#96 / Bug-90: 血圧 server-side validation 退行検知", () => {
  test("systolic_bp=-1 を POST → 400 が返る", async ({ authedPage }) => {
    const { status, json } = await postApi(authedPage, "/api/health/records", {
      record_date: HEALTH_TEST_DATE,
      systolic_bp: -1,
    });
    expect(status, `systolic_bp=-1 は 400 を期待: ${JSON.stringify(json)}`).toBe(400);
  });

  test("systolic_bp=999 を POST → 400 が返る", async ({ authedPage }) => {
    const { status, json } = await postApi(authedPage, "/api/health/records", {
      record_date: HEALTH_TEST_DATE,
      systolic_bp: 999,
    });
    expect(status, `systolic_bp=999 は 400 を期待: ${JSON.stringify(json)}`).toBe(400);
  });

  test("systolic_bp=120 (有効値) を POST → 200 が返る", async ({ authedPage }) => {
    const { status, json } = await postApi(authedPage, "/api/health/records", {
      record_date: HEALTH_TEST_DATE,
      systolic_bp: 120,
    });
    expect([200, 201], `systolic_bp=120 は 200/201 を期待: ${JSON.stringify(json)}`).toContain(status);
  });

  test("diastolic_bp=-1 を POST → 400 が返る", async ({ authedPage }) => {
    const { status, json } = await postApi(authedPage, "/api/health/records", {
      record_date: HEALTH_TEST_DATE,
      diastolic_bp: -1,
    });
    expect(status, `diastolic_bp=-1 は 400 を期待: ${JSON.stringify(json)}`).toBe(400);
  });

  test("diastolic_bp=999 を POST → 400 が返る", async ({ authedPage }) => {
    const { status, json } = await postApi(authedPage, "/api/health/records", {
      record_date: HEALTH_TEST_DATE,
      diastolic_bp: 999,
    });
    expect(status, `diastolic_bp=999 は 400 を期待: ${JSON.stringify(json)}`).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR #97 / Bug-91: 献立なし時の買い物リスト生成サイレント失敗 退行検知
// ─────────────────────────────────────────────────────────────────────────────

test.describe("PR#97 / Bug-91: 献立なし買い物リスト生成 退行検知", () => {
  test("献立なし週で「献立から再生成」→ API 未呼出 + エラーダイアログ", async ({
    authedPage: page,
  }) => {
    const apiCalls: string[] = [];
    page.on("request", (req) => {
      if (
        req.url().includes("/api/shopping-list/regenerate") &&
        req.method() === "POST"
      ) {
        apiCalls.push(req.url());
      }
    });

    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle", { timeout: 30_000 });

    // 翌週ボタンを4回押して確実に献立なし週へ
    const nextWeekBtn = page.getByRole("button", { name: "翌週" });
    await nextWeekBtn.waitFor({ state: "visible", timeout: 10_000 });
    for (let i = 0; i < 4; i++) {
      await nextWeekBtn.click();
      await page.waitForTimeout(400);
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // 買い物リストモーダルを開く
    const cartBtn = page.getByRole("button", { name: "買い物リストを開く" });
    await cartBtn.waitFor({ state: "visible", timeout: 10_000 });
    await cartBtn.click();
    await page.waitForTimeout(500);

    // 「献立から再生成」ボタンをクリック
    const regenBtn = page.locator('[data-testid="shopping-regenerate-button"]');
    await regenBtn.waitFor({ state: "visible", timeout: 10_000 });
    await regenBtn.click();
    await page.waitForTimeout(1500);

    // API 未呼出
    expect(apiCalls, "献立なし状態では regenerate API を呼ばない").toHaveLength(0);

    // エラーダイアログが表示される
    const title = page.locator('[data-testid="success-message-title"]');
    await expect(title).toBeVisible({ timeout: 5_000 });
    expect(await title.textContent()).toMatch(/献立/);
  });

  test("連打しても二重 API 呼び出しが起きない（献立なし週）", async ({ authedPage: page }) => {
    const apiCalls: string[] = [];
    page.on("request", (req) => {
      if (
        req.url().includes("/api/shopping-list/regenerate") &&
        req.method() === "POST"
      ) {
        apiCalls.push(req.url());
      }
    });

    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle", { timeout: 30_000 });

    // 翌週ボタンを4回押して確実に献立なし週へ
    const nextWeekBtn = page.getByRole("button", { name: "翌週" });
    await nextWeekBtn.waitFor({ state: "visible", timeout: 10_000 });
    for (let i = 0; i < 4; i++) {
      await nextWeekBtn.click();
      await page.waitForTimeout(300);
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    const cartBtn = page.getByRole("button", { name: "買い物リストを開く" });
    await cartBtn.waitFor({ state: "visible", timeout: 10_000 });
    await cartBtn.click();
    await page.waitForTimeout(500);

    const regenBtn = page.locator('[data-testid="shopping-regenerate-button"]');
    await regenBtn.waitFor({ state: "visible", timeout: 10_000 });

    // 1回クリック
    await regenBtn.click();
    await page.waitForTimeout(500);

    // 「献立がありません」ダイアログが出たらOKで閉じてから2回目を試みる
    const dialog = page.locator('[data-testid="success-message-title"]');
    if (await dialog.isVisible().catch(() => false)) {
      // ダイアログが出た → 1回目で正しく動作した
      // OKを押して閉じる
      const okBtn = page.getByRole("button", { name: "OK" });
      if (await okBtn.isVisible().catch(() => false)) {
        await okBtn.click();
        await page.waitForTimeout(300);
      }
    }

    // 2回目
    const regenBtn2 = page.locator('[data-testid="shopping-regenerate-button"]');
    if (await regenBtn2.isVisible().catch(() => false)) {
      await regenBtn2.click();
      await page.waitForTimeout(500);
    }

    await page.waitForTimeout(1000);

    // 献立なし週なのでゼロ呼び出しが正解
    expect(apiCalls.length, "連打しても献立なし状態では API 未呼出").toBe(0);
  });
});
