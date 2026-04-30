/**
 * Exploration spec: Onboarding
 *
 * 探索対象: /onboarding フロー全体
 * スクショ保存先: tests/e2e/.exploration/onboarding/screenshot-XX.png
 *
 * シナリオ一覧:
 *   S1  フローを最後まで完走（各 step 入力 + 次へ）
 *   S2  各 step の back ボタン
 *   S3  「栄養設計を計算中...」画面表示確認
 *   S4  完了後 /home redirect 確認
 *   S5  中断: 途中で別 URL → 再訪 /onboarding でどうなるか
 *   S6  既に onboarding 済ユーザーが /onboarding に来たら /home redirect されるか
 *   S7  validation: required フィールド空 submit / 不正値
 */

import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { login, E2E_USER } from "../fixtures/auth";

// ─── helpers ────────────────────────────────────────────────────────────────

const SS_DIR = path.resolve(
  __dirname,
  "onboarding"
);

let ssIndex = 0;
async function ss(page: Page, label: string) {
  ssIndex++;
  const num = String(ssIndex).padStart(2, "0");
  const filename = `screenshot-${num}-${label.replace(/[^\w-]/g, "_")}.png`;
  await page.screenshot({ path: path.join(SS_DIR, filename), fullPage: true });
}

/** onboarding 状態をリセットして未開始状態にする */
async function resetOnboardingStatus(page: Page) {
  // DELETE /api/onboarding/status でリセット
  const res = await page.request.delete("/api/onboarding/status");
  // 既にリセット済みでも無視
  return res.status();
}

/** onboarding_completed_at をセットして「完了済み」状態にする
 *  API が存在しないため POST /api/onboarding/complete を使用 */
async function markOnboardingComplete(page: Page) {
  await page.request.post("/api/onboarding/complete");
}

// ─── S1: フローを最後まで完走 ────────────────────────────────────────────────

test("S1: onboarding フローを最後まで完走して /home へ redirect される", async ({
  page,
  context,
}) => {
  // コンソールとネットワークを記録
  const consoleLogs: string[] = [];
  const networkRequests: { url: string; status: number }[] = [];

  page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("response", (res) => {
    if (res.url().includes("/api/") || res.url().includes("/onboarding")) {
      networkRequests.push({ url: res.url(), status: res.status() });
    }
  });

  await login(page);

  // onboarding 状態をリセット（未開始へ）
  // NOTE: DELETE /api/onboarding/status は completed_at をクリアしない既知の問題がある
  // そのため直接 /onboarding/questions に行ってフローを完走する
  await resetOnboardingStatus(page);

  // /onboarding/welcome → questions を直接開く（リセット不完全でも questions は直接開ける）
  await page.goto("/onboarding");
  await ss(page, "S1-01-onboarding-root-loading");

  // completed 状態なら /home に飛ぶ（これ自体は S6 の検証対象）
  // completed or in_progress でも questions に直接アクセスしてフローを完走できるか確認
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith("/home") ||
      url.pathname.startsWith("/onboarding/welcome") ||
      url.pathname.startsWith("/onboarding/questions") ||
      url.pathname.startsWith("/onboarding/resume"),
    { timeout: 15_000 }
  );
  const afterRootUrl = page.url();
  await ss(page, "S1-02-after-root-redirect");
  console.log("[探索] S1: /onboarding root redirect 先:", afterRootUrl);

  // 強制的に questions へ進む
  await page.goto("/onboarding/questions");
  await ss(page, "S1-03-questions-direct");
  await page.waitForURL(/\/onboarding\/questions/, { timeout: 10_000 });
  await ss(page, "S1-04-questions-first-step");

  // --- Step: nickname (text) ---
  await expect(page.getByPlaceholder("例: たろう")).toBeVisible({ timeout: 10_000 });
  await ss(page, "S1-05-question-nickname");
  await page.getByPlaceholder("例: たろう").fill("探索ユーザー");
  await page.locator("form").first().getByRole("button").click();

  // --- Step: gender (choice) ---
  await page.waitForTimeout(800); // typing animation
  await expect(page.getByRole("button", { name: /男性/ })).toBeVisible({ timeout: 8_000 });
  await ss(page, "S1-06-question-gender");
  await page.getByRole("button", { name: /男性/ }).click();

  // --- Step: body_stats (custom_stats) ---
  // label は for 属性なしのため placeholder で特定
  await page.waitForTimeout(800);
  await expect(page.getByPlaceholder("25")).toBeVisible({ timeout: 8_000 });
  await ss(page, "S1-07-question-body-stats");
  await page.getByPlaceholder("25").fill("30");
  await page.getByPlaceholder("会社員").fill("エンジニア");
  await page.getByPlaceholder("170").fill("170");
  await page.getByPlaceholder("60").fill("65");
  await page.getByRole("button", { name: "次へ" }).click();

  // --- Step: nutrition_goal (choice) ---
  await page.waitForTimeout(800);
  await expect(page.getByRole("button", { name: /現状維持/ })).toBeVisible({ timeout: 8_000 });
  await ss(page, "S1-08-question-nutrition-goal");
  await page.getByRole("button", { name: /現状維持/ }).click();

  // --- Step: exercise_types (multi_choice) ---
  await page.waitForTimeout(800);
  await expect(page.getByRole("button", { name: /ウォーキング/ })).toBeVisible({ timeout: 8_000 });
  await ss(page, "S1-09-question-exercise-types");
  await page.getByRole("button", { name: /ウォーキング/ }).click();
  await page.getByRole("button", { name: "次へ" }).click();

  // --- Steps: exercise_frequency, exercise_intensity, exercise_duration ---
  for (const [label, btnName] of [
    ["exercise-frequency", "2日"],
    ["exercise-intensity", /普通/],
    ["exercise-duration", /30分〜1時間/],
  ]) {
    await page.waitForTimeout(800);
    await ss(page, `S1-10-question-${label}`);
    await page.getByRole("button", { name: btnName as string | RegExp }).first().click();
  }

  // --- Step: work_style (choice) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-11-question-work-style");
  await page.getByRole("button", { name: /デスクワーク/ }).click();

  // --- Step: health_conditions (multi_choice + allowSkip) ---
  // スキップボタンは2つある（ヘッダーと入力エリア）→ .nth(1) でフォーム内のものを使う
  await page.waitForTimeout(800);
  await expect(page.getByText("気になる健康状態はありますか")).toBeVisible({ timeout: 8_000 });
  await ss(page, "S1-12-question-health-conditions");
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // --- Step: body_concerns (multi_choice + allowSkip) ---
  await page.waitForTimeout(800);
  await expect(page.getByText("体の悩みはありますか")).toBeVisible({ timeout: 8_000 });
  await ss(page, "S1-13-question-body-concerns");
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // --- Step: sleep_quality (choice: 良好/普通/悪い) ---
  await page.waitForTimeout(800);
  await expect(page.getByRole("button", { name: /良好/ })).toBeVisible({ timeout: 8_000 });
  await ss(page, "S1-14-question-sleep");
  await page.getByRole("button", { name: /良好/ }).click();

  // --- Step: stress_level (choice: 低い/普通/高い) ---
  await page.waitForTimeout(800);
  await expect(page.getByRole("button", { name: /低い/ })).toBeVisible({ timeout: 8_000 });
  await ss(page, "S1-15-question-stress");
  await page.getByRole("button", { name: /低い/ }).click();

  // --- Step: medications (multi_choice + allowSkip) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-16-question-medications");
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // --- Step: allergies (tags + allowSkip) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-17-question-allergies");
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // --- Step: dislikes (tags + allowSkip) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-18-question-dislikes");
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // --- Step: favorite_ingredients (tags + allowSkip) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-19-question-favorites");
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // --- Step: diet_style (choice + allowSkip) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-20-question-diet-style");
  await page.getByRole("button", { name: /通常/ }).first().click();

  // --- Step: cooking_experience (choice) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-21-question-cooking-experience");
  await page.getByRole("button", { name: /中級者/ }).first().click();

  // --- Step: cooking_time (choice) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-22-question-cooking-time");
  await page.getByRole("button", { name: /30分以内/ }).click();

  // --- Step: cuisine_preference (multi_choice) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-23-question-cuisine");
  await page.getByRole("button", { name: /和食/ }).click();
  await page.getByRole("button", { name: "次へ" }).click();

  // --- Step: family_size (number) ---
  await page.waitForTimeout(800);
  await expect(page.getByPlaceholder("例: 4")).toBeVisible({ timeout: 8_000 });
  await ss(page, "S1-24-question-family-size");
  await page.getByPlaceholder("例: 4").fill("2");
  await page.locator("form").getByRole("button").click();

  // --- Step: servings_grid ---
  await page.waitForTimeout(800);
  await ss(page, "S1-25-question-servings-grid");
  await page.getByRole("button", { name: "次へ" }).click();

  // --- Step: shopping_frequency (choice) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-26-question-shopping");
  await page.getByRole("button", { name: /週2〜3回/ }).click();

  // --- Step: weekly_food_budget (choice + allowSkip) ---
  // choice タイプは UI 上スキップボタンなし → 選択肢を選ぶ
  await page.waitForTimeout(800);
  await ss(page, "S1-27-question-budget");
  await page.getByRole("button", { name: /特に決めていない/ }).click();

  // --- Step: kitchen_appliances (multi_choice + allowSkip) ---
  // スキップ: nth(1) = フォーム内のスキップ, nth(0) = ヘッダーのスキップ全体
  await page.waitForTimeout(800);
  await ss(page, "S1-28-question-appliances");
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // --- Step: stove_type (choice) ---
  await page.waitForTimeout(800);
  await ss(page, "S1-29-question-stove");
  await page.getByRole("button", { name: /ガスコンロ/ }).click();

  // --- Step: hobbies (tags + allowSkip) ---
  // nth(1) = フォーム内のスキップ（ヘッダーと合計2個）
  await page.waitForTimeout(800);
  await ss(page, "S1-30-question-hobbies");
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // S3: 栄養設計を計算中... 画面
  // 最後のステップ回答後、isCalculating=true になるタイミングをキャプチャ
  await page.waitForTimeout(300);
  const calculatingText = page.getByText("栄養設計を計算中...");
  const calculatingVisible = await calculatingText.isVisible().catch(() => false);
  if (calculatingVisible) {
    await ss(page, "S3-calculating-screen");
    console.log("[探索] 栄養設計を計算中... 画面を確認");
  } else {
    // タイミングによっては既に遷移済み
    console.warn("[探索] 計算中画面はタイミングにより捕捉できなかった");
  }

  // S4: /onboarding/complete → /home redirect の確認
  // complete ページへの遷移を待つ (2500ms timer)
  await page.waitForURL(/\/onboarding\/complete|\/home/, { timeout: 15_000 });
  await ss(page, "S4-01-after-questions-redirect");

  if (page.url().includes("/onboarding/complete")) {
    console.log("[探索] /onboarding/complete ページに到達");
    await ss(page, "S4-02-complete-page");
    // 「この設定で始める」クリックで /home へ
    const startBtn = page.getByRole("link", { name: "この設定で始める" });
    await expect(startBtn).toBeVisible({ timeout: 8_000 });
    await startBtn.click();
    await page.waitForURL(/\/home/, { timeout: 10_000 });
    await ss(page, "S4-03-home-after-complete");
    console.log("[探索] /home への redirect を確認");
  }

  await expect(page).toHaveURL(/\/home/);

  // コンソール・ネットワークサマリ
  const errors = consoleLogs.filter((l) => l.includes("[error]"));
  if (errors.length > 0) {
    console.warn("[探索] Console errors:", errors);
  }
  console.log("[探索] Network requests:", networkRequests.map((r) => `${r.status} ${r.url}`));
});

// ─── S2: back ボタン ─────────────────────────────────────────────────────────

test("S2: back ボタンで前のステップに戻れる", async ({ page }) => {
  const consoleLogs: string[] = [];
  page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

  await login(page);
  await resetOnboardingStatus(page);

  await page.goto("/onboarding/questions");
  await expect(page.getByPlaceholder("例: たろう")).toBeVisible({ timeout: 10_000 });
  await ss(page, "S2-01-step1-nickname");

  // Step 1: nickname 入力
  await page.getByPlaceholder("例: たろう").fill("テストユーザー");
  await page.locator("form").first().getByRole("button").click();

  // Step 2: gender が表示されるのを待つ
  await page.waitForTimeout(800);
  await expect(page.getByRole("button", { name: /男性/ })).toBeVisible({ timeout: 8_000 });
  await ss(page, "S2-02-step2-gender");

  // back ボタンが表示されているか確認
  const backBtn = page.locator("button").filter({ has: page.locator("svg") }).first();
  // back ボタンは SVG を持つ丸いボタン
  const backBtnVisible = await backBtn.isVisible().catch(() => false);

  if (backBtnVisible) {
    await backBtn.click();
    await page.waitForTimeout(600);
    await ss(page, "S2-03-after-back-should-be-step1");

    // Step 1 に戻っているか確認
    const nicknameInput = await page.getByPlaceholder("例: たろう").isVisible().catch(() => false);
    if (nicknameInput) {
      console.log("[探索] back ボタンで Step1 に戻ることを確認");
    } else {
      console.warn("[探索][BUG候補] back 後に nickname 入力欄が表示されない");
    }
  } else {
    // Step 1 では履歴がないので back ボタンは非表示が正常
    // → Step 2 で back ボタンが見えるはず
    await page.getByRole("button", { name: /男性/ }).click();
    await page.waitForTimeout(800);
    await ss(page, "S2-04-step3-body-stats");

    const backBtnAtStep3 = page.locator("button").filter({ has: page.locator("svg path[d*='M15 19']") });
    const backVisibleStep3 = await backBtnAtStep3.isVisible().catch(() => false);
    if (backVisibleStep3) {
      await backBtnAtStep3.click();
      await page.waitForTimeout(600);
      await ss(page, "S2-05-after-back-step2");
      console.log("[探索] Step3 → Step2 の back を確認");
    } else {
      console.warn("[探索] back ボタンが見つからなかった");
    }
  }

  const errors = consoleLogs.filter((l) => l.includes("[error]"));
  if (errors.length > 0) console.warn("[探索] Console errors:", errors);
});

// ─── S3: 計算中画面 (standalone) ─────────────────────────────────────────────

test("S3: 栄養設計を計算中... 画面を専用に確認", async ({ page }) => {
  /**
   * 最後の質問に答えた瞬間に isCalculating=true になり 2500ms 表示される。
   * このテストでは最短ルートで最終ステップまで進める。
   * 実際には S1 で既にカバー済みだが、単独でも確認できるようにする。
   */
  await login(page);
  await resetOnboardingStatus(page);

  await page.goto("/onboarding/questions");
  await expect(page.getByPlaceholder("例: たろう")).toBeVisible({ timeout: 10_000 });

  // nickname
  await page.getByPlaceholder("例: たろう").fill("S3User");
  await page.locator("form").first().getByRole("button").click();

  // gender → 女性 (pregnancy_status が追加されるが skip)
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /回答しない/ }).click();

  // body_stats (label は for 属性なし → placeholder で特定)
  await page.waitForTimeout(800);
  await expect(page.getByPlaceholder("25")).toBeVisible({ timeout: 8_000 });
  await page.getByPlaceholder("25").fill("25");
  await page.getByPlaceholder("会社員").fill("学生");
  await page.getByPlaceholder("170").fill("160");
  await page.getByPlaceholder("60").fill("55");
  await page.getByRole("button", { name: "次へ" }).click();

  // nutrition_goal → 現状維持 (target_weight/target_date/weight_change_rate をスキップ)
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /現状維持/ }).click();

  // exercise_types → 運動していない
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /運動していない/ }).click();
  await page.getByRole("button", { name: "次へ" }).click();

  // work_style
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /デスクワーク/ }).click();

  // health_conditions → skip (nth(1): フォーム内のスキップボタン)
  await page.waitForTimeout(800);
  await expect(page.getByText("気になる健康状態はありますか")).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // body_concerns → skip
  await page.waitForTimeout(800);
  await expect(page.getByText("体の悩みはありますか")).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // sleep_quality (良好/普通/悪い)
  await page.waitForTimeout(800);
  await expect(page.getByRole("button", { name: /良好/ })).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: /良好/ }).click();

  // stress_level (低い/普通/高い)
  await page.waitForTimeout(800);
  await expect(page.getByRole("button", { name: /低い/ })).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: /低い/ }).click();

  // medications → skip
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // allergies → skip
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // dislikes → skip
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // favorite_ingredients → skip
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // diet_style → 通常 or skip
  await page.waitForTimeout(800);
  const dietStyleSkip = page.getByRole("button", { name: "スキップ" }).nth(1);
  const dietStyleSkipVisible = await dietStyleSkip.isVisible().catch(() => false);
  if (dietStyleSkipVisible) {
    await dietStyleSkip.click();
  } else {
    await page.getByRole("button", { name: /通常/ }).first().click();
  }

  // cooking_experience
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /初心者/ }).click();

  // cooking_time
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /15分以内/ }).click();

  // cuisine_preference → 和食
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /和食/ }).click();
  await page.getByRole("button", { name: "次へ" }).click();

  // family_size
  await page.waitForTimeout(800);
  await page.getByPlaceholder("例: 4").fill("1");
  await page.locator("form").getByRole("button").click();

  // servings_grid
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "次へ" }).click();

  // shopping_frequency
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /毎日買い物/ }).click();

  // weekly_food_budget → choice タイプのため選択肢を選ぶ（UIにスキップボタンなし）
  await page.waitForTimeout(800);
  await expect(page.getByRole("button", { name: /特に決めていない/ })).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: /特に決めていない/ }).click();

  // kitchen_appliances → skip (nth(1): フォーム内スキップ)
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // stove_type → ガス
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /ガスコンロ/ }).click();

  // hobbies → skip (最後の質問)
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "スキップ" }).nth(1).click();

  // 計算中画面をキャプチャ（300ms 以内）
  await page.waitForTimeout(200);
  await ss(page, "S3-calculating-standalone");

  const calculatingVisible = await page.getByText("栄養設計を計算中...").isVisible().catch(() => false);
  if (calculatingVisible) {
    console.log("[探索] S3: 栄養設計を計算中... 画面を確認できた");
  } else {
    console.warn("[探索] S3: 計算中画面はタイミングにより捕捉できなかった（遷移済みの可能性）");
  }

  // /onboarding/complete または /home に遷移することを確認
  await page.waitForURL(/\/onboarding\/complete|\/home/, { timeout: 15_000 });
  await ss(page, "S3-after-calculating");
  console.log("[探索] S3: 計算後の遷移先:", page.url());
});

// ─── S5: 中断 → 再訪 ─────────────────────────────────────────────────────────

test("S5: フロー途中で別 URL → 再訪 /onboarding でどうなるか", async ({ page }) => {
  const consoleLogs: string[] = [];
  const networkLogs: { url: string; status: number }[] = [];
  page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("response", (res) => {
    if (res.url().includes("/api/onboarding")) {
      networkLogs.push({ url: res.url(), status: res.status() });
    }
  });

  await login(page);
  await resetOnboardingStatus(page);

  // Step 1 まで進める
  await page.goto("/onboarding/questions");
  await expect(page.getByPlaceholder("例: たろう")).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder("例: たろう").fill("中断テスト");
  await page.locator("form").first().getByRole("button").click();

  // Step 2 の progress が保存されるのを待つ
  await page.waitForTimeout(1200);
  await ss(page, "S5-01-mid-flow");

  // 別ページへ移動（中断）
  await page.goto("/home");
  await ss(page, "S5-02-interrupted-to-home");
  console.log("[探索] S5: 中断して /home に移動");

  // 再訪
  await page.goto("/onboarding");
  await ss(page, "S5-03-revisit-onboarding-root");

  // status を確認
  // NOTE: E2Eユーザーが completed 状態の場合は /home に飛ぶ（DELETE が completed_at をクリアしないため）
  // in_progress 状態の場合は /onboarding/resume に飛ぶはず
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith("/home") ||
      url.pathname.startsWith("/onboarding/resume") ||
      url.pathname.startsWith("/onboarding/questions") ||
      url.pathname.startsWith("/onboarding/welcome"),
    { timeout: 10_000 }
  );
  const redirectedTo = page.url();
  await ss(page, "S5-04-after-revisit-redirect");
  console.log("[探索] S5: 再訪後の redirect 先:", redirectedTo);

  if (redirectedTo.includes("/onboarding/resume")) {
    console.log("[探索] S5 OK: resume ページにリダイレクトされた（progress 保存が機能）");
  } else if (redirectedTo.includes("/onboarding/welcome")) {
    console.warn("[探索][BUG候補] S5: welcome にリダイレクトされた（progress が保存されていない可能性）");
  } else if (redirectedTo.includes("/home")) {
    console.warn("[探索][BUG候補] S5: DELETE が completed_at をクリアしないため /home に redirect。途中中断後に /onboarding で resume できない");
  } else {
    console.warn("[探索] S5: 予期しない redirect 先:", redirectedTo);
  }

  console.log("[探索] S5 ネットワーク:", networkLogs);
  const errors = consoleLogs.filter((l) => l.includes("[error]"));
  if (errors.length > 0) console.warn("[探索] Console errors:", errors);
});

// ─── S6: 完了済みユーザー → /onboarding で /home redirect ────────────────────

test("S6: onboarding 完了済みユーザーが /onboarding を訪れると /home に redirect される", async ({
  page,
}) => {
  const consoleLogs: string[] = [];
  const networkLogs: { url: string; status: number }[] = [];
  page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("response", (res) => {
    if (res.url().includes("/api/onboarding") || res.url().includes("/onboarding")) {
      networkLogs.push({ url: res.url(), status: res.status() });
    }
  });

  await login(page);

  // 完了済み状態にする
  await markOnboardingComplete(page);
  await ss(page, "S6-01-marked-complete");
  console.log("[探索] S6: onboarding を complete 状態にした");

  // /onboarding へアクセス
  await page.goto("/onboarding");
  await ss(page, "S6-02-onboarding-after-complete");

  // /home へ redirect されるはず（/onboarding/complete は除外）
  // status=completed → page.tsx が router.replace('/home') を呼ぶ
  await page.waitForURL(
    (url) => url.pathname.startsWith("/home") || url.pathname.startsWith("/onboarding/resume") || url.pathname.startsWith("/onboarding/welcome"),
    { timeout: 10_000 }
  );
  const finalUrl = page.url();
  await ss(page, "S6-03-final-redirect");
  console.log("[探索] S6: redirect 先:", finalUrl);

  if (finalUrl.includes("/home")) {
    console.log("[探索] S6 OK: /home へ redirect された");
  } else {
    console.warn("[探索][BUG候補] S6: 完了済みなのに /home へ redirect されなかった → 実際:", finalUrl);
  }

  expect(page.url()).toContain("/home");

  console.log("[探索] S6 ネットワーク:", networkLogs);
  const errors = consoleLogs.filter((l) => l.includes("[error]"));
  if (errors.length > 0) console.warn("[探索] Console errors:", errors);
});

// ─── S7: validation ──────────────────────────────────────────────────────────

test("S7: required フィールド空 submit / 不正値でバリデーションが機能するか", async ({
  page,
}) => {
  const consoleLogs: string[] = [];
  page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

  await login(page);
  await resetOnboardingStatus(page);

  await page.goto("/onboarding/questions");
  await expect(page.getByPlaceholder("例: たろう")).toBeVisible({ timeout: 10_000 });
  await ss(page, "S7-01-step1-empty");

  // S7-A: nickname 空のまま submit ボタンが disabled か確認
  const submitBtn = page.locator("form").first().getByRole("button");
  const isDisabledEmpty = await submitBtn.isDisabled();
  if (isDisabledEmpty) {
    console.log("[探索] S7-A OK: 空 nickname では submit ボタンが disabled");
  } else {
    console.warn("[探索][BUG候補] S7-A: 空 nickname でも submit ボタンが有効");
    // 実際に submit して次のステップに移動しないか確認
    await submitBtn.click();
    await page.waitForTimeout(500);
    const stillOnStep1 = await page.getByPlaceholder("例: たろう").isVisible().catch(() => false);
    if (!stillOnStep1) {
      console.warn("[探索][BUG] S7-A: 空のまま次のステップに進んでしまった");
    }
  }
  await ss(page, "S7-02-empty-submit-state");

  // S7-B: number フィールドの範囲外値（family_size）
  // まず nickname → gender → body_stats → nutrition_goal → exercise → ... と進めて family_size まで行く
  // ショートカット: 直接 family_size ステップへは行けないので questions を一通り進める
  // ここでは nickname 入力 → gender まで進めて family_size の入力ステップは検証のみ確認済み
  await page.getByPlaceholder("例: たろう").fill("バリデーションテスト");
  await submitBtn.click();

  // gender step
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /回答しない/ }).click();

  // body_stats step
  await page.waitForTimeout(800);
  // body_stats: label は for 属性なし → placeholder で特定
  await expect(page.getByPlaceholder("25")).toBeVisible({ timeout: 8_000 });
  const ageInput = page.getByPlaceholder("25");
  await ageInput.fill(""); // 空のまま
  const nextBtn = page.getByRole("button", { name: "次へ" });
  const disabledWhenEmpty = await nextBtn.isDisabled();
  if (disabledWhenEmpty) {
    console.log("[探索] S7-B OK: body_stats の必須フィールドが空では disabled");
  } else {
    console.warn("[探索][BUG候補] S7-B: 必須フィールド空でも 次へ が有効");
  }
  await ss(page, "S7-03-body-stats-empty-age");

  // S7-C: number 範囲外入力（height=0, weight=-1）
  await page.getByPlaceholder("25").fill("25");
  await page.getByPlaceholder("会社員").fill("テスト");
  await page.getByPlaceholder("170").fill("0"); // 不正値
  await page.getByPlaceholder("60").fill("-1"); // 不正値
  const disabledInvalid = await nextBtn.isDisabled();
  // body_stats は HTML の type=number バリデーションに依存
  // disabled かどうかよりブラウザが弾くか確認
  if (disabledInvalid) {
    console.log("[探索] S7-C: 不正な height/weight では disabled");
  } else {
    console.log("[探索] S7-C: 不正値でも disabled にならない（body_stats は min/max 制約なし）");
  }
  await ss(page, "S7-04-body-stats-invalid-values");

  const errors = consoleLogs.filter((l) => l.includes("[error]"));
  if (errors.length > 0) console.warn("[探索] Console errors:", errors);
});
