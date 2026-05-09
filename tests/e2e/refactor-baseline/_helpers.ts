/**
 * tests/e2e/refactor-baseline/_helpers.ts
 *
 * weekly/page.tsx 特性テスト共通ヘルパー
 * リファクタ前の挙動を固定するテスト群で共有する。
 */
import { type Page, expect } from "@playwright/test";

/**
 * オンボーディング未完了ユーザーのリダイレクトをスキップして
 * /menus/weekly へ確実に到達するヘルパー。
 *
 * authedPage fixture の login() は /home をチェックするが、
 * E2E ユーザーがオンボーディング途中の場合は /onboarding/resume へ
 * リダイレクトされる。その場合は /api/onboarding/complete を叩いて
 * 完了状態にしてから再度 weekly へ移動する。
 */
async function ensureOnboardingComplete(page: Page): Promise<void> {
  const url = page.url();
  if (url.includes("/onboarding")) {
    // オンボーディング完了 API を呼び出す
    await page.evaluate(async () => {
      try {
        await fetch("/api/onboarding/complete", {
          method: "POST",
          credentials: "include",
        });
      } catch {
        // 無視: 失敗しても続行
      }
    });
    // 再度 weekly へ遷移
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");
  }
}

/** weekly ページへ移動し、ネットワークアイドル状態まで待つ */
export async function gotoWeekly(page: Page): Promise<void> {
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");

  // オンボーディングリダイレクトを処理
  await ensureOnboardingComplete(page);

  // 週ナビゲーションボタンが表示されるまで待つ (aria-label で特定)
  await expect(
    page.locator('[aria-label="前の週"]'),
  ).toBeVisible({ timeout: 20_000 });
}

/** 「買い物リストを開く」ボタン経由で shopping モーダルを開く */
export async function openShoppingModal(page: Page): Promise<void> {
  const btn = page.locator('[aria-label="買い物リストを開く"]');
  await btn.waitFor({ state: "visible", timeout: 10_000 });
  await btn.click();
  await expect(page.getByText("買い物リスト").first()).toBeVisible({
    timeout: 10_000,
  });
}

/** 「冷蔵庫を確認」ボタン経由で fridge モーダルを開く */
export async function openFridgeModal(page: Page): Promise<void> {
  const btn = page.locator('[aria-label="冷蔵庫を確認"]');
  await btn.waitFor({ state: "visible", timeout: 10_000 });
  await btn.click();
  await expect(page.getByText("冷蔵庫").first()).toBeVisible({
    timeout: 10_000,
  });
}

/** モーダルを閉じる (X ボタンを押す) */
export async function closeModalByX(page: Page): Promise<void> {
  // 最前面のモーダル内の X ボタン (X アイコン内の button)
  const closeBtn = page.locator('button:has(svg.lucide-x)').last();
  await closeBtn.waitFor({ state: "visible", timeout: 5_000 });
  await closeBtn.click();
}

/**
 * 既存の食事カードがあるかどうかを確認し、あれば最初の食事を返す。
 * データが無い環境では null を返す。
 */
export async function findFirstMealCard(page: Page) {
  // 食事カード内の「手動で修正」ボタンで特定
  const manualEditBtn = page.getByRole("button", { name: /手動で修正/ }).first();
  const exists = await manualEditBtn
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  return exists ? manualEditBtn : null;
}
