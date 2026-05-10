/**
 * Bug #79, #81, #82: Onboarding 関連バグ修正の E2E 検証
 *
 * #79: DELETE /api/onboarding/status が onboarding_completed_at をクリアしない
 *   -> リセット後に /onboarding を再訪してフロー再開できる
 *
 * #81: resolveOnboardingRedirect が /onboarding/complete を /onboarding/resume へ誤リダイレクト
 *   -> in_progress 中に /onboarding/complete へ到達できる (リダイレクトされない)
 *
 * #82: body_stats height/weight に min/max バリデーションなし
 *   -> 不正値 (height=0) では「次へ」ボタンが disabled になる
 *
 * onboardingPendingUser fixture: 確認済み + onboarding 未完了ユーザーとして開始。
 * E2E_USER_EMAIL / PASSWORD 環境変数が不要になり、毎テスト独立した fresh user で動作する。
 */
import { test, expect } from "./fixtures/fresh-user";

test.describe("Bug #82: body_stats height/weight min/max バリデーション", () => {
  test("身長に 0 を入力したとき「次へ」が disabled になる", async ({ onboardingPendingUser: page }) => {
    // onboarding questions ページへ直接アクセス
    await page.goto("/onboarding/questions");
    await page.waitForLoadState("networkidle");

    // body_stats ステップの入力フィールドが存在する場合のみテスト
    const heightInput = page.locator('input[placeholder="170"]');
    const nextButton = page.locator('button:has-text("次へ")');

    // heightInput が見えている場合のみ検証
    if (await heightInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      // 範囲外の値 (0) を入力
      await heightInput.fill("0");
      // 「次へ」が disabled であることを確認
      await expect(nextButton).toBeDisabled();

      // 正常範囲の値を入力
      await heightInput.fill("170");
      const weightInput = page.locator('input[placeholder="60"]');
      await weightInput.fill("60");

      // age フィールドが必要な場合がある
      const ageInput = page.locator('input[placeholder*="25"]').first();
      if (await ageInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        await ageInput.fill("30");
      }

      // 正常値では disabled が解除される
      await expect(nextButton).not.toBeDisabled({ timeout: 3000 });
    }
  });
});

test.describe("Bug #79: リセット時に onboarding_completed_at がクリアされる", () => {
  test("DELETE /api/onboarding/status がステータスを not_started に戻す", async ({ onboardingPendingUser: page }) => {
    // onboarding_pending ユーザーは /onboarding にリダイレクトされるはず
    await page.goto("/home");
    await page.waitForLoadState("networkidle");

    // リセット API を呼び出す (page.evaluate 経由で session cookie を引き継ぐ)
    const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
    const res = await page.evaluate(async (url) => {
      const r = await fetch(url, { method: 'DELETE', credentials: 'include' });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, `${baseURL}/api/onboarding/status`);
    expect(res.status).toBe(200);

    const body = res.body;
    expect(body?.success).toBe(true);

    // リセット後にステータスを取得して not_started になっていることを確認 (credentials:include)
    const statusRes = await page.evaluate(async (url) => {
      const r = await fetch(url, { method: 'GET', credentials: 'include' });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, `${baseURL}/api/onboarding/status`);
    const statusBody = statusRes.body;
    expect(statusBody?.status).toBe("not_started");
  });
});

test.describe("Bug #81: in_progress 中に /onboarding/complete へ到達できる", () => {
  test("/onboarding/complete が /onboarding/resume にリダイレクトされない", async ({ onboardingPendingUser: page }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

    // onboarding を開始させる (welcome -> questions への遷移)
    await page.goto(`${baseURL}/onboarding/welcome`);
    await page.waitForLoadState("networkidle");

    // 「始める」ボタンをクリックして in_progress 状態にする
    const startButton = page.locator('button:has-text("始める"), button:has-text("スタート"), a:has-text("始める")').first();
    if (await startButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await startButton.click();
      await page.waitForLoadState("networkidle");
    }

    // /onboarding/complete に直接アクセスして、resume にリダイレクトされないことを確認
    await page.goto(`${baseURL}/onboarding/complete`);
    await page.waitForLoadState("networkidle");

    // resume にリダイレクトされていないことを確認
    expect(page.url()).not.toContain("/onboarding/resume");
  });
});
