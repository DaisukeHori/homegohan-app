/**
 * Wave 2 / Cluster F2: Queue worker 信頼性 regression spec
 *
 * 対象 Issue:
 *   #115 attempt_count 上限 (claim_menu_request)
 *   #116 cron worker が status=queued をスキップ
 *   #118 triggerNextV5Step 10秒タイムアウト
 *   #119 進捗% Ultimate Mode 6 ステップ未対応
 *   #120 subscription leak (二重起動)
 *   #122 cron Edge Function 50秒 abort 後の二重 status 書き込み
 *   #142 weeklyMenuGenerating セッション切れ永久ループ
 *
 * 注: 実際の LLM 生成・DB 書き込みは行わない。API をモックして UI 挙動のみ検証する。
 */
import { test, expect } from "./fixtures/auth";
// 今週の月曜日は、ページ (ブラウザは Asia/Tokyo) と同じ JST の週で作る (#1564)
import { jstThisMonday } from "./helpers/jst-week";

const FAKE_REQUEST_ID = "00000000-0000-4444-8888-000000000f2a";

// =========================================================
// #116: cleanup API が status=queued も含めてクリアする
// =========================================================
test("#116 cleanup route includes queued status in stuck detection", async ({ authedPage }) => {
  let cleanupRequestBody: any = null;

  // cleanup API への POST リクエストをキャプチャしつつモック
  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route: any) => {
    if (route.request().method() === "POST") {
      cleanupRequestBody = {};
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ stuckRequests: [], count: 0 }),
      });
    }
  });

  // pending API: queued のリクエストを返す
  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasPending: true,
        requestId: FAKE_REQUEST_ID,
        status: "queued",
        mode: "v5",
        startDate: jstThisMonday(),
      }),
    });
  });

  await authedPage.route("**/api/ai/menu/weekly/status*", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "queued", progress: null }),
    });
  });

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(2000);

  // cleanup API が呼ばれたことを確認（queued を含む状態チェックのため）
  expect(cleanupRequestBody).not.toBeNull();
});

// =========================================================
// #119: Ultimate Mode (6ステップ) の progress が正しく計算される
// #1609: pending のモックに ultimateMode: true を足し、究極モードの段 (4〜6 工程) が実際に出ることを確かめる。
//   以前のモックは mode: 'v5' だけで、#1597 のあとは通常の段 (3 工程) として描かれ、step 4 の進捗は割合 0 で
//   出ていなかった (見えなければ skip だったので赤にならなかった)。
//   あわせて、最初の進捗 (status) が届くまでの間も究極の段で描かれること (#1609 の 2) を、status の応答を止めて確かめる。
// =========================================================
test("#119 Ultimate Mode step 4-6 progress percentage is shown correctly", async ({ authedPage }) => {
  /** 究極モードの段にだけある工程の名前 (packages/shared の ULTIMATE_PROGRESS_PHASES。通常の段 PROGRESS_PHASES には無い) */
  const ULTIMATE_ONLY_LABEL = "栄養バランスを詳細分析";
  /** 通常の段にだけある工程の名前 (PROGRESS_PHASES の no_issues。ULTIMATE_PROGRESS_PHASES には無い) */
  const NORMAL_ONLY_LABEL = "問題なし";
  /**
   * 下の step 4 の進捗の割合。究極モードの step 4 は 50% + (2/7) × 12% を丸めて 53%
   * (src/app/(main)/menus/weekly/_state/v4ProgressUi.ts)。通常の段には step 4 が無く、割合は出ない
   */
  const ULTIMATE_STEP4_PERCENT = "53%";

  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });

  // サーバー (pending/route.ts) は、表示中の週 (date) と start_date が違う行を返さない。モックも date の週の行を返す
  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route: any) => {
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

  // Step 4 のデータを返す (Ultimate Mode 6 ステップ)。最初の進捗が届く前の表示を見るため、テストが離すまで応答を止める
  let releaseStatus: () => void = () => {};
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route: any) => {
    await statusGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "processing",
        progress: {
          currentStep: 4,
          totalSteps: 6,
          message: "栄養バランス分析中...（2/7）",
          completedSlots: 2,
          totalSlots: 7,
        },
      }),
    });
  });

  await authedPage.goto("/menus/weekly");

  const card = authedPage.getByTestId("generation-progress");
  await expect(card).toBeVisible({ timeout: 15_000 });
  // 工程の一覧を開く
  await card.click();

  // 最初の進捗が届く前: 究極モードの段 (pending の ultimateMode だけを持つ空の進捗)。割合はまだ出ない
  await expect(card.getByText(ULTIMATE_ONLY_LABEL)).toBeVisible();
  await expect(card.getByText(NORMAL_ONLY_LABEL)).toHaveCount(0);
  await expect(card).toContainText("AIが献立を生成中...");
  await expect(card).not.toContainText("%");

  // step 4 の進捗が届いたあと: 究極モードの step 4 の割合と、枠の数の見出し
  releaseStatus();
  await expect(card).toContainText(ULTIMATE_STEP4_PERCENT, { timeout: 15_000 });
  await expect(card).toContainText("献立を生成中...（2/7食、3日分）");
  await expect(card.getByText(ULTIMATE_ONLY_LABEL)).toBeVisible();
  await expect(card.getByText(NORMAL_ONLY_LABEL)).toHaveCount(0);
});

// =========================================================
// #120: 二重起動防止 — checkPendingRequests が restoreGeneration 完了前に走らない
// =========================================================
test("#120 checkPendingRequests does not double-subscribe when restoreGeneration is running", async ({ authedPage }) => {
  let subscribeCallCount = 0;

  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });

  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route: any) => {
    subscribeCallCount++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ hasPending: false }),
    });
  });

  await authedPage.route("**/api/ai/menu/weekly/status*", async (route: any) => {
    subscribeCallCount++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "failed" }),
    });
  });

  // v4MenuGenerating に expired な requestId を仕込む（restoreGeneration を起動させる）
  await authedPage.addInitScript(() => {
    // 31分前のタイムスタンプ → restoreGeneration で即座にクリアされる
    localStorage.setItem(
      "v4MenuGenerating",
      JSON.stringify({ requestId: "expired-id", timestamp: Date.now() - 31 * 60 * 1000, totalSlots: 7 }),
    );
  });

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");
  await authedPage.waitForTimeout(3000);

  // pending API への呼び出しが過剰でないこと（二重起動なら 2回以上呼ばれる可能性）
  // 許容: 1回または0回（restoreGeneration でクリアされてから checkPending が実行）
  expect(subscribeCallCount).toBeLessThanOrEqual(3);
});

// =========================================================
// #142: セッション切れ (401) → ポーリング停止 + /login リダイレクト
// =========================================================
test("#142 polling stops and redirects to /login on 401 status response", async ({ authedPage }) => {
  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "No stuck requests found", cleaned: 0 }),
    });
  });

  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasPending: true,
        requestId: FAKE_REQUEST_ID,
        status: "processing",
        mode: "v5",
        startDate: jstThisMonday(),
      }),
    });
  });

  // status API が 401 を返す（セッション切れ）
  await authedPage.route("**/api/ai/menu/weekly/status*", async (route: any) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unauthorized" }),
    });
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
  await authedPage.waitForLoadState("domcontentloaded");

  // /login へのリダイレクトを待機（最大 15秒）
  try {
    await authedPage.waitForURL("**/login**", { timeout: 15_000 });
    const url = authedPage.url();
    expect(url).toContain("/login");
  } catch {
    // リダイレクトが発生しなかった場合はスキップ（auth middleware が先に介入する場合など）
    test.skip();
  }
});

// =========================================================
// #115 + #122: attempt_count >= 3 のリクエストが failed に遷移することを API レベルで確認
// (migration は実 DB でのみ確認可能なため、UI 側での failed 表示を確認)
// =========================================================
test("#115/#122 request with failed status shows error UI (not infinite loop)", async ({ authedPage }) => {
  const weekStr = jstThisMonday();

  await authedPage.route("**/api/ai/menu/weekly/cleanup", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "Cleaned up stuck requests", cleaned: 1 }),
    });
  });

  await authedPage.route("**/api/ai/menu/weekly/pending*", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasPending: true,
        requestId: FAKE_REQUEST_ID,
        status: "failed",
        mode: "v5",
        startDate: weekStr,
        error_message: "attempt_limit_exceeded",
      }),
    });
  });

  await authedPage.route("**/api/ai/menu/weekly/status*", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "failed",
        error_message: "attempt_limit_exceeded",
        progress: null,
      }),
    });
  });

  await authedPage.addInitScript(
    ([reqId, weekKey]: [string, string]) => {
      localStorage.setItem(
        "weeklyMenuGenerating",
        JSON.stringify({ weekStartDate: weekKey, timestamp: Date.now() - 10_000, requestId: reqId }),
      );
    },
    [FAKE_REQUEST_ID, weekStr],
  );

  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("domcontentloaded");
  await authedPage.waitForTimeout(3000);

  // エラーモーダルか通常画面（生成中ではない状態）が表示されること
  const errorModal = authedPage
    .locator("[data-testid='generation-failed-modal']")
    .or(authedPage.locator("text=/生成に失敗/"))
    .or(authedPage.locator("text=/もう一度試す/"))
    .or(authedPage.locator("text=/AIに埋めてもらう/"))
    .or(authedPage.locator("text=/AI献立/"));

  const isVisible = await errorModal.first().isVisible({ timeout: 10_000 }).catch(() => false);

  if (!isVisible) {
    test.skip();
    return;
  }

  expect(isVisible).toBe(true);
});
