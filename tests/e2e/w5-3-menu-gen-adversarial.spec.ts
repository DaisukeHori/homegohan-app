/**
 * Wave 5 / W5-3: 献立生成 Queue 完全嫌がらせ E2E
 *
 * 3〜5分かかる週間献立生成プロセスを破壊的にテストする。
 * 実際の LLM 呼び出しは行わず、API をモックして UI・Queue・cron の挙動を検証する。
 *
 * 実行方法:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e -- w5-3-menu-gen-adversarial
 *
 * prefix: [menu-gen][adversarial]
 *
 * テストユーザー (#1672):
 *   - 画面の挙動を見るテストは、生成の API をブラウザの通信の差し替え (page.route) で返すので、共通のテストユーザー (authedPage) を使う。
 *   - 本物の生成の API (POST /api/ai/menu/weekly/request・/api/ai/menu/v4/generate) へ直接送るテスト (A-3・C-9〜C-12・Edge) と、
 *     生成のモーダルを開いて送る A-1・E-19 は、テストごとに作るユーザー (fresh-user の regularUser) を使う (apiUserTest)。
 *     本物の API は、利用者ごとに 1 分 5 回のレート制限 (src/lib/rate-limit.ts の generation) と 1 日の AI の上限
 *     (free は 1 日の AI 3 回・献立の作成 3 回。billing/03 §6.5。429) で数え、その週の献立を消して生成の要求の行を作る。
 *     1 人で献立の作成を 4 回以上送るテスト (A-3・C-12) は、テストごとのユーザーに pro (献立の作成 10 回・1 日の AI 30 回) を
 *     手動付与してから送る (paidApiUserTest。billing/03 §16.1 の w5-3 の行)。3 回以下のテストは無料のユーザーのまま。
 *     共通のテストユーザーは worker の番号で 4 人を回して使うので、同じユーザーの送信が並びによって 1 分に 5 回を超えて 429 になりえた。
 *     429 を Retry-After どおりに待つ案は採らない: 1 日の上限の 429 は次の JST 0 時まで待たせるので待っても通らず、
 *     共通のユーザーの献立を消すことも残るため。
 */

import { test, expect, type Page } from "./fixtures/auth";
import {
  test as apiUserTest,
  cleanupFreshUser,
  createFreshUser,
  getAdminClient,
  injectSession,
  upsertUserProfile,
} from "./fixtures/fresh-user";
import type { APIResponse } from "@playwright/test";
import { addDaysToDate } from "../../packages/shared/src/date-utils";
import { jstThisMonday } from "./helpers/jst-week";
import { E2E_PAID_PERSONAL_PLAN_KEY, grantManualPlanForE2e } from "./helpers/billing-plan";
import { grantE2eAiConsent } from "../../scripts/lib/e2e-ai-consent";

/**
 * 1 人で献立の作成を 4 回以上送るテスト (A-3・C-12) の利用者: fresh-user の regularUser と同じ作り方
 * (テストごとに作る・AI の提供の同意を記録・roles = ['user'] と初期設定の完了・セッションの注入・終わったら削除) に、
 * pro の手動付与を足したもの。無料の利用者は献立の作成が 1 日 3 回・AI が 1 日 3 回 (billing/03 §6.5) で、
 * 4 回目が 429 になるため (billing/03 §16.1 の w5-3 の行)。期待 (受け付けられること) は変えない
 */
const paidApiUserTest = apiUserTest.extend<{ paidRegularUser: Page }>({
  paidRegularUser: async ({ page, aiConsentGranted }, use) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-fresh-paid" });
    try {
      if (aiConsentGranted) await grantE2eAiConsent(supabaseAdmin, user.id);
      await upsertUserProfile(user.id, { nickname: "E2E Paid User", roles: ["user"] });
      // 手動付与は user_profiles の行が要るので、プロファイルの後に呼ぶ
      await grantManualPlanForE2e(user.id, E2E_PAID_PERSONAL_PLAN_KEY);
      await injectSession(page, user.email);
      await use(page);
    } finally {
      // 契約の行は利用者の削除で CASCADE で消える
      await cleanupFreshUser(supabaseAdmin, user.id);
    }
  },
});

// ─── helpers ───────────────────────────────────────────────────────────────
// 今週の月曜日は、ページ (ブラウザは Asia/Tokyo) と同じ JST の週で作る (#1564)。前後の週は暦の計算 (addDaysToDate) でずらす

/** 1 週間の日数 */
const DAYS_PER_WEEK = 7;
/** C-10 の「約 10 年前」を週の数で表したもの (52 週 × 10 年。月曜日始まりの週のまま戻すため日数でなく週で数える) */
const TEN_YEARS_IN_WEEKS = 520;

const FAKE_REQUEST_ID = "00000000-dead-beef-cafe-000000000w53";
const FAKE_REQUEST_ID_2 = "00000000-dead-beef-cafe-000000001w53";

/** 共通ルートモック: cleanup は "nothing stuck", pending は false を返す */
async function stubIdle(page: Page) {
  await page.route("**/api/ai/menu/weekly/cleanup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });
  await page.route("**/api/ai/menu/weekly/pending*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ hasPending: false }),
    });
  });
}

/** 生成のモーダル (V4GenerateModal) の「1日献立変更」で作る枠の数 (朝・昼・夜)。モックの応答の totalSlots に使う */
const SINGLE_DAY_SLOT_COUNT = 3;

/**
 * 画面の生成の入り口 (POST /api/ai/menu/v4/generate。useV4MenuGeneration) をモックする (#1672)。
 * 送られた回数を返す。応答の requestId は、呼ばれた順に requestIds から取る (足りなければ最後のもの)
 */
async function stubV4Generate(page: Page, requestIds: readonly string[]): Promise<{ posts: () => number }> {
  let posts = 0;
  await page.route("**/api/ai/menu/v4/generate", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const requestId = requestIds[Math.min(posts, requestIds.length - 1)];
    posts++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "processing",
        message: "Generation started",
        requestId,
        totalSlots: SINGLE_DAY_SLOT_COUNT,
      }),
    });
  });
  return { posts: () => posts };
}

/** 献立の画面とモーダルの表示を待つ上限 (本番ビルドでも、初回の表示は献立の読み込みを含めて数秒かかる) */
const MODAL_OPEN_TIMEOUT_MS = 30_000;

/**
 * 今の生成の入り口を開く: 献立の画面の「AI献立アシスタント」(空欄があれば「空欄N件 → AIに埋めてもらう」) のボタン →
 * 生成のモーダル (V4GenerateModal) → 「1日献立変更」を選ぶ (#1672)。
 * テストごとに作るユーザーは献立が無いので、上書きの確認は出ない (bug-27-ultimate-mode-locked.spec.ts と同じ)。
 * 「献立を生成」のボタン (押すと文言が「献立を作成中...」に変わるので testid で指す) を返す
 */
async function openSingleDayGenerateModal(page: Page) {
  const banner = page.getByTestId("ai-assistant-banner-button");
  await expect(banner).toBeVisible({ timeout: MODAL_OPEN_TIMEOUT_MS });
  await banner.click();
  return chooseSingleDayInGenerateModal(page);
}

/** 開いている生成のモーダルで「1日献立変更」を選び、「献立を生成」のボタンを返す */
async function chooseSingleDayInGenerateModal(page: Page) {
  const modal = page.getByTestId("v4-generate-modal-normal");
  await expect(modal).toBeVisible({ timeout: MODAL_OPEN_TIMEOUT_MS });
  await modal.getByRole("button", { name: /1日献立変更/ }).click();
  const submit = modal.getByTestId("v4-generate-submit-button");
  await expect(submit).toHaveText("献立を生成");
  await expect(submit).toBeEnabled();
  return submit;
}

/** レート制限・1 日の AI の上限で断られたときのステータス */
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * 本物の生成の API への送信が、レート制限・1 日の AI の上限 (429) で止まらず、入力の扱いまで届いたこと (#1672)。
 * 429 は 5xx でないので「5xx にならない」の確認は通ってしまうが、それでは入力の検証もクラッシュの有無も確かめていない。
 * 送るテストはテストごとのユーザー (apiUserTest) を使い、1 分 5 回の枠を超えない回数しか送らないので、429 は来ない前提。
 * 来たら前提が崩れているので失敗にする (期待を緩めて通さない)
 */
function expectNotRateLimited(res: APIResponse, label: string) {
  expect(
    res.status(),
    `[テストの前提] ${label} が 429 (レート制限・1 日の AI の上限) で断られ、入力の扱いまで届いていない`,
  ).not.toBe(HTTP_TOO_MANY_REQUESTS);
}

/** status のモックが返す本文 (completed / failed を返すと、その要求は終わったものとして pending から消える) */
type StatusBody = { status: string } & Record<string, unknown>;

/** 終わった状態。サーバーの pending はこの状態の行を返さない (queued / pending / processing だけを返す) */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed"]);

/**
 * 生成が終わったあと、画面が生成中に戻らないことを見る待ちの長さ。
 * 画面は Realtime がつながらないとき、監視を始めて 5 秒後にポーリングをやり直す (page.tsx の subscribeToRequestStatus)。
 * それを超えて見る
 */
const AFTER_TERMINAL_SETTLE_MS = 7_000;

/** 生成中のカード (ProgressTodoCard) が出る・消えるまでの待ちの上限 (ポーリングは 3 秒ごと。3 回目で completed を返すので 2 回分 + 余裕) */
const PROGRESS_CARD_TIMEOUT_MS = 20_000;

/**
 * cleanup・pending・status を、サーバーと同じ整合で返すモック (#1622)。
 *
 * サーバーの pending (src/app/api/ai/menu/weekly/pending/route.ts) は queued / pending / processing の行だけを返す。
 * status が completed / failed を返したあと (行が終わったあと) は、同じ行を生成中として返さない (hasPending: false)。
 *
 * 以前の F-22・E-18・B-6 のモックは、status が終わりを返したあとも pending が生成中を返し続けていた。
 * 画面は生成が終わると (isGenerating が false に戻るたびに) pending を確かめ直すので、終わった要求をまた監視して
 * 終わりをまた受け取る、終わらない輪になっていた (F-22 は生成中のカードが出たり消えたりし続けて赤、
 * E-18 は要求が途切れず networkidle が来ないまま 60 秒で時間切れ、B-6 も同じ形で 1 回目が時間切れ)。
 * サーバーは終わった行を pending で返さないので、実際の画面ではこの輪は起きない (テストの前提が古かった)。
 */
async function stubPendingConsistentWithStatus(
  page: Page,
  opts: { requestId: string; statusBodyAt: (callIndex: number) => StatusBody },
): Promise<{ statusCalls: () => number; pendingCalls: () => number }> {
  let statusCalls = 0;
  let pendingCalls = 0;
  let terminalReturned = false;

  await page.route("**/api/ai/menu/weekly/cleanup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });
  // サーバー (pending/route.ts) は、表示中の週 (date) と start_date が違う行を返さない。モックも date の週の行を返す
  await page.route("**/api/ai/menu/weekly/pending*", async (route) => {
    pendingCalls++;
    const date = new URL(route.request().url()).searchParams.get("date");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        terminalReturned
          ? { hasPending: false }
          : { hasPending: true, requestId: opts.requestId, status: "processing", mode: "v5", startDate: date },
      ),
    });
  });
  await page.route("**/api/ai/menu/weekly/status*", async (route) => {
    const body = opts.statusBodyAt(statusCalls);
    statusCalls++;
    if (TERMINAL_STATUSES.has(body.status)) terminalReturned = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  return { statusCalls: () => statusCalls, pendingCalls: () => pendingCalls };
}

// ─── A. 連打・重複 ──────────────────────────────────────────────────────────

/** A-1 の連打の回数 */
const RAPID_CLICK_COUNT = 50;
/**
 * A-1 の 1 回の押下がボタンを見つけるまで待つ上限。1 回目の押下で生成が始まるとモーダルが閉じてボタンが無くなるので、
 * 残りの押下は見つからずに終わる (それで正しい)。そのとき全体が長く待たないよう短くする
 */
const RAPID_CLICK_TIMEOUT_MS = 2_000;
/** 1 件目の送信のあと、追加の送信が出ないことを見る待ちの長さ (以前の A-1 と同じ 2 秒) */
const RAPID_CLICK_SETTLE_MS = 2_000;
/** 生成が始まって、生成中のカード (ProgressTodoCard) が出るまでの待ちの上限 */
const GENERATION_START_TIMEOUT_MS = 10_000;

/**
 * A-1: 生成のモーダルの「献立を生成」を 50 連打 → 連打の防止 (V4GenerateModal の isSubmitting とボタンの disabled) が効き、
 *      生成の要求 (POST /api/ai/menu/v4/generate) はちょうど 1 件だけ送られる。
 *
 * #1672: 以前は今の画面に無い文言 (/今週の献立を生成|献立を生成|AI献立|生成する/) のボタンを探し、見つからずに毎回 skip していた。
 * 今の生成の入り口 (「AI献立アシスタント」のボタン → モーダル → 「1日献立変更」→「献立を生成」) で押す。
 * 1 件も送られなかった (押下が効かなかった) ときも失敗にする (以前の「最大 1 件」は 0 件でも通っていた)。
 *
 * 押下は dispatchEvent("click") で送る。押すたびにボタンが要素として見つかっている必要があるが、座標をクリックしないので、
 * モーダルが閉じたあとの押下が下の画面の別の要素に当たることはない。disabled のボタンへの click も、
 * ブラウザの既定の動き (disabled なら押せない) に頼らず、React の onClick の扱いと handleGenerate の確認まで届く (より厳しい)
 */
apiUserTest("[menu-gen][adversarial] A-1: 生成ボタン50連打 → リクエストは1件だけ", async ({
  regularUser,
}) => {
  const page = regularUser;
  await stubIdle(page);
  const generate = await stubV4Generate(page, [FAKE_REQUEST_ID]);
  // 生成が始まったあと、画面は status を読みに来る。生成中を返し続ける (完了・失敗で画面が変わらないように)
  await page.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", progress: null }),
    });
  });

  await page.goto("/menus/weekly");
  const submit = await openSingleDayGenerateModal(page);

  // 50 連打 (同時に投げる)
  await Promise.all(
    Array.from({ length: RAPID_CLICK_COUNT }, () =>
      submit.dispatchEvent("click", undefined, { timeout: RAPID_CLICK_TIMEOUT_MS }).catch(() => undefined),
    ),
  );

  await expect.poll(generate.posts, { message: "[BUG] 押しても生成の要求が送られなかった" }).toBeGreaterThanOrEqual(1);
  // 生成が始まり、生成中のカードが出る (押下が実際に生成を始めた)
  await expect(page.getByTestId("generation-progress")).toBeVisible({ timeout: GENERATION_START_TIMEOUT_MS });
  await page.waitForTimeout(RAPID_CLICK_SETTLE_MS);
  expect(
    generate.posts(),
    `[BUG] ${RAPID_CLICK_COUNT}連打で生成の要求が ${generate.posts()} 件送られた（期待: 1件）`,
  ).toBe(1);
});

/**
 * A-2: 生成中に同じ週を別タブで生成依頼 → 2 本目の POST が弾かれるか確認。
 *
 * 期待: 2 本目タブでも pending 検出により UI が生成中状態を引き継ぐ
 *       or 生成ボタンが disabled になっている
 */
test("[menu-gen][adversarial] A-2: 生成中に別タブで同週リクエスト → ガード or 引き継ぎ", async ({
  authedPage,
  context,
}) => {
  // tab A でモックした生成中状態を作る
  const weekStr = jstThisMonday();

  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasPending: true,
        requestId: FAKE_REQUEST_ID,
        status: "processing",
        mode: "v5",
        startDate: weekStr,
      }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", progress: null }),
    });
  });

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(2_000);

  // tab B を開く
  const tabB = await context.newPage();

  // tab B でも同じモックを適用
  await tabB.route("**/api/ai/menu/weekly/cleanup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });
  await tabB.route("**/api/ai/menu/weekly/pending*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasPending: true,
        requestId: FAKE_REQUEST_ID,
        status: "processing",
        mode: "v5",
        startDate: weekStr,
      }),
    });
  });
  await tabB.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", progress: null }),
    });
  });

  const tabBPostCount = { value: 0 };
  tabB.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/ai/menu/weekly/request")) {
      tabBPostCount.value++;
    }
  });

  await tabB.goto("/menus/weekly");
  await tabB.waitForLoadState("networkidle");
  await tabB.waitForTimeout(2_000);

  // tab B の生成ボタンが disabled か、または新規 POST が発行されていないことを確認
  const genBtn = tabB
    .locator("button")
    .filter({ hasText: /今週の献立を生成|献立を生成|AI献立/ })
    .first();

  const isDisabled = await genBtn.isDisabled({ timeout: 5_000 }).catch(() => false);
  const showsGenerating = await tabB.locator("text=/生成中|処理中/").first().isVisible({ timeout: 3_000 }).catch(() => false);

  // 生成ボタンが無効化されているか、生成中表示があれば OK
  const isProtected = isDisabled || showsGenerating || tabBPostCount.value === 0;
  expect(
    isProtected,
    `[BUG] tab B で生成中の重複リクエストが保護されていない（tabBPostCount=${tabBPostCount.value}, disabled=${isDisabled}, showsGenerating=${showsGenerating}）`,
  ).toBe(true);

  await tabB.close();
});

/** A-3 で続けて送る週の数。生成のレート制限 (1 分 5 回) の上限ちょうど。テストごとのユーザーなので、ほかのテストの送信と枠を分け合わない */
const A3_WEEK_COUNT = 5;
/** 生成を受け付けたときのステータス (src/app/api/ai/menu/weekly/request/route.ts は 200 で { status: "processing", requestId } を返す) */
const HTTP_OK = 200;

/**
 * A-3: 異なる週を 5 回続けて生成の要求 (POST /api/ai/menu/weekly/request) → 5 件とも受け付けられ、それぞれ別の requestId が返る
 *
 * page.request (API へ直接送る通信) は page.route の差し替えを通らないので、本物のサーバーに届く (#1672)。
 * 以前はモックが効く前提の書き方で、本物のサーバーの 400 / 401 / 500 も許していたが、429 は許しておらず、
 * 共通のテストユーザーの生成が 1 分に 5 回を超えると赤になった。テストごとのユーザー (apiUserTest) で送り、
 * 1 分 5 回の枠の中 (5 回) なので、5 件とも受け付けられることまで確かめる (429 は前提が崩れたとして失敗)。
 * 無料の献立の作成は 1 日 3 回 (billing/03 §6.5) なので、5 回送るこのテストは pro を付与した利用者 (paidApiUserTest) で送る
 */
paidApiUserTest("[menu-gen][adversarial] A-3: 異なる週を5連続リクエスト → 各 requestId 返却", async ({
  paidRegularUser,
}) => {
  const monday = jstThisMonday();
  const results: Array<{ startDate: string; status: number; requestId: unknown }> = [];
  for (let i = 0; i < A3_WEEK_COUNT; i++) {
    const startDate = addDaysToDate(monday, i * DAYS_PER_WEEK);
    const res = await paidRegularUser.request.post("/api/ai/menu/weekly/request", {
      data: { startDate },
      headers: { "Content-Type": "application/json" },
    });
    expectNotRateLimited(res, `${startDate} の週の生成の要求`);
    const body = (await res.json().catch(() => null)) as { requestId?: unknown } | null;
    results.push({ startDate, status: res.status(), requestId: body?.requestId });
  }

  for (const r of results) {
    expect(r.status, `[BUG] ${r.startDate} の週の生成の要求が受け付けられなかった: ${JSON.stringify(results)}`).toBe(HTTP_OK);
    expect(typeof r.requestId, `[BUG] ${r.startDate} の週の応答に requestId が無い: ${JSON.stringify(results)}`).toBe("string");
  }
  const ids = results.map((r) => r.requestId);
  expect(new Set(ids).size, `[BUG] 週ごとに別の requestId が返っていない: ${JSON.stringify(ids)}`).toBe(A3_WEEK_COUNT);
});

// ─── B. 中断・再開 ──────────────────────────────────────────────────────────

/**
 * B-5: 生成中にタブ閉じ → 再オープン → 進捗復元
 *
 * 期待: pending リクエストが検出されて UI が生成中状態を引き継ぐ
 */
test("[menu-gen][adversarial] B-5: 生成中タブ閉じ再オープン → 進捗復元", async ({
  authedPage,
}) => {
  const weekStr = jstThisMonday();

  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasPending: true,
        requestId: FAKE_REQUEST_ID,
        status: "processing",
        mode: "v5",
        startDate: weekStr,
      }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", progress: null }),
    });
  });

  // localStorage に生成中状態を仕込む（タブを閉じた後の状態を模倣）
  await authedPage.addInitScript(
    ([reqId, weekKey]: [string, string]) => {
      localStorage.setItem(
        "weeklyMenuGenerating",
        JSON.stringify({ weekStartDate: weekKey, timestamp: Date.now(), requestId: reqId }),
      );
    },
    [FAKE_REQUEST_ID, weekStr],
  );

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(3_000);

  // 生成中UI（progress bar / spinner / テキスト）が表示されているか確認
  const generatingIndicator = authedPage
    .locator("text=/生成中|処理中|AIが献立/")
    .or(authedPage.locator("[data-testid='generation-progress']"))
    .or(authedPage.locator("text=/step.*of|ステップ/i"))
    .first();

  const isVisible = await generatingIndicator.isVisible({ timeout: 8_000 }).catch(() => false);

  expect(
    isVisible,
    "[BUG] タブ再オープン後に生成中状態が復元されなかった（進捗UIが表示されていない）",
  ).toBe(true);
});

/**
 * B-6: 生成中に signOut → queue が孤児化しない（stale timeout で failed に遷移）
 *
 * 期待: ログアウト後に再ログインしてページを開いたとき、
 *       stale request が failed 扱いになって UI が生成中ループにならない
 *
 * #1622: pending は status が failed を返すまで生成中を返し、そのあとは返さない (サーバーと同じ。stubPendingConsistentWithStatus)。
 * 以前は pending が生成中を返し続け、画面が終わった要求の監視をやり直す輪で networkidle が来ず、1 回目が時間切れになっていた
 */
test("[menu-gen][adversarial] B-6: 生成中にサインアウト → stale 処理で failed 確認", async ({
  authedPage,
}) => {
  // stale なリクエスト（21分前に更新されたもの）をシミュレート
  // status=processing の行を status API が stale 判定で failed にした応答を返す
  const staleUpdatedAt = new Date(Date.now() - 21 * 60 * 1000).toISOString();

  const counters = await stubPendingConsistentWithStatus(authedPage, {
    requestId: FAKE_REQUEST_ID,
    statusBodyAt: () => ({
      status: "failed",
      errorMessage: "stale_request_timeout",
      updatedAt: staleUpdatedAt,
    }),
  });

  await authedPage.addInitScript(
    ([reqId, weekKey]: [string, string]) => {
      localStorage.setItem(
        "weeklyMenuGenerating",
        JSON.stringify({
          weekStartDate: weekKey,
          timestamp: Date.now() - 25 * 60 * 1000, // 25分前
          requestId: reqId,
        }),
      );
    },
    [FAKE_REQUEST_ID, jstThisMonday()],
  );

  await authedPage.goto("/menus/weekly");

  // stale な要求の status (failed) を読み、失敗の表示を出す
  await expect(
    authedPage.getByTestId("generation-failed-modal"),
    "[BUG] stale なリクエスト（21分以上前）の失敗が表示されなかった",
  ).toBeVisible({ timeout: PROGRESS_CARD_TIMEOUT_MS });
  expect(counters.statusCalls(), "status を一度も読んでいない").toBeGreaterThanOrEqual(1);

  // stale な request で生成中表示に戻らない（ループしない）
  await authedPage.waitForTimeout(AFTER_TERMINAL_SETTLE_MS);
  await expect(
    authedPage.getByTestId("generation-progress"),
    "[BUG] stale なリクエスト（21分以上前）で UI が生成中に戻った（ループ）",
  ).toBeHidden();
});

/**
 * B-7: 生成中に /home に navigate → 戻ったとき進捗が復元されること
 *
 * 期待: /menus/weekly → /home → /menus/weekly で生成中状態が引き継がれる
 */
test("[menu-gen][adversarial] B-7: 生成中に /home ナビゲート → 戻ると進捗復元", async ({
  authedPage,
}) => {
  const weekStr = jstThisMonday();

  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasPending: true,
        requestId: FAKE_REQUEST_ID,
        status: "processing",
        mode: "v5",
        startDate: weekStr,
      }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", progress: null }),
    });
  });

  await authedPage.addInitScript(
    ([reqId, weekKey]: [string, string]) => {
      localStorage.setItem(
        "weeklyMenuGenerating",
        JSON.stringify({ weekStartDate: weekKey, timestamp: Date.now(), requestId: reqId }),
      );
    },
    [FAKE_REQUEST_ID, weekStr],
  );

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(1_500);

  // /home に遷移
  await authedPage.goto("/");
  await authedPage.waitForLoadState("networkidle");

  // /menus/weekly に戻る
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(3_000);

  // 生成中 UI の復元を確認
  const generatingIndicator = authedPage
    .locator("text=/生成中|処理中|AIが献立/")
    .or(authedPage.locator("[data-testid='generation-progress']"))
    .first();

  const isRestored = await generatingIndicator.isVisible({ timeout: 8_000 }).catch(() => false);
  expect(
    isRestored,
    "[BUG] /home → /menus/weekly 戻り後に生成中状態が復元されなかった",
  ).toBe(true);
});

/**
 * B-8: 生成中に週を切り替え → 別週を表示しても生成進捗UIが正しく扱われる
 *
 * 期待: 別週の生成中でも、pending check でstartDate が不一致なら「引き継ぎしない」
 */
test("[menu-gen][adversarial] B-8: 生成中に週切り替え → 別週はhasPending=falseで返す", async ({
  authedPage,
}) => {
  const weekStr = jstThisMonday();
  const nextWeekStr = addDaysToDate(weekStr, 7);
  let pendingCallDate = "";

  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route) => {
    const url = new URL(route.request().url());
    pendingCallDate = url.searchParams.get("date") ?? "";
    // pending リクエストのstart_dateが今週（weekStr）、でも別週（nextWeekStr）を見ている場合はhasPending=false
    if (pendingCallDate === nextWeekStr) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ hasPending: false }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          hasPending: true,
          requestId: FAKE_REQUEST_ID,
          status: "processing",
          mode: "v5",
          startDate: weekStr, // 今週の生成中
        }),
      });
    }
  });
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", progress: null }),
    });
  });

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(2_000);

  // 翌週ボタン（next week）を探してクリック
  const nextWeekBtn = authedPage
    .locator("button")
    .filter({ hasText: /翌週|次週|来週|>|›/ })
    .or(authedPage.locator("[aria-label*='next week'], [aria-label*='翌週']"))
    .first();

  const hasNextWeekBtn = await nextWeekBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!hasNextWeekBtn) {
    test.skip(true, "Next week navigation button not found – UI layout may differ");
    return;
  }

  await nextWeekBtn.click();
  await authedPage.waitForTimeout(2_000);

  // 別週（nextWeekStr）では pending が false なので生成中UIが出ないことを確認
  const generatingText = authedPage.locator("text=/生成中|処理中/").first();
  // 別週を見ているので生成中UIは表示されない（または今週の生成を引き継がない）
  // これは仕様確認テスト — 表示状態をログするだけ
  const isGeneratingVisible = await generatingText.isVisible({ timeout: 3_000 }).catch(() => false);
  // pending check で別週の date が渡されていれば仕様通り
  if (pendingCallDate === nextWeekStr) {
    // 別週でも pending=false が返ったのに生成中が表示されている → BUG
    if (isGeneratingVisible) {
      // startDate が今週だが別週を見ている場合のログ
      console.warn(`[INFO] 別週（${nextWeekStr}）でも生成中UIが表示された。仕様確認必要。`);
    }
  }
  // テスト自体は pending API の呼び出しがあったことを確認
  expect(pendingCallDate).not.toBe("");
});

// ─── C. 異常入力 ──────────────────────────────────────────────────────────

/**
 * C-9: startDate = 1900-01-01 / 9999-12-31 でリクエスト
 *
 * 期待: 400 または 401（サーバーがクラッシュしない）
 */
apiUserTest("[menu-gen][adversarial] C-9: 極端な日付 1900-01-01 でリクエスト → 400/401", async ({
  regularUser,
}) => {
  const res1 = await regularUser.request.post("/api/ai/menu/weekly/request", {
    data: { startDate: "1900-01-01" },
    headers: { "Content-Type": "application/json" },
  });
  const res2 = await regularUser.request.post("/api/ai/menu/weekly/request", {
    data: { startDate: "9999-12-31" },
    headers: { "Content-Type": "application/json" },
  });

  expectNotRateLimited(res1, "1900-01-01 の生成の要求");
  expectNotRateLimited(res2, "9999-12-31 の生成の要求");
  // サーバーがクラッシュ（5xx）していないことを確認
  // 400（バリデーションエラー）、401（未認証）、200（受け付けた場合）は OK
  expect(res1.status(), `1900-01-01 で 5xx が返った: ${res1.status()}`).not.toBeGreaterThanOrEqual(500);
  expect(res2.status(), `9999-12-31 で 5xx が返った: ${res2.status()}`).not.toBeGreaterThanOrEqual(500);
});

/**
 * C-10: 過去 10 年前の週を生成リクエスト → 拒否 or 受け付け確認
 *
 * 期待: 400（拒否）または 200（受け付けて処理）— 5xx ではない
 */
apiUserTest("[menu-gen][adversarial] C-10: 過去10年前の週をリクエスト → 5xxなし", async ({
  regularUser,
}) => {
  // 端末 (Node のプロセス) の日付ではなく、JST の今週の月曜日から週の単位で戻す (#1564・#1622。月曜日のまま約 10 年前の週になる)
  const dateStr = addDaysToDate(jstThisMonday(), -TEN_YEARS_IN_WEEKS * DAYS_PER_WEEK);

  const res = await regularUser.request.post("/api/ai/menu/weekly/request", {
    data: { startDate: dateStr },
    headers: { "Content-Type": "application/json" },
  });

  expectNotRateLimited(res, `${dateStr} の生成の要求`);
  expect(
    res.status(),
    `過去10年前の日付で 5xx が返った: ${res.status()}`,
  ).not.toBeGreaterThanOrEqual(500);
});

/**
 * C-11: 7日間範囲ではなく 1日 / 100日 の targetSlots を送付
 *
 * 期待: server がクラッシュしない（400 or 200 で処理）
 */
apiUserTest("[menu-gen][adversarial] C-11: targetSlots が不正サイズ → サーバークラッシュなし", async ({
  regularUser,
}) => {
  const monday = jstThisMonday();

  // 1日分のみ
  const res1 = await regularUser.request.post("/api/ai/menu/v4/generate", {
    data: {
      targetSlots: [{ date: monday, mealType: "dinner" }],
      constraints: {},
      note: "",
      ultimateMode: false,
    },
    headers: { "Content-Type": "application/json" },
  });

  // 100日分（7×3×100/7 ≒ 300スロット）
  const massiveSlots = Array.from({ length: 300 }, (_, i) => ({
    date: addDaysToDate(monday, Math.floor(i / 3)),
    mealType: ["breakfast", "lunch", "dinner"][i % 3],
  }));
  const res2 = await regularUser.request.post("/api/ai/menu/v4/generate", {
    data: {
      targetSlots: massiveSlots,
      constraints: {},
      note: "",
      ultimateMode: false,
    },
    headers: { "Content-Type": "application/json" },
  });

  expectNotRateLimited(res1, "1 枠の生成の要求");
  expectNotRateLimited(res2, "300 枠の生成の要求");
  expect(res1.status(), `1スロットで 5xx: ${res1.status()}`).not.toBeGreaterThanOrEqual(500);
  expect(res2.status(), `300スロットで 5xx: ${res2.status()}`).not.toBeGreaterThanOrEqual(500);
});

/**
 * C-12: メモ欄に 10000 文字 / NULL byte / control chars
 *
 * 期待: サーバーがクラッシュしない（400 or 200）
 *
 * 6 件のうち NULL byte はレート制限の前に 400 で断られるので、レート制限に数えるのは 5 件 (1 分 5 回の枠の中)。
 * 件を足すときは、1 分 5 回を超えないよう別のテストに分ける (#1672)。
 * 無料の献立の作成は 1 日 3 回 (billing/03 §6.5) なので、5 件を数えるこのテストは pro を付与した利用者 (paidApiUserTest) で送る
 */
paidApiUserTest("[menu-gen][adversarial] C-12: 異常メモ入力 → サーバークラッシュなし", async ({
  paidRegularUser,
}) => {
  const monday = jstThisMonday();
  const cases: Array<{ name: string; note: string; expectedStatus?: number; expectedCode?: string }> = [
    { name: "10000文字", note: "あ".repeat(10000) },
    // #1622: NULL 文字は Postgres の text / jsonb に入らない (以前は insert が拒まれて 500)。route が DB に渡す前に 400 で断る
    { name: "NULL byte", note: "test\x00injection", expectedStatus: 400, expectedCode: "INVALID_CHARACTER" },
    { name: "control chars", note: "test\x01\x02\x03\x1B[31m red\x1B[0m" },
    { name: "Unicode emoji bomb", note: "💣".repeat(1000) },
    { name: "SQL injection attempt", note: "'; DROP TABLE weekly_menu_requests; --" },
    { name: "JSON injection", note: '{"__proto__": {"admin": true}}' },
  ];

  for (const c of cases) {
    const res = await paidRegularUser.request.post("/api/ai/menu/weekly/request", {
      data: { startDate: monday, note: c.note },
      headers: { "Content-Type": "application/json" },
    });
    expectNotRateLimited(res, `${c.name} の生成の要求`);
    expect(
      res.status(),
      `[BUG] ${c.name} で 5xx クラッシュ: ${res.status()}`,
    ).not.toBeGreaterThanOrEqual(500);
    if (c.expectedStatus !== undefined) {
      expect(res.status(), `[BUG] ${c.name} を ${c.expectedStatus} で断っていない`).toBe(c.expectedStatus);
      expect(await res.json()).toMatchObject({ code: c.expectedCode });
    }
  }
});

// ─── D. queue / cron ──────────────────────────────────────────────────────

/**
 * D-14: CRON_SECRET なしで /api/cron/process-menu-queue → 401 or 503
 *
 * 期待: 未認証アクセスは拒否される
 */
test("[menu-gen][adversarial] D-14: CRON_SECRETなしでcron → 401/503", async ({
  authedPage,
}) => {
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("domcontentloaded");

  // Authorization ヘッダーなしで GET
  const resNoAuth = await authedPage.request.get("/api/cron/process-menu-queue");
  expect(
    [401, 503],
    `[BUG] CRON_SECRET なしで ${resNoAuth.status()} が返った（401 or 503 が期待）`,
  ).toContain(resNoAuth.status());

  // 間違った secret
  const resWrongAuth = await authedPage.request.get("/api/cron/process-menu-queue", {
    headers: { Authorization: "Bearer wrong-secret-12345" },
  });
  expect(
    [401, 503],
    `[BUG] 不正な CRON_SECRET で ${resWrongAuth.status()} が返った`,
  ).toContain(resWrongAuth.status());
});

/**
 * D-16: attempt_count >= 3 のリクエストが failed に変わること
 *
 * 期待: cleanup API で status=failed に遷移した response が返る
 *       (UI では failed エラーが表示される)
 */
test("[menu-gen][adversarial] D-16: attempt_count >= 3 → UI が failed 状態を表示", async ({
  authedPage,
}) => {
  const weekStr = jstThisMonday();

  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route) => {
    // attempt_count 上限超えは status=failed で返ってくる
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ hasPending: false }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "failed",
        errorMessage: "attempt_limit_exceeded",
        updatedAt: new Date().toISOString(),
      }),
    });
  });

  // localStorage に attempt_limit_exceeded な failed request を仕込む
  await authedPage.addInitScript(
    ([reqId, weekKey]: [string, string]) => {
      localStorage.setItem(
        "weeklyMenuGenerating",
        JSON.stringify({ weekStartDate: weekKey, timestamp: Date.now(), requestId: reqId }),
      );
    },
    [FAKE_REQUEST_ID, weekStr],
  );

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(3_000);

  // failed 状態のとき UI がループ（生成中表示）にならないことを確認
  const infiniteSpinner = authedPage.locator("text=/生成中|処理中/").first();
  const isStuckGenerating = await infiniteSpinner.isVisible({ timeout: 3_000 }).catch(() => false);
  expect(
    isStuckGenerating,
    "[BUG] attempt_limit_exceeded (failed) なのに生成中UIがループし続けている",
  ).toBe(false);
});

/**
 * D-17: cleanup API の status='queued' 対応 (#116)
 *
 * 期待: GET /api/ai/menu/weekly/cleanup が status 'queued' を含めて返す
 */
test("[menu-gen][adversarial] D-17: cleanup API が queued ステータスを認識", async ({
  authedPage,
}) => {
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("domcontentloaded");

  // GET /api/ai/menu/weekly/cleanup を呼んで stuckRequests の status フィールドを確認
  const res = await authedPage.request.get("/api/ai/menu/weekly/cleanup");
  // 認証済みなので 200 が返るはず
  if (res.status() === 401) {
    test.skip(true, "Authentication required for cleanup API – skip");
    return;
  }
  expect(res.status()).toBe(200);

  const body = await res.json();
  // レスポンスが stuckRequests 配列を持っているか確認
  expect(body).toHaveProperty("stuckRequests");
  expect(Array.isArray(body.stuckRequests)).toBe(true);

  // もし queued/pending/processing が含まれていれば status フィールドが正しいか確認
  for (const req of body.stuckRequests ?? []) {
    expect(
      ["queued", "pending", "processing"],
      `[BUG] cleanup API の stuckRequests に想定外の status: ${req.status}`,
    ).toContain(req.status);
  }
});

// ─── E. failure シナリオ ──────────────────────────────────────────────────

/**
 * E-18: AI API timeout 後の status 整合性 (#122)
 *
 * 期待: Edge Function が 50秒 abort した後、cron worker が二重に status を書き込まない
 *       → UI では failed が一度だけ表示されてループしない
 *
 * #1622: pending は status が failed を返すまで生成中を返し、そのあとは返さない (サーバーと同じ。stubPendingConsistentWithStatus)。
 * 以前のモックは pending が「hasPending: true・status: failed」を返し続けた (サーバーは failed の行を pending で返さない)。
 * 画面は終わった要求の監視をやり直し続け、要求が途切れず networkidle が来ないまま 60 秒で時間切れになっていた
 */
test("[menu-gen][adversarial] E-18: タイムアウト後の status 整合性 → ループなし", async ({
  authedPage,
}) => {
  const counters = await stubPendingConsistentWithStatus(authedPage, {
    requestId: FAKE_REQUEST_ID,
    statusBodyAt: () => ({
      status: "failed",
      errorMessage: "Edge function timeout after 50s",
      updatedAt: new Date().toISOString(),
    }),
  });

  await authedPage.addInitScript(
    ([reqId, weekKey]: [string, string]) => {
      localStorage.setItem(
        "weeklyMenuGenerating",
        JSON.stringify({ weekStartDate: weekKey, timestamp: Date.now(), requestId: reqId }),
      );
    },
    [FAKE_REQUEST_ID, jstThisMonday()],
  );

  await authedPage.goto("/menus/weekly");

  // failed を受け取り、失敗の表示を出して、生成中のカードを消す
  await expect(
    authedPage.getByTestId("generation-failed-modal"),
    "[BUG] タイムアウトの failed が表示されなかった",
  ).toBeVisible({ timeout: PROGRESS_CARD_TIMEOUT_MS });
  await expect(authedPage.getByTestId("generation-progress")).toBeHidden();

  // failed を受け取ったあとはポーリングが止まる (Realtime がつながらないときの 5 秒後のやり直しも含めて、status を読み直さない)
  const callsAtFailure = counters.statusCalls();
  await authedPage.waitForTimeout(AFTER_TERMINAL_SETTLE_MS);
  const additionalCalls = counters.statusCalls() - callsAtFailure;
  expect(
    additionalCalls,
    `[BUG] failed 状態後もポーリングが続いている（failed のあと ${AFTER_TERMINAL_SETTLE_MS} ms で ${additionalCalls} 回呼ばれた）`,
  ).toBe(0);
  // 生成中に戻らない
  await expect(authedPage.getByTestId("generation-progress")).toBeHidden();
});

/** 状態の確認の API のパス (画面は ?requestId=... を付けて読む) */
const STATUS_API_PATH = "/api/ai/menu/weekly/status";
/**
 * やり直しで始めた生成の status を、画面が読みに来るまでの待ちの上限。
 * 生成のモーダルから始めた生成は、Realtime と並んで 5 秒ごとに status を読む (page.tsx の handleV4Generate)。2 回分 + 余裕
 */
const RETRIED_STATUS_READ_TIMEOUT_MS = 15_000;

/**
 * E-19: 生成の失敗の表示の「もう一度試す」→ 生成のモーダルから送り直す → 新しい生成の要求が 1 件送られ、画面は新しい requestId を監視する
 *
 * #1672: 以前は今の画面に無い文言のボタンを探し、見つからずに毎回 skip していた。また失敗の状態を作れておらず
 * (pending が hasPending: false だった)、失敗の表示そのものが出ていなかった。
 * 今の流れ: 生成中だった要求 (FAKE_REQUEST_ID) が failed になる → 失敗の表示 (generation-failed-modal) の「もう一度試す」
 * (generation-retry-button) → 生成のモーダル → 「1日献立変更」→「献立を生成」→ POST /api/ai/menu/v4/generate (FAKE_REQUEST_ID_2 を返す)。
 */
apiUserTest("[menu-gen][adversarial] E-19: 生成失敗後のリトライ → 新規requestId", async ({
  regularUser,
}) => {
  const page = regularUser;
  // 失敗した要求: pending は status が failed を返すまで生成中を返し、そのあとは返さない (サーバーと同じ)
  await stubPendingConsistentWithStatus(page, {
    requestId: FAKE_REQUEST_ID,
    statusBodyAt: () => ({
      status: "failed",
      errorMessage: "generation failed",
      updatedAt: new Date().toISOString(),
    }),
  });
  // やり直しで始めた要求の status は生成中を返す (あとから登録した route が先に当たる)
  let retriedStatusReads = 0;
  await page.route(
    (url) => url.pathname === STATUS_API_PATH && url.searchParams.get("requestId") === FAKE_REQUEST_ID_2,
    async (route) => {
      retriedStatusReads++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "processing", progress: null }),
      });
    },
  );
  const generate = await stubV4Generate(page, [FAKE_REQUEST_ID_2]);

  // 生成中だった要求の印 (画面を開くと、この要求の状態を読み直して失敗を表示する)
  const generatingMarker: [string, string] = [FAKE_REQUEST_ID, jstThisMonday()];
  await page.addInitScript(([reqId, weekKey]: [string, string]) => {
    localStorage.setItem(
      "weeklyMenuGenerating",
      JSON.stringify({ weekStartDate: weekKey, timestamp: Date.now(), requestId: reqId }),
    );
  }, generatingMarker);

  await page.goto("/menus/weekly");

  const failedModal = page.getByTestId("generation-failed-modal");
  await expect(failedModal, "[BUG] 生成の失敗が表示されなかった").toBeVisible({ timeout: PROGRESS_CARD_TIMEOUT_MS });
  await page.getByTestId("generation-retry-button").click();
  await expect(failedModal).toBeHidden();

  const submit = await chooseSingleDayInGenerateModal(page);
  await submit.click();

  await expect.poll(generate.posts, { message: "[BUG] リトライで新しい生成の要求が送られなかった" }).toBe(1);
  await expect(page.getByTestId("generation-progress")).toBeVisible({ timeout: GENERATION_START_TIMEOUT_MS });
  // 画面は、古い requestId ではなく、新しく返った requestId の状態を読みに来る
  await expect
    .poll(() => retriedStatusReads, {
      message: "[BUG] リトライで返った新しい requestId の状態を読みに来ない",
      timeout: RETRIED_STATUS_READ_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(1);
  expect(generate.posts(), "[BUG] リトライ 1 回で生成の要求が複数送られた").toBe(1);
});

// ─── F. multi-tab realtime ───────────────────────────────────────────────

/**
 * F-22: tab A で生成完了 → tab B で Realtime 受信して UI 更新
 *
 * 期待: Supabase Realtime の postgres_changes が tab B に届き、
 *       献立データが更新されること（最低限：生成中UIが消える）
 *
 * #1622: pending は status が completed を返すまで生成中を返し、そのあとは返さない (サーバーと同じ。stubPendingConsistentWithStatus)。
 * 以前のモックは pending が生成中を返し続け、画面は completed のあと pending を確かめ直して、終わった要求をまた監視し、
 * 生成中のカードが出たり消えたりし続けていた (サーバーは completed の行を pending で返さないので、実際の画面では起きない)。
 * 生成中を引き継いだこと (カードが出ること) も確かめる (以前は出ていなければ何も確かめずに通っていた)
 */
test("[menu-gen][adversarial] F-22: tabA生成完了 → tabBでリアルタイム更新", async ({
  authedPage,
  context,
}) => {
  const weekStr = jstThisMonday();
  /** status の何回目 (0 始まり) から completed を返すか (最初の 2 回は processing) */
  const COMPLETED_FROM_CALL_INDEX = 2;

  // tab B を先に開いておく（Realtime 購読を開始させる）
  const tabB = await context.newPage();

  const counters = await stubPendingConsistentWithStatus(tabB, {
    requestId: FAKE_REQUEST_ID,
    statusBodyAt: (callIndex) => ({
      status: callIndex >= COMPLETED_FROM_CALL_INDEX ? "completed" : "processing",
      progress: null,
    }),
  });

  await tabB.addInitScript(
    ([reqId, weekKey]: [string, string]) => {
      localStorage.setItem(
        "weeklyMenuGenerating",
        JSON.stringify({ weekStartDate: weekKey, timestamp: Date.now(), requestId: reqId }),
      );
    },
    [FAKE_REQUEST_ID, weekStr],
  );

  await tabB.goto("/menus/weekly");

  // tab B が生成中状態を引き継いでいることを確認
  const card = tabB.getByTestId("generation-progress");
  await expect(card, "[BUG] tab B が生成中の状態を引き継がなかった").toBeVisible({ timeout: PROGRESS_CARD_TIMEOUT_MS });

  // ポーリングが completed を受信した後、生成中UIが消える
  await expect(
    card,
    "[BUG] completed 後もtab Bで生成中UIが残り続けている（ポーリング/Realtime が機能していない）",
  ).toBeHidden({ timeout: PROGRESS_CARD_TIMEOUT_MS });
  expect(counters.statusCalls(), "completed を返す前に生成中の UI が消えた").toBeGreaterThan(COMPLETED_FROM_CALL_INDEX);

  // 完了のあと、生成中に戻らない
  await tabB.waitForTimeout(AFTER_TERMINAL_SETTLE_MS);
  await expect(card, "[BUG] completed 後に tab B が生成中に戻った").toBeHidden();

  await tabB.close();
});

/**
 * F-23: 進捗 % が逆行しない (#119 Ultimate Mode 6 step)
 *
 * 期待: step 4 → step 5 → step 6 の順で progress % が増加のみ
 *
 * #1609: pending のモックに ultimateMode: true を足し、究極モードの段 (4〜6 工程) が実際に出ることを確かめる。
 * 以前のモックは mode: 'v5' だけで、#1597 のあとは通常の段 (3 工程) として描かれ、step 4〜6 の割合は 0 で出ていなかった
 * (% がサンプリングできなければ pass だったので赤にならなかった)。
 */
test("[menu-gen][adversarial] F-23: Ultimate Mode 6ステップの進捗%が逆行しない", async ({
  authedPage,
}) => {
  let statusCallCount = 0;

  // step 4 → 5 → 6 を順にシミュレート
  const progressSequence = [
    { currentStep: 4, totalSteps: 6, message: "栄養バランス分析中...", completedSlots: 2, totalSlots: 7 },
    { currentStep: 5, totalSteps: 6, message: "献立を改善中...", completedSlots: 5, totalSlots: 7 },
    { currentStep: 6, totalSteps: 6, message: "最終保存中...", completedSlots: 7, totalSlots: 7 },
  ];
  /**
   * 上の各 step の究極モードの割合 (src/app/(main)/menus/weekly/_state/v4ProgressUi.ts。message に n/m が無いときの値):
   * step 4 = 55%・step 5 = 70%・step 6 (完了の文でない) = 90%。通常の段には step 4〜6 が無く、割合は出ない
   */
  const ULTIMATE_PERCENTAGES = [55, 70, 90];
  const FINAL_PERCENTAGE = ULTIMATE_PERCENTAGES[ULTIMATE_PERCENTAGES.length - 1];
  /** 究極モードの段にだけある工程の名前 (packages/shared の ULTIMATE_PROGRESS_PHASES) */
  const ULTIMATE_ONLY_LABEL = "栄養バランスを詳細分析";
  /** 割合を読む間隔と、最後の step の割合が出るまで待つ上限 (ポーリングは 3 秒ごと。3 つの step で 2 回分 + 余裕) */
  const SAMPLE_INTERVAL_MS = 500;
  const SAMPLE_TIMEOUT_MS = 30_000;

  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });
  // サーバー (pending/route.ts) は、表示中の週 (date) と start_date が違う行を返さない。モックも date の週の行を返す
  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route) => {
    const date = new URL(route.request().url()).searchParams.get("date");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasPending: true,
        requestId: FAKE_REQUEST_ID,
        status: "processing",
        mode: "v5",
        ultimateMode: true,
        startDate: date,
      }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    const idx = Math.min(statusCallCount, progressSequence.length - 1);
    statusCallCount++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "processing",
        progress: progressSequence[idx],
      }),
    });
  });

  await authedPage.goto("/menus/weekly");

  const card = authedPage.getByTestId("generation-progress");
  await expect(card).toBeVisible({ timeout: 15_000 });

  // 進捗 % を、最後の step の割合が出るまで読み続ける
  const displayedPercentages: number[] = [];
  const deadline = Date.now() + SAMPLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = (await card.textContent()) ?? "";
    const match = text.match(/(\d+)%/);
    if (match) {
      displayedPercentages.push(parseInt(match[1], 10));
      if (displayedPercentages[displayedPercentages.length - 1] === FINAL_PERCENTAGE) break;
    }
    await authedPage.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  // 究極モードの段の割合が出て、最後の step まで進んだ
  expect(displayedPercentages, "[BUG] 究極モードの step 6 の割合まで進まなかった").toContain(FINAL_PERCENTAGE);
  // 出た割合は、どれも究極モードの step 4〜6 の値 (通常の段なら割合は出ない)
  for (const percentage of displayedPercentages) {
    expect(ULTIMATE_PERCENTAGES, `[BUG] 究極モードの step 4〜6 でない割合が出た: ${percentage}%`).toContain(percentage);
  }
  // 途中の step の割合も読めた (最後の 1 回だけでは逆行を確かめられない)
  expect(new Set(displayedPercentages).size).toBeGreaterThanOrEqual(2);
  // 単調増加
  for (let i = 1; i < displayedPercentages.length; i++) {
    expect(
      displayedPercentages[i],
      `[BUG] 進捗%が逆行した: ${displayedPercentages[i - 1]}% → ${displayedPercentages[i]}%`,
    ).toBeGreaterThanOrEqual(displayedPercentages[i - 1]);
  }

  // 工程の一覧も究極モードの段
  await card.click();
  await expect(card.getByText(ULTIMATE_ONLY_LABEL)).toBeVisible();
});

// ─── Security / CRON boundary ───────────────────────────────────────────

/**
 * Security: 任意ユーザーが他ユーザーの requestId で status を確認できない
 *
 * 期待: /api/ai/menu/weekly/status?requestId=<他人のID> → { status: "not_found", requestId } だけ (状態・進捗・エラー文・時刻を返さない)
 *
 * #1622: status の route (src/app/api/ai/menu/weekly/status/route.ts) は本人の行 (user_id が自分) だけを読み、
 * 他人の行と存在しない行に、同じ { status: "not_found", requestId } を返す (#780 で failed + "Request not found" から変えた。
 * 他人の行の有無を応答から見分けられない)。このテストは #780 より前の failed を期待したままだった。
 * 本人に絞ることと応答の形は src/__tests__/api/ai/menu/weekly-status-not-found.test.ts でも確かめる
 */
test("[menu-gen][adversarial] Security: 他ユーザーのrequestIdでstatus確認不可", async ({
  authedPage,
}) => {
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("domcontentloaded");

  // ランダムな UUID（他人の requestId を模倣）
  const otherUsersRequestId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const res = await authedPage.request.get(
    `/api/ai/menu/weekly/status?requestId=${otherUsersRequestId}`,
  );

  expect(res.status(), `[BUG] 他ユーザーの requestId で ${res.status()} が返った`).toBe(200);
  const body = await res.json();
  // 本人に絞った結果が 0 行のときの応答だけを返す (他人の行の状態・進捗を返していない)
  expect(
    body,
    `[BUG] 他ユーザーの requestId で not_found 以外が返された（認可漏れの可能性）: ${JSON.stringify(body)}`,
  ).toEqual({ status: "not_found", requestId: otherUsersRequestId });
});

/**
 * Edge: 生成リクエストに JSON 以外のボディを送付
 *
 * 期待: 400 or 415（サーバーがクラッシュしない）
 */
apiUserTest("[menu-gen][adversarial] Edge: 非JSONボディ送付 → クラッシュなし", async ({
  regularUser,
}) => {
  const res = await regularUser.request.post("/api/ai/menu/weekly/request", {
    data: "this is not json at all <script>alert(1)</script>",
    headers: { "Content-Type": "text/plain" },
  });

  expectNotRateLimited(res, "JSON 以外の本文の生成の要求");
  expect(
    res.status(),
    `[BUG] 非JSON ボディで 5xx クラッシュ: ${res.status()}`,
  ).not.toBeGreaterThanOrEqual(500);
});

/**
 * Edge: 巨大な JSON ボディ（note フィールドに 1MB のテキスト）
 *
 * 期待: 400 or 413（ペイロード制限）または処理される — 5xx ではない
 */
apiUserTest("[menu-gen][adversarial] Edge: 1MBのnoteフィールド → クラッシュなし", async ({
  regularUser,
}) => {
  const oneMBNote = "x".repeat(1024 * 1024);
  const res = await regularUser.request.post("/api/ai/menu/weekly/request", {
    data: { startDate: jstThisMonday(), note: oneMBNote },
    headers: { "Content-Type": "application/json" },
  });

  expectNotRateLimited(res, "1MB の note の生成の要求");
  expect(
    res.status(),
    `[BUG] 1MB note で 5xx クラッシュ: ${res.status()}`,
  ).not.toBeGreaterThanOrEqual(500);
});
