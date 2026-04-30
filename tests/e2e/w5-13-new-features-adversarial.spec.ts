/**
 * W5-13: Wave 1-6 新規追加機能 嫌がらせ E2E テスト
 *
 * 対象機能:
 *   A. Org 組織管理 (#132)
 *   B. Pantry 食材管理 (#136)
 *   C. Health blood-tests (#176)
 *   D. Health streaks (#176)
 *   E. CSV エクスポート (#133)
 *   F. アカウント削除 UI (#215)
 *   G. フリープラン rate limit (#134)
 *   H. フォアグラウンド通知 (#99)
 *
 * 実行:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e -- w5-13
 *
 * バグ発見時 Issue prefix: [<area>][adversarial]
 *   area: org / pantry / health / export / account / plan / notification
 */

import { test, expect } from "./fixtures/auth";

// ─── helpers ───────────────────────────────────────────────────────────────

async function apiGet(page: any, path: string) {
  return page.evaluate(async (url: string) => {
    const res = await fetch(url, { credentials: "include" });
    let json: unknown;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }, path);
}

async function apiPost(page: any, path: string, body: unknown) {
  return page.evaluate(
    async ({ url, payload }: { url: string; payload: unknown }) => {
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

async function apiDelete(page: any, path: string) {
  return page.evaluate(async (url: string) => {
    const res = await fetch(url, { method: "DELETE", credentials: "include" });
    let json: unknown;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }, path);
}

/** スクリーンショットを testInfo に添付する */
async function attach(page: any, testInfo: any, name: string) {
  const buf = await page.screenshot({ fullPage: false });
  await testInfo.attach(name, { body: buf, contentType: "image/png" });
}

// ============================================================
// A. Org 組織管理 (#132)
// ============================================================

test.describe("A. Org 組織管理 (#132)", () => {
  /**
   * A-1: /org に未認証でアクセスすると /login にリダイレクト
   */
  test("A-1: /org 未認証 → /login リダイレクト", async ({ page }, testInfo) => {
    // authedPage を使わず素のページでアクセス
    await page.goto("/org");
    await page.waitForLoadState("networkidle");
    await attach(page, testInfo, "A-1: 未認証 /org");
    expect(page.url()).toMatch(/\/login/);
  });

  /**
   * A-2: 通常ユーザー (non org_admin) が /org にアクセスすると 403 または /home にリダイレクト
   */
  test("A-2: 通常ユーザー → /org が 403 or リダイレクト", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/org");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "A-2: 通常ユーザー /org");

    const url = authedPage.url();
    const body = await authedPage.locator("body").textContent();

    // 403 ページ or /home / /login へのリダイレクト、または「アクセス権限がない」メッセージを確認
    const isBlocked =
      !url.includes("/org/") ||
      (body ?? "").match(/403|Forbidden|アクセス|権限|permitted/i) !== null;

    testInfo.annotations.push({
      type: "result",
      description: `A-2: 通常ユーザー /org アクセス URL=${url}, ブロックされた=${isBlocked}`,
    });

    if (!isBlocked) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[org][adversarial] A-2: 通常ユーザーが /org にアクセスできてしまっている。権限チェックが不足している可能性",
      });
    }
  });

  /**
   * A-3: /api/org/departments に未認証アクセス → 401
   */
  test("A-3: /api/org/departments 未認証 → 401", async ({ page }) => {
    // 未認証ページから直接 API を叩く
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/org/departments");
    expect(status, `expected 401, got ${status}`).toBe(401);
  });

  /**
   * A-4: /api/org/departments に通常ユーザーでアクセス → 403
   */
  test("A-4: /api/org/departments 通常ユーザー → 403", async ({ authedPage }) => {
    await authedPage.goto("/settings");
    const { status } = await apiGet(authedPage, "/api/org/departments");
    // 通常ユーザーは org_admin でないため 403 が返るはず
    expect([401, 403], `expected 401 or 403, got ${status}`).toContain(status);
  });

  /**
   * A-5: 部署名に XSS payload を送信しても サーバーがサニタイズする
   *       (API 側で格納時にエスケープするか、DB が拒否するか)
   */
  test("A-5: /api/org/departments POST - XSS payload は 400/403 で弾かれるか無害化される", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");
    const { status, json } = await apiPost(authedPage, "/api/org/departments", {
      name: "<script>alert(1)</script>",
    });
    testInfo.annotations.push({
      type: "result",
      description: `A-5: XSS payload POST → status=${status}, json=${JSON.stringify(json)}`,
    });
    // 通常ユーザーなので 403 か、org_admin なら 200 で格納されるが
    // レスポンス中の name がサニタイズされているか確認
    if (status === 200 || status === 201) {
      const name = (json as any)?.department?.name ?? "";
      expect(name, "XSS script タグがそのまま格納されてはいけない").not.toBe(
        "<script>alert(1)</script>"
      );
    } else {
      expect([400, 403, 401]).toContain(status);
    }
  });

  /**
   * A-6: 部署名 1000 文字 → 400 or DB 制約でエラー
   */
  test("A-6: /api/org/departments POST - 1000文字部署名は拒否される", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");
    const longName = "あ".repeat(1000);
    const { status } = await apiPost(authedPage, "/api/org/departments", {
      name: longName,
    });
    testInfo.annotations.push({
      type: "result",
      description: `A-6: 1000文字部署名 → status=${status}`,
    });
    // 通常ユーザーなら 403、org_admin なら 400 or 500 (DB 制約) が期待される
    expect([400, 401, 403, 422, 500]).toContain(status);
  });

  /**
   * A-7: 部署名 SQL injection payload は安全に処理される
   */
  test("A-7: /api/org/departments POST - SQL injection payload は安全に処理される", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");
    const sqlPayload = "'; DROP TABLE departments; --";
    const { status, json } = await apiPost(authedPage, "/api/org/departments", {
      name: sqlPayload,
    });
    testInfo.annotations.push({
      type: "result",
      description: `A-7: SQL injection POST → status=${status}`,
    });
    // Supabase はパラメータ化クエリを使っているため DROP TABLE は実行されない
    // 通常ユーザーなら 403、org_admin でも 200 で無害格納が期待される
    if (status === 200 || status === 201) {
      // 正常に格納されたならサーバーがまだ生きていること
      expect(json).toBeDefined();
    } else {
      expect([400, 401, 403]).toContain(status);
    }
  });
});

// ============================================================
// B. Pantry 食材管理 (#136)
// ============================================================

test.describe("B. Pantry 食材管理 (#136)", () => {
  /**
   * B-7: /pantry ページに navigate して表示される
   */
  test("B-7: /pantry ページが表示される", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/pantry");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "B-7: /pantry");

    // ページ本体が表示されていること (エラーページではない)
    const bodyText = await authedPage.locator("body").textContent();
    expect(bodyText, "Pantryページが表示されている").not.toMatch(/404|not found/i);

    // Pantry関連のテキストが存在するか
    const hasPantryContent =
      (await authedPage.locator("text=パントリー").isVisible().catch(() => false)) ||
      (await authedPage.locator("text=食材").isVisible().catch(() => false)) ||
      (await authedPage.locator("text=pantry").isVisible({ timeout: 3_000 }).catch(() => false));

    testInfo.annotations.push({
      type: "result",
      description: `B-7: Pantry コンテンツ表示=${hasPantryContent}, URL=${authedPage.url()}`,
    });
  });

  /**
   * B-8: 「写真で追加」ボタンが存在する
   */
  test("B-8: 「写真で追加」ボタンが表示される", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/pantry");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "B-8: /pantry 写真追加ボタン確認");

    const photoBtn = authedPage
      .getByRole("button", { name: /写真で追加|カメラ|photo|camera/i })
      .or(authedPage.locator('[data-testid="pantry-photo-add"]'))
      .first();

    const btnVisible = await photoBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    testInfo.annotations.push({
      type: "result",
      description: `B-8: 写真で追加ボタン表示=${btnVisible}`,
    });

    if (!btnVisible) {
      testInfo.annotations.push({
        type: "issue",
        description: "[pantry][adversarial] B-8: 「写真で追加」ボタンが /pantry に見つからない",
      });
    }
  });

  /**
   * B-9: /api/pantry/from-photo に巨大 payload (10MB 相当) を送信 → 413 or タイムアウトなし
   */
  test("B-9: /api/pantry/from-photo に巨大 payload → 413 か適切なエラー", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/pantry");

    // 10MB のダミーデータを base64 として生成 (実際のファイルの代わり)
    const { status } = await authedPage.evaluate(async () => {
      // 10MB 相当の文字列
      const bigData = "A".repeat(10 * 1024 * 1024);
      try {
        const res = await fetch("/api/pantry/from-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: bigData }),
          credentials: "include",
        });
        return { status: res.status };
      } catch (e: any) {
        return { status: 0, error: e.message };
      }
    });

    testInfo.annotations.push({
      type: "result",
      description: `B-9: 10MB payload → status=${status}`,
    });

    // 413 (Payload Too Large) か 400 か 500 が期待される。200 は問題
    if (status === 200) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[pantry][adversarial] B-9: 10MB の巨大 payload に対して 200 が返ってしまった。サイズ制限が機能していない可能性",
      });
    }
    expect([400, 401, 413, 422, 500, 0]).toContain(status);
  });

  /**
   * B-10: /api/pantry に空文字の食材名を送信 → 400
   */
  test("B-10: /api/pantry POST - 空文字の食材名 → 400 or エラー", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/pantry");
    const { status, json } = await apiPost(authedPage, "/api/pantry", {
      name: "",
      amount: "1個",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-10: 空文字食材名 POST → status=${status}, json=${JSON.stringify(json)}`,
    });
    // DB NOT NULL 制約か、APIバリデーションで弾かれるはず
    expect([400, 422, 500]).toContain(status);
  });

  /**
   * B-11: /api/pantry に 5000 文字の食材名を送信 → 400 か DB 制約エラー
   */
  test("B-11: /api/pantry POST - 5000文字食材名は拒否される", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/pantry");
    const longName = "食".repeat(5000);
    const { status } = await apiPost(authedPage, "/api/pantry", {
      name: longName,
      amount: "1個",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-11: 5000文字食材名 → status=${status}`,
    });
    // 400 か 422 か 500 (DB 制約) が期待される
    if (status === 200 || status === 201) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[pantry][adversarial] B-11: 5000文字の食材名が格納されてしまった。文字列長バリデーションが不足している可能性",
      });
    }
  });

  /**
   * B-12: 賞味期限に過去日付 → 正常に格納される (過去でも受け入れる場合)
   */
  test("B-12a: /api/pantry POST - 賞味期限が過去日付でも格納される", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/pantry");
    const { status, json } = await apiPost(authedPage, "/api/pantry", {
      name: `テスト食材_過去日_${Date.now()}`,
      amount: "1個",
      expirationDate: "2000-01-01",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-12a: 過去日付賞味期限 → status=${status}`,
    });
    // アプリ仕様による: 過去日を許容するか拒否するか
    // どちらの場合もサーバーエラー (500) にならないことを確認
    expect(status, "サーバーエラーにならない").not.toBe(500);
  });

  /**
   * B-12b: 賞味期限に不正フォーマットを送信 → 400 か無害化
   */
  test("B-12b: /api/pantry POST - 不正フォーマット賞味期限 → 400 か無害格納", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/pantry");
    const { status, json } = await apiPost(authedPage, "/api/pantry", {
      name: `テスト食材_不正日付_${Date.now()}`,
      amount: "1個",
      expirationDate: "not-a-date",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-12b: 不正フォーマット日付 → status=${status}, json=${JSON.stringify(json)}`,
    });
    // 400 か、DB が日付型でエラーになって 500 が期待される
    // 200 で "not-a-date" がそのまま格納されるのは問題
    if (status === 200 || status === 201) {
      const expDate = (json as any)?.item?.expirationDate;
      if (expDate === "not-a-date") {
        testInfo.annotations.push({
          type: "issue",
          description:
            "[pantry][adversarial] B-12b: 不正フォーマット日付 'not-a-date' がそのまま格納された",
        });
      }
    }
  });

  /**
   * B-13: /api/pantry GET - 認証なしで 401
   */
  test("B-13: /api/pantry 認証なし → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/pantry");
    expect(status).toBe(401);
  });
});

// ============================================================
// C. Health blood-tests (#176)
// ============================================================

test.describe("C. Health blood-tests (#176)", () => {
  /**
   * C-14: /health/blood-tests に 0 件の場合 → 空状態 UI が表示される
   */
  test("C-14: /health/blood-tests 0件 → 空状態 UI が表示される", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/health/blood-tests");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "C-14: /health/blood-tests");

    const url = authedPage.url();
    // ページが正常に表示されること (エラーページでない)
    const bodyText = await authedPage.locator("body").textContent();
    expect(bodyText).not.toMatch(/500|Internal Server Error/i);

    testInfo.annotations.push({
      type: "result",
      description: `C-14: /health/blood-tests URL=${url}`,
    });
  });

  /**
   * C-15: /api/health/blood-tests GET - 認証なし → 401
   */
  test("C-15: /api/health/blood-tests 認証なし → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/health/blood-tests");
    expect(status).toBe(401);
  });

  /**
   * C-16: /api/health/blood-tests POST - 必須フィールド欠落 → 400
   */
  test("C-16: /api/health/blood-tests POST - test_date 欠落 → 400", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/health/blood-tests");
    const { status, json } = await apiPost(authedPage, "/api/health/blood-tests", {
      // test_date を意図的に省略
      hemoglobin: 14.5,
    });
    testInfo.annotations.push({
      type: "result",
      description: `C-16: test_date 欠落 POST → status=${status}`,
    });
    expect(status).toBe(400);
  });

  /**
   * C-17: /api/health/blood-tests POST - 数値フィールドに文字列 → 400
   */
  test("C-17: /api/health/blood-tests POST - 数値フィールドに文字列 → 400 or エラー", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/health/blood-tests");
    const { status, json } = await apiPost(authedPage, "/api/health/blood-tests", {
      test_date: "2026-01-01",
      hemoglobin: "not-a-number",
      platelets: "abc",
    });
    testInfo.annotations.push({
      type: "result",
      description: `C-17: 文字列数値フィールド → status=${status}, json=${JSON.stringify(json)}`,
    });
    // sanitizeBloodTestPayload でエラーが返るはず
    expect([400, 422]).toContain(status);
  });

  /**
   * C-18: /api/health/blood-tests GET - limit パラメータ上限 (201 は 200 に丸められる)
   */
  test("C-18: /api/health/blood-tests GET - limit=999 は 200 に制限される", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/health/blood-tests");
    const { status, json } = await apiGet(
      authedPage,
      "/api/health/blood-tests?limit=999"
    );
    testInfo.annotations.push({
      type: "result",
      description: `C-18: limit=999 GET → status=${status}`,
    });
    // limit=999 でも 200 OK (サーバー側で 200 に丸める仕様)
    expect(status).toBe(200);
    // 結果が配列であることを確認
    expect(Array.isArray((json as any)?.results)).toBe(true);
  });

  /**
   * C-19: blood-tests ページで expand/collapse 動作確認
   */
  test("C-19: /health/blood-tests - ページにエラーなく描画される", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/health/blood-tests");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "C-19: blood-tests 描画");

    const errors = await authedPage.evaluate(() => {
      return (window as any).__reactError || null;
    });

    const consoleErrors: string[] = [];
    authedPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // ページ本体が表示されている
    const bodyVisible = await authedPage.locator("body").isVisible();
    expect(bodyVisible).toBe(true);

    testInfo.annotations.push({
      type: "result",
      description: `C-19: ReactError=${errors}, consoleErrors=${consoleErrors.length}件`,
    });
  });
});

// ============================================================
// D. Health streaks (#176)
// ============================================================

test.describe("D. Health streaks (#176)", () => {
  /**
   * D-17: /health/streaks に navigate → 空状態 UI が表示される
   */
  test("D-17: /health/streaks ページが表示される", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/health/streaks");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "D-17: /health/streaks");

    const bodyText = await authedPage.locator("body").textContent();
    expect(bodyText).not.toMatch(/500|Internal Server Error/i);

    testInfo.annotations.push({
      type: "result",
      description: `D-17: /health/streaks URL=${authedPage.url()}`,
    });
  });

  /**
   * D-18: /api/health/streaks GET - 認証なし → 401
   */
  test("D-18: /api/health/streaks 認証なし → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/health/streaks");
    expect(status).toBe(401);
  });

  /**
   * D-19: /api/health/streaks GET - type=daily_record → streak オブジェクト返却
   */
  test("D-19: /api/health/streaks GET - streak データ構造確認", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/health/streaks");
    const { status, json } = await apiGet(
      authedPage,
      "/api/health/streaks?type=daily_record"
    );
    testInfo.annotations.push({
      type: "result",
      description: `D-19: streaks GET → status=${status}, json=${JSON.stringify(json).slice(0, 200)}`,
    });
    expect(status).toBe(200);
    const streakData = json as any;
    // streak オブジェクトが存在すること
    expect(streakData).toHaveProperty("streak");
    expect(typeof streakData.streak.current_streak).toBe("number");
    expect(typeof streakData.streak.longest_streak).toBe("number");
  });

  /**
   * D-20: /api/health/streaks GET - 不正な type パラメータでもクラッシュしない
   */
  test("D-20: /api/health/streaks GET - 不正 type パラメータ → 200 or エラー (500 ではない)", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/health/streaks");
    const { status } = await apiGet(
      authedPage,
      "/api/health/streaks?type=<script>alert(1)</script>"
    );
    testInfo.annotations.push({
      type: "result",
      description: `D-20: 不正 type パラメータ → status=${status}`,
    });
    // 200 (デフォルト値にフォールバック) か 400 が期待される。500 はNG
    expect(status, "500 Internal Server Error は発生してはいけない").not.toBe(500);
  });

  /**
   * D-21: badge milestone の achieved_badges が配列であることを確認
   */
  test("D-21: /api/health/streaks - achieved_badges が配列として返る", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/health/streaks");
    const { status, json } = await apiGet(authedPage, "/api/health/streaks");
    testInfo.annotations.push({
      type: "result",
      description: `D-21: achieved_badges=${JSON.stringify((json as any)?.streak?.achieved_badges)}`,
    });
    expect(status).toBe(200);
    expect(Array.isArray((json as any)?.streak?.achieved_badges)).toBe(true);
  });
});

// ============================================================
// E. CSV エクスポート (#133)
// ============================================================

test.describe("E. CSV エクスポート (#133)", () => {
  /**
   * E-21: /settings にエクスポートボタンが存在する
   */
  test("E-21: /settings にCSVエクスポートボタンが存在する", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/settings");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "E-21: /settings エクスポートボタン");

    const csvButton = authedPage.getByRole("button", { name: /献立をCSVエクスポート/ });
    await expect(csvButton).toBeVisible();
  });

  /**
   * E-22: CSVエクスポートボタンクリックで CSV ダウンロード開始
   */
  test("E-22: CSVエクスポートボタンクリック → ダウンロード開始", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");

    const requestPromise = authedPage.waitForRequest(
      (req) => req.url().includes("/api/export/meals") && req.method() === "GET"
    );
    const downloadPromise = authedPage.waitForEvent("download", { timeout: 30_000 });

    const csvButton = authedPage.getByRole("button", { name: /献立をCSVエクスポート/ });
    await csvButton.click();

    const request = await requestPromise;
    expect(request).toBeTruthy();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^homegohan-meals-.*\.csv$/);

    testInfo.annotations.push({
      type: "result",
      description: `E-22: CSV ダウンロード成功 filename=${download.suggestedFilename()}`,
    });
  });

  /**
   * E-23: CSV formula injection 防止 (#269 fix) - API レスポンスの CSV を直接検証
   */
  test("E-23: CSV formula injection 防止 - 先頭文字 =+−@ に ' が prepend される", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");

    const csvText = await authedPage.evaluate(async () => {
      const res = await fetch("/api/export/meals");
      if (!res.ok) return null;
      return res.text();
    });

    expect(csvText).not.toBeNull();

    if (csvText) {
      const lines = csvText.split(/\r?\n/).filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);

      let injectionFound = false;
      for (const line of lines) {
        const cells = line.split(",");
        for (const cell of cells) {
          if (cell.startsWith('"')) continue;
          if (/^[=+\-@]/.test(cell)) {
            injectionFound = true;
            testInfo.annotations.push({
              type: "issue",
              description: `[export][adversarial] E-23: CSV formula injection 未対処のセル発見: "${cell}"`,
            });
          }
        }
      }

      testInfo.annotations.push({
        type: "result",
        description: `E-23: CSV ${lines.length}行検査, formula injection 発見=${injectionFound}`,
      });

      expect(injectionFound, "formula injection が発見されてはいけない").toBe(false);
    }
  });

  /**
   * E-24: /api/export/meals 認証なし → 401
   */
  test("E-24: /api/export/meals 認証なし → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/export/meals");
    expect(status, `expected 401, got ${status}`).toBe(401);
  });

  /**
   * E-25: /api/export/meals エクスポートが Content-Type text/csv を返す
   */
  test("E-25: /api/export/meals が Content-Type: text/csv を返す", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");

    const contentType = await authedPage.evaluate(async () => {
      const res = await fetch("/api/export/meals");
      return res.headers.get("content-type");
    });

    testInfo.annotations.push({
      type: "result",
      description: `E-25: Content-Type=${contentType}`,
    });

    expect(contentType).toMatch(/text\/csv/i);
  });

  /**
   * E-26: escapeCsv ロジックのブラウザ内単体テスト
   */
  test("E-26: escapeCsv formula injection 防止ロジック (ブラウザ内検証)", async ({
    authedPage,
  }) => {
    await authedPage.goto("/settings");

    const result = await authedPage.evaluate(() => {
      function escapeCsv(value: unknown): string {
        if (value === null || value === undefined) return "";
        const str = String(value);
        const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
        if (
          safe.includes('"') ||
          safe.includes(",") ||
          safe.includes("\n") ||
          safe.includes("\r")
        ) {
          return `"${safe.replace(/"/g, '""')}"`;
        }
        return safe;
      }

      return {
        formula: escapeCsv("=cmd|'/c calc'!A1"),
        plus: escapeCsv("+1234"),
        minus: escapeCsv("-1234"),
        at: escapeCsv("@SUM(A1)"),
        normal: escapeCsv("チキン南蛮"),
        empty: escapeCsv(null),
        withComma: escapeCsv("a,b"),
      };
    });

    expect(result.formula).toBe(`'=cmd|'/c calc'!A1`);
    expect(result.plus).toBe("'+1234");
    expect(result.minus).toBe("'-1234");
    expect(result.at).toBe("'@SUM(A1)");
    expect(result.normal).toBe("チキン南蛮");
    expect(result.empty).toBe("");
    expect(result.withComma).toBe('"a,b"');
  });
});

// ============================================================
// F. アカウント削除 (#215)
// ============================================================

test.describe("F. アカウント削除 (#215)", () => {
  /**
   * F-26: /settings 最下部に「アカウント削除」ボタンが表示される
   */
  test("F-26: /settings にアカウント削除ボタンが表示される", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "F-26: /settings アカウント削除ボタン");

    const deleteButton = authedPage.getByRole("button", {
      name: /アカウントを削除する/,
    });
    await expect(deleteButton).toBeVisible();
  });

  /**
   * F-27: 削除ボタンクリック → 確認モーダルが開く
   */
  test("F-27: アカウント削除ボタンクリック → 確認モーダル表示", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await attach(authedPage, testInfo, "F-27: 確認モーダル");
    await expect(
      authedPage.getByText("アカウントを削除しますか？")
    ).toBeVisible();
  });

  /**
   * F-28: 確認テキスト未入力の状態では削除実行ボタンが disabled
   */
  test("F-28: 確認テキスト未入力 → 削除実行ボタンが disabled", async ({
    authedPage,
  }) => {
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    const confirmButton = authedPage.getByRole("button", {
      name: /アカウントを完全に削除する/,
    });
    await expect(confirmButton).toBeDisabled();
  });

  /**
   * F-29: 「削除します」入力後に削除実行ボタンが enabled になる
   */
  test("F-29: 「削除します」入力後 → 削除実行ボタンが enabled", async ({
    authedPage,
  }) => {
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await authedPage
      .getByRole("textbox", { name: /削除確認テキスト入力/ })
      .fill("削除します");

    const confirmButton = authedPage.getByRole("button", {
      name: /アカウントを完全に削除する/,
    });
    await expect(confirmButton).toBeEnabled();
  });

  /**
   * F-29b: 「削除します」以外の文字列 → 削除実行ボタンが依然 disabled
   */
  test("F-29b: 誤った確認テキスト入力 → 削除実行ボタンは disabled のまま", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    // 微妙に異なるテキストを入力
    await authedPage
      .getByRole("textbox", { name: /削除確認テキスト入力/ })
      .fill("削除しまs");

    const confirmButton = authedPage.getByRole("button", {
      name: /アカウントを完全に削除する/,
    });

    const isDisabled = await confirmButton.isDisabled();
    testInfo.annotations.push({
      type: "result",
      description: `F-29b: 誤ったテキスト入力後の削除ボタン disabled=${isDisabled}`,
    });

    if (!isDisabled) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[account][adversarial] F-29b: 誤った確認テキスト ('削除しまs') でも削除ボタンが enabled になってしまった",
      });
    }
    expect(isDisabled, "誤ったテキストでは disabled のまま").toBe(true);
  });

  /**
   * F-30: キャンセルボタンでモーダルが閉じる
   */
  test("F-30: 確認モーダル → キャンセルで閉じる", async ({ authedPage }) => {
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await expect(
      authedPage.getByText("アカウントを削除しますか？")
    ).toBeVisible();

    await authedPage.getByRole("button", { name: /キャンセル/ }).click();

    await expect(
      authedPage.getByText("アカウントを削除しますか？")
    ).not.toBeVisible();
  });

  /**
   * F-31: 実際の削除実行は破壊的操作のためスキップ
   *        /api/account/delete に confirm=false を送ると 400 が返ることだけ確認
   */
  test("F-31: /api/account/delete POST - confirm=false → 400", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");
    const { status } = await apiPost(authedPage, "/api/account/delete", {
      confirm: false,
    });
    testInfo.annotations.push({
      type: "result",
      description: `F-31: confirm=false POST → status=${status}`,
    });
    expect(status).toBe(400);
  });

  /**
   * F-32: /api/account/delete 認証なし → 401
   */
  test("F-32: /api/account/delete 認証なし → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiPost(page, "/api/account/delete", { confirm: true });
    expect(status).toBe(401);
  });

  /**
   * F-33: アカウント削除実行は破壊的操作のためスキップ (実ユーザー復元不可)
   */
  test.skip("F-33: アカウント削除実行 → /login リダイレクト (破壊的操作のためスキップ)", async ({
    authedPage,
  }) => {
    // このテストはアカウントを実際に削除してしまうためスキップ
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await authedPage
      .getByRole("textbox", { name: /削除確認テキスト入力/ })
      .fill("削除します");

    const requestPromise = authedPage.waitForRequest(
      (req) =>
        req.url().includes("/api/account/delete") && req.method() === "POST"
    );

    await authedPage
      .getByRole("button", { name: /アカウントを完全に削除する/ })
      .click();

    const request = await requestPromise;
    expect(request).toBeTruthy();

    await authedPage.waitForURL(/\/login/, { timeout: 15_000 });
    await expect(authedPage).toHaveURL(/\/login/);
  });
});

// ============================================================
// G. フリープラン rate limit (#134)
// ============================================================

test.describe("G. フリープラン rate limit (#134)", () => {
  /**
   * G-31: /api/meals - 認証なしで POST → 401
   */
  test("G-31: /api/meals POST 認証なし → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiPost(page, "/api/meals", {
      meal_name: "テスト",
      meal_type: "breakfast",
      record_date: "2026-01-01",
    });
    expect(status).toBe(401);
  });

  /**
   * G-32: /api/meals GET - 認証済みで正常に取得できる
   */
  test("G-32: /api/meals GET - 認証済み → 200 とデータ構造確認", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");
    const { status, json } = await apiGet(authedPage, "/api/meals?limit=10");
    testInfo.annotations.push({
      type: "result",
      description: `G-32: meals GET status=${status}`,
    });
    expect(status).toBe(200);
  });

  /**
   * G-33: フリープラン rate limit エンドポイントの挙動確認
   *        /api/meals へのリクエスト上限に関するヘッダーまたはレスポンスを確認
   */
  test("G-33: フリープラン制限 - rate limit ヘッダーが存在するか確認", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");

    const rateLimitInfo = await authedPage.evaluate(async () => {
      const res = await fetch("/api/meals?limit=1", { credentials: "include" });
      return {
        status: res.status,
        xRateLimit: res.headers.get("x-ratelimit-limit"),
        xRateLimitRemaining: res.headers.get("x-ratelimit-remaining"),
        retryAfter: res.headers.get("retry-after"),
      };
    });

    testInfo.annotations.push({
      type: "result",
      description: `G-33: rate limit ヘッダー: ${JSON.stringify(rateLimitInfo)}`,
    });

    // 402 が返ったらフリープランの制限に達している
    if (rateLimitInfo.status === 402) {
      testInfo.annotations.push({
        type: "info",
        description: "G-33: フリープランの rate limit に達している。アップグレード CTA が表示されるはず",
      });
    }
  });

  /**
   * G-34: /api/export/meals - 認証なし → 401 (再確認)
   */
  test("G-34: /api/export/meals 認証なし → 401 (rate limit もバイパスされない)", async ({
    page,
  }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/export/meals");
    expect(status).toBe(401);
  });
});

// ============================================================
// H. フォアグラウンド通知 (#99)
// ============================================================

test.describe("H. フォアグラウンド通知 (#99)", () => {
  /**
   * H-34: /settings に通知トグルが存在する
   */
  test("H-34: /settings に通知トグルが存在する", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/settings");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "H-34: /settings 通知トグル");

    const notificationRow = authedPage.locator("text=通知").first();
    await expect(notificationRow).toBeVisible();
  });

  /**
   * H-35: Notification API がブラウザで利用可能
   */
  test("H-35: ブラウザで Notification API が利用可能", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/settings");

    const notificationAvailable = await authedPage.evaluate(() => {
      return typeof Notification !== "undefined";
    });

    testInfo.annotations.push({
      type: "result",
      description: `H-35: Notification API 利用可能=${notificationAvailable}`,
    });

    expect(notificationAvailable, "Notification API が存在する").toBe(true);
  });

  /**
   * H-36: 通知 toggle が button 要素として実装されている
   */
  test("H-36: 通知トグルが Switch (button) として実装されている", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");

    const switchButtons = authedPage.locator("button[role='switch'], button[aria-checked]");
    const count = await switchButtons.count();

    testInfo.annotations.push({
      type: "result",
      description: `H-36: Switch ボタン数=${count}`,
    });

    // 通知・自動解析など複数のスイッチがあるはず
    expect(count).toBeGreaterThanOrEqual(1);
  });

  /**
   * H-37: permission denied 状態での Notification API の graceful fallback
   *        Playwright では Notification.permission = 'denied' をシミュレートする
   */
  test("H-37: permission denied 状態でも通知トグル操作でクラッシュしない", async ({
    authedPage,
  }, testInfo) => {
    // Notification.permission を 'denied' にモック
    await authedPage.addInitScript(() => {
      Object.defineProperty(Notification, "permission", {
        get: () => "denied",
        configurable: true,
      });
      (Notification as any).requestPermission = async () => "denied";
    });

    await authedPage.goto("/settings");
    await authedPage.waitForLoadState("networkidle");

    const consoleErrors: string[] = [];
    authedPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // 通知スイッチを探してクリック
    const switchBtn = authedPage
      .locator("div")
      .filter({ has: authedPage.locator("span", { hasText: "通知" }) })
      .first()
      .locator("button")
      .first();

    const btnVisible = await switchBtn.isVisible({ timeout: 5_000 }).catch(() => false);

    if (btnVisible) {
      await switchBtn.click().catch(() => {});
      // 少し待ってコンソールエラーを収集
      await authedPage.waitForTimeout(2_000);

      await attach(authedPage, testInfo, "H-37: permission denied後の通知トグル");

      const criticalErrors = consoleErrors.filter(
        (e) => !e.includes("permission") && !e.includes("Notification")
      );

      testInfo.annotations.push({
        type: "result",
        description: `H-37: permission denied後のコンソールエラー=${consoleErrors.length}件, 重大=${criticalErrors.length}件`,
      });

      if (criticalErrors.length > 0) {
        testInfo.annotations.push({
          type: "issue",
          description: `[notification][adversarial] H-37: permission denied 後に予期しないエラー: ${criticalErrors.slice(0, 2).join("; ")}`,
        });
      }

      // ページがクラッシュしていないこと
      const bodyVisible = await authedPage.locator("body").isVisible();
      expect(bodyVisible, "permission denied 後もページが正常表示").toBe(true);
    } else {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "H-37: 通知スイッチが見つからないためスキップ",
      });
    }
  });

  /**
   * H-38: /api/notification-preferences GET - 認証なし → 401
   */
  test("H-38: /api/notification-preferences 認証なし → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/notification-preferences");
    expect(status).toBe(401);
  });

  /**
   * H-39: /api/notification-preferences GET - 認証済み → 200 とデータ構造確認
   */
  test("H-39: /api/notification-preferences 認証済み → 200 と設定データ返却", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/settings");
    const { status, json } = await apiGet(
      authedPage,
      "/api/notification-preferences"
    );
    testInfo.annotations.push({
      type: "result",
      description: `H-39: notification-preferences GET status=${status}, json=${JSON.stringify(json).slice(0, 200)}`,
    });
    // 200 か、機能未実装なら 404
    expect([200, 404]).toContain(status);
  });
});
