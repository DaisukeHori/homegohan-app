/**
 * 使い方ガイド (/guide) の手順の画面 (#1852) と、紹介ページ (/) の新しい画面・拡大の画像 (#1867 段 0) を撮る。
 * run.sh から playwright.config.ts で動かす。
 *
 * - アプリはローカルの組み立て (ローカルの Supabase + 本番ビルド)、利用者とデータは seed.ts が入れたテスト用のもの。
 * - ローカルには AI が無いので、AI の読み取りの結果 (食事の写真・体重計の写真) は、この台本がテスト用の値で返す
 *   (page.route で /api/ai/analyze-meal-photo・/api/ai/analyze-weight-scale の応答を差し替える。画面はアプリそのもの)。
 * - 撮った画像は GUIDE_SHOTS_RAW_DIR (既定 .guide-shots/raw) に <名前>.png で置く。optimize.ts が縮めて、ガイドの画像は public/guide/ に、
 *   紹介ページの画面と拡大の画像は public/marketing/screens/ に置く。
 * - 撮る名前の一覧は、src/app/guide/guide-content.ts の画像のパス (15 枚) と、src/components/marketing/landing-screens.ts の
 *   LANDING_SCREENS (6 枚)・LANDING_ZOOMS (2 枚) の名前を合わせたもの (最後の確認で突き合わせる)。
 * - 紹介ページの画面に写っているべきもの・写ってはいけないものは docs/design/marketing/01-landing-site.md §7.1 の表 2・表 3。
 *   画面の部品や文言は書き換えない (DOM を書き換えない)。台本が選ぶのは、開く画面・押す操作・スクロールの位置と、見本のデータだけ (同 P-2)。
 *   撮る前に、写っているべきものが画面の中にあり、写ってはいけないものが画面の中に無いことを確かめる。
 * - 拡大の画像 2 枚は、comment.png・menu-result.png を撮ったのと同じ画面の状態のまま、その一部を切り出して撮る (同 §5.4)。
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { injectSession } from "../../tests/e2e/fixtures/fresh-user";
import { GUIDE_IMAGE_SIZE, guideImagePaths } from "../../src/app/guide/guide-content";
import { AI_CONSENT_COPY } from "../../src/lib/ai/consent-config";
import { LANDING_ZOOMS, landingScreenNames, landingZoomNames, type LandingZoomName } from "../../src/components/marketing/landing-screens";
import { DEMO_TODAY_WEIGHT_KG, GUIDE_FAMILY, GUIDE_USERS, SHOOT_VIEWPORT, type GuideUserKey } from "./guide-users";
import { GUIDE_MEAL_ANALYSIS } from "./meal-analysis-mock";
import { zoomClip, type ClipRect } from "./zoom-clip";

const ROOT = path.resolve(__dirname, "..", "..");
const RAW_DIR = path.resolve(ROOT, process.env.GUIDE_SHOTS_RAW_DIR ?? path.join(".guide-shots", "raw"));
/** 食事の写真 (アプリのハンズオンツアーのお試しの写真と同じもの) */
const MEAL_PHOTO = path.join(ROOT, "public", "handson-tour", "sample-meal.webp");

/** 画面の動き (framer-motion の出だしの動き・グラフの描き始め) が落ち着くまで待つ時間 (ms) */
const SETTLE_MS = 1_200;
/** 新しいバッジのお知らせは 5 秒で消えるので、出だしの動き (約 0.5 秒) だけ待って撮る */
const BADGE_TOAST_SETTLE_MS = 700;

/** 体重計の写真の読み取りの結果 (テスト用の値。/api/ai/analyze-weight-scale の応答の形) */
const WEIGHT_SCALE_READING = { weight: DEMO_TODAY_WEIGHT_KG, bodyFat: 25.1, muscleMass: 43.8, confidence: 0.96 };

/** 撮影用の体重計の写真 (表示部だけの絵)。ブラウザで描いて PNG にする */
const SCALE_PHOTO_HTML = `<!doctype html><html><body style="margin:0;background:#d9d6d0;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="width:520px;height:520px;border-radius:48px;background:linear-gradient(160deg,#fafafa,#e3e3e3);box-shadow:0 20px 40px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center">
<div style="width:360px;height:150px;border-radius:16px;background:#1d2a1f;display:flex;align-items:baseline;justify-content:center;gap:12px;font-family:monospace;color:#8cff9a">
<span style="font-size:96px;font-weight:bold;line-height:150px">${DEMO_TODAY_WEIGHT_KG.toFixed(1)}</span><span style="font-size:36px">kg</span></div></div></body></html>`;
const SCALE_PHOTO_SIZE = { width: 640, height: 640 };

async function save(page: Page, name: string): Promise<void> {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: path.join(RAW_DIR, `${name}.png`), animations: "disabled", caret: "hide" });
}

async function loginAs(page: Page, key: GuideUserKey): Promise<void> {
  await injectSession(page, GUIDE_USERS[key].email);
}

async function mockAi(page: Page): Promise<void> {
  await page.route("**/api/ai/analyze-meal-photo", (route) => route.fulfill({ json: GUIDE_MEAL_ANALYSIS }));
  await page.route("**/api/ai/analyze-weight-scale", (route) => route.fulfill({ json: WEIGHT_SCALE_READING }));
}

async function scalePhoto(page: Page): Promise<Buffer> {
  const scratch = await page.context().newPage();
  await scratch.setViewportSize(SCALE_PHOTO_SIZE);
  await scratch.setContent(SCALE_PHOTO_HTML);
  const buffer = await scratch.screenshot({ type: "png" });
  await scratch.close();
  return buffer;
}

// ─── 紹介ページ (/) の画面と拡大の画像 (#1867 段 0) ───

/**
 * 拡大の画像で、箱いっぱいに見せる部分の外接の矩形に足す余白 (CSS px)。
 * 設計 (§5.4) は保存した 540 px 幅の画像で 8 px と決めているので、撮影の画面 (CSS px) の大きさに直す
 */
const ZOOM_MARGIN_IMAGE_PX = 8;
const ZOOM_MARGIN_PX = (ZOOM_MARGIN_IMAGE_PX * SHOOT_VIEWPORT.width) / GUIDE_IMAGE_SIZE.width;
/**
 * 画面の右下の AI アドバイザーのボタンの枠の外に空ける幅 (CSS px)。
 * ボタンの影 (Tailwind の shadow-lg: 0 10px 15px -3px と 0 4px 6px -4px。どちらも下へずれる) がボタンの枠より上に出す濃さは 1/255 未満
 * (ぼかしの端の 2 px ほど) なので数えず、丸い縁をなめらかにする画素 (撮影の 2 倍の画素で 1 画素 = 0.5 CSS px) の分だけ空ける。
 * 章 menu の拡大は、朝食の箱の下の端のすぐ下 (約 1.5 CSS px) からボタンが始まるので、影の 2 px を空けると箱が入らない (設計 §5.4)
 */
const FAB_EDGE_ALLOWANCE_PX = 0.5;
/** ホームの画面と AI 相談のシートを撮るとき、「今日の献立」の箱の上の端を画面の上の端から下げる量 (CSS px) */
const HOME_CARD_TOP_GAP_PX = 16;
/** 食材管理の画面に写っているべき食材の行の数 (§7.1 の表 2: 食材の一覧が 3 件以上) */
const PANTRY_MIN_ITEMS_ON_SCREEN = 3;
/** AI アドバイザーのボタン (src/components/AIChatBubble.tsx の data-testid) */
const AI_CHAT_BUTTON_TEST_ID = "ai-chat-floating-button";
/** 箱の外側の要素を Tailwind のクラスで探す XPath (祖先のうち、いちばん近いもの) */
const nearestAncestorWithClass = (className: string) =>
  `xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ${className} ")][1]`;

function expandRect(rect: ClipRect, by: number): ClipRect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}

async function boxOf(locator: Locator, label: string): Promise<ClipRect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${label} の位置が取れない (画面に無い)`);
  return box;
}

/**
 * 拡大の画像を、いま開いている画面の状態のまま切り出して撮る (comment.png・menu-result.png と同じ撮影の回・同じ画面。§5.4・§7.1 の表 3)。
 * targets (箱いっぱいに見せる部分) を切らずに入れ、AI アドバイザーのボタン (影を含む) を入れない範囲を、LANDING_ZOOMS の縦横比で決める
 */
async function saveZoom(page: Page, name: LandingZoomName, targets: ReadonlyArray<{ locator: Locator; label: string }>): Promise<void> {
  const zoom = LANDING_ZOOMS.find((item) => item.name === name);
  if (!zoom) throw new Error(`LANDING_ZOOMS に ${name} が無い`);
  const targetBoxes = await Promise.all(targets.map((target) => boxOf(target.locator, target.label)));
  const chatButton = page.getByTestId(AI_CHAT_BUTTON_TEST_ID);
  const avoid = (await chatButton.count()) > 0 ? [expandRect(await boxOf(chatButton, "AI アドバイザーのボタン"), FAB_EDGE_ALLOWANCE_PX)] : [];
  const clip = zoomClip({ targets: targetBoxes, avoid, aspect: zoom.width / zoom.height, marginPx: ZOOM_MARGIN_PX, viewport: SHOOT_VIEWPORT });
  fs.mkdirSync(RAW_DIR, { recursive: true });
  await page.screenshot({ path: path.join(RAW_DIR, `${name}.png`), clip, animations: "disabled", caret: "hide" });
}

/** 箱の上の端が、画面の上の端から gapPx の位置に来るまでページを送る (スクロールの位置を選ぶだけで、画面は書き換えない) */
async function scrollBoxToTop(box: Locator, gapPx: number): Promise<void> {
  await box.evaluate((element, gap) => {
    window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - gap, behavior: "instant" });
  }, gapPx);
}

/** 新しい相談のシートの提案のボタン (src/components/AIChatBubble.tsx の提案の 4 つ。§7.1 の表 2) */
const CHAT_SUGGESTIONS = ["献立を提案してほしい", "冷蔵庫の食材で作れるものは?", "今日の栄養バランスは?", "来週の献立を作りたい"] as const;

/** 要素を含むスクロールの箱 (中身が箱より高く、縦に送れるもの) を、いちばん上まで送る (スクロールの位置を選ぶだけ) */
async function scrollContainerToTop(element: Locator): Promise<void> {
  await element.evaluate((node) => {
    let box = node.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && ["auto", "scroll"].includes(getComputedStyle(box).overflowY))) {
      box = box.parentElement;
    }
    if (!box) throw new Error("スクロールの箱が見つからない");
    box.scrollTo({ top: 0, behavior: "instant" });
  });
}

/** 写ってはいけないものが画面の中に無いことを確かめる (要素が無いか、あっても画面の外) */
async function expectNotOnScreen(page: Page, text: string): Promise<void> {
  const element = page.getByText(text, { exact: true });
  if ((await element.count()) === 0) return;
  await expect(element.first()).not.toBeInViewport();
}

/** ホームを開き、今日の献立が読み込まれてから、「今日の献立」の箱を画面の上に送る (ホームの画面と AI 相談のシートで同じ位置) */
async function openHomeAtTodayMenu(page: Page): Promise<void> {
  await page.goto("/home");
  const heading = page.getByRole("heading", { name: "今日の献立" });
  await expect(heading).toBeVisible();
  // 今日の献立の行 (朝食・昼食・夕食) が出るまで待つ (読み込み中は灰色の箱)
  for (const mealType of ["breakfast", "lunch", "dinner"]) {
    await expect(page.getByTestId(`meal-toggle-${mealType}`)).toBeVisible();
  }
  await scrollBoxToTop(heading.locator(nearestAncestorWithClass("rounded-3xl")), HOME_CARD_TOP_GAP_PX);
}

test.describe("使い方ガイドの画面", () => {
  test("signup: 新規登録の画面", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: "アカウント作成" })).toBeVisible();
    await save(page, "signup");
  });

  test("profile: 初期設定で身長・体重を入れる画面", async ({ page }) => {
    await loginAs(page, "onboarding");
    await page.goto("/onboarding/questions");
    const nickname = page.locator("form input").first();
    await nickname.fill(GUIDE_USERS.demo.nickname);
    await nickname.press("Enter");
    await page.getByRole("button", { name: /女性/ }).click();
    const stats = page.locator('input[type="number"]');
    await expect(stats).toHaveCount(3);
    await page.getByPlaceholder("25").fill("32");
    await page.getByPlaceholder("会社員").fill("会社員");
    await page.getByPlaceholder("170").fill("158");
    await page.getByPlaceholder("60").fill("64.8");
    await page.getByPlaceholder("60").blur();
    await save(page, "profile");
  });

  test("ready: 初期設定が終わった画面", async ({ page }) => {
    await loginAs(page, "demo");
    await page.goto("/onboarding/complete");
    await expect(page.getByRole("heading", { name: "栄養設計まで完了しました" })).toBeVisible();
    await expect(page.getByRole("link", { name: "この設定で始める" })).toBeVisible();
    await save(page, "ready");
  });

  test("camera / comment / analyze: 食事の写真を撮って解析する", async ({ page }) => {
    await loginAs(page, "demo");
    await mockAi(page);
    await page.goto("/meals/new?mode=meal");
    await expect(page.getByTestId("meal-camera-button")).toBeVisible();
    await page.locator('input[type="file"]:not([capture])').setInputFiles(MEAL_PHOTO);
    const analyze = page.getByRole("button", { name: /AIで解析する/ });
    await expect(analyze).toBeVisible();
    await save(page, "camera");

    await analyze.click();
    await expect(page.getByText("記録コメント")).toBeVisible();
    await save(page, "comment");

    // 章 photo の拡大 (zoom-photo.png): いま撮った comment.png と同じ画面から、スコアの箱と記録コメントの箱を切り出す (§7.1 の表 3)
    const scoreBox = page.getByText(String(GUIDE_MEAL_ANALYSIS.overallScore), { exact: true }).locator(nearestAncestorWithClass("rounded-2xl"));
    const commentBox = page.getByText("記録コメント", { exact: true }).locator(nearestAncestorWithClass("rounded-2xl"));
    await expect(scoreBox).toContainText(GUIDE_MEAL_ANALYSIS.dishes[0].name);
    await expect(commentBox).toContainText(GUIDE_MEAL_ANALYSIS.praiseComment);
    await saveZoom(page, "zoom-photo", [
      { locator: scoreBox, label: "スコアの箱" },
      { locator: commentBox, label: "記録コメントの箱" },
    ]);

    await page.getByTestId("meal-result-calories").scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="meal-result-calories"]');
      grid?.scrollIntoView({ block: "start" });
      window.scrollBy(0, -16);
    });
    await save(page, "analyze");
  });

  test("menu-request / menu-setting: 献立表から AI に献立を頼む", async ({ page }) => {
    await loginAs(page, "planner");
    await page.goto("/menus/weekly");
    const banner = page.getByTestId("ai-assistant-banner-button");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("AIに埋めてもらう");
    await save(page, "menu-request");

    await banner.click();
    const modal = page.getByTestId("v4-generate-modal-normal");
    await expect(modal.getByRole("heading", { name: "AIアシスタント" })).toBeVisible();
    await modal.getByRole("button", { name: /時短中心/ }).click();
    await modal.getByRole("button", { name: /ヘルシー/ }).click();
    // 条件の選び方が見えるよう、モーダルの中を「条件を指定」まで送る
    await modal.getByText("条件を指定").scrollIntoViewIfNeeded();
    await save(page, "menu-setting");
  });

  test("menu-result: 1 週間分の献立が入った献立表", async ({ page }) => {
    await loginAs(page, "demo");
    await page.goto("/menus/weekly");
    await expect(page.getByTestId("ai-assistant-banner-button")).toContainText("AI献立アシスタント");
    await save(page, "menu-result");

    // 章 menu の拡大 (zoom-menu.png): いま撮った menu-result.png と同じ画面から、今日の朝食の 1 食の箱を切り出す (§7.1 の表 3)
    const breakfastBox = page.getByText("朝食", { exact: true }).first().locator(nearestAncestorWithClass("rounded-[20px]"));
    for (const text of ["レシピを見る", "この食事の栄養素", "AIで変更", "手動で修正"]) {
      await expect(breakfastBox.getByText(text).first()).toBeVisible();
    }
    await saveZoom(page, "zoom-menu", [{ locator: breakfastBox, label: "今日の朝食の 1 食の箱" }]);
  });

  test("weight: 体重を入れる画面", async ({ page }) => {
    await loginAs(page, "demo");
    await page.goto("/health/record");
    const weight = page.locator("#health-weight");
    await expect(weight).toBeVisible();
    await weight.fill(DEMO_TODAY_WEIGHT_KG.toFixed(1));
    await page.getByPlaceholder("20.0").fill(WEIGHT_SCALE_READING.bodyFat.toFixed(1));
    await page.getByPlaceholder("20.0").blur();
    await save(page, "weight");
  });

  test("weight-photo: 体重計の写真の読み取りを確かめる画面", async ({ page }) => {
    await loginAs(page, "demo");
    await mockAi(page);
    const photo = await scalePhoto(page);
    await page.goto("/meals/new?mode=weight_scale");
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "scale.png", mimeType: "image/png", buffer: photo });
    await page.getByRole("button", { name: /AIで解析する/ }).click();
    await expect(page.getByText("体重計読み取り結果")).toBeVisible();
    await expect(page.getByText(DEMO_TODAY_WEIGHT_KG.toFixed(1)).first()).toBeVisible();
    await save(page, "weight-photo");
  });

  test("trend: 体重の推移のグラフ", async ({ page }) => {
    await loginAs(page, "demo");
    await page.goto("/health/graphs");
    await expect(page.getByText("体重の推移")).toBeVisible();
    await expect(page.getByText("目標体重")).toBeVisible();
    await save(page, "trend");
  });

  test("badge-get / badge-collection / badge-rare: バッジ", async ({ page }) => {
    await loginAs(page, "demo");
    await page.goto("/badges");
    await expect(page.getByRole("heading", { name: "新しいバッジを獲得！" })).toBeVisible();
    fs.mkdirSync(RAW_DIR, { recursive: true });
    await page.waitForTimeout(BADGE_TOAST_SETTLE_MS);
    await page.screenshot({ path: path.join(RAW_DIR, "badge-get.png"), caret: "hide" });

    // お知らせが消えてから一覧を撮る (2 回目に開いたときは出ない)
    await page.reload();
    await expect(page.getByRole("heading", { name: "トロフィールーム" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "新しいバッジを獲得！" })).toHaveCount(0);
    // 一覧は未獲得のバッジが先に並ぶので、獲得したバッジ (はじめの一歩 など) が見えるところまで送る
    await page.locator('[data-badge-code="first_bite"]').evaluate((card) => card.scrollIntoView({ block: "center" }));
    await save(page, "badge-collection");

    await page.locator('[data-badge-code="breakfast_champion"]').click();
    await expect(page.getByTestId("badge-detail-modal")).toBeVisible();
    await save(page, "badge-rare");
  });

});

// 紹介ページ (/) の新しい画面 6 枚 (docs/design/marketing/01-landing-site.md §7.1 の表 2)。ガイドの 3 人とは別の利用者で撮る (guide-users.ts)
test.describe("紹介ページの画面", () => {
  test("home: ホームの画面 (今日の献立・食事を記録と AI献立・今週の自炊率)", async ({ page }) => {
    await loginAs(page, "home");
    await openHomeAtTodayMenu(page);
    for (const text of ["今日の献立", "食事を記録", "AI献立", "今週の自炊率"]) {
      await expect(page.getByText(text, { exact: true }).first()).toBeInViewport();
    }
    // 写ってはいけないもの: 健康記録のカード (体重)・今日の栄養スコアの箱・期限切れ間近の箱 (表 2)
    for (const text of ["健康記録", "今日の栄養スコア", "期限切れ間近"]) {
      await expectNotOnScreen(page, text);
    }
    await save(page, "home");
  });

  test("chat: ホームの AI アドバイザーのボタンから開いた、新しい相談のシート", async ({ page }) => {
    await loginAs(page, "home");
    // シートの後ろに健康記録のカードが写らないよう、ホームの画面と同じ位置まで送ってから開く (表 2)
    await openHomeAtTodayMenu(page);
    await page.getByTestId(AI_CHAT_BUTTON_TEST_ID).click();
    await expect(page.getByRole("heading", { name: "AIアドバイザー" })).toBeVisible();
    await expect(page.getByText("いつでも相談できます")).toBeVisible();
    const greeting = page.getByText(/^こんにちは！/);
    await expect(greeting).toBeVisible();
    // シートは開くと相談の欄の末尾 (あいさつ) まで送られ、上の提案のボタンの 1 つ目が隠れる。提案のボタン 4 つが見えるよう、欄の先頭へ送る
    const suggestions = CHAT_SUGGESTIONS.map((name) => page.getByRole("button", { name }));
    await scrollContainerToTop(suggestions[0]);
    for (const suggestion of suggestions) {
      await expect(suggestion).toBeInViewport({ ratio: 1 });
    }
    await expect(greeting).toBeInViewport();
    await expect(page.getByPlaceholder("メッセージを入力...")).toBeVisible();
    await expectNotOnScreen(page, "健康記録");
    await save(page, "chat");
  });

  test("pantry: 食材管理の画面 (食材 3 件以上・期限間近の印)", async ({ page }) => {
    await loginAs(page, "pantry");
    await page.goto("/pantry");
    await expect(page.getByRole("heading", { name: "食材管理" })).toBeVisible();
    await expect(page.getByTestId("expiry-soon-badge").first()).toBeInViewport();
    // 食材の行 (行ごとに「編集」のボタンが 1 つ) が、表 2 の数だけ画面の中にある
    const rows = page.getByRole("button", { name: "編集" });
    for (let index = 0; index < PANTRY_MIN_ITEMS_ON_SCREEN; index++) {
      await expect(rows.nth(index)).toBeInViewport();
    }
    await save(page, "pantry");
  });

  test("shopping: 献立表から開いた買い物リストのシート", async ({ page }) => {
    await loginAs(page, "shopper");
    await page.goto("/menus/weekly");
    await expect(page.getByTestId("ai-assistant-banner-button")).toContainText("AI献立アシスタント");
    await page.getByRole("button", { name: "買い物リストを開く" }).click();
    const sheet = page.getByRole("dialog", { name: "買い物リスト" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("鶏むね肉")).toBeVisible();
    await expect(page.getByText("買い物リストは空です")).toHaveCount(0);
    await expect(page.getByText("早めに使い切り")).toHaveCount(0);
    await save(page, "shopping");
  });

  test("family: 家族の画面 (代表者・大人・子ども・大人メンバーを招待・共有設定)", async ({ page }) => {
    await loginAs(page, "familyRep");
    await page.goto("/family/dashboard");
    await expect(page.getByRole("heading", { name: GUIDE_FAMILY.groupName })).toBeVisible();
    for (const name of Object.values(GUIDE_FAMILY.displayNames)) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(page.getByText("大人メンバーを招待")).toBeInViewport();
    await expect(page.getByText("共有設定")).toBeInViewport();
    await save(page, "family");
  });

  test("consent: AI 機能の同意の画面 (同意していない利用者が写真を解析しようとした直後)", async ({ page }) => {
    await loginAs(page, "consent");
    await mockAi(page);
    await page.goto("/meals/new?mode=meal");
    await expect(page.getByTestId("meal-camera-button")).toBeVisible();
    await page.locator('input[type="file"]:not([capture])').setInputFiles(MEAL_PHOTO);
    await page.getByRole("button", { name: /AIで解析する/ }).click();
    const modal = page.getByTestId("ai-consent-modal");
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("heading", { name: AI_CONSENT_COPY.title })).toBeVisible();
    await save(page, "consent");
  });
});

test.describe("撮った画像の一覧", () => {
  test("撮った画像が、ガイドの画像 15 枚と紹介ページの画面 6 枚・拡大の画像 2 枚の一覧と一致する", () => {
    const expected = [
      ...guideImagePaths().map((urlPath) => path.basename(urlPath)),
      ...landingScreenNames().map((name) => `${name}.png`),
      ...landingZoomNames().map((name) => `${name}.png`),
    ].sort();
    const shot = fs.readdirSync(RAW_DIR).filter((name) => name.endsWith(".png")).sort();
    expect(shot).toEqual(expected);
  });
});
