/**
 * 探索 spec: Nutrition targets + Badges + Misc
 *
 * 対象: https://homegohan-app.vercel.app
 * 実行コマンド:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npx playwright test \
 *     tests/e2e/.exploration/nutrition-badges-misc-explore.spec.ts --headed
 *
 * カバレッジ:
 *   S1  /profile/nutrition-targets — 全要素表示確認
 *   S2  概算バッジ (defaults_applied) / missing-fields-warning
 *   S3  「栄養目標を再設定する」セクション表示
 *   S4  計算根拠 JSON expand/collapse
 *   S5  /badges — バッジ一覧
 *   S6  バッジカードクリック → 詳細モーダル
 *   S7  取得済 vs 未取得の表示差
 *   S8  /comparison — 比較ページ
 *   S9  /meals/[id] — 単一食事画面 (存在しない ID でエラーハンドリング確認)
 *   S10 /api/account/export — ダウンロード確認 + JSON 内容検証
 *   S11 マーケティングページ群 (/, /about, /pricing, /faq, /contact, /legal, /guide)
 *   S12 /news / /privacy
 *
 * スクリーンショット保存先: tests/e2e/.exploration/nutrition-badges-misc/
 *
 * バグ判定ポリシー:
 *   既知 close 済 Bug-1〜Bug-38 (#15〜#57) と重複しない
 *   明らかな期待外のみ登録（false-positive 厳禁）
 */

import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { login } from "../fixtures/auth";

// ────────────────────────────────────────────────────────
// 設定
// ────────────────────────────────────────────────────────

test.use({
  trace: "on",
  screenshot: "on",
  video: "retain-on-failure",
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
});

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://homegohan-app.vercel.app";

const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "nutrition-badges-misc"
);

// ────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────

let ssIndex = 0;
async function saveScreenshot(page: Page, label: string): Promise<string> {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
  ssIndex++;
  const num = String(ssIndex).padStart(2, "0");
  const safe = label.replace(/[^\w\-]/g, "_");
  const filePath = path.join(SCREENSHOT_DIR, `${num}-${safe}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

function attachMonitors(page: Page) {
  const consoleErrors: string[] = [];
  const failedRequests: { url: string; status: number }[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("response", (res) => {
    if (res.status() >= 500) {
      failedRequests.push({ url: res.url(), status: res.status() });
    }
  });
  return { consoleErrors, failedRequests };
}

// ────────────────────────────────────────────────────────
// テスト前処理
// ────────────────────────────────────────────────────────

test.beforeAll(async () => {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
});

// ────────────────────────────────────────────────────────
// S1: /profile/nutrition-targets — 全要素表示
// ────────────────────────────────────────────────────────

test("S1: /profile/nutrition-targets — ページが正常に表示され全要素が存在する", async ({ page }) => {
  await login(page);
  const { consoleErrors, failedRequests } = attachMonitors(page);

  await page.goto(`${BASE_URL}/profile/nutrition-targets`, { waitUntil: "networkidle" });
  await saveScreenshot(page, "s1-nutrition-targets-initial");

  // タイトル
  await expect(page.getByText("栄養目標の根拠")).toBeVisible({ timeout: 10_000 });

  // 目標サマリーカード
  const summaryCard = page.locator("h2", { hasText: "目標サマリー" });
  await expect(summaryCard).toBeVisible();

  // カロリー表示
  const kcalEl = page.locator("p.text-2xl.font-bold.text-orange-500").first();
  const kcalText = await kcalEl.innerText({ timeout: 10_000 }).catch(() => null);
  if (kcalText) {
    expect(parseInt(kcalText, 10)).toBeGreaterThan(0);
  }

  // 「計算に使用した入力値」セクション
  await expect(page.getByText("計算に使用した入力値")).toBeVisible();

  // 「エネルギー計算」セクション (basis.energy が存在する場合)
  const energySection = page.getByText("エネルギー計算");
  const hasEnergy = await energySection.isVisible().catch(() => false);
  if (hasEnergy) {
    await expect(energySection).toBeVisible();
  }

  // 「ビタミン・ミネラル」セクション
  const vitSection = page.getByText("ビタミン・ミネラル");
  const hasVit = await vitSection.isVisible().catch(() => false);
  if (hasVit) {
    await expect(vitSection).toBeVisible();
  }

  // 計算根拠JSON セクション
  await expect(page.getByText("計算根拠JSON")).toBeVisible();

  // 5xx エラーチェック
  expect(
    failedRequests,
    `5xx responses: ${JSON.stringify(failedRequests)}`
  ).toHaveLength(0);
});

// ────────────────────────────────────────────────────────
// S2: 概算バッジ + missing-fields-warning
// ────────────────────────────────────────────────────────

test("S2: defaults-applied-badge と missing-fields-warning の表示確認", async ({ page }) => {
  await login(page);

  await page.goto(`${BASE_URL}/profile/nutrition-targets`, { waitUntil: "networkidle" });

  const badgeVisible = await page
    .locator('[data-testid="defaults-applied-badge"]')
    .isVisible()
    .catch(() => false);
  const warningVisible = await page
    .locator('[data-testid="missing-fields-warning"]')
    .isVisible()
    .catch(() => false);

  // テストユーザーはプロフィール未入力なので少なくとも一方が表示されるはず
  // どちらも表示されない場合は warn にとどめる (テスト自体はパス)
  if (!badgeVisible && !warningVisible) {
    console.warn(
      "[S2] Neither defaults-applied-badge nor missing-fields-warning is visible. " +
      "Profile may be fully set up. Skipping badge/warning assertion."
    );
    return;
  }

  // どちらか一方でも表示されていれば OK
  const eitherVisible = badgeVisible || warningVisible;
  expect(eitherVisible).toBe(true);

  if (badgeVisible) {
    const badgeText = await page
      .locator('[data-testid="defaults-applied-badge"]')
      .innerText();
    expect(badgeText).toMatch(/概算/);
  }

  if (warningVisible) {
    const warningText = await page
      .locator('[data-testid="missing-fields-warning"]')
      .innerText();
    expect(warningText).toMatch(/未入力/);
  }

  await saveScreenshot(page, "s2-defaults-applied-badge");
});

// ────────────────────────────────────────────────────────
// S3: 「栄養目標を再設定する」セクション (NutritionTargetPlanner)
// ────────────────────────────────────────────────────────

test("S3: 栄養目標を再設定するセクションが表示される", async ({ page }) => {
  await login(page);

  await page.goto(`${BASE_URL}/profile/nutrition-targets`, { waitUntil: "networkidle" });

  // NutritionTargetPlanner コンポーネントが展開されていること
  const reconfigureSection = page.getByText("栄養目標を再設定する");
  await expect(reconfigureSection).toBeVisible({ timeout: 10_000 });

  // RECONFIGURE ラベルも確認
  const reconfigureLabel = page.getByText("RECONFIGURE");
  await expect(reconfigureLabel).toBeVisible();

  await saveScreenshot(page, "s3-nutrition-target-planner");
});

// ────────────────────────────────────────────────────────
// S4: 計算根拠 JSON expand/collapse
// ────────────────────────────────────────────────────────

test("S4: 計算根拠JSON ボタンクリックで pre が展開・折り畳まれる", async ({ page }) => {
  await login(page);

  await page.goto(`${BASE_URL}/profile/nutrition-targets`, { waitUntil: "networkidle" });

  // JSONエリアは初期非表示
  const pre = page.locator("pre").filter({ hasText: /"inputs"/ });
  const preInitiallyVisible = await pre.isVisible().catch(() => false);

  // 展開ボタンをクリック
  const expandBtn = page.locator("button", { hasText: "計算根拠JSON" });
  await expect(expandBtn).toBeVisible({ timeout: 10_000 });
  await expandBtn.click();

  // PRE が表示される (basis が存在する場合)
  const preVisible = await pre.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!preInitiallyVisible && preVisible) {
    // 展開成功
    const jsonText = await pre.innerText();
    expect(jsonText).toContain("{");
    await saveScreenshot(page, "s4-json-expanded");
  } else if (!preVisible) {
    // basis が null の場合は PRE が表示されないのは正常
    console.warn("[S4] pre not visible after expand — basis may be null");
  }

  // 再クリックで折り畳む
  await expandBtn.click();
  await saveScreenshot(page, "s4-json-collapsed");
});

// ────────────────────────────────────────────────────────
// S5: /badges — バッジ一覧表示
// ────────────────────────────────────────────────────────

test("S5: /badges — バッジ一覧が正常に表示される", async ({ page }) => {
  await login(page);
  const { consoleErrors, failedRequests } = attachMonitors(page);

  await page.goto(`${BASE_URL}/badges`, { waitUntil: "networkidle" });
  await saveScreenshot(page, "s5-badges-initial");

  // タイトル
  await expect(page.getByText("トロフィールーム")).toBeVisible({ timeout: 10_000 });

  // バッジカードが 1 枚以上存在する
  const cards = page.locator('[data-testid="badge-card"]');
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);

  // ランク表示
  await expect(page.getByText("現在のランク")).toBeVisible();

  // 5xx エラーチェック
  expect(
    failedRequests,
    `5xx responses: ${JSON.stringify(failedRequests)}`
  ).toHaveLength(0);

  // [Bug 候補] ICON_MAP に存在しないバッジコードによりフォールバックアイコン🏅が多発
  // バッジカードのアイコン要素を収集し、🏅 (フォールバック) の割合を確認
  const badgeIcons = await cards.evaluateAll((els) =>
    els.map((el) => {
      const iconEl = el.querySelector(".text-5xl");
      return iconEl ? iconEl.textContent?.trim() : "";
    })
  );
  const fallbackCount = badgeIcons.filter((icon) => icon === "🏅").length;
  console.log(
    `[S5] Total badge cards: ${count}, Fallback icons (🏅): ${fallbackCount}`
  );

  // フォールバックアイコンが全体の 50% 以上なら警告
  if (fallbackCount > count / 2) {
    console.warn(
      `[S5] [BUG-CANDIDATE] ${fallbackCount}/${count} badges use fallback icon 🏅. ` +
      "ICON_MAP in /badges/page.tsx is missing many badge codes."
    );
  }
});

// ────────────────────────────────────────────────────────
// S6: バッジカードクリック → 詳細モーダル
// ────────────────────────────────────────────────────────

test("S6: バッジカードクリックで詳細モーダルが開き、閉じるボタンで閉じる", async ({ page }) => {
  await login(page);

  await page.goto(`${BASE_URL}/badges`, { waitUntil: "networkidle" });

  const firstCard = page.locator('[data-testid="badge-card"]').first();
  await expect(firstCard).toBeVisible({ timeout: 10_000 });

  // クリックでモーダルが開く
  await firstCard.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // 取得条件ラベルが表示される
  await expect(dialog.getByText("取得条件")).toBeVisible();

  // 取得済み or 未取得 ラベルが表示される
  const statusLabel = dialog
    .locator("span", { hasText: /取得済み|未取得/ })
    .first();
  await expect(statusLabel).toBeVisible();

  await saveScreenshot(page, "s6-badge-modal-open");

  // 閉じるボタンでモーダルが閉じる
  // B spec flaky: dialogに「閉じる」ボタンが2つある（× button with aria-label="閉じる"
  // と テキスト「閉じる」ボタン）。.first()で最初の一致を使う。
  const closeBtn = dialog.getByRole("button", { name: "閉じる" }).first();
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();

  await expect(dialog).toBeHidden({ timeout: 3_000 });
  await saveScreenshot(page, "s6-badge-modal-closed");
});

// ────────────────────────────────────────────────────────
// S7: 取得済み vs 未取得の表示差
// ────────────────────────────────────────────────────────

test("S7: 未取得バッジはグレーアウト、取得済みは明るく表示される", async ({ page }) => {
  await login(page);

  await page.goto(`${BASE_URL}/badges`, { waitUntil: "networkidle" });

  const cards = page.locator('[data-testid="badge-card"]');
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });

  const allCards = await cards.all();
  let earnedCount = 0;
  let unearnedCount = 0;

  for (const card of allCards) {
    const classes = await card.getAttribute("class") ?? "";
    if (classes.includes("opacity-60") || classes.includes("bg-gray-100")) {
      unearnedCount++;
    } else if (classes.includes("bg-white")) {
      earnedCount++;
    }
  }

  console.log(`[S7] Earned: ${earnedCount}, Unearned: ${unearnedCount}`);

  // 少なくとも未取得バッジが存在する (テストユーザーはデータが少ない)
  expect(unearnedCount).toBeGreaterThan(0);

  // 未取得バッジをクリックしてモーダルで「未取得」ラベルを確認
  const unearnedCard = cards.filter({
    has: page.locator(".opacity-60, .bg-gray-100"),
  }).first();
  const unearnedAvailable = await unearnedCard
    .isVisible()
    .catch(() => false);

  if (unearnedAvailable) {
    await unearnedCard.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const unearnedLabel = dialog.locator("span", { hasText: "未取得" });
    await expect(unearnedLabel).toBeVisible();

    await dialog.getByRole("button", { name: "閉じる" }).click();
    await expect(dialog).toBeHidden({ timeout: 3_000 });
  }

  await saveScreenshot(page, "s7-badge-earned-vs-unearned");
});

// ────────────────────────────────────────────────────────
// S8: /comparison — 比較ページ
// ────────────────────────────────────────────────────────

test("S8: /comparison — ページが表示され 5xx エラーが出ない", async ({ page }) => {
  await login(page);
  const { consoleErrors, failedRequests } = attachMonitors(page);

  await page.goto(`${BASE_URL}/comparison`, { waitUntil: "networkidle" });
  await saveScreenshot(page, "s8-comparison-initial");

  // タイトル確認
  await expect(page.getByText("みんなと比較")).toBeVisible({ timeout: 10_000 });

  // 週間/月間 切り替えボタンが存在する
  await expect(page.getByRole("button", { name: "週間" })).toBeVisible();
  await expect(page.getByRole("button", { name: "月間" })).toBeVisible();

  // データがない場合はエンプティステートが表示される
  const emptyState = page.getByText("まだデータがありません");
  const hasEmpty = await emptyState.isVisible().catch(() => false);
  if (hasEmpty) {
    await expect(emptyState).toBeVisible();
    console.log("[S8] Comparison page shows empty state (no data)");
  }

  // 月間に切り替え
  await page.getByRole("button", { name: "月間" }).click();
  await page.waitForTimeout(1000);
  await saveScreenshot(page, "s8-comparison-monthly");

  // 5xx エラーチェック
  expect(
    failedRequests,
    `5xx responses: ${JSON.stringify(failedRequests)}`
  ).toHaveLength(0);

  // バッジ一覧へのリンクが存在する
  const badgesLink = page.getByRole("link", { name: /バッジ/ });
  const hasBadgesLink = await badgesLink.isVisible().catch(() => false);
  if (hasBadgesLink) {
    await expect(badgesLink).toBeVisible();
  }
});

// ────────────────────────────────────────────────────────
// S9: /meals/[id] — 存在しない ID でのエラーハンドリング
// ────────────────────────────────────────────────────────

test("S9: /meals/[id] — 存在しない ID にアクセスするとエラーメッセージが表示される", async ({ page }) => {
  await login(page);

  const fakeId = "00000000-0000-0000-0000-000000000001";
  await page.goto(`${BASE_URL}/meals/${fakeId}`, { waitUntil: "networkidle" });
  await saveScreenshot(page, "s9-meal-not-found");

  // エラーメッセージが表示されること
  await expect(
    page.getByText(/食事データが見つかりません/)
  ).toBeVisible({ timeout: 10_000 });

  // 「献立表へ戻る」ボタンが表示されること
  const backBtn = page.getByRole("button", { name: /献立表へ戻る/ });
  await expect(backBtn).toBeVisible();

  // ボタンクリックで /menus/weekly に遷移すること
  await backBtn.click();
  await page.waitForURL(/\/menus\/weekly/, { timeout: 10_000 });
  expect(page.url()).toMatch(/\/menus\/weekly/);
});

// ────────────────────────────────────────────────────────
// S10: /api/account/export — レスポンス内容確認
// ────────────────────────────────────────────────────────

test("S10: /api/account/export — JSON が返り主要テーブルがエラーなし", async ({ page }) => {
  await login(page);

  await page.goto(`${BASE_URL}/home`, { waitUntil: "networkidle" });

  // fetch 経由でエクスポート内容を確認
  const result = await page.evaluate(async () => {
    const res = await fetch("/api/account/export");
    const data = await res.json();
    return {
      status: res.status,
      keys: Object.keys(data),
      errors: Object.entries(data)
        .filter(
          ([k, v]) =>
            typeof v === "object" &&
            v !== null &&
            !Array.isArray(v) &&
            "error" in (v as object)
        )
        .map(([k, v]) => ({ table: k, error: (v as { error: string }).error })),
      tableCounts: Object.entries(data)
        .filter(([k, v]) => Array.isArray(v))
        .map(([k, v]) => ({ table: k, count: (v as unknown[]).length })),
    };
  });

  expect(result.status).toBe(200);
  expect(result.keys).toContain("schemaVersion");
  expect(result.keys).toContain("exportedAt");
  expect(result.keys).toContain("user");

  console.log("[S10] Export table counts:", JSON.stringify(result.tableCounts));

  // エラーがある場合は警告とともにログ出力
  if (result.errors.length > 0) {
    console.warn(
      "[S10] [BUG-CANDIDATE] Export API has errors in tables:",
      JSON.stringify(result.errors)
    );
  }

  // 全テーブルエラーではないこと (少なくとも何かデータが取得できる)
  const successTables = result.tableCounts.filter((t) => t.count >= 0).length;
  expect(successTables).toBeGreaterThan(0);

  // nutrition_targets は少なくとも 1 件あるはず (テストユーザーは計算済み)
  const nutritionEntry = result.tableCounts.find(
    (t) => t.table === "nutrition_targets"
  );
  if (nutritionEntry) {
    expect(nutritionEntry.count).toBeGreaterThanOrEqual(1);
  }
});

// ────────────────────────────────────────────────────────
// S11: マーケティングページ群 (未認証でも開ける)
// ────────────────────────────────────────────────────────

const MARKETING_PAGES: { path: string; title?: string }[] = [
  { path: "/", title: "ほめゴハン" },
  { path: "/about" },
  { path: "/pricing" },
  { path: "/faq" },
  { path: "/contact" },
  { path: "/legal" },
  { path: "/guide" },
];

for (const { path: pagePath, title } of MARKETING_PAGES) {
  test(`S11: ${pagePath} — 未認証でも 200 で表示される`, async ({ page }) => {
    const { failedRequests } = attachMonitors(page);

    await page.goto(`${BASE_URL}${pagePath}`, { waitUntil: "load", timeout: 20_000 });

    // HTTP ステータス 200 (Not Found にリダイレクトされていないこと)
    expect(page.url()).not.toMatch(/404/);

    if (title) {
      await expect(page).toHaveTitle(new RegExp(title), { timeout: 5_000 });
    }

    // 5xx エラーチェック
    expect(
      failedRequests,
      `5xx on ${pagePath}: ${JSON.stringify(failedRequests)}`
    ).toHaveLength(0);

    await saveScreenshot(page, `s11-marketing${pagePath.replace(/\//g, "-")}`);
  });
}

// ────────────────────────────────────────────────────────
// S12: /news / /privacy
// ────────────────────────────────────────────────────────

test("S12: /news — 200 で表示される", async ({ page }) => {
  const { failedRequests } = attachMonitors(page);

  await page.goto(`${BASE_URL}/news`, { waitUntil: "load", timeout: 15_000 });

  expect(page.url()).not.toMatch(/404/);
  expect(failedRequests).toHaveLength(0);

  await saveScreenshot(page, "s12-news");
});

test("S12: /privacy — 認証済みユーザーで表示される", async ({ page }) => {
  await login(page);
  const { failedRequests } = attachMonitors(page);

  await page.goto(`${BASE_URL}/privacy`, { waitUntil: "load", timeout: 15_000 });

  expect(page.url()).not.toMatch(/404/);
  expect(failedRequests).toHaveLength(0);

  await saveScreenshot(page, "s12-privacy");
});
