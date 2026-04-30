/**
 * Wave 2 / F19: A11y high 違反 一括修正 検証テスト
 *
 * #199: ホーム週間統計モーダル role=dialog / aria-labelledby / Escape キー
 * #204: AIChatBubble SVG ボタン aria-label (open / close / send)
 * #207: 設定トグルスイッチ role=switch / aria-checked / aria-label
 * #209: 健康記録 体重・体脂肪率 input label 関連付け
 * #210: バッジモーダル Escape キーで閉じる
 *
 * 対象環境: ローカル dev / https://homegohan-app.vercel.app/
 */
import { test, expect } from "./fixtures/auth";

// ─────────────────────────────────────────────────────────────────────────────
// #199: 週間統計モーダル role=dialog
// ─────────────────────────────────────────────────────────────────────────────
test.describe("#199 週間統計モーダル ARIA", () => {
  test("role=dialog / aria-modal / aria-labelledby が付与されている", async ({ page }) => {
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    // 週間グラフをクリックしてモーダルを開く
    const weeklyGraph = page.locator("text=今週の自炊率").first();
    await weeklyGraph.click();

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("aria-labelledby", "weekly-stats-title");

    // labelledby が指す見出しが存在する
    const title = page.locator("#weekly-stats-title");
    await expect(title).toBeVisible();
    await expect(title).toContainText("今週の統計");
  });

  test("Escape キーでモーダルが閉じる", async ({ page }) => {
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    const weeklyGraph = page.locator("text=今週の自炊率").first();
    await weeklyGraph.click();

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #204: AIChatBubble SVG ボタン aria-label
// ─────────────────────────────────────────────────────────────────────────────
test.describe("#204 AIChatBubble ボタン aria-label", () => {
  test("AI チャットを開くボタンに aria-label がある", async ({ page }) => {
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    const openBtn = page.locator('[data-testid="ai-chat-floating-button"]');
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toHaveAttribute("aria-label", "AIアドバイザーを開く");
  });

  test("AI チャットを閉じるボタンに aria-label がある", async ({ page }) => {
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    // チャットを開く
    const openBtn = page.locator('[data-testid="ai-chat-floating-button"]');
    await openBtn.click();

    // 閉じるボタン
    const closeBtn = page.locator('button[aria-label="AIチャットを閉じる"]');
    await expect(closeBtn).toBeVisible();
  });

  test("メッセージ送信ボタンに aria-label がある", async ({ page }) => {
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    const openBtn = page.locator('[data-testid="ai-chat-floating-button"]');
    await openBtn.click();

    const sendBtn = page.locator('button[aria-label="メッセージを送信"]');
    await expect(sendBtn).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #207: 設定トグルスイッチ role=switch / aria-checked / aria-label
// ─────────────────────────────────────────────────────────────────────────────
test.describe("#207 設定トグルスイッチ ARIA", () => {
  test("通知スイッチに role=switch / aria-checked / aria-label がある", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const notifSwitch = page.locator('[role="switch"][aria-label="通知を有効化"]');
    await expect(notifSwitch).toBeVisible();

    const checked = await notifSwitch.getAttribute("aria-checked");
    expect(["true", "false"]).toContain(checked);
  });

  test("自動解析スイッチに role=switch / aria-checked / aria-label がある", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const analyzeSwitch = page.locator('[role="switch"][aria-label="自動解析を有効化"]');
    await expect(analyzeSwitch).toBeVisible();

    const checked = await analyzeSwitch.getAttribute("aria-checked");
    expect(["true", "false"]).toContain(checked);
  });

  test("スイッチをクリックすると aria-checked が反転する", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const notifSwitch = page.locator('[role="switch"][aria-label="通知を有効化"]');
    const before = await notifSwitch.getAttribute("aria-checked");

    await notifSwitch.click();
    await page.waitForTimeout(500);

    const after = await notifSwitch.getAttribute("aria-checked");
    expect(after).not.toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #209: 健康記録 input label 関連付け
// ─────────────────────────────────────────────────────────────────────────────
test.describe("#209 健康記録 input label", () => {
  test("体重 input が label と htmlFor/id で関連付けられている", async ({ page }) => {
    await page.goto("/health/record");
    await page.waitForLoadState("networkidle");

    // label をクリックすると input にフォーカスが当たる
    const weightLabel = page.locator('label[for="health-weight"]');
    await expect(weightLabel).toBeVisible();

    const weightInput = page.locator('input#health-weight');
    await expect(weightInput).toBeVisible();

    // label クリックで input にフォーカス
    await weightLabel.click();
    await expect(weightInput).toBeFocused();
  });

  test("体脂肪率 input が label と htmlFor/id で関連付けられている", async ({ page }) => {
    await page.goto("/health/record");
    await page.waitForLoadState("networkidle");

    const fatLabel = page.locator('label[for="health-body-fat"]');
    await expect(fatLabel).toBeVisible();

    const fatInput = page.locator('input#health-body-fat');
    await expect(fatInput).toBeVisible();

    await fatLabel.click();
    await expect(fatInput).toBeFocused();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #210: バッジモーダル Escape キーで閉じる
// ─────────────────────────────────────────────────────────────────────────────
test.describe("#210 バッジモーダル Escape キー", () => {
  test("バッジカードをクリックするとモーダルが開く", async ({ page }) => {
    await page.goto("/badges");
    await page.waitForLoadState("networkidle");

    const badgeCard = page.locator('[data-testid="badge-card"]').first();
    await badgeCard.click();

    const modal = page.locator('[data-testid="badge-detail-modal"]');
    await expect(modal).toBeVisible();
  });

  test("Escape キーでバッジモーダルが閉じる", async ({ page }) => {
    await page.goto("/badges");
    await page.waitForLoadState("networkidle");

    const badgeCard = page.locator('[data-testid="badge-card"]').first();
    await badgeCard.click();

    const modal = page.locator('[data-testid="badge-detail-modal"]');
    await expect(modal).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible({ timeout: 3000 });
  });

  test("バッジモーダルに role=dialog / aria-modal / aria-labelledby がある", async ({ page }) => {
    await page.goto("/badges");
    await page.waitForLoadState("networkidle");

    const badgeCard = page.locator('[data-testid="badge-card"]').first();
    await badgeCard.click();

    const modal = page.locator('[data-testid="badge-detail-modal"]');
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-modal", "true");
    await expect(modal).toHaveAttribute("aria-labelledby", "badge-detail-title");
  });
});
