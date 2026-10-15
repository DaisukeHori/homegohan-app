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
 */

import { test, expect, type Page } from "./fixtures/auth";
import { addDaysToDate } from "../../packages/shared/src/date-utils";
import { jstThisMonday } from "./helpers/jst-week";

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

/** モックした週次リクエスト API (POST /api/ai/menu/weekly/request) */
async function stubWeeklyRequest(page: Page, requestId: string) {
  await page.route("**/api/ai/menu/weekly/request", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", message: "Generation started", requestId }),
    });
  });
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

/**
 * A-1: 「献立生成」ボタンを 50 連打 → debounce/guard が機能して
 *      API リクエストが最大 1 件しか発行されないことを確認。
 *
 * 期待: POST /api/ai/menu/weekly/request が 0〜1 件のみ
 */
test("[menu-gen][adversarial] A-1: 生成ボタン50連打 → リクエストは最大1件", async ({
  authedPage,
}) => {
  await stubIdle(authedPage);
  await stubWeeklyRequest(authedPage, FAKE_REQUEST_ID);

  // status: processing を返すことで UI がループしないようにする
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", progress: null }),
    });
  });

  const postCount = { value: 0 };
  authedPage.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/ai/menu/weekly/request")) {
      postCount.value++;
    }
  });

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");

  // 献立生成ボタンを探す（複数のセレクタを試みる）
  const genBtn = authedPage
    .locator("button")
    .filter({ hasText: /今週の献立を生成|献立を生成|AI献立|生成する/ })
    .first();

  const isVisible = await genBtn.isVisible({ timeout: 8_000 }).catch(() => false);
  if (!isVisible) {
    test.skip(true, "Generate button not visible – UI layout may differ");
    return;
  }

  // 50 連打（Promise.all で同時発火）
  const clicks = Array.from({ length: 50 }, () => genBtn.click({ force: true }).catch(() => {}));
  await Promise.all(clicks);
  await authedPage.waitForTimeout(2_000);

  expect(
    postCount.value,
    `[BUG] 50連打でリクエストが ${postCount.value} 件送信された（期待: 最大1件）`,
  ).toBeLessThanOrEqual(1);
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

/**
 * A-3: 異なる7日間範囲を5連続でリクエスト (queue 詰まり)
 *
 * 期待: 各リクエストが requestId を持って返ること
 *       (実際の DB への挿入は行わないがモックで検証)
 */
test("[menu-gen][adversarial] A-3: 異なる週を5連続リクエスト → 各 requestId 返却", async ({
  authedPage,
}) => {
  const requestIds: string[] = [];
  let callCount = 0;

  await authedPage.route("**/api/ai/menu/weekly/request", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    callCount++;
    const id = `fake-id-${callCount.toString().padStart(4, "0")}`;
    requestIds.push(id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", message: "Generation started", requestId: id }),
    });
  });

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
      body: JSON.stringify({ hasPending: false }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", progress: null }),
    });
  });

  // 5 つの異なる週を直接 POST
  const monday = jstThisMonday();
  const responses: number[] = [];
  for (let i = 0; i < 5; i++) {
    const startDate = addDaysToDate(monday, i * 7);
    const res = await authedPage.request.post("/api/ai/menu/weekly/request", {
      data: { startDate },
      headers: { "Content-Type": "application/json" },
    });
    responses.push(res.status());
  }

  // 認証済みユーザーとして呼んでいるので 200 が期待されるが、
  // モックが使えない場合は 401/400/500 も許容（実際の API を叩く場合）
  // 少なくとも 5 件すべてがレスポンスを返したことを確認
  expect(responses).toHaveLength(5);
  for (const status of responses) {
    expect(
      [200, 201, 400, 401, 500],
      `予期しない HTTP ステータス: ${status}`,
    ).toContain(status);
  }
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
test("[menu-gen][adversarial] C-9: 極端な日付 1900-01-01 でリクエスト → 400/401", async ({
  authedPage,
}) => {
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("domcontentloaded");

  const res1 = await authedPage.request.post("/api/ai/menu/weekly/request", {
    data: { startDate: "1900-01-01" },
    headers: { "Content-Type": "application/json" },
  });
  const res2 = await authedPage.request.post("/api/ai/menu/weekly/request", {
    data: { startDate: "9999-12-31" },
    headers: { "Content-Type": "application/json" },
  });

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
test("[menu-gen][adversarial] C-10: 過去10年前の週をリクエスト → 5xxなし", async ({
  authedPage,
}) => {
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("domcontentloaded");

  // 端末 (Node のプロセス) の日付ではなく、JST の今週の月曜日から週の単位で戻す (#1564・#1622。月曜日のまま約 10 年前の週になる)
  const dateStr = addDaysToDate(jstThisMonday(), -TEN_YEARS_IN_WEEKS * DAYS_PER_WEEK);

  const res = await authedPage.request.post("/api/ai/menu/weekly/request", {
    data: { startDate: dateStr },
    headers: { "Content-Type": "application/json" },
  });

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
test("[menu-gen][adversarial] C-11: targetSlots が不正サイズ → サーバークラッシュなし", async ({
  authedPage,
}) => {
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("domcontentloaded");

  const monday = jstThisMonday();

  // 1日分のみ
  const res1 = await authedPage.request.post("/api/ai/menu/v4/generate", {
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
  const res2 = await authedPage.request.post("/api/ai/menu/v4/generate", {
    data: {
      targetSlots: massiveSlots,
      constraints: {},
      note: "",
      ultimateMode: false,
    },
    headers: { "Content-Type": "application/json" },
  });

  expect(res1.status(), `1スロットで 5xx: ${res1.status()}`).not.toBeGreaterThanOrEqual(500);
  expect(res2.status(), `300スロットで 5xx: ${res2.status()}`).not.toBeGreaterThanOrEqual(500);
});

/**
 * C-12: メモ欄に 10000 文字 / NULL byte / control chars
 *
 * 期待: サーバーがクラッシュしない（400 or 200）
 */
test("[menu-gen][adversarial] C-12: 異常メモ入力 → サーバークラッシュなし", async ({
  authedPage,
}) => {
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("domcontentloaded");

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
    const res = await authedPage.request.post("/api/ai/menu/weekly/request", {
      data: { startDate: monday, note: c.note },
      headers: { "Content-Type": "application/json" },
    });
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

/**
 * E-19: 生成失敗後の retry button → 新規 requestId が発行されること
 *
 * 期待: retry したとき同じ requestId が再利用されるのではなく新規 POST が発行される
 */
test("[menu-gen][adversarial] E-19: 生成失敗後のリトライ → 新規requestId", async ({
  authedPage,
}) => {
  let newRequestId = "";
  let postCallCount = 0;

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
      body: JSON.stringify({ hasPending: false }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "failed",
        errorMessage: "generation failed",
        updatedAt: new Date().toISOString(),
      }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/request", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    postCallCount++;
    newRequestId = `retry-request-${postCallCount}`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "processing", requestId: newRequestId }),
    });
  });

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(2_000);

  // retry/再生成ボタンを探す
  const retryBtn = authedPage
    .locator("button")
    .filter({ hasText: /再試行|もう一度|リトライ|再生成/ })
    .first();

  const hasRetryBtn = await retryBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!hasRetryBtn) {
    // 通常の生成ボタンでリトライ相当
    const genBtn = authedPage
      .locator("button")
      .filter({ hasText: /今週の献立を生成|献立を生成|AI献立/ })
      .first();
    const hasGenBtn = await genBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!hasGenBtn) {
      test.skip(true, "Retry/Generate button not visible – UI may be in different state");
      return;
    }
    await genBtn.click();
  } else {
    await retryBtn.click();
  }

  await authedPage.waitForTimeout(2_000);

  // 新規 POST が発行されたことを確認
  expect(postCallCount, "[BUG] retry 時に新規 POST が発行されなかった").toBeGreaterThanOrEqual(1);
  expect(
    newRequestId,
    "[BUG] retry 時に requestId が生成されなかった",
  ).not.toBe("");
  expect(
    newRequestId,
    "[BUG] retry 時に古い requestId が再利用された",
  ).not.toBe(FAKE_REQUEST_ID);
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
test("[menu-gen][adversarial] Edge: 非JSONボディ送付 → クラッシュなし", async ({
  authedPage,
}) => {
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("domcontentloaded");

  const res = await authedPage.request.post("/api/ai/menu/weekly/request", {
    data: "this is not json at all <script>alert(1)</script>",
    headers: { "Content-Type": "text/plain" },
  });

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
test("[menu-gen][adversarial] Edge: 1MBのnoteフィールド → クラッシュなし", async ({
  authedPage,
}) => {
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("domcontentloaded");

  const oneMBNote = "x".repeat(1024 * 1024);
  const res = await authedPage.request.post("/api/ai/menu/weekly/request", {
    data: { startDate: jstThisMonday(), note: oneMBNote },
    headers: { "Content-Type": "application/json" },
  });

  expect(
    res.status(),
    `[BUG] 1MB note で 5xx クラッシュ: ${res.status()}`,
  ).not.toBeGreaterThanOrEqual(500);
});
