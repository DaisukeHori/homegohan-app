/**
 * Bug-27 (#47) → #1142: 究極モードは全員に開放されている
 *
 * 経緯:
 *   Bug-27 では「Premium プランが無いのに無料アカウントで有効にできてしまう」ことを理由に、
 *   AI献立アシスタントの究極モードを disabled + 「Premium」「準備中」の表示でロックしていた。
 *   ところが Premium プラン自体が未提供で、ロックを外す条件がコードのどこにも無く、
 *   誰にも押せない飾りになっていた (#1142)。
 *   オーナー判断 (2026-10-08) で、プランによる制限なしに全員へ開放した。
 *   この spec は「ロックされていること」を確かめる内容だったが、「開放されていること」を確かめる内容に書き換えた。
 *   (経緯が追えるよう、ファイル名は据え置き)
 *
 * 確認:
 *   1. 究極モードのスイッチが操作でき、「Premium」「準備中」の表示と alert が無い
 *   2. ON にして「献立を生成」すると、POST /api/ai/menu/v4/generate に ultimateMode: true が載る
 *   3. 触らずに生成すれば ultimateMode: false (既定は OFF)
 *   4. 閉じて開き直すと OFF に戻る (時間と AI の呼び出しが増えるため、使うかどうかを毎回選ぶ)
 *
 * 注: 実際の LLM 生成・DB 書き込みは行わない。究極モードは通常より AI の呼び出しが多いため、
 *     生成 API はモックして、送られた内容だけを検証する。
 */
import { test, expect } from "./fixtures/fresh-user";
import type { Locator, Page, Route } from "@playwright/test";

/** 生成 API のモックが返す、実在しない requestId */
const FAKE_REQUEST_ID = "00000000-0000-4444-8888-000000001142";

/**
 * POST /api/ai/menu/v4/generate をモックし、送られた本文を配列に溜めて返す。
 * 生成後にページが進捗を見に行く API も、実在しない requestId を引かないよう固定の応答にする。
 */
async function mockGenerateApi(page: Page): Promise<Array<Record<string, unknown>>> {
  const requestBodies: Array<Record<string, unknown>> = [];

  await page.route("**/api/ai/menu/v4/generate", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    requestBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "processing",
        message: "mock",
        requestId: FAKE_REQUEST_ID,
        totalSlots: 3,
      }),
    });
  });

  await page.route("**/api/ai/menu/weekly/status*", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", progress: null }),
    });
  });

  return requestBodies;
}

/** 週間献立ページで AI アシスタントのモーダルを開く */
async function openAssistantModal(page: Page) {
  await page.goto("/menus/weekly");

  const banner = page.getByTestId("ai-assistant-banner-button");
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await banner.click();

  const modal = page.getByTestId("v4-generate-modal-normal");
  await expect(modal).toBeVisible({ timeout: 10_000 });
  return {
    modal,
    toggle: modal.getByTestId("ultimate-mode-toggle"),
  };
}

/** 「1日献立変更」を選んで「献立を生成」を押す (新しいユーザーは献立が無いので、上書き確認は出ない) */
async function startSingleDayGeneration(modal: Locator) {
  await modal.getByRole("button", { name: /1日献立変更/ }).click();
  await modal.getByRole("button", { name: "献立を生成", exact: true }).click();
}

test.describe("究極モードは全員に開放されている (#1142)", () => {
  test("スイッチが操作でき、「Premium」「準備中」の表示も alert も無い", async ({ regularUser }) => {
    const page = regularUser;

    // alert が出たら記録する (以前は押すと「Premium プラン準備中です」の alert が出た)
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });

    const { modal, toggle } = await openAssistantModal(page);

    // 無効化されておらず、スイッチとして読み上げられる。既定は OFF
    await expect(toggle).toBeEnabled();
    await expect(page.getByRole("switch", { name: "究極モード" })).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // 以前のロック表示が残っていない
    await expect(modal).toContainText("究極モード");
    await expect(modal).not.toContainText("Premium");
    await expect(modal).not.toContainText("準備中");

    // 押すたびに ON / OFF が切り替わる
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    expect(dialogMessages, "究極モードを押しても alert は出ない").toEqual([]);
  });

  test("ON にして生成すると、生成 API に ultimateMode: true が送られる", async ({ regularUser }) => {
    const page = regularUser;
    const requestBodies = await mockGenerateApi(page);

    const { modal, toggle } = await openAssistantModal(page);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await startSingleDayGeneration(modal);

    await expect.poll(() => requestBodies.length, { timeout: 10_000 }).toBe(1);
    expect(requestBodies[0].ultimateMode).toBe(true);
    // 生成の対象 (1 日 3 食) など、ほかの内容は今までどおり
    expect(requestBodies[0].targetSlots).toHaveLength(3);
  });

  test("触らずに生成すると、生成 API には ultimateMode: false が送られる (既定は OFF)", async ({ regularUser }) => {
    const page = regularUser;
    const requestBodies = await mockGenerateApi(page);

    const { modal, toggle } = await openAssistantModal(page);
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await startSingleDayGeneration(modal);

    await expect.poll(() => requestBodies.length, { timeout: 10_000 }).toBe(1);
    expect(requestBodies[0].ultimateMode).toBe(false);
  });

  test("モーダルを閉じて開き直すと、究極モードは OFF に戻る", async ({ regularUser }) => {
    const page = regularUser;

    const { toggle } = await openAssistantModal(page);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // 背景 (オーバーレイ) を押して閉じる。V4GenerateModal は Escape を処理しない
    await page.mouse.click(5, 5);
    await expect(page.getByTestId("v4-generate-modal-normal")).toBeHidden();

    // 開き直すと OFF (ON のまま残らない)
    await page.getByTestId("ai-assistant-banner-button").click();
    const reopenedToggle = page.getByTestId("v4-generate-modal-normal").getByTestId("ultimate-mode-toggle");
    await expect(reopenedToggle).toBeVisible({ timeout: 10_000 });
    await expect(reopenedToggle).toHaveAttribute("aria-checked", "false");
  });
});
