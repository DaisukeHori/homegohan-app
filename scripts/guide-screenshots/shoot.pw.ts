/**
 * 使い方ガイド (/guide) の手順の画面を撮る (#1852)。run.sh から playwright.config.ts で動かす。
 *
 * - アプリはローカルの組み立て (ローカルの Supabase + 本番ビルド)、利用者とデータは seed.ts が入れたテスト用のもの。
 * - ローカルには AI が無いので、AI の読み取りの結果 (食事の写真・体重計の写真) は、この台本がテスト用の値で返す
 *   (page.route で /api/ai/analyze-meal-photo・/api/ai/analyze-weight-scale の応答を差し替える。画面はアプリそのもの)。
 * - 撮った画像は GUIDE_SHOTS_RAW_DIR (既定 .guide-shots/raw) に <名前>.png で置く。optimize.mjs が縮めて public/guide/ に置く。
 * - 撮る名前の一覧は src/app/guide/guide-content.ts の画像のパスと同じ (最後の確認で突き合わせる)。
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { injectSession } from "../../tests/e2e/fixtures/fresh-user";
import { guideImagePaths } from "../../src/app/guide/guide-content";
import { DEMO_TODAY_WEIGHT_KG, GUIDE_USERS, type GuideUserKey } from "./guide-users";
import { GUIDE_MEAL_ANALYSIS } from "./meal-analysis-mock";

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

  test("撮った画像がガイドの画像の一覧と一致する", () => {
    const expected = guideImagePaths().map((urlPath) => path.basename(urlPath)).sort();
    const shot = fs.readdirSync(RAW_DIR).filter((name) => name.endsWith(".png")).sort();
    expect(shot).toEqual(expected);
  });
});
