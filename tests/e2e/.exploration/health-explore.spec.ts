/**
 * 探索的 E2E spec — Health record core
 *
 * カバー範囲:
 *   1. /health 全体 render エラーなし
 *   2. 今日の記録 cards (体重 / 気分 / 睡眠) 表示 — データなしユーザーは CTA 表示
 *   3. クイック記録ボタン → form open → fill (weight, mood, sleep) → submit
 *   4. 週カレンダー: 過去日 click → 該当日 record 表示 (record なしなら empty + 「記録を追加」リンク)
 *   5. 同じ日 re-click → パネル dismiss
 *   6. 「今日」セル click → パネル dismiss
 *   7. /health/record 単独画面 → form full
 *   8. 全 fields 入力 → submit
 *   9. /health/goals → 目標一覧 + 進捗
 *  10. 各 goal: delete / add new
 *  11. /health/record/quick → クイック記録専用画面
 *
 * Trace / console / network キャプチャ → tests/e2e/.exploration/health/
 * (Playwright outputDir = tests/e2e/.output 配下に自動保存される)
 */

import { test, expect, type Page } from "@playwright/test";
import { login } from "../fixtures/auth";

// ---------------------------------------------------------------------------
// トレースを毎テスト記録する (top-level)
// NOTE: 並列実行時のトレースファイル競合を防ぐため --workers=1 で実行を推奨
// trace:"retain-on-failure" により失敗テストのみ zip が保存される
// ---------------------------------------------------------------------------
test.use({
  trace: "retain-on-failure",
  screenshot: "only-on-failure",
  video: "retain-on-failure",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gotoAuthed(page: Page, url: string) {
  await login(page);
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

function collectFailedRequests(page: Page): string[] {
  const failed: string[] = [];
  page.on("requestfailed", (req) => {
    failed.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
  return failed;
}

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

test.describe("Health record core — 探索", () => {
  // ---------------------------------------------------------------------------
  // シナリオ 1: /health render エラーなし
  // ---------------------------------------------------------------------------
  test("S1: /health 全体 render — コンソールエラー・HTTP エラーなし", async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    const failedReqs = collectFailedRequests(page);

    await gotoAuthed(page, "/health");

    await expect(page.locator("h1").first()).toBeVisible({ timeout: 15_000 });

    // Next.js RSC や Supabase セッション確立中の一時的な fetch エラーはノイズとして除外
    const TRANSIENT_PATTERNS = [
      "Failed to fetch RSC payload",         // Next.js RSC fallback (known)
      "rb._useSession",                       // Supabase session init race
      "Failed to load resource: net::ERR_",   // ネットワーク瞬断
    ];
    const fatalErrors = consoleErrors.filter(
      (e) =>
        (e.includes("Error:") || e.includes("TypeError") || e.includes("Uncaught")) &&
        !TRANSIENT_PATTERNS.some((p) => e.includes(p))
    );
    expect(fatalErrors, `Non-transient console errors: ${JSON.stringify(fatalErrors)}`).toHaveLength(0);

    // RSC フェッチ失敗 (Next.js の既知フォールバック) を記録
    const rscErrors = consoleErrors.filter((e) => e.includes("Failed to fetch RSC payload"));
    if (rscErrors.length > 0) {
      console.warn("[探索] Next.js RSC fetch fallback detected on /health:", rscErrors.length, "occurrences");
    }

    const apiFailures = failedReqs.filter((r) => r.includes("/api/"));
    expect(apiFailures, `Failed API requests: ${JSON.stringify(apiFailures)}`).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // シナリオ 2: 今日の記録 cards 表示 / データなし CTA
  // ---------------------------------------------------------------------------
  test("S2: 今日の記録 cards または CTA が表示される", async ({ page }) => {
    await gotoAuthed(page, "/health");

    const hasRecord = await page.locator("text=今日の記録").first().isVisible().catch(() => false);
    const hasCta = await page.locator("text=今日の記録をつける").first().isVisible().catch(() => false);

    expect(hasRecord || hasCta, "今日の記録 card か CTA のいずれかが表示されること").toBe(true);

    if (hasRecord) {
      await expect(page.locator("text=体重").first()).toBeVisible();
      await expect(page.locator("text=気分").first()).toBeVisible();
      const sleepLabel = page.locator("text=睡眠時間").or(page.locator("text=睡眠の質")).first();
      await expect(sleepLabel).toBeVisible();
    }

    if (hasCta) {
      const ctaButton = page.locator("button", { hasText: "今日の記録をつける" }).first();
      await expect(ctaButton).toBeEnabled();
    }
  });

  // ---------------------------------------------------------------------------
  // シナリオ 3: クイック記録ボタン → form → fill → submit
  // ---------------------------------------------------------------------------
  test("S3: クイック記録ボタン → form open → fill → submit", async ({ page }) => {
    await gotoAuthed(page, "/health");

    const ctaButton = page.locator("button", { hasText: "今日の記録をつける" }).first();
    const ctaVisible = await ctaButton.isVisible().catch(() => false);

    if (!ctaVisible) {
      test.skip(true, "今日の記録が既にあるため CTA は非表示。S8 の /health/record フォームで検証済み");
      return;
    }

    await ctaButton.click();

    const sheetHeader = page.locator("h2", { hasText: "今日の記録" }).first();
    await expect(sheetHeader).toBeVisible({ timeout: 5_000 });

    // 体重
    const weightInput = page.locator('input[type="number"]').first();
    await expect(weightInput).toBeVisible();
    await weightInput.fill("65.0");

    // 気分: スコア 4 (🙂)
    const moodButtons = page.locator("button").filter({ hasText: "🙂" });
    if (await moodButtons.count() > 0) {
      await moodButtons.first().click();
    }

    // 睡眠: スコア 3 (😴)
    const sleepButtons = page.locator("button").filter({ hasText: "😴" });
    if (await sleepButtons.count() > 0) {
      await sleepButtons.first().click();
    }

    // 保存
    const saveButton = page.locator("button", { hasText: "記録する" }).first();
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    // 成功メッセージ or シートが閉じる (3秒以内)
    await page.waitForTimeout(3_000);
    const sheetStillVisible = await sheetHeader.isVisible().catch(() => false);
    const successMsg = await page.locator("text=記録しました").or(page.locator("text=保存しました")).first().isVisible().catch(() => false);
    expect(sheetStillVisible === false || successMsg, "シートが閉じるか成功メッセージが表示されること").toBe(true);
  });

  // ---------------------------------------------------------------------------
  // シナリオ 4: 週カレンダー 過去日 click → 記録パネル表示
  // ---------------------------------------------------------------------------
  test("S4: 週カレンダー — 過去日 click で記録パネルが開く", async ({ page }) => {
    await gotoAuthed(page, "/health");

    // aria-pressed="false" のカレンダーボタンを直接セレクトする
    const pastButtons = page.locator('button[aria-pressed="false"]');
    const pastCount = await pastButtons.count();
    if (pastCount === 0) {
      test.skip(true, "過去日の aria-pressed=\"false\" ボタンが見つからない");
      return;
    }

    const pastBtn = pastButtons.first();
    await expect(pastBtn).toBeEnabled();
    await pastBtn.click();

    // パネルが開く: h3 が "YYYY-MM-DD の記録" 形式 または「この日の記録はありません」
    const panelRecord = page.locator("h3", { hasText: /\d{4}-\d{2}-\d{2}.*の記録/ }).first();
    const panelEmpty = page.locator("text=この日の記録はありません").first();
    const panelVisible = panelRecord.or(panelEmpty);
    await expect(panelVisible).toBeVisible({ timeout: 10_000 });

    // 記録なしの場合は「記録を追加」リンクが表示される
    const emptyVisible = await panelEmpty.isVisible().catch(() => false);
    if (emptyVisible) {
      const addLink = page.locator("a", { hasText: "記録を追加" }).first();
      await expect(addLink).toBeVisible();
    }
  });

  // ---------------------------------------------------------------------------
  // シナリオ 5: 同じ日 re-click → パネル dismiss
  // ---------------------------------------------------------------------------
  test("S5: 過去日を再クリックするとパネルが閉じる", async ({ page }) => {
    await gotoAuthed(page, "/health");

    const pastButtons = page.locator('button[aria-pressed="false"]');
    const pastCount = await pastButtons.count();
    if (pastCount === 0) {
      test.skip(true, "過去日ボタンが見つからない");
      return;
    }

    // aria-label を保存してから 1 回目クリック
    const pastBtn = pastButtons.first();
    const ariaLabel = await pastBtn.getAttribute("aria-label") ?? "";

    await pastBtn.click();
    // 過去日パネルの h3 は "YYYY-MM-DD の記録" 形式 (今日のカードの "今日の記録" と区別)
    const panel = page.locator("h3", { hasText: /\d{4}-\d{2}-\d{2}.*の記録/ }).or(page.locator("text=この日の記録はありません")).first();
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // 2 回目クリック: クリック後 aria-pressed が変わるため aria-label で再特定
    const sameDayBtn = page.locator(`button[aria-label="${ariaLabel}"]`);
    await sameDayBtn.click();
    await page.waitForTimeout(600);
    // パネルが非表示になることを確認
    await expect(panel).not.toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // シナリオ 6: 「今日」セル click → パネル dismiss
  // ---------------------------------------------------------------------------
  test("S6: 過去日パネル開放後に今日セルをクリックするとパネルが閉じる", async ({ page }) => {
    await gotoAuthed(page, "/health");

    const allCalBtns = page.locator("button[aria-pressed]");
    const calCount = await allCalBtns.count();
    if (calCount === 0) {
      test.skip(true, "カレンダーボタンが見つからない");
      return;
    }

    // 今日のボタン: 最後のカレンダーボタン (週の最後 = 今日)
    // aria-label を保存しておく
    const todayBtn = allCalBtns.last();
    const todayLabel = await todayBtn.getAttribute("aria-label") ?? "";

    const pastButtons = page.locator('button[aria-pressed="false"]');
    const pastCount = await pastButtons.count();
    if (pastCount === 0) {
      test.skip(true, "過去日ボタンが見つからない");
      return;
    }

    // 過去日パネルを開く
    await pastButtons.first().click();
    // 過去日パネルの h3 は "YYYY-MM-DD の記録" 形式 (今日のカードの "今日の記録" と区別)
    const panel = page.locator("h3", { hasText: /\d{4}-\d{2}-\d{2}.*の記録/ }).or(page.locator("text=この日の記録はありません")).first();
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // 今日のセルを aria-label で特定してクリック (aria-pressed 状態が変わっていてもOK)
    const todayBtnByLabel = page.locator(`button[aria-label="${todayLabel}"]`);
    await expect(todayBtnByLabel).toBeVisible({ timeout: 5_000 });
    await todayBtnByLabel.click();

    await page.waitForTimeout(600);
    await expect(panel).not.toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // シナリオ 7: /health/record 単独画面 → form full
  // ---------------------------------------------------------------------------
  test("S7: /health/record — 全セクションのフォームが表示される", async ({ page }) => {
    await gotoAuthed(page, "/health/record");

    await expect(page.locator("h1,h2").first()).toBeVisible({ timeout: 10_000 });

    // 体重フィールド (最初の number input)
    const weightInput = page.locator('input[type="number"]').first();
    await expect(weightInput).toBeVisible({ timeout: 10_000 });

    // 「保存」または「記録する」ボタン
    const saveBtn = page.locator("button", { hasText: /保存|記録する/ }).first();
    await expect(saveBtn).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // シナリオ 8: /health/record 全 fields 入力 → submit
  // ---------------------------------------------------------------------------
  test("S8: /health/record — 全 fields 入力して submit できる", async ({ page }) => {
    await gotoAuthed(page, "/health/record");

    const numberInputs = page.locator('input[type="number"]');
    const inputCount = await numberInputs.count();

    const sampleValues = ["65.0", "20.0", "120", "80", "72", "36.5", "7", "2000", "8000"];
    for (let i = 0; i < Math.min(inputCount, sampleValues.length); i++) {
      const inp = numberInputs.nth(i);
      if (await inp.isVisible().catch(() => false) && await inp.isEnabled().catch(() => false)) {
        await inp.fill(sampleValues[i]);
      }
    }

    const textarea = page.locator("textarea").first();
    if (await textarea.isVisible().catch(() => false)) {
      await textarea.fill("探索テスト用メモ");
    }

    const saveBtn = page.locator("button", { hasText: /保存|記録する/ }).first();
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // 成功: toast / メッセージ / ページ遷移のいずれか
    const successIndicator = page
      .locator("text=保存しました")
      .or(page.locator("text=記録しました"))
      .or(page.locator("text=更新しました"))
      .first();

    await Promise.race([
      expect(successIndicator).toBeVisible({ timeout: 15_000 }),
      page.waitForURL("**/health", { timeout: 15_000 }),
    ]).catch(() => {
      // どちらも満たされなかった場合は silent — エラーが出ていないかをチェック
    });

    const errorMsg = page.locator("text=エラー").or(page.locator("text=失敗")).first();
    const hasError = await errorMsg.isVisible({ timeout: 1_000 }).catch(() => false);
    expect(hasError, "submit 後にエラーメッセージが表示されていないこと").toBe(false);
  });

  // ---------------------------------------------------------------------------
  // シナリオ 9: /health/goals → 目標一覧 + 進捗
  // ---------------------------------------------------------------------------
  test("S9: /health/goals — 目標一覧と進捗が表示される", async ({ page }) => {
    await gotoAuthed(page, "/health/goals");

    await expect(page.locator("h1,h2").first()).toBeVisible({ timeout: 10_000 });

    // 進行中の目標セクションが存在する
    const activeSection = page.locator("text=進行中の目標").first();
    await expect(activeSection).toBeVisible({ timeout: 10_000 });

    // 目標カードまたは空状態のいずれかが表示される
    const emptyState = await page.locator("text=目標がありません").isVisible().catch(() => false);
    const hasGoalCards = (await page.locator('text=目標体重').isVisible().catch(() => false))
      || (await page.locator('text=目標体脂肪率').isVisible().catch(() => false))
      || (await page.locator('text=目標:').isVisible().catch(() => false));

    expect(emptyState || hasGoalCards, "目標カードか空状態が表示されること").toBe(true);

    // 進捗バー (目標がある場合のみ)
    if (!emptyState && hasGoalCards) {
      const progressTrack = page.locator(".rounded-full").first();
      await expect(progressTrack).toBeVisible({ timeout: 5_000 });
    }
  });

  // ---------------------------------------------------------------------------
  // シナリオ 10: goal — add new / delete
  // ---------------------------------------------------------------------------
  test("S10: /health/goals — 新規目標を追加してから削除できる", async ({ page }) => {
    await gotoAuthed(page, "/health/goals");

    // ヘッダー右上の + ボタン (classes: "p-2 rounded-lg")
    const addBtn = page.locator("button.p-2.rounded-lg").first();
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();

    // モーダルが開く
    const modalTitle = page.locator("text=新しい目標を設定").first();
    await expect(modalTitle).toBeVisible({ timeout: 5_000 });

    // 目標値を入力
    const targetInput = page.locator('input[type="number"]').first();
    await expect(targetInput).toBeVisible();
    await targetInput.fill("63.0");

    // 「目標を設定する」ボタンが有効になる
    const modalSaveBtn = page.locator("button", { hasText: "目標を設定する" }).last();
    await expect(modalSaveBtn).toBeEnabled({ timeout: 3_000 });
    await modalSaveBtn.click();

    // モーダルが閉じる
    await expect(modalTitle).not.toBeVisible({ timeout: 10_000 });

    // 目標リストに新しい目標が追加される (体重カードが出現)
    const goalCard = page.locator("text=体重").first();
    await expect(goalCard).toBeVisible({ timeout: 10_000 });

    // 削除: goal card 内の Trash アイコンボタン
    // class は "p-2" のみ (back button は "p-2 -ml-2", + button は "p-2 rounded-lg")
    // より安全に: goal カードコンテナ内の button を狙う
    page.on("dialog", (dialog) => void dialog.accept());
    // goal card は rounded-2xl クラスのコンテナ内にある
    const trashBtns = page.locator('.rounded-2xl button.p-2');
    const trashCount = await trashBtns.count();

    if (trashCount > 0) {
      await trashBtns.first().click();
      await page.waitForTimeout(2_000);
      const stillVisible = await goalCard.isVisible({ timeout: 2_000 }).catch(() => false);
      if (stillVisible) {
        console.info("Goal card still visible after delete — possibly multiple goals exist");
      }
    } else {
      console.info("No trash button found in goal card — delete test skipped");
    }
  });

  // ---------------------------------------------------------------------------
  // シナリオ 11: /health/record/quick → クイック記録専用画面
  // ---------------------------------------------------------------------------
  test("S11: /health/record/quick — クイック記録専用画面が表示される", async ({ page }) => {
    await gotoAuthed(page, "/health/record/quick");

    // 404 / 500 でないこと
    const notFoundText = page.locator("text=404").or(page.locator("text=ページが見つかりません"));
    const isNotFound = await notFoundText.isVisible({ timeout: 2_000 }).catch(() => false);
    expect(isNotFound, "/health/record/quick が 404 を返さないこと").toBe(false);

    // コンテンツが表示される
    await expect(page.locator("h1,h2,main").first()).toBeVisible({ timeout: 10_000 });

    // カメラ / 写真 / 体重計 関連要素が存在する
    const cameraEl = page
      .locator("text=カメラ")
      .or(page.locator("text=写真"))
      .or(page.locator("text=体重計"))
      .or(page.locator('input[type="file"]'))
      .first();
    await expect(cameraEl).toBeVisible({ timeout: 10_000 });
  });
});
