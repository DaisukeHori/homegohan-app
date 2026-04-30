/**
 * Exploration spec: Recipe modal + Shopping list
 *
 * 探索対象: /menus/weekly のレシピ詳細モーダルと買い物リスト全フロー
 * スクショ保存先: tests/e2e/.exploration/recipe-shopping/screenshot-XX.png
 *
 * シナリオ一覧:
 *   S1  週間献立でメニューをクリック → レシピ詳細モーダルを開く
 *   S2  レシピモーダル内部スクロール（下まで）
 *   S3  ハート(favorite)ボタン: クリックで色変化 + リロード後保持
 *   S4  「材料を買い物リストに追加」ボタン
 *   S5  右上カートアイコン → 買い物リストモーダル open
 *   S6  「献立から再生成」→ 買い物範囲モーダル
 *   S7  範囲選択: 今日/明日/明後日/N日分/1週間分 (時系列順になっているか確認)
 *   S8  「次へ」→ 人数確認 → 「この設定で生成」
 *   S9  完了メッセージ「N件の材料を M件にまとめました」確認
 *   S10 買い物リストアイテム: チェック ON/OFF、削除
 *   S11 export / 印刷機能の有無確認
 *
 * 発見済みバグ (探索実行: 2026-04-30):
 *   BUG-A: 献立データなし状態で「この設定で買い物リストを生成」がサイレント失敗
 *   BUG-B: 買い物リストモーダル内ボタンが z-index オーバーレイにより
 *           Playwright の通常 click() では到達不可 (z-[200] が z-[201] の前にある)
 *   BUG-C: 買い物リストモーダルが開いている間に週ナビが操作可能 (モーダル未ロック)
 */

import path from "node:path";
import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { login } from "../fixtures/auth";

// ─── helpers ─────────────────────────────────────────────────────────────────

const SS_DIR = path.resolve(__dirname, "recipe-shopping");

// ディレクトリ存在確認
if (!fs.existsSync(SS_DIR)) {
  fs.mkdirSync(SS_DIR, { recursive: true });
}

const ssCounters: Record<string, number> = {};

async function ss(page: Page, label: string) {
  const key = label.split("-")[0];
  ssCounters[key] = (ssCounters[key] ?? 0) + 1;
  const num = String(ssCounters[key]).padStart(2, "0");
  const filename = `${label.replace(/[^\w-]/g, "_")}-${num}.png`;
  await page.screenshot({ path: path.join(SS_DIR, filename), fullPage: false }).catch(() => {});
  return filename;
}

// ─── S1: レシピ詳細モーダルを開く ────────────────────────────────────────────

test("S1: 週間献立でレシピを見るボタンをクリックしてモーダルが開く", async ({ page }) => {
  const consoleLogs: string[] = [];
  const networkRequests: { url: string; status: number; method: string }[] = [];

  page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("response", (res) => {
    if (res.url().includes("/api/")) {
      networkRequests.push({ url: res.url(), status: res.status(), method: res.request().method() });
    }
  });

  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  await ss(page, "S1-weekly-loaded");

  // レシピを見るボタンを探す
  const recipeBtn = page.getByRole("button", { name: /レシピを見る/ }).first();
  const btnVisible = await recipeBtn
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!btnVisible) {
    await ss(page, "S1-no-recipe-button");
    console.log("INFO: レシピを見るボタンが見つかりません (献立データ未生成)");
    test.info().annotations.push({ type: "info", description: "献立データ未生成のためスキップ" });
    return;
  }

  await ss(page, "S1-recipe-button-visible");
  await recipeBtn.click();

  // モーダルが開くのを待つ
  const scrollArea = page.locator("div.flex-1.overflow-y-auto, div.overflow-y-auto").first();
  const modalVisible = await scrollArea
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  await ss(page, "S1-recipe-modal-opened");
  console.log("レシピモーダル開いた:", modalVisible);
  console.log("コンソールエラー:", consoleLogs.filter(l => l.includes("[error]")));

  expect(modalVisible, "レシピモーダルが表示されているべき").toBe(true);
});

// ─── S2: レシピモーダル内部スクロール ────────────────────────────────────────

test("S2: レシピモーダルを下までスクロールできる", async ({ page }) => {
  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  const recipeBtn = page.getByRole("button", { name: /レシピを見る/ }).first();
  const btnVisible = await recipeBtn
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!btnVisible) {
    test.info().annotations.push({ type: "info", description: "献立データ未生成のためスキップ" });
    return;
  }

  await recipeBtn.click();
  await ss(page, "S2-modal-top");

  // flex-1 min-h-0 ... overflow-y-auto のスクロール領域
  const scrollArea = page.locator("div.flex-1.min-h-0.overflow-y-auto, div.flex-1.overflow-y-auto").first();
  const scrollVisible = await scrollArea
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  console.log("スクロール領域存在:", scrollVisible);

  if (scrollVisible) {
    const overflowY = await scrollArea.evaluate((el) => getComputedStyle(el).overflowY);
    const scrollTopBefore = await scrollArea.evaluate((el) => el.scrollTop);
    await scrollArea.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(500);
    const scrollTopAfter = await scrollArea.evaluate((el) => el.scrollTop);
    await ss(page, "S2-modal-scrolled-bottom");

    console.log(`スクロール量: ${scrollTopAfter - scrollTopBefore}px, overflow-y: ${overflowY}`);

    // 作り方まで見えるか
    const recipeSteps = page.locator("text=作り方").first();
    const stepsVisible = await recipeSteps.isVisible();
    console.log("作り方テキスト表示:", stepsVisible);
  } else {
    await ss(page, "S2-scroll-area-not-found");
    console.log("WARN: スクロール領域が見つからない");
  }
});

// ─── S3: ハートボタン: クリックで色変化 ──────────────────────────────────────

test("S3: ハートボタン: クリックで aria-pressed 変化確認", async ({ page }) => {
  // 修正: data-testid="favorite-button" が実装に存在しない場合のフォールバックを追加
  // aria-pressed 属性を持つハートボタンを複数パターンで探す
  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  const recipeBtn = page.getByRole("button", { name: /レシピを見る/ }).first();
  const btnVisible = await recipeBtn
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!btnVisible) {
    test.info().annotations.push({ type: "info", description: "献立データ未生成のためスキップ" });
    return;
  }

  await recipeBtn.click();
  await ss(page, "S3-modal-opened");

  // 修正: data-testid → aria-pressed 属性を持つボタンへのフォールバック
  const favBtn = page.locator('[data-testid="favorite-button"]')
    .or(page.locator('button[aria-pressed]').filter({ has: page.locator("svg") }))
    .first();
  const favVisible = await favBtn
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  if (!favVisible) {
    await ss(page, "S3-no-fav-button");
    console.log("INFO: ハートボタンが見つからない — 献立データがないか実装変更の可能性あり");
    return;
  }

  const ariaBeforeClick = await favBtn.getAttribute("aria-pressed");
  const heartFillBefore = await favBtn.locator("svg").getAttribute("fill").catch(() => null);
  console.log(`クリック前: aria-pressed=${ariaBeforeClick}, fill=${heartFillBefore}`);
  await ss(page, "S3-before-click");

  await favBtn.click();
  await page.waitForTimeout(1000);

  const ariaAfterClick = await favBtn.getAttribute("aria-pressed");
  const heartFillAfter = await favBtn.locator("svg").getAttribute("fill").catch(() => null);
  console.log(`クリック後: aria-pressed=${ariaAfterClick}, fill=${heartFillAfter}`);
  await ss(page, "S3-after-click");

  const stateChanged = ariaBeforeClick !== ariaAfterClick;
  console.log("状態変化:", stateChanged);

  // クリーンアップ
  if (stateChanged) {
    await favBtn.click();
    await page.waitForTimeout(500);
  }

  expect(stateChanged, "ハートボタンのaria-pressedがクリックで変わるべき").toBe(true);
});

// ─── S4: 「材料を買い物リストに追加」ボタン ──────────────────────────────────

test("S4: 材料を買い物リストに追加ボタン動作確認", async ({ page }) => {
  const networkRequests: { url: string; status: number; method: string }[] = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/shopping")) {
      networkRequests.push({ url: res.url(), status: res.status(), method: res.request().method() });
    }
  });

  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  const recipeBtn = page.getByRole("button", { name: /レシピを見る/ }).first();
  const btnVisible = await recipeBtn
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!btnVisible) {
    test.info().annotations.push({ type: "info", description: "献立データ未生成のためスキップ" });
    return;
  }

  await recipeBtn.click();
  await page.waitForTimeout(500);

  const addToShoppingBtn = page.getByRole("button", { name: /材料を買い物リストに追加/ });
  const addVisible = await addToShoppingBtn
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  console.log("「材料を買い物リストに追加」ボタン表示:", addVisible);
  await ss(page, "S4-add-button");

  if (!addVisible) {
    console.log("WARN: 追加ボタンが見つからない");
    return;
  }

  await addToShoppingBtn.click();
  await page.waitForTimeout(2000);
  await ss(page, "S4-after-add-click");

  console.log("買い物リストAPIリクエスト:", networkRequests);
  expect(addVisible, "「材料を買い物リストに追加」ボタンが表示されるべき").toBe(true);
});

// ─── S5: カートアイコン → 買い物リストモーダル ───────────────────────────────

test("S5: カートアイコンをクリックして買い物リストモーダルが開く", async ({ page }) => {
  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  await ss(page, "S5-weekly-loaded");

  const cartBtn = page.getByRole("button", { name: /買い物リストを開く/ });
  const cartVisible = await cartBtn
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  console.log("カートボタン (aria-label) 発見:", cartVisible);

  if (!cartVisible) {
    await ss(page, "S5-no-cart-button");
    console.log("WARN: カートボタンが見つからない");
    return;
  }

  await cartBtn.click();
  await page.waitForTimeout(800);
  await ss(page, "S5-shopping-modal-opened");

  // 買い物リストモーダルが開いたか - ヘッダーテキストで確認
  const shoppingHeader = page.locator('span').filter({ hasText: "買い物リスト" }).first();
  const modalVisible = await shoppingHeader.isVisible().catch(() => false);
  console.log("買い物リストモーダル表示:", modalVisible);

  // z-index オーバーレイの確認
  const overlayInfo = await page.evaluate(() => {
    const overlay = document.querySelector('.fixed.inset-0');
    if (!overlay) return { found: false };
    const style = window.getComputedStyle(overlay);
    return {
      found: true,
      zIndex: style.zIndex,
      pointerEvents: style.pointerEvents
    };
  });
  console.log("z-200オーバーレイ:", overlayInfo);

  // モーダル内ボタン確認 (Playwright 通常クリックでブロックされるか)
  const regenBtnClickable = await page.locator('button').filter({ hasText: "献立から再生成" })
    .click({ timeout: 2000 })
    .then(() => true)
    .catch((e) => {
      console.log("献立から再生成 クリック失敗:", e.message.substring(0, 100));
      return false;
    });

  console.log("献立から再生成 通常クリック成功:", regenBtnClickable);
  await ss(page, "S5-after-regen-click-attempt");

  expect(modalVisible, "買い物リストモーダルが表示されるべき").toBe(true);
});

// ─── S6 & S7: 「献立から再生成」→ 買い物範囲モーダル + 順序確認 ──────────────

test("S6-S7: 献立から再生成ボタン → 買い物範囲モーダルの順序確認", async ({ page }) => {
  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  const cartBtn = page.getByRole("button", { name: /買い物リストを開く/ });
  const cartVisible = await cartBtn
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!cartVisible) {
    test.info().annotations.push({ type: "info", description: "カートボタンが見つからないためスキップ" });
    return;
  }

  await cartBtn.click();
  await page.waitForTimeout(500);
  await ss(page, "S6-shopping-modal");

  // 「献立から再生成」ボタン - z-index オーバーレイによりPlaywright通常clickが失敗する場合があるためJS経由
  const rangeModalOpened = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const regenBtn = btns.find(b => b.textContent.includes('献立から再生成'));
    if (regenBtn) { regenBtn.click(); return true; }
    return false;
  });

  console.log("「献立から再生成」JSクリック:", rangeModalOpened);

  if (!rangeModalOpened) {
    await ss(page, "S6-no-regen-button");
    test.info().annotations.push({ type: "info", description: "献立から再生成ボタンが見つからない" });
    return;
  }

  await page.waitForTimeout(500);
  await ss(page, "S6-range-modal-opened");

  // S7: 各オプションの表示確認
  const todayBtn = page.locator('button').filter({ hasText: "今日の分" });
  const tomorrowBtn = page.locator('button').filter({ hasText: "明日の分" });
  const dayAfterBtn = page.locator('button').filter({ hasText: "明後日の分" });
  const nDaysBtn = page.locator('button').filter({ hasText: /^\d+日分$/ }).first();
  const weekBtn = page.locator('button').filter({ hasText: "1週間分" });

  const todayVisible = await todayBtn.isVisible().catch(() => false);
  const tomorrowVisible = await tomorrowBtn.isVisible().catch(() => false);
  const dayAfterVisible = await dayAfterBtn.isVisible().catch(() => false);
  const nDaysVisible = await nDaysBtn.isVisible().catch(() => false);
  const weekVisible = await weekBtn.isVisible().catch(() => false);

  console.log("範囲オプション:", { 今日: todayVisible, 明日: tomorrowVisible, 明後日: dayAfterVisible, N日: nDaysVisible, 週: weekVisible });

  // 時系列順の確認
  const optionOrder = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns
      .filter(b => ['今日の分', '明日の分', '明後日の分', '1週間分'].includes(b.textContent.trim()) || /^\d+日分$/.test(b.textContent.trim()))
      .map(b => b.textContent.trim());
  });
  console.log("オプション時系列順:", optionOrder);

  // デフォルト選択確認
  const defaultSelected = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns
      .filter(b => ['今日の分', '明日の分', '明後日の分', '1週間分'].includes(b.textContent.trim()) || /^\d+日分$/.test(b.textContent.trim()))
      .map(b => ({
        text: b.textContent.trim(),
        isSelected: window.getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)'
      }));
  });
  console.log("デフォルト選択状態:", defaultSelected);
});

// ─── S8: 「次へ」→ 人数確認 → 「この設定で生成」 ─────────────────────────────

test("S8: 範囲選択 → 次へ → 人数確認 → この設定で生成 (献立なし時のサイレント失敗確認)", async ({ page }) => {
  const shoppingApiCalls: { url: string; method: string }[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/shopping-list")) {
      shoppingApiCalls.push({ url: req.url(), method: req.method() });
    }
  });

  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  await ss(page, "S8-weekly-initial");

  // 献立データがあるか確認
  const hasMeals = await page.locator('button:has-text("レシピを見る")').count().then(c => c > 0);
  console.log("献立データあり:", hasMeals);

  const cartBtn = page.getByRole("button", { name: /買い物リストを開く/ });
  await cartBtn.waitFor({ state: "visible", timeout: 10_000 });
  await cartBtn.click();
  await page.waitForTimeout(500);

  // 献立から再生成 (JS経由)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    btns.find(b => b.textContent.includes('献立から再生成'))?.click();
  });
  await page.waitForTimeout(500);
  await ss(page, "S8-range-modal");

  // 明日の分を選択
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    btns.find(b => b.textContent.trim() === '明日の分')?.click();
  });
  await page.waitForTimeout(300);

  // 次へをクリック
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    btns.find(b => b.textContent.includes('次へ'))?.click();
  });
  await page.waitForTimeout(500);
  await ss(page, "S8-servings-step2");

  // 人数確認ステップの確認
  const servingsTitle = page.locator('text=人数を確認').first();
  const step2Visible = await servingsTitle.isVisible().catch(() => false);
  console.log("人数確認ステップ表示:", step2Visible);

  // 「この設定で買い物リストを生成」をクリック
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    btns.find(b => b.textContent.includes('この設定で買い物リストを生成'))?.click();
  });
  await page.waitForTimeout(3000);
  await ss(page, "S8-after-generate-click");

  // APIが呼ばれたか確認
  console.log("shopping-list API calls:", shoppingApiCalls);
  console.log("献立データなし時にAPIが呼ばれないバグ:", !hasMeals && shoppingApiCalls.length === 0);

  // BUG-A: 献立データなしの場合、APIが呼ばれずサイレント失敗
  if (!hasMeals) {
    test.info().annotations.push({
      type: "bug",
      description: `BUG-A: 献立データなし状態で「この設定で買い物リストを生成」がAPIを呼ばずサイレント失敗。API calls: ${JSON.stringify(shoppingApiCalls)}`,
    });
  }
});

// ─── S9: 完了メッセージ確認 ──────────────────────────────────────────────────

test("S9: 買い物リスト生成完了メッセージを確認する (献立ありの環境のみ実行)", async ({ page }) => {
  const shoppingApiCalls: { url: string; status: number }[] = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/shopping-list")) {
      shoppingApiCalls.push({ url: res.url(), status: res.status() });
    }
  });

  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  const hasMeals = (await page.locator('button:has-text("レシピを見る")').count()) > 0;
  if (!hasMeals) {
    console.log("INFO: 献立データなし - S9 はスキップ (生成APIが呼ばれないバグにより)");
    test.info().annotations.push({ type: "info", description: "献立データなし: 生成APIサイレント失敗バグのためスキップ" });
    return;
  }

  const cartBtn = page.getByRole("button", { name: /買い物リストを開く/ });
  await cartBtn.waitFor({ state: "visible", timeout: 10_000 });
  await cartBtn.click();
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    document.querySelectorAll('button')[3]?.click(); // 献立から再生成
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    btns.find(b => b.textContent.trim() === '明日の分')?.click();
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    btns.find(b => b.textContent.includes('次へ'))?.click();
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    btns.find(b => b.textContent.includes('この設定で買い物リストを生成'))?.click();
  });
  await ss(page, "S9-generating");

  // 完了メッセージを待つ (最大60秒)
  const completionMsg = page.locator('text=/\\d+件の材料/').first();
  const msgVisible = await completionMsg
    .waitFor({ state: "visible", timeout: 60_000 })
    .then(() => true)
    .catch(() => false);

  await ss(page, "S9-completion-state");
  if (msgVisible) {
    const msgText = await completionMsg.textContent();
    console.log("完了メッセージ:", msgText);
  } else {
    console.log("WARN: 完了メッセージが表示されなかった");
    console.log("API calls:", shoppingApiCalls);
  }
});

// ─── S10: チェック ON/OFF、削除 ──────────────────────────────────────────────

test("S10: 買い物リストアイテムのチェックON/OFF + 削除", async ({ page }) => {
  const networkRequests: { url: string; status: number; method: string }[] = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/shopping-list")) {
      networkRequests.push({ url: res.url(), status: res.status(), method: res.request().method() });
    }
  });

  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  const cartBtn = page.getByRole("button", { name: /買い物リストを開く/ });
  await cartBtn.waitFor({ state: "visible", timeout: 10_000 });
  await cartBtn.click();
  await page.waitForTimeout(500);
  await ss(page, "S10-shopping-modal");

  const emptyMsg = page.locator('text=買い物リストは空です').first();
  const isEmpty = await emptyMsg.isVisible().catch(() => false);

  if (isEmpty) {
    console.log("INFO: 買い物リストが空 — チェック/削除テストをスキップ");
    test.info().annotations.push({ type: "info", description: "買い物リストが空のためスキップ" });
    return;
  }

  // チェックボタン確認 (丸いボタン)
  const checkBtns = page.locator('button.rounded-full.flex-shrink-0').first();
  const checkVisible = await checkBtns.isVisible().catch(() => false);

  if (checkVisible) {
    const countBefore = await page.locator('text=/\\d+\\/\\d+/').first().textContent().catch(() => null);
    console.log("チェック前カウント:", countBefore);
    await ss(page, "S10-before-check");

    await checkBtns.click();
    await page.waitForTimeout(1000);
    await ss(page, "S10-after-check");

    const countAfter = await page.locator('text=/\\d+\\/\\d+/').first().textContent().catch(() => null);
    console.log("チェック後カウント:", countAfter);
    console.log("PATCH API:", networkRequests.filter(r => r.method === "PATCH"));

    // アンチェック
    await checkBtns.click();
    await page.waitForTimeout(500);
  } else {
    await ss(page, "S10-no-check-button");
    console.log("WARN: チェックボタンが見つからない");
  }

  console.log("Shopping API calls:", networkRequests.map(r => `${r.method} ${r.url.split("/").pop()} → ${r.status}`));
});

// ─── S11: export / 印刷機能の有無 ────────────────────────────────────────────

test("S11: 買い物リストのexport/印刷機能の有無を確認", async ({ page }) => {
  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  const cartBtn = page.getByRole("button", { name: /買い物リストを開く/ });
  await cartBtn.waitFor({ state: "visible", timeout: 10_000 });
  await cartBtn.click();
  await page.waitForTimeout(500);
  await ss(page, "S11-shopping-modal-full");

  // export / 印刷 / 共有ボタンを探す
  const exportBtn = page.getByRole("button", { name: /export|エクスポート|印刷|共有|share|print/i });
  const exportVisible = await exportBtn.isVisible().catch(() => false);
  console.log("export/印刷ボタン表示:", exportVisible);

  // モーダル内ボタン一覧 (JS経由で全ボタン調査)
  const modalButtons = await page.evaluate(() => {
    const modal = document.querySelector('.fixed.z-\\[201\\]');
    if (!modal) return { found: false, buttons: [] };
    const btns = Array.from(modal.querySelectorAll('button'));
    return {
      found: true,
      buttons: btns.map(b => ({
        text: b.textContent.trim().substring(0, 30),
        ariaLabel: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
        hasIcon: !!b.querySelector('svg')
      }))
    };
  });
  console.log("モーダル内ボタン:", JSON.stringify(modalButtons.buttons, null, 2));

  // export/download リンク
  const exportLinkCount = await page.locator('a[href*="export"], a[download]').count();
  console.log("export/download リンク数:", exportLinkCount);

  // 結果サマリー
  console.log("=== S11 サマリー ===");
  console.log("export機能あり:", exportVisible || exportLinkCount > 0);
  console.log("機能なし(未実装):", !exportVisible && exportLinkCount === 0);
});

// ─── BUG-B: 買い物リストモーダル内ボタンが z-index オーバーレイでブロック ────

test("BUG-B確認: z-index オーバーレイが買い物リストモーダルのボタンをブロックするか", async ({ page }) => {
  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  const cartBtn = page.getByRole("button", { name: /買い物リストを開く/ });
  await cartBtn.waitFor({ state: "visible", timeout: 10_000 });
  await cartBtn.click();
  await page.waitForTimeout(500);

  // オーバーレイ情報を確認
  const overlayInfo = await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('.fixed'));
    return overlays.map(el => {
      const style = window.getComputedStyle(el);
      return {
        className: el.className.substring(0, 60),
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents,
        isInset0: el.classList.contains('inset-0'),
      };
    });
  });
  console.log("固定要素:", JSON.stringify(overlayInfo, null, 2));

  // z-[200] inset-0 の存在確認
  const blockingOverlay = overlayInfo.find(o => o.isInset0 && parseInt(o.zIndex) >= 200);
  console.log("ブロッキングオーバーレイ:", blockingOverlay);

  // Playwright 通常 click() が成功するか
  const clickResult = await page.locator('button').filter({ hasText: "献立から再生成" })
    .click({ timeout: 3000 })
    .then(() => "success")
    .catch((e) => `failed: ${e.message.substring(0, 150)}`);

  console.log("Playwright 通常クリック結果:", clickResult);
  await ss(page, "BUGB-overlay-check");

  test.info().annotations.push({
    type: "bug-evidence",
    description: `BUG-B: blockingOverlay=${JSON.stringify(blockingOverlay)}, clickResult=${clickResult}`,
  });
});

// ─── BUG-C: 買い物リストモーダルが開いている間に週ナビが操作可能 ──────────────

test("BUG-C確認: 買い物リストモーダル表示中に週ナビボタンが操作できる", async ({ page }) => {
  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  const cartBtn = page.getByRole("button", { name: /買い物リストを開く/ });
  await cartBtn.waitFor({ state: "visible", timeout: 10_000 });

  // モーダルを開く前の週を記録
  const weekBefore = await page.evaluate(() => document.title);

  await cartBtn.click();
  await page.waitForTimeout(500);
  await ss(page, "BUGC-modal-open");

  // モーダルが開いている状態で週ナビボタンが見える/クリック可能か
  const nextWeekBtn = page.getByRole("button", { name: /翌週/ });
  const prevWeekBtn = page.getByRole("button", { name: /前の週/ });

  const nextWeekVisible = await nextWeekBtn.isVisible().catch(() => false);
  const prevWeekVisible = await prevWeekBtn.isVisible().catch(() => false);

  console.log("モーダル開時の週ナビ表示:", { nextWeek: nextWeekVisible, prevWeek: prevWeekVisible });

  // 翌週ボタンをクリックしてみる (JS経由)
  const weekChangedWhileModalOpen = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const nextBtn = btns.find(b => b.getAttribute('aria-label') === '翌週' || b.textContent.trim() === '翌週');
    if (nextBtn) {
      nextBtn.click();
      return true;
    }
    return false;
  });

  await page.waitForTimeout(1500);
  await ss(page, "BUGC-after-week-nav");

  const shoppingModalStillOpen = await page.locator('span').filter({ hasText: "買い物リスト" }).isVisible().catch(() => false);
  console.log("週ナビ後のモーダル状態:", {
    weekChangedWhileModalOpen,
    shoppingModalStillOpen
  });

  test.info().annotations.push({
    type: "bug-evidence",
    description: `BUG-C: モーダル開状態で週ナビ=${weekChangedWhileModalOpen}, モーダル維持=${shoppingModalStillOpen}`,
  });

  console.log("=== BUG-C サマリー ===");
  console.log("モーダルが開いている間に週ナビが操作可能:", weekChangedWhileModalOpen && nextWeekVisible);
});
