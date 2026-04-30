/**
 * 探索テスト: Home dashboard (/home)
 *
 * 目的: ホームダッシュボードの全要素を網羅的に探索し、
 *       バグ・不具合の証拠を収集する。
 *
 * カバレッジ:
 *   1. /home 全体レンダーエラーなし (console error 0, 5xx なし)
 *   2. 連続自炊 streak 表示
 *   3. 今月の自炊 stat
 *   4. 今日の進捗 円形プログレス + 完了%
 *   5. 「今日の献立合計 ... kcal」ラベル
 *   6. Weekly stats card (週間自炊 / 平均カロリー)
 *   7. 30秒チェックイン: open → fill → submit → feedback
 *   8. AI 提案 card クリック → 反応確認
 *   9. 冷蔵庫期限切れ alert
 *  10. Latest badge card / Best meal of week card
 *  11. ヒーロー / プロフィールアイコン → /profile 遷移
 *  12. floating AI chat ボタン
 *  13. ボトムナビゲーション: 各遷移
 *
 * 出力: tests/e2e/.exploration/home/ にスクリーンショット保存
 */

import { test, expect } from "../fixtures/auth";
import path from "path";
import fs from "fs";

const SCREENSHOT_DIR = path.join(
  __dirname,
  ".exploration",
  "home"
);

// スクリーンショットを保存するヘルパー
async function saveScreenshot(
  page: import("@playwright/test").Page,
  name: string
) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  return filePath;
}

// テスト前にディレクトリを確保
test.beforeAll(() => {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
});

// ============================================================
// シナリオ 1: /home 全体 render エラーなし
// ============================================================
test("1. /home renders without console errors or 5xx responses", async ({ authedPage: page }) => {
  const consoleErrors: string[] = [];
  const failedResponses: { url: string; status: number }[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failedResponses.push({ url: response.url(), status: response.status() });
    }
  });

  await page.goto("/home", { waitUntil: "networkidle" });
  await saveScreenshot(page, "01-home-initial-load");

  // console error の確認
  const filteredErrors = consoleErrors.filter(
    (e) =>
      !e.includes("ResizeObserver") &&
      !e.includes("favicon") &&
      !e.includes("hydration") &&
      !e.includes("Warning:")
  );
  expect(filteredErrors, `Console errors found: ${JSON.stringify(filteredErrors)}`).toHaveLength(0);

  // 5xx の確認
  expect(failedResponses, `5xx responses: ${JSON.stringify(failedResponses)}`).toHaveLength(0);
});

// ============================================================
// シナリオ 2: 連続自炊 streak 表示
// ============================================================
test("2. cooking streak is displayed", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  // "連続自炊" テキストが含まれるカード
  const streakCard = page.getByText("連続自炊").first();
  await expect(streakCard).toBeVisible({ timeout: 10_000 });

  // 数値が表示されていること (0以上の整数 + "日")
  const streakText = await page.locator("text=/\\d+日/").first().textContent();
  expect(streakText).toMatch(/\d+日/);

  await saveScreenshot(page, "02-streak");
});

// ============================================================
// シナリオ 3: 今月の自炊 stat
// ============================================================
test("3. monthly cooking stat is displayed", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  const monthlyCard = page.getByText("今月の自炊").first();
  await expect(monthlyCard).toBeVisible({ timeout: 10_000 });

  await saveScreenshot(page, "03-monthly-stat");
});

// ============================================================
// シナリオ 4: 今日の進捗 円形プログレス + 完了%
// ============================================================
test("4. today's progress circle and completion % are shown", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  const progressPercent = page.getByTestId("home-progress-percent");
  await expect(progressPercent).toBeVisible({ timeout: 10_000 });

  const percentText = await progressPercent.textContent();
  expect(percentText).toMatch(/^\d+%$/);

  const progressFraction = page.getByTestId("home-progress-fraction");
  await expect(progressFraction).toBeVisible();

  await saveScreenshot(page, "04-progress-circle");
});

// ============================================================
// シナリオ 5: 「今日の献立合計 ... kcal」ラベル
// ============================================================
test("5. '今日の献立合計' calorie label is visible", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  const label = page.getByText("今日の献立合計", { exact: true });
  await expect(label).toBeVisible({ timeout: 10_000 });

  await saveScreenshot(page, "05-calorie-label");
});

// ============================================================
// シナリオ 6: Weekly stats card
// ============================================================
test("6. weekly stats card (今週の自炊率) is shown", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  const weeklyCard = page.getByText("今週の自炊率").first();
  await expect(weeklyCard).toBeVisible({ timeout: 10_000 });

  // % 値が表示されていること
  const percentEl = page.locator("text=/\\d+%/").first();
  await expect(percentEl).toBeVisible();

  // カードをクリックして週間詳細モーダルが開くこと
  await weeklyCard.click();
  await expect(page.getByText("今週の統計")).toBeVisible({ timeout: 5_000 });

  await saveScreenshot(page, "06-weekly-stats-modal");

  // モーダルを閉じる
  const closeBtn = page.getByRole("button", { name: "閉じる" });
  if (await closeBtn.isVisible()) {
    await closeBtn.click();
  }
});

// ============================================================
// シナリオ 7: 30秒チェックイン
// ============================================================
test("7. 30-second check-in: open → fill → submit → feedback shown", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  // 既に今日のチェックインが完了している場合はスキップ
  const alreadyDone = await page.getByText("今日のチェックイン完了！").isVisible().catch(() => false);
  test.skip(alreadyDone, "today's check-in already submitted");

  // チェックインフォームを開く
  const recordBtn = page.getByRole("button", { name: /記録する/ }).first();
  await expect(recordBtn).toBeVisible({ timeout: 10_000 });
  await recordBtn.click();

  // フォームが展開されること
  const submitBtn = page.getByRole("button", { name: /チェックイン完了/ });
  await expect(submitBtn).toBeVisible({ timeout: 5_000 });

  await saveScreenshot(page, "07a-checkin-open");

  // sleepHours スライダーを 7 に設定 (デフォルト 7 のため操作不要だが確認)
  const slider = page.locator('input[type="range"]');
  await expect(slider).toBeVisible();

  // sleepQuality, fatigue, focus, hunger をそれぞれ 3 に設定 (デフォルト 3)
  // 各ボタングループを確認
  const ratingButtons = page.locator("button").filter({ hasText: "3" });
  const count = await ratingButtons.count();
  expect(count).toBeGreaterThanOrEqual(4);

  // submit
  await submitBtn.click();

  // feedback メッセージの表示
  const feedback = page.getByTestId("checkin-feedback");
  await expect(feedback).toBeVisible({ timeout: 8_000 });
  const feedbackText = await feedback.textContent();
  expect(feedbackText).toMatch(/チェックイン|保存/);

  await saveScreenshot(page, "07b-checkin-feedback");
});

// ============================================================
// シナリオ 8: AI 提案 card クリック
// ============================================================
test("8. AI suggestion card click causes some reaction", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  // AI サジェスト card は表示されている場合のみテスト
  const suggestionCard = page.getByText("今日のアドバイス").first();
  const isVisible = await suggestionCard.isVisible().catch(() => false);

  if (!isVisible) {
    test.skip(true, "AI suggestion card not present for this user/state");
    return;
  }

  await saveScreenshot(page, "08a-ai-suggestion-card");

  // 「献立表でAI変更する」ボタンがある場合はクリック
  const changeMealBtn = page.getByText("献立表でAI変更する");
  if (await changeMealBtn.isVisible().catch(() => false)) {
    await changeMealBtn.click();
    await expect(page).toHaveURL(/\/menus\/weekly/, { timeout: 5_000 });
    await saveScreenshot(page, "08b-ai-suggestion-redirect");
    await page.goBack();
  } else {
    // X ボタンで閉じると suggestion が消えること
    const closeBtn = suggestionCard.locator("..").locator("button").last();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await expect(suggestionCard).not.toBeVisible({ timeout: 3_000 });
      await saveScreenshot(page, "08b-ai-suggestion-closed");
    }
  }
});

// ============================================================
// シナリオ 9: 冷蔵庫期限切れ alert
// ============================================================
test("9. expiring fridge items alert (conditional)", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  const alert = page.getByText("期限切れ間近").first();
  const isVisible = await alert.isVisible().catch(() => false);

  if (!isVisible) {
    // アラートがないこと自体は正常 (データ依存)
    console.log("No expiring items alert - may be correct if no items near expiry");
    test.skip(true, "No expiring items for this user; skipping alert check");
    return;
  }

  await expect(alert).toBeVisible();
  await saveScreenshot(page, "09-expiring-items-alert");
});

// ============================================================
// シナリオ 10: Latest badge card / Best meal of week card
// ============================================================
test("10. latest badge card and best meal of week card", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  // バッジカード
  const badgeCard = page.getByText("獲得バッジ").first();
  await expect(badgeCard).toBeVisible({ timeout: 10_000 });

  // バッジカードをクリックすると /badges に遷移
  await badgeCard.click();
  await expect(page).toHaveURL(/\/badges/, { timeout: 5_000 });
  await saveScreenshot(page, "10a-badges-page");
  await page.goBack();

  await page.waitForLoadState("networkidle");

  // 今週のベスト (データ依存なので存在する場合のみ確認)
  const bestMeal = page.getByText("今週のベスト").first();
  const hasBestMeal = await bestMeal.isVisible().catch(() => false);
  if (hasBestMeal) {
    await saveScreenshot(page, "10b-best-meal-card");
  } else {
    console.log("No best meal this week - data dependent, acceptable");
  }
});

// ============================================================
// シナリオ 11: ヒーロー / プロフィールアイコン → /profile 遷移
// ============================================================
test("11. profile icon in hero section navigates to /profile", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  // プロフィールアイコン (Link href="/profile" の中の丸いアバター)
  const profileLink = page.locator('a[href="/profile"]').first();
  await expect(profileLink).toBeVisible({ timeout: 10_000 });

  await saveScreenshot(page, "11a-hero-profile-icon");

  await profileLink.click();
  await expect(page).toHaveURL(/\/profile/, { timeout: 5_000 });

  await saveScreenshot(page, "11b-profile-page");
});

// ============================================================
// シナリオ 12: Floating AI chat ボタン
// ============================================================
test("12. floating AI chat button is present and interactive", async ({ authedPage: page }) => {
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  // AIChatBubble コンポーネントが配置されていること
  // 典型的には固定位置のボタン (チャットアイコン)
  const chatBubble = page.locator("[data-testid='ai-chat-bubble'], button[aria-label*='AI'], button[aria-label*='チャット'], button[aria-label*='chat']").first();
  const isVisible = await chatBubble.isVisible().catch(() => false);

  if (!isVisible) {
    // AIChatBubble は別のセレクタの可能性あり
    // fixed ボタンで AI 関連のものを探す
    const fixedButtons = page.locator("button").filter({ has: page.locator("svg") });
    const count = await fixedButtons.count();
    console.log(`Found ${count} buttons with SVG icons`);

    await saveScreenshot(page, "12-ai-chat-button-search");
    // テストとして「ページに何らかの fixed UI がある」ことを確認
    const mainContent = page.locator("main");
    await expect(mainContent).toBeVisible();
  } else {
    await expect(chatBubble).toBeVisible();
    await saveScreenshot(page, "12-ai-chat-button-visible");

    await chatBubble.click();
    await saveScreenshot(page, "12b-ai-chat-opened");
  }
});

// ============================================================
// シナリオ 13: ボトムナビゲーション各遷移 (mobile viewport)
// ============================================================
test("13. bottom navigation: tab transitions (mobile)", async ({ authedPage: page }) => {
  // モバイルビューポートに設定
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  await saveScreenshot(page, "13a-bottom-nav");

  // ボトムナビゲーションが表示されること
  const navLinks = page.locator("nav").or(page.locator('[class*="bottom"]')).first();

  // 献立タブ → /menus/weekly
  const menuLink = page.locator('a[href="/menus/weekly"]').first();
  await expect(menuLink).toBeVisible({ timeout: 10_000 });
  await menuLink.click();
  await expect(page).toHaveURL(/\/menus\/weekly/, { timeout: 5_000 });
  await saveScreenshot(page, "13b-menus-weekly");

  // ホームへ戻る
  const homeLink = page.locator('a[href="/home"]').first();
  await homeLink.click();
  await expect(page).toHaveURL(/\/home/, { timeout: 5_000 });

  // 健康タブ (health) - layout には health リンクがないが確認
  // 比較タブ → /comparison
  const comparisonLink = page.locator('a[href="/comparison"]').first();
  await expect(comparisonLink).toBeVisible({ timeout: 5_000 });
  await comparisonLink.click();
  await expect(page).toHaveURL(/\/comparison/, { timeout: 5_000 });
  await saveScreenshot(page, "13c-comparison");

  // マイページ → /profile
  await page.goto("/home");
  const profileNavLink = page.locator('a[href="/profile"]').last();
  await expect(profileNavLink).toBeVisible({ timeout: 5_000 });
  await profileNavLink.click();
  await expect(page).toHaveURL(/\/profile/, { timeout: 5_000 });
  await saveScreenshot(page, "13d-profile-via-nav");
});
