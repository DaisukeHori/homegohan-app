/**
 * ai-consent-first-use.spec.ts
 * 外国の AI 事業者への提供の同意画面 (T15 / #1154) の e2e
 *
 * 確かめること (AI を使う操作の例として、パントリーの「写真で追加」(冷蔵庫の写真の解析) を使う):
 *   1. 同意していない利用者が AI を初めて使うと、同意画面が出る。選ぶまで AI には送らない
 *   2. 「あとで」を押すと、画面が閉じて、AI の操作はそのまま進む。サーバーには何も記録しない (拒否の行は作らない)
 *      同じブラウザでは、次の AI の操作で画面を出さない
 *   3. 「同意する」を押すと、同意が記録され (POST /api/ai/consent)、AI の操作が進む。以後は画面が出ない。
 *      設定ページ (/settings/ai-consent) で確認と撤回ができ、撤回したあとの AI の操作では、もう一度画面が出る
 *   4. 同意の記録に失敗しても、「あとで」で AI の操作は進む。同意の状況が取れなくても、画面を出さずに進む
 *
 * 【AI への送信は止めない】どの場面でも、利用者が始めた AI の操作は最後まで進む (同意の強制は別タスク T18)。
 * AI の API (/api/ai/analyze-fridge) はブラウザの通信を差し替えて (page.route) 本物は呼ばない。AI の API キーは要らない。
 * 同意の API (/api/ai/consent, /api/ai/consent/revoke) とデータベースは本物を使う。
 *
 * ユーザー: fixtures/fresh-user.ts の regularUser (test ごとに新しく作る。同意の行も空の状態から始まる)。
 *   fresh-user の fixture と authedPage は、既定では同意画面を「あとで」にした状態で始まる (ほかの AI を使う spec が
 *   この画面で止まらないようにするため。fixtures/fresh-user.ts, fixtures/auth.ts, helpers/ai-consent.ts)。
 *   この spec は画面そのものを試すので、test.use({ aiConsentSnoozed: false }) で localStorage も空の状態から始める。
 *
 * 実行方法 (fixture が service_role で fresh user を作るため .env.local に SUPABASE_SERVICE_ROLE_KEY が必要):
 *   ローカル (ローカル Supabase を向いた .env.local):
 *     npx playwright test ai-consent-first-use
 *   next dev は初回コンパイルで遅いことがある。さらに、Playwright の出力 (動画・スクリーンショット。既定は tests/e2e/.output) が
 *   リポジトリの中にあると、dev server が再コンパイルを繰り返してページの読み込みが止まり、タイムアウトすることがあった。
 *   dev server で動かすときは、出力先をリポジトリの外にする:
 *     PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test ai-consent-first-use --output=/tmp/pw-out
 *   それでも不安定なら npm run build && npm run start で起動して同じように実行する (CI の e2e-local.yml と同じ)。
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/fresh-user";
import { AI_CONSENT_LATER_STORAGE_KEY, AI_CONSENT_VERSION } from "../../src/lib/ai/consent-config";

/** 1x1 の JPEG (中身は問わない。解析の API は差し替えるので、ファイルを選べればよい) */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

/** 解析の API の差し替え結果 (画面に「解析結果: 1品目を検出」と出る) */
const FRIDGE_RESULT = {
  detailedIngredients: [{ name: "卵", quantity: "6個" }],
  summary: "e2e のテスト用の解析結果です",
  suggestions: ["オムレツ"],
};
const RESULT_TEXT = "解析結果: 1品目を検出";

/**
 * next dev は、ページや API を初めて開くときにコンパイルする (負荷の高い環境では 1 つで 1 分近くかかる)。
 * そのコンパイルを含めて待つところ (ページを開く・API を初めて呼ぶ) は、長めにする。
 * 本番ビルド (CI の e2e-local.yml) ではコンパイルが無いので、この長さまで待つことは無い。
 */
const FIRST_LOAD = { timeout: 90_000 };

/** /api/ai/analyze-fridge を差し替え、呼ばれた回数を数える (本物の AI には送らない) */
async function mockFridgeAnalysis(page: Page) {
  const state = { calls: 0 };
  await page.route("**/api/ai/analyze-fridge", async (route) => {
    state.calls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FRIDGE_RESULT) });
  });
  return state;
}

const isConsentRequest = (url: string, method: string, expected: "GET" | "POST") =>
  new URL(url).pathname === "/api/ai/consent" && method === expected;

/**
 * パントリーを開き、同意の状況の取得 (GET /api/ai/consent) が終わるまで待つ。
 * 画面は、開いたときに状況を先に取っておき、AI の操作のときに長く待たせない。
 * 取得が終わる前に操作すると、同意画面を出さずに進む作りなので、ここで待ってから操作する。
 */
async function openPantry(page: Page, options: { statusStatus?: number } = {}) {
  const statusLoaded = page.waitForResponse(
    (res) => isConsentRequest(res.url(), res.request().method(), "GET"),
    FIRST_LOAD,
  );
  await page.goto("/pantry");
  const res = await statusLoaded;
  if (options.statusStatus !== undefined) expect(res.status()).toBe(options.statusStatus);
  await expect(page.getByTestId("add-by-photo-btn")).toBeVisible(FIRST_LOAD);
}

/** 「写真で追加」で冷蔵庫の写真を選ぶ (AI の操作を始める) */
async function pickFridgePhoto(page: Page) {
  await page.locator('input[type="file"]').setInputFiles({ name: "fridge.jpg", mimeType: "image/jpeg", buffer: TINY_JPEG });
}

async function readConsentStatus(page: Page) {
  const res = await page.request.get("/api/ai/consent");
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    version: string;
    consented: boolean;
    revokedAt: string | null;
    providers: Array<{ provider: string; state: string }>;
  };
}

test.describe("外国の AI 事業者への提供の同意画面 (初回の AI 操作)", () => {
  test.setTimeout(240_000);
  // 同意画面を「あとで」にした状態で始めない (既定の fixture の挙動を切る)
  test.use({ aiConsentSnoozed: false });

  test("初回の AI 操作で同意画面が出る。「あとで」を押しても AI の操作は進み、サーバーには何も記録しない", async ({
    regularUser: page,
  }) => {
    const fridge = await mockFridgeAnalysis(page);
    await openPantry(page);

    await pickFridgePhoto(page);

    // 1. 同意画面が出る。提供先・国・提供する情報が読める。選ぶまで AI には送らない
    const modal = page.getByTestId("ai-consent-modal");
    await expect(modal).toBeVisible(FIRST_LOAD);
    await expect(modal).toContainText("xAI");
    await expect(modal).toContainText("Google");
    await expect(modal).toContainText("OpenAI");
    await expect(modal).toContainText("アメリカ合衆国");
    await expect(modal).toContainText("冷蔵庫の写真");
    await expect(modal.getByTestId("ai-consent-settings-link")).toHaveAttribute("href", "/settings/ai-consent");
    expect(fridge.calls, "同意画面の選択を待つ間は、AI に送らない").toBe(0);

    // 2. 「あとで」: 画面が閉じ、AI の操作が進む
    await page.getByTestId("ai-consent-later").click();
    await expect(modal).toBeHidden();
    await expect(page.getByText(RESULT_TEXT)).toBeVisible(FIRST_LOAD);
    expect(fridge.calls).toBe(1);

    // 3. サーバーには何も記録していない (拒否の行は作らない。あとで同意できなくなるため)
    const status = await readConsentStatus(page);
    expect(status.consented).toBe(false);
    expect(status.providers.map((p) => p.state)).toEqual(["none", "none", "none"]);
    expect(status.revokedAt).toBeNull();

    // 4. 「あとで」の期限 (24 時間) だけをブラウザに覚える
    const until = await page.evaluate((key) => window.localStorage.getItem(key), AI_CONSENT_LATER_STORAGE_KEY);
    expect(Number(until)).toBeGreaterThan(Date.now());

    // 5. 同じブラウザの次の AI の操作では、画面を出さずに進む
    await pickFridgePhoto(page);
    await expect.poll(() => fridge.calls, FIRST_LOAD).toBe(2);
    await expect(modal).toBeHidden();
  });

  test("「同意する」で同意が記録され、以後は画面が出ない。設定ページで確認・撤回でき、撤回後はもう一度画面が出る", async ({
    regularUser: page,
  }) => {
    const fridge = await mockFridgeAnalysis(page);
    await openPantry(page);
    await pickFridgePhoto(page);

    const modal = page.getByTestId("ai-consent-modal");
    await expect(modal).toBeVisible(FIRST_LOAD);
    expect(fridge.calls).toBe(0);

    // 1. 「同意する」: 同意の API が成功し、画面が閉じ、AI の操作が進む
    const granted = page.waitForResponse((res) => isConsentRequest(res.url(), res.request().method(), "POST"), FIRST_LOAD);
    await page.getByTestId("ai-consent-accept").click();
    const grantResponse = await granted;
    expect(grantResponse.status()).toBe(200);
    const granting = (await grantResponse.json()) as { consented: boolean; version: string };
    expect(granting).toMatchObject({ consented: true, version: AI_CONSENT_VERSION });
    await expect(modal).toBeHidden();
    await expect(page.getByText(RESULT_TEXT)).toBeVisible(FIRST_LOAD);
    expect(fridge.calls).toBe(1);

    // 2. 事業者ごとに同意の行ができている (読めるのは自分の行だけ)
    const status = await readConsentStatus(page);
    expect(status.consented).toBe(true);
    expect(status.providers.map((p) => `${p.provider}:${p.state}`)).toEqual(["xai:granted", "google:granted", "openai:granted"]);

    // 3. 次の AI の操作では、画面を出さずに進む
    await pickFridgePhoto(page);
    await expect.poll(() => fridge.calls, FIRST_LOAD).toBe(2);
    await expect(modal).toBeHidden();

    // 4. 設定ページで同意の状況が分かる
    await page.goto("/settings/ai-consent");
    await expect(page.getByTestId("ai-consent-overall")).toHaveText("同意済みです", FIRST_LOAD);
    for (const provider of ["xai", "google", "openai"]) {
      await expect(page.getByTestId(`ai-consent-status-${provider}`)).toContainText("同意済み");
    }

    // 5. 撤回: 確認のダイアログを通ってから撤回され、未同意の表示に変わる
    await page.getByTestId("ai-consent-revoke").click();
    const confirm = page.getByTestId("confirm-delete-modal");
    await expect(confirm).toBeVisible(FIRST_LOAD);
    await expect(confirm).toContainText("引き続きお使いいただけます");
    await confirm.getByRole("button", { name: "撤回する", exact: true }).click();
    await expect(page.getByTestId("ai-consent-overall")).toHaveText("まだ同意していません", FIRST_LOAD);
    await expect(page.getByTestId("ai-consent-notice")).toHaveText("同意を撤回しました。");
    expect((await readConsentStatus(page)).consented).toBe(false);

    // 6. 撤回のあとの AI の操作では、もう一度同意画面が出る。「あとで」でも操作は進む
    await openPantry(page);
    await pickFridgePhoto(page);
    await expect(modal).toBeVisible(FIRST_LOAD);
    expect(fridge.calls, "撤回後も、選ぶまで AI には送らない").toBe(2);
    await page.getByTestId("ai-consent-later").click();
    await expect(modal).toBeHidden();
    await expect.poll(() => fridge.calls, FIRST_LOAD).toBe(3);
  });

  test("同意の記録に失敗しても、画面にメッセージを出し、「あとで」で AI の操作は進む", async ({ regularUser: page }) => {
    const fridge = await mockFridgeAnalysis(page);
    await page.route("**/api/ai/consent", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "同意を記録できませんでした。時間をおいて再度お試しください。", code: "AI_CONSENT_GRANT_FAILED" }),
        });
        return;
      }
      await route.continue();
    });
    await openPantry(page);
    await pickFridgePhoto(page);

    const modal = page.getByTestId("ai-consent-modal");
    await expect(modal).toBeVisible(FIRST_LOAD);

    // 「同意する」が失敗: 画面は閉じず、メッセージが出る。AI にはまだ送らない
    await page.getByTestId("ai-consent-accept").click();
    await expect(page.getByTestId("ai-consent-error")).toContainText("同意を記録できませんでした");
    await expect(modal).toBeVisible();
    expect(fridge.calls).toBe(0);

    // 「あとで」はいつでも押せて、AI の操作が進む
    await page.getByTestId("ai-consent-later").click();
    await expect(modal).toBeHidden();
    await expect(page.getByText(RESULT_TEXT)).toBeVisible(FIRST_LOAD);
    expect(fridge.calls).toBe(1);
  });

  test("同意の状況が取れなくても (API が 500)、同意画面を出さずに AI の操作は進む", async ({ regularUser: page }) => {
    const fridge = await mockFridgeAnalysis(page);
    await page.route("**/api/ai/consent", async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "テスト用の障害" }) });
    });
    await openPantry(page, { statusStatus: 500 });

    await pickFridgePhoto(page);

    await expect(page.getByText(RESULT_TEXT)).toBeVisible(FIRST_LOAD);
    expect(fridge.calls).toBe(1);
    await expect(page.getByTestId("ai-consent-modal")).toHaveCount(0);
  });
});
