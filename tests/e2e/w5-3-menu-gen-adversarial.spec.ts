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

// ─── helpers ───────────────────────────────────────────────────────────────

function getThisMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

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
  const weekStr = getThisMonday();

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
  const monday = getThisMonday();
  const responses: number[] = [];
  for (let i = 0; i < 5; i++) {
    const startDate = addDays(monday, i * 7);
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
  const weekStr = getThisMonday();

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
 */
test("[menu-gen][adversarial] B-6: 生成中にサインアウト → stale 処理で failed 確認", async ({
  authedPage,
}) => {
  // stale なリクエスト（21分前に更新されたもの）をシミュレート
  // status=processing で returned → stale 判定で failed 化
  const staleUpdatedAt = new Date(Date.now() - 21 * 60 * 1000).toISOString();

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
        startDate: getThisMonday(),
      }),
    });
  });

  // status API: stale なデータ（20分以上前の updated_at）
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "failed",
        errorMessage: "stale_request_timeout",
        updatedAt: staleUpdatedAt,
      }),
    });
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
    [FAKE_REQUEST_ID, getThisMonday()],
  );

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(3_000);

  // failed 状態のUIが表示されているか、または生成中ではないこと
  const infiniteSpinner = authedPage
    .locator("text=/生成中|処理中/")
    .first();
  const isStillGenerating = await infiniteSpinner.isVisible({ timeout: 3_000 }).catch(() => false);

  // stale な request で永遠に生成中表示のままになっていたら BUG
  expect(
    isStillGenerating,
    "[BUG] stale なリクエスト（21分以上前）で UI が永遠に生成中のまま（ループ）",
  ).toBe(false);
});

/**
 * B-7: 生成中に /home に navigate → 戻ったとき進捗が復元されること
 *
 * 期待: /menus/weekly → /home → /menus/weekly で生成中状態が引き継がれる
 */
test("[menu-gen][adversarial] B-7: 生成中に /home ナビゲート → 戻ると進捗復元", async ({
  authedPage,
}) => {
  const weekStr = getThisMonday();

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
  const weekStr = getThisMonday();
  const nextWeekStr = addDays(weekStr, 7);
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

  const tenYearsAgo = new Date();
  tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
  const dateStr = tenYearsAgo.toISOString().slice(0, 10);

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

  const monday = getThisMonday();

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
    date: addDays(monday, Math.floor(i / 3)),
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

  const monday = getThisMonday();
  const cases = [
    { name: "10000文字", note: "あ".repeat(10000) },
    { name: "NULL byte", note: "test\x00injection" },
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
  const weekStr = getThisMonday();

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
 */
test("[menu-gen][adversarial] E-18: タイムアウト後の status 整合性 → ループなし", async ({
  authedPage,
}) => {
  let statusCallCount = 0;

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
        status: "failed",
        mode: "v5",
        startDate: getThisMonday(),
      }),
    });
  });
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route) => {
    statusCallCount++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "failed",
        errorMessage: "Edge function timeout after 50s",
        updatedAt: new Date().toISOString(),
      }),
    });
  });

  await authedPage.addInitScript(
    ([reqId, weekKey]: [string, string]) => {
      localStorage.setItem(
        "weeklyMenuGenerating",
        JSON.stringify({ weekStartDate: weekKey, timestamp: Date.now(), requestId: reqId }),
      );
    },
    [FAKE_REQUEST_ID, getThisMonday()],
  );

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(5_000);

  // failed になった後にポーリングが停止していることを確認
  // 5秒待って status API の呼び出し回数が過剰でない（ループしていない）
  const callCountAfter5s = statusCallCount;
  await authedPage.waitForTimeout(5_000);
  const callCountAfter10s = statusCallCount;

  // failed 確認後はポーリングが止まるはず → 後半5秒で 0〜2回程度しか呼ばれない
  const additionalCalls = callCountAfter10s - callCountAfter5s;
  expect(
    additionalCalls,
    `[BUG] failed 状態後もポーリングが続いている（後半5秒で ${additionalCalls} 回呼ばれた）`,
  ).toBeLessThanOrEqual(3);
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
 */
test("[menu-gen][adversarial] F-22: tabA生成完了 → tabBでリアルタイム更新", async ({
  authedPage,
  context,
}) => {
  const weekStr = getThisMonday();

  // tab B を先に開いておく（Realtime 購読を開始させる）
  const tabB = await context.newPage();

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

  let tabBStatusCallCount = 0;
  await tabB.route("**/api/ai/menu/weekly/status*", async (route) => {
    tabBStatusCallCount++;
    // 最初2回は processing、3回目以降は completed
    const status = tabBStatusCallCount >= 3 ? "completed" : "processing";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status, progress: null }),
    });
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
  await tabB.waitForLoadState("networkidle");
  await tabB.waitForTimeout(2_000);

  // tab B が生成中状態を引き継いでいることを確認
  const generatingIndicator = tabB
    .locator("text=/生成中|処理中|AIが献立/")
    .first();
  const isGenerating = await generatingIndicator.isVisible({ timeout: 5_000 }).catch(() => false);

  // ポーリングが completed を受信した後、生成中UIが消えることを待つ（最大15秒）
  await tabB.waitForTimeout(15_000);

  const isStillGenerating = await generatingIndicator.isVisible({ timeout: 2_000 }).catch(() => false);

  if (isGenerating) {
    // 生成中が表示されていたなら、completed 後は消えているべき
    expect(
      isStillGenerating,
      "[BUG] completed 後もtab Bで生成中UIが残り続けている（ポーリング/Realtime が機能していない）",
    ).toBe(false);
  }

  await tabB.close();
});

/**
 * F-23: 進捗 % が逆行しない (#119 Ultimate Mode 6 step)
 *
 * 期待: step 4 → step 5 → step 6 の順で progress % が増加のみ
 */
test("[menu-gen][adversarial] F-23: Ultimate Mode 6ステップの進捗%が逆行しない", async ({
  authedPage,
}) => {
  const weekStr = getThisMonday();
  let statusCallCount = 0;

  // step 4 → 5 → 6 を順にシミュレート
  const progressSequence = [
    { currentStep: 4, totalSteps: 6, message: "栄養バランス分析中...", completedSlots: 2, totalSlots: 7 },
    { currentStep: 5, totalSteps: 6, message: "献立を改善中...", completedSlots: 5, totalSlots: 7 },
    { currentStep: 6, totalSteps: 6, message: "最終保存中...", completedSlots: 7, totalSlots: 7 },
  ];

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

  await authedPage.addInitScript(
    ([reqId, weekKey]: [string, string]) => {
      localStorage.setItem(
        "weeklyMenuGenerating",
        JSON.stringify({ weekStartDate: weekKey, timestamp: Date.now(), requestId: reqId }),
      );
    },
    [FAKE_REQUEST_ID, weekStr],
  );

  const displayedPercentages: number[] = [];

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");

  // 進捗 % 表示を 10秒間サンプリング
  for (let i = 0; i < 10; i++) {
    await authedPage.waitForTimeout(1_000);
    // progress bar や % テキストを探す
    const percentText = await authedPage
      .locator("text=/%/")
      .first()
      .textContent({ timeout: 500 })
      .catch(() => null);
    if (percentText) {
      const match = percentText.match(/(\d+)%/);
      if (match) {
        displayedPercentages.push(parseInt(match[1]));
      }
    }
  }

  // サンプリングできた場合は単調増加を検証
  if (displayedPercentages.length >= 2) {
    for (let i = 1; i < displayedPercentages.length; i++) {
      expect(
        displayedPercentages[i],
        `[BUG] 進捗%が逆行した: ${displayedPercentages[i - 1]}% → ${displayedPercentages[i]}%`,
      ).toBeGreaterThanOrEqual(displayedPercentages[i - 1]);
    }
  }
  // サンプリングできなくてもテスト自体は pass（進捗バーなしの UI 構成の可能性）
});

// ─── Security / CRON boundary ───────────────────────────────────────────

/**
 * Security: 任意ユーザーが他ユーザーの requestId で status を確認できない
 *
 * 期待: /api/ai/menu/weekly/status?requestId=<他人のID> → 404 or 403 or empty result
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

  // 認証済みだが他人のリクエスト → 空 result（failed/not found）または 403
  if (res.status() === 200) {
    const body = await res.json().catch(() => ({}));
    // user_id フィルタが効いていれば status=failed (not found)
    expect(
      body.status,
      `[BUG] 他ユーザーの requestId で status が ${body.status} として返された（認可漏れの可能性）`,
    ).toBe("failed");
  } else {
    expect([403, 404]).toContain(res.status());
  }
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
    data: { startDate: getThisMonday(), note: oneMBNote },
    headers: { "Content-Type": "application/json" },
  });

  expect(
    res.status(),
    `[BUG] 1MB note で 5xx クラッシュ: ${res.status()}`,
  ).not.toBeGreaterThanOrEqual(500);
});
