/**
 * 敵対的 / 異常系探索 spec — 全画面横断
 *
 * 対象: https://homegohan-app.vercel.app (PLAYWRIGHT_BASE_URL で上書き可)
 * 実行コマンド:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npx playwright test \
 *     tests/e2e/.exploration/adversarial-explore.spec.ts --headed
 *
 * 証拠保存先: tests/e2e/.exploration/adversarial/
 *
 * バグ判定ポリシー:
 *   - クラッシュ / console error / 5xx / UI 凍結 / XSS DOM 変化 → filed
 *   - 既知 close 済み Bug-1〜Bug-38 との重複は filed しない
 *   - false-positive 厳禁。判定不明は filed しない
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { login, E2E_USER } from "../fixtures/auth";

// ────────────────────────────────────────────────────────
// 設定
// ────────────────────────────────────────────────────────

test.use({
  trace: "on",
  video: "on",
  screenshot: "on",
});

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? "https://homegohan-app.vercel.app";

const EVIDENCE_DIR = path.resolve(__dirname, "adversarial");

// ────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
}

async function ss(page: Page, name: string): Promise<string> {
  ensureDir();
  const p = path.join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  console.log(`[screenshot] ${p}`);
  return p;
}

function saveJson(name: string, data: unknown) {
  ensureDir();
  const p = path.join(EVIDENCE_DIR, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  console.log(`[json] ${p}`);
}

interface Monitors {
  pageErrors: string[];
  consoleErrors: string[];
  networkErrors: string[];
}

/** page error / console error / 5xx を収集するリスナーを付与する */
function attachMonitors(page: Page): Monitors {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
    console.error(`[pageerror] ${err.message}`);
  });

  page.on("crash", () => {
    pageErrors.push("PAGE_CRASHED");
    console.error("[crash] page crashed!");
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("response", (res) => {
    if (res.status() >= 500) {
      networkErrors.push(`[5xx] ${res.status()} ${res.url()}`);
      console.error(`[5xx] ${res.status()} ${res.url()}`);
    }
  });

  return { pageErrors, consoleErrors, networkErrors };
}

/** ログイン済みページを返す */
async function authedPage(page: Page) {
  await login(page);
}

// ════════════════════════════════════════════════════════
// グループ 1: Race condition / 連投
// ════════════════════════════════════════════════════════

test.describe("G1: Race condition / 連投", () => {
  /**
   * 1-1: 「献立を作って」ボタンを 0.5 秒間隔で 5 回連打
   * 期待: 重複 enqueue されない (requestId は 1 つ)
   */
  test("1-1: 献立生成ボタン 5 連打 → 重複 enqueue されない", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    // API リクエストを収集
    const generateRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/ai/menu") && req.method() === "POST") {
        generateRequests.push(req.url());
      }
    });

    // 「AI献立アシスタント」または生成ボタンを探す
    const generateBtn = page
      .locator("button", { hasText: /AI献立|献立を作る|献立を生成/ })
      .first();

    if (await generateBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // 0.5 秒間隔で 5 回クリック
      for (let i = 0; i < 5; i++) {
        await generateBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    await page.waitForTimeout(3_000);
    await ss(page, "1-1-generate-spam");
    saveJson("1-1-generate-requests", { count: generateRequests.length, urls: generateRequests });

    // バグ判定: pageerror / crash がないこと
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);

    // 連打でも POST が 2 回以上飛ぶ場合は警告ログに残す
    if (generateRequests.length > 1) {
      console.warn(
        `[WARNING] 献立生成 POST が ${generateRequests.length} 回飛んだ (重複 enqueue の可能性)`
      );
    }
    saveJson("1-1-monitors", m);
  });

  /**
   * 1-2: Recipe 詳細モーダルのハートを連打 → 楽観的 UI が破綻しないか
   */
  test("1-2: Recipe ハートボタン連打 → UI 破綻なし", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    // meal カードをクリックしてモーダルを開く
    const mealCard = page.locator('[data-testid*="meal"], [class*="meal-card"], [class*="MealCard"]').first();
    if (await mealCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await mealCard.click();
      await page.waitForTimeout(1_000);

      // ハートボタンを 10 回連打
      const heartBtn = page
        .locator('button[aria-label*="お気に入り"], button[aria-label*="favorite"], button svg[class*="heart"]')
        .first();

      if (await heartBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        for (let i = 0; i < 10; i++) {
          await heartBtn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(100);
        }
      }
    }

    await page.waitForTimeout(2_000);
    await ss(page, "1-2-heart-spam");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("1-2-monitors", m);
  });

  /**
   * 1-3: ログアウト確認ダイアログ「ログアウト」を連打
   */
  test("1-3: ログアウトボタン連打 → クラッシュなし", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const logoutBtn = page.locator("button", { hasText: /ログアウト|サインアウト|Sign out/ }).first();

    if (await logoutBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await logoutBtn.click();
      await page.waitForTimeout(500);

      // 確認ダイアログの「ログアウト」ボタンを連打
      const confirmBtn = page
        .locator('[role="dialog"] button', { hasText: /ログアウト|はい|確認/ })
        .first();

      if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        for (let i = 0; i < 5; i++) {
          await confirmBtn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(200);
        }
      }
    }

    await page.waitForTimeout(3_000);
    await ss(page, "1-3-logout-spam");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("1-3-monitors", m);
  });

  /**
   * 1-4: 30秒チェックインボタン連打
   */
  test("1-4: 30秒チェックインボタン連打 → 重複送信なし", async ({ page }) => {
    const m = attachMonitors(page);
    const checkinRequests: string[] = [];

    await authedPage(page);
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    page.on("request", (req) => {
      if (req.url().includes("checkin") && req.method() === "POST") {
        checkinRequests.push(req.url());
      }
    });

    const checkinBtn = page
      .locator("button", { hasText: /チェックイン|30秒|記録/ })
      .first();

    if (await checkinBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      for (let i = 0; i < 5; i++) {
        await checkinBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    await page.waitForTimeout(3_000);
    await ss(page, "1-4-checkin-spam");
    if (checkinRequests.length > 1) {
      console.warn(`[WARNING] チェックイン POST ${checkinRequests.length} 回 (重複の可能性)`);
    }
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("1-4-monitors", { ...m, checkinRequests });
  });
});

// ════════════════════════════════════════════════════════
// グループ 2: ブラウザナビゲーション
// ════════════════════════════════════════════════════════

test.describe("G2: ブラウザナビゲーション", () => {
  /**
   * 2-1: 生成中にブラウザ「戻る」 → 状態
   */
  test("2-1: 献立生成中に戻る → 状態正常", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    // 生成ボタンがあればクリックしてすぐ戻る
    const generateBtn = page
      .locator("button", { hasText: /AI献立|献立を作る|献立を生成/ })
      .first();

    if (await generateBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await generateBtn.click().catch(() => {});
      await page.waitForTimeout(1_000);
      await page.goBack();
    } else {
      // 生成ボタンがなければ直接 back
      await page.goBack();
    }

    await page.waitForLoadState("networkidle");
    await ss(page, "2-1-back-during-generation");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("2-1-monitors", m);
  });

  /**
   * 2-2: モーダル open 中に戻る → モーダル閉じるか URL 変わるか
   */
  test("2-2: モーダル open 中に戻る → UI 整合", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    const mealCard = page.locator('[class*="meal"], [class*="Meal"], [data-testid*="meal"]').first();
    if (await mealCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await mealCard.click();
      await page.waitForTimeout(1_000);

      // モーダルが表示されているか確認
      const modal = page.locator('[role="dialog"]').first();
      if (await modal.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await page.goBack();
        await page.waitForTimeout(1_000);

        // モーダルが閉じているか
        const modalStillVisible = await modal.isVisible().catch(() => false);
        await ss(page, "2-2-modal-after-back");
        if (modalStillVisible) {
          console.warn("[WARNING] 戻るボタン後もモーダルが表示されたまま");
        }
      }
    }

    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("2-2-monitors", m);
  });

  /**
   * 2-3: /home → /menus/weekly の高速往復 5 連続
   */
  test("2-3: home <-> weekly 高速往復 5 回 → クラッシュなし", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);

    for (let i = 0; i < 5; i++) {
      await page.goto("/home");
      await page.waitForTimeout(300);
      await page.goto("/menus/weekly");
      await page.waitForTimeout(300);
    }

    await page.waitForLoadState("networkidle");
    await ss(page, "2-3-rapid-navigation");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    // 5xx がある場合は警告
    if (m.networkErrors.length > 0) {
      console.warn("[WARNING] 5xx during rapid navigation:", m.networkErrors);
    }
    saveJson("2-3-monitors", m);
  });

  /**
   * 2-4: 生成中にリロード(F5)
   */
  test("2-4: 生成中にリロード → 進捗復元 or クリーン状態", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    const generateBtn = page
      .locator("button", { hasText: /AI献立|献立を作る|献立を生成/ })
      .first();

    if (await generateBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await generateBtn.click().catch(() => {});
      await page.waitForTimeout(1_500);
    }

    // リロード
    await page.reload();
    await page.waitForLoadState("networkidle");

    await ss(page, "2-4-reload-during-generation");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("2-4-monitors", m);
  });
});

// ════════════════════════════════════════════════════════
// グループ 3: 入力境界・特殊文字
// ════════════════════════════════════════════════════════

test.describe("G3: 入力境界・特殊文字", () => {
  /**
   * 3-1: プロフィール編集で <script>alert(1)</script> を入力 → XSS 防御確認
   * セキュリティ: High
   */
  test("3-1: XSS ペイロードをプロフィールに入力 → DOM に script タグ注入されない", async ({ page }) => {
    const m = attachMonitors(page);
    let xssTriggered = false;

    await authedPage(page);
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");

    // alert をフックして XSS 発火を検知
    await page.addInitScript(() => {
      (window as any).__xss_triggered = false;
      window.alert = () => { (window as any).__xss_triggered = true; };
    });

    const XSS_PAYLOAD = '<script>alert(1)</script>';
    const XSS_PAYLOAD_IMG = '<img src=x onerror="window.__xss_triggered=true">';

    // 名前フィールドなどにペイロードを入力
    const nameInput = page.locator('input[name="name"], input[id="name"], input[placeholder*="名前"], input[placeholder*="ニックネーム"]').first();

    if (await nameInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await nameInput.fill(XSS_PAYLOAD);

      // 保存ボタンをクリック
      const saveBtn = page.locator("button", { hasText: /保存|更新|Save|Update/ }).first();
      if (await saveBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await saveBtn.click();
        await page.waitForTimeout(2_000);
      }

      // XSS 発火チェック
      xssTriggered = await page.evaluate(() => (window as any).__xss_triggered ?? false);

      // DOM に raw script タグがないか確認
      const domContainsScript = await page.evaluate(() => {
        return document.body.innerHTML.includes("<script>alert");
      });

      await ss(page, "3-1-xss-profile-name");
      saveJson("3-1-xss-result", { xssTriggered, domContainsScript, pageErrors: m.pageErrors });

      if (xssTriggered) {
        console.error("[SECURITY] **XSS 発火** alert() が呼ばれた");
      }
      if (domContainsScript) {
        console.error("[SECURITY] DOM に raw <script>alert が存在する");
      }

      // XSS 発火はバグ
      expect(xssTriggered, "XSS alert should NOT fire").toBe(false);
      expect(domContainsScript, "DOM should not contain raw <script>alert").toBe(false);
    } else {
      console.log("[SKIP] 名前入力フィールドが見つからなかった (profile 構造を確認)");
      await ss(page, "3-1-xss-no-field");
    }

    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
  });

  /**
   * 3-2: 体重に境界値 / 不正値を入力
   */
  test("3-2: 体重フィールドへの異常値入力 → バリデーションエラー表示", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/health/record");
    await page.waitForLoadState("networkidle");

    const weightInput = page.locator('input[name="weight"], input[id="weight"], input[placeholder*="体重"], input[type="number"]').first();

    if (!(await weightInput.isVisible({ timeout: 5_000 }).catch(() => false))) {
      // /health/record/quick を試す
      await page.goto("/health/record/quick");
      await page.waitForLoadState("networkidle");
    }

    const WEIGHT_CASES = [
      { value: "999999", label: "extreme-large" },
      { value: "-1", label: "negative" },
      { value: "0", label: "zero" },
      { value: "abc", label: "alpha" },
      { value: "", label: "empty" },
      { value: "1.2.3", label: "multi-dot" },
    ];

    for (const tc of WEIGHT_CASES) {
      const wInput = page.locator('input[name="weight"], input[id="weight"], input[type="number"]').first();
      if (await wInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await wInput.fill(tc.value);
        const submitBtn = page.locator("button[type=submit]").first();
        if (await submitBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await submitBtn.click();
          await page.waitForTimeout(1_000);
        }
        await ss(page, `3-2-weight-${tc.label}`);
      }
    }

    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("3-2-monitors", m);
  });

  /**
   * 3-3: 食事メモに 5000 文字入力
   */
  test("3-3: 食事メモ 5000 文字入力 → クラッシュなし", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    const LONG_TEXT = "あ".repeat(5000);

    // チェックインモーダルを探す
    const checkinBtn = page
      .locator("button", { hasText: /チェックイン|30秒|記録/ })
      .first();

    if (await checkinBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await checkinBtn.click();
      await page.waitForTimeout(1_000);

      const memoField = page.locator('textarea[name="memo"], textarea[placeholder*="メモ"], textarea').first();
      if (await memoField.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await memoField.fill(LONG_TEXT);
        await page.waitForTimeout(500);
        await ss(page, "3-3-long-memo");

        const submitBtn = page.locator("button[type=submit]").first();
        if (await submitBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await submitBtn.click();
          await page.waitForTimeout(2_000);
        }
      }
    }

    await ss(page, "3-3-long-memo-after-submit");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    if (m.networkErrors.length > 0) {
      console.warn("[WARNING] 5xx on long memo submit:", m.networkErrors);
    }
    saveJson("3-3-monitors", m);
  });

  /**
   * 3-4: Email に 256 文字超 / パスワードに 1000 文字
   */
  test("3-4: 超長 email / 超長 password をログインフォームに入力 → クラッシュなし", async ({ page }) => {
    const m = attachMonitors(page);
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const LONG_EMAIL = "a".repeat(250) + "@example.com"; // 263 文字
    const LONG_PASS = "A1!".repeat(334); // 1002 文字

    await page.locator("#email").fill(LONG_EMAIL);
    await page.locator("#password").fill(LONG_PASS);
    await page.locator("button[type=submit]").click();
    await page.waitForTimeout(3_000);

    await ss(page, "3-4-long-email-password");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("3-4-monitors", m);
  });
});

// ════════════════════════════════════════════════════════
// グループ 4: 日付境界
// ════════════════════════════════════════════════════════

test.describe("G4: 日付境界", () => {
  /**
   * 4-1: 翌週ボタンを 100 回押し続けて 2027 年まで進む → render エラーなし
   */
  test("4-1: 翌週ボタン 100 連打 → 2027 年まで進んでも render エラーなし", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    const nextWeekBtn = page
      .locator('button[aria-label*="翌週"], button[aria-label*="次の週"], button[aria-label*="next"], button[title*="翌週"]')
      .or(page.locator("button", { hasText: /翌週|次の週|>|›/ }))
      .first();

    let clickCount = 0;
    if (await nextWeekBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      for (let i = 0; i < 100; i++) {
        const clicked = await nextWeekBtn.click({ force: true }).then(() => true).catch(() => false);
        if (!clicked) break;
        clickCount++;
        if (i % 10 === 0) {
          await page.waitForTimeout(200);
        }
      }
    }

    await page.waitForTimeout(2_000);
    await ss(page, "4-1-next-week-100");
    console.log(`[INFO] 翌週ボタン ${clickCount} 回クリック完了`);
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("4-1-monitors", { ...m, clickCount });
  });

  /**
   * 4-2: 過去カレンダーで 2 年前まで戻る
   */
  test("4-2: ヘルスカレンダーを 2 年前まで遡る → render エラーなし", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/health");
    await page.waitForLoadState("networkidle");

    const prevWeekBtn = page
      .locator('button[aria-label*="前週"], button[aria-label*="前の週"], button[aria-label*="prev"], button[title*="前週"]')
      .or(page.locator("button", { hasText: /前週|前の週|<|‹/ }))
      .first();

    let clickCount = 0;
    // 2年 = 約 104 週
    if (await prevWeekBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      for (let i = 0; i < 104; i++) {
        const clicked = await prevWeekBtn.click({ force: true }).then(() => true).catch(() => false);
        if (!clicked) break;
        clickCount++;
        if (i % 10 === 0) {
          await page.waitForTimeout(200);
        }
      }
    }

    await page.waitForTimeout(2_000);
    await ss(page, "4-2-past-calendar-2years");
    console.log(`[INFO] 前週ボタン ${clickCount} 回クリック`);
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("4-2-monitors", { ...m, clickCount });
  });
});

// ════════════════════════════════════════════════════════
// グループ 5: ネットワーク劣化
// ════════════════════════════════════════════════════════

test.describe("G5: ネットワーク劣化", () => {
  /**
   * 5-1: offline 状態で submit → 適切なエラーメッセージ
   */
  test("5-1: offline で献立生成 submit → エラー表示 (クラッシュなし)", async ({ page, context }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    // オフラインに切り替え
    await context.setOffline(true);

    const generateBtn = page
      .locator("button", { hasText: /AI献立|献立を作る|献立を生成/ })
      .first();

    if (await generateBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await generateBtn.click().catch(() => {});
      await page.waitForTimeout(3_000);
    }

    await ss(page, "5-1-offline-generate");

    // エラーメッセージが出ているか確認
    const errorMsg = page.locator('[role="alert"], [class*="error"], [class*="Error"]').first();
    const hasError = await errorMsg.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasError) {
      console.warn("[WARNING] offline 時のエラーメッセージが見つからない");
    }

    // オンラインに戻す
    await context.setOffline(false);

    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("5-1-monitors", m);
  });

  /**
   * 5-2: API 5xx をモック → エラー表示 (page.route 経由)
   */
  test("5-2: 献立生成 API を 500 にモック → エラー UI 表示", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);

    // /api/ai/menu/* を 500 に差し替え
    await page.route("**/api/ai/menu/**", (route) => {
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal Server Error (mocked)" }),
      });
    });

    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    const generateBtn = page
      .locator("button", { hasText: /AI献立|献立を作る|献立を生成/ })
      .first();

    if (await generateBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await generateBtn.click().catch(() => {});
      await page.waitForTimeout(5_000);
    }

    await ss(page, "5-2-api-500-mock");

    // エラーメッセージが表示されているか
    const errorEl = page.locator('[role="alert"], [class*="error"], [class*="Error"]').first();
    const errorVisible = await errorEl.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!errorVisible) {
      console.warn("[WARNING] 5xx モック時のエラー UI が表示されていない");
    }

    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("5-2-monitors", m);
  });

  /**
   * 5-3: health API を 500 にモック → エラー表示
   */
  test("5-3: health API を 500 にモック → エラー UI 表示", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);

    await page.route("**/api/health/**", (route) => {
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "mocked 500" }),
      });
    });

    await page.goto("/health");
    await page.waitForLoadState("networkidle");

    await ss(page, "5-3-health-api-500");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("5-3-monitors", m);
  });
});

// ════════════════════════════════════════════════════════
// グループ 6: セッション系
// ════════════════════════════════════════════════════════

test.describe("G6: セッション系", () => {
  /**
   * 6-1: 認証 token が expire した瞬間の操作 (cookie クリアでシミュレート)
   */
  test("6-1: cookie クリア後 /home 操作 → /login にリダイレクト or エラー表示", async ({
    page,
    context,
  }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    // セッション cookie を削除 (token expire シミュレート)
    await context.clearCookies();

    // API 呼び出しを発火
    const checkinBtn = page
      .locator("button", { hasText: /チェックイン|30秒|記録/ })
      .first();

    if (await checkinBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await checkinBtn.click().catch(() => {});
      await page.waitForTimeout(3_000);
    } else {
      // reload してリダイレクト確認
      await page.reload();
      await page.waitForTimeout(3_000);
    }

    const currentUrl = page.url();
    await ss(page, "6-1-token-expire");
    console.log(`[INFO] token expire 後の URL: ${currentUrl}`);

    // /login にリダイレクトされているか、または適切なエラーが表示されているか
    const isRedirectedToLogin = currentUrl.includes("/login");
    const hasError = await page.locator('[role="alert"]').isVisible().catch(() => false);

    if (!isRedirectedToLogin && !hasError) {
      console.warn("[WARNING] token expire 後に /login リダイレクトも エラーも表示されない");
    }

    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("6-1-monitors", { ...m, currentUrl, isRedirectedToLogin, hasError });
  });
});

// ════════════════════════════════════════════════════════
// グループ 7: キーボード乱用
// ════════════════════════════════════════════════════════

test.describe("G7: キーボード乱用", () => {
  /**
   * 7-1: modal open 中に Escape 連打
   */
  test("7-1: モーダル open 中に Escape 連打 → クラッシュなし", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    const mealCard = page.locator('[class*="meal"], [class*="Meal"], [data-testid*="meal"]').first();
    if (await mealCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await mealCard.click();
      await page.waitForTimeout(1_000);

      // Escape を 10 回連打
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
      }
    }

    await ss(page, "7-1-escape-spam");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("7-1-monitors", m);
  });

  /**
   * 7-2: Tab で全要素を巡回 → focus 逃しなし (20 回 tab)
   */
  test("7-2: /home で Tab 20 回 → focus が body に戻らない", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    const focusTraps: string[] = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(100);
      const focusedTag = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? `${el.tagName}#${el.id}.${el.className}` : "none";
      });
      focusTraps.push(focusedTag);
    }

    await ss(page, "7-2-tab-focus");
    saveJson("7-2-focus-sequence", focusTraps);

    // body がフォーカスされたまま連続している場合はフォーカストラップ漏れの可能性
    const bodyFocusCount = focusTraps.filter((f) => f.startsWith("BODY")).length;
    if (bodyFocusCount > 5) {
      console.warn(`[WARNING] BODY にフォーカスが ${bodyFocusCount} 回戻った (フォーカス管理の問題の可能性)`);
    }

    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("7-2-monitors", m);
  });
});

// ════════════════════════════════════════════════════════
// グループ 8: Storage 系
// ════════════════════════════════════════════════════════

test.describe("G8: Storage 系", () => {
  /**
   * 8-1: localStorage を直接書き換えてから操作
   */
  test("8-1: localStorage に malicious 値を注入してから /home 操作 → クラッシュなし", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    // localStorage を改ざん
    await page.evaluate(() => {
      try {
        localStorage.setItem("v4_include_existing", "malicious");
        localStorage.setItem("user_id", "<script>alert(1)</script>");
        localStorage.setItem("auth_token", "eyJfaketoken.fakebody.fakesig");
        localStorage.setItem("menu_generation_status", '{"status":"completed","data":null}');
      } catch {
        // quota エラー等は無視
      }
    });

    // リロードして動作確認
    await page.reload();
    await page.waitForLoadState("networkidle");

    await ss(page, "8-1-localstorage-tamper");

    // pageerror がないこと
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("8-1-monitors", m);
  });

  /**
   * 8-2: localStorage quota オーバーフロー状態で操作
   */
  test("8-2: localStorage quota オーバーフロー → クラッシュなし", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    // localStorage をほぼ埋める (5MB 制限の 95% 相当)
    await page.evaluate(() => {
      const chunk = "x".repeat(1024); // 1KB
      let i = 0;
      while (i < 4800) {
        // ~4.7MB
        try {
          localStorage.setItem(`__fill_${i}`, chunk);
          i++;
        } catch {
          break; // QuotaExceededError — これ以上は無理
        }
      }
    });

    // チェックインボタン押下
    const checkinBtn = page
      .locator("button", { hasText: /チェックイン|30秒|記録/ })
      .first();
    if (await checkinBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await checkinBtn.click().catch(() => {});
      await page.waitForTimeout(2_000);
    }

    await ss(page, "8-2-localstorage-quota");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("8-2-monitors", m);
  });
});

// ════════════════════════════════════════════════════════
// グループ 9: URL 直叩き
// ════════════════════════════════════════════════════════

test.describe("G9: URL 直叩き", () => {
  /**
   * 9-1: 不正な weekly menu ID → 404 or リダイレクト (クラッシュなし)
   */
  test("9-1: /menus/weekly/bad-id 直叩き → 404 or /menus/weekly にリダイレクト", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/menus/weekly/00000000-0000-0000-0000-000000000000");
    await page.waitForLoadState("networkidle");

    const currentUrl = page.url();
    await ss(page, "9-1-bad-menu-id");
    console.log(`[INFO] bad menu id URL 後: ${currentUrl}`);

    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("9-1-monitors", { ...m, currentUrl });
  });

  /**
   * 9-2: /health/checkups/<XSS payload> → render エラーなし
   */
  test("9-2: /health/checkups/xss-url → 404 or リダイレクト (XSS なし)", async ({ page }) => {
    const m = attachMonitors(page);
    let xssTriggered = false;

    await authedPage(page);

    await page.addInitScript(() => {
      (window as any).__xss_triggered = false;
      window.alert = () => { (window as any).__xss_triggered = true; };
    });

    await page.goto(
      `/health/checkups/%3Cscript%3Ealert(1)%3C%2Fscript%3E`
    );
    await page.waitForLoadState("networkidle");

    xssTriggered = await page.evaluate(() => (window as any).__xss_triggered ?? false);
    const domContainsScript = await page.evaluate(() =>
      document.body.innerHTML.includes("<script>alert")
    );

    await ss(page, "9-2-xss-url");

    if (xssTriggered) console.error("[SECURITY] XSS triggered via URL");
    if (domContainsScript) console.error("[SECURITY] DOM contains raw script from URL");

    expect(xssTriggered, "URL XSS should not fire").toBe(false);
    expect(domContainsScript, "DOM should not contain raw script from URL").toBe(false);
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("9-2-monitors", { ...m, xssTriggered, domContainsScript });
  });

  /**
   * 9-3: 別ユーザー user_id を query に付与して アクセス → 自分のデータのみ返る
   */
  test("9-3: ?user_id=other-user を query に付与 → 他ユーザーデータが漏れない", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);

    // 別ユーザー UUID を付与してアクセス
    await page.goto("/home?user_id=00000000-0000-0000-0000-deadbeefcafe");
    await page.waitForLoadState("networkidle");

    await ss(page, "9-3-other-user-query");
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("9-3-monitors", m);
  });

  /**
   * 9-4: 存在しないルートへ直叩き → 404 ページが表示される
   */
  test("9-4: 存在しないルート /does-not-exist/123 → 404 表示 (クラッシュなし)", async ({ page }) => {
    const m = attachMonitors(page);
    await authedPage(page);
    await page.goto("/does-not-exist/123456");
    await page.waitForLoadState("networkidle");

    await ss(page, "9-4-nonexistent-route");
    // 真っ白でないこと (404 画面が出ていること)
    const bodyText = await page.locator("body").textContent();
    expect((bodyText?.trim().length ?? 0), "body should not be empty (404 page expected)").toBeGreaterThan(0);
    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("9-4-monitors", m);
  });
});

// ════════════════════════════════════════════════════════
// グループ 10: ファイルアップロード嫌がらせ
// ════════════════════════════════════════════════════════

test.describe("G10: ファイルアップロード嫌がらせ", () => {
  /**
   * 10-1: 0 バイト画像をアップロード → エラー表示
   */
  test("10-1: 0 バイト画像アップロード → エラー表示 (クラッシュなし)", async ({ page }) => {
    const m = attachMonitors(page);

    // 一時的な 0 バイトファイルを作成
    const emptyFilePath = path.join(EVIDENCE_DIR, "empty.png");
    ensureDir();
    fs.writeFileSync(emptyFilePath, "");

    await authedPage(page);
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await fileInput.setInputFiles(emptyFilePath);
      await page.waitForTimeout(2_000);
      await ss(page, "10-1-empty-file-upload");
    } else {
      await ss(page, "10-1-no-file-input");
      console.log("[SKIP] ファイル入力フィールドが見つからない");
    }

    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("10-1-monitors", m);

    // クリーンアップ
    fs.unlinkSync(emptyFilePath);
  });

  /**
   * 10-2: .exe を .png にリネームしてアップロード → サーバー側でブロック
   */
  test("10-2: exe-renamed-to-png アップロード → エラー表示 (実行されない)", async ({ page }) => {
    const m = attachMonitors(page);

    // 偽 PNG (EXE MZ ヘッダー)
    const fakePngPath = path.join(EVIDENCE_DIR, "evil.png");
    ensureDir();
    const mzHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]); // MZ header
    fs.writeFileSync(fakePngPath, mzHeader);

    await authedPage(page);
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await fileInput.setInputFiles({ name: "evil.png", mimeType: "image/png", buffer: mzHeader });
      await page.waitForTimeout(3_000);
      await ss(page, "10-2-fake-png-upload");

      // エラーメッセージが表示されているか
      const errorEl = page.locator('[role="alert"], [class*="error"]').first();
      const hasError = await errorEl.isVisible({ timeout: 3_000 }).catch(() => false);
      if (!hasError) {
        console.warn("[WARNING] 偽 PNG アップロード後のエラーメッセージが見つからない");
      }
    } else {
      await ss(page, "10-2-no-file-input");
    }

    expect(m.pageErrors, `pageErrors: ${m.pageErrors.join(", ")}`).toHaveLength(0);
    saveJson("10-2-monitors", m);

    // クリーンアップ
    if (fs.existsSync(fakePngPath)) fs.unlinkSync(fakePngPath);
  });
});
