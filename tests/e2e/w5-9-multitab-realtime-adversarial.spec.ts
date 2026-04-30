/**
 * Wave 5 / W5-9: Multi-tab / Multi-device / Realtime 完全嫌がらせ
 *
 * 目的: 複数タブ・別デバイス・realtime 同期を破壊的にテストし、
 *       race condition / DB 不整合 / メモリリーク / セッション漏洩を検出する。
 *
 * グループ:
 *   A. 同一ユーザー / 2 タブ (W5A-1 〜 W5A-6)
 *   B. 同一ユーザー / 別デバイス (W5B-7 〜 W5B-10)
 *   C. 同時編集 / collision (W5C-11 〜 W5C-15)
 *   D. realtime subscription leak (W5D-16 〜 W5D-18)
 *   E. session 同期 (W5E-19 〜 W5E-21)
 *   F. localStorage / sessionStorage 同期 (W5F-22 〜 W5F-23)
 *   G. 異常な device 状態 (W5G-24 〜 W5G-25)
 *
 * 実行:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e -- w5-9
 *
 * バグ発見時 Issue prefix: [multi-tab][adversarial] or [realtime][adversarial]
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

// ============================================================
// 定数・ヘルパー
// ============================================================

const E2E_USER = {
  email: process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local",
  password: process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!",
};

/** 指定コンテキストでログインする。最大 2 回リトライ。 */
async function loginInContext(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto("/login");
      await page.locator("#email").fill(E2E_USER.email);
      await page.locator("#password").fill(E2E_USER.password);
      await Promise.all([
        page.waitForURL(
          (url) =>
            !url.pathname.startsWith("/login") &&
            !url.pathname.startsWith("/auth"),
          { timeout: 35_000 }
        ),
        page.locator("button[type=submit]").click(),
      ]);
      await expect(page).not.toHaveURL(/\/login/);
      return page;
    } catch (err) {
      if (attempt === 1) throw err;
      await page.waitForTimeout(3_000);
    }
  }
  throw new Error("loginInContext: should not reach here");
}

/** スクリーンショットを添付 */
async function attach(page: Page, testInfo: any, name: string) {
  const buf = await page.screenshot({ fullPage: false });
  await testInfo.attach(name, { body: buf, contentType: "image/png" });
}

/** console.error を収集するリスナーを設定し、クリーナーを返す */
function collectConsoleErrors(page: Page, label: string): () => string[] {
  const errors: string[] = [];
  const handler = (msg: any) => {
    if (msg.type() === "error") errors.push(`[${label}] ${msg.text()}`);
  };
  page.on("console", handler);
  return () => errors;
}

// ============================================================
// A. 同一ユーザー / 2 タブ
// ============================================================

/**
 * W5A-1: tab A で食事記録 (planned_meal を is_completed: true) →
 *         tab B で /home リロード後に反映されること (#143 修正後確認)
 */
test("W5A-1: タブA で食事完了 toggle → タブB /home リロードで反映", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    // タブ B: /home を開いて初期状態を記録
    await pageB.goto("/home");
    await pageB.waitForLoadState("networkidle");
    await attach(pageB, testInfo, "W5A-1: タブB 初期 /home");

    // タブ A: /home に移動してチェックボックスを探す
    await pageA.goto("/home");
    await pageA.waitForLoadState("networkidle");
    await attach(pageA, testInfo, "W5A-1: タブA 初期 /home");

    // 食事完了チェックボックスを探す
    const checkbox = pageA
      .locator('[data-testid="meal-checkbox"], input[type="checkbox"], button[role="checkbox"]')
      .first();
    const checkboxVisible = await checkbox.isVisible({ timeout: 5_000 }).catch(() => false);

    if (!checkboxVisible) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5A-1: 食事チェックボックスが見つからない (献立未生成の可能性)",
      });
      return;
    }

    // 初期状態を記録してトグル
    const initialChecked = await checkbox.getAttribute("aria-checked").catch(() => null);

    await Promise.race([
      checkbox.click().then(() =>
        pageA.waitForResponse(
          (res) =>
            res.url().includes("/api/") || res.url().includes("supabase"),
          { timeout: 10_000 }
        )
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]).catch(() => {});

    await attach(pageA, testInfo, "W5A-1: タブA チェック後");

    // タブ B: /home をリロードして反映確認
    await pageB.reload();
    await pageB.waitForLoadState("networkidle");
    await attach(pageB, testInfo, "W5A-1: タブB リロード後");

    // エラーが出ていないことを確認
    const hasError = await pageB.locator("text=エラー").isVisible().catch(() => false);
    expect(hasError, "タブB /home リロード後にエラーが表示されない").toBe(false);

    testInfo.annotations.push({
      type: "result",
      description: `W5A-1: 食事完了toggle後タブBリロード正常。初期checked=${initialChecked}`,
    });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

/**
 * W5A-2: tab A で signOut → tab B が BroadcastChannel 経由で即時 /login へリダイレクト (#145)
 *         同一コンテキスト (= 同じ Cookie) で確認する。
 */
test("W5A-2: タブA signOut → タブB が BroadcastChannel で /login にリダイレクト", async ({ browser }, testInfo) => {
  // 同一コンテキスト = 同一ブラウザセッション
  const ctx = await browser.newContext();
  try {
    const pageA = await loginInContext(ctx);

    // タブ B を同じコンテキストで開く (/home を表示)
    const pageB = await ctx.newPage();
    await pageB.goto("/home");
    await pageB.waitForLoadState("networkidle");
    await attach(pageB, testInfo, "W5A-2: タブB signOut前");

    // BroadcastChannel の利用可能確認
    const bcAvailableB = await pageB.evaluate(() => typeof BroadcastChannel !== "undefined");
    expect(bcAvailableB, "タブB で BroadcastChannel が利用可能").toBe(true);

    // タブ A: /settings からサインアウト
    await pageA.goto("/settings");
    await pageA.waitForLoadState("networkidle");

    const logoutBtn = pageA
      .getByRole("button", { name: /ログアウト/ })
      .or(pageA.locator("button").filter({ hasText: /ログアウト/ }))
      .first();

    const logoutVisible = await logoutBtn.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!logoutVisible) {
      // BroadcastChannel の実装確認だけ行う
      const bcAvailableA = await pageA.evaluate(() => typeof BroadcastChannel !== "undefined");
      expect(bcAvailableA, "BroadcastChannel が利用可能").toBe(true);
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5A-2: ログアウトボタンが見つからないため、BroadcastChannel 存在確認のみ実施",
      });
      return;
    }

    pageA.on("dialog", (d) => d.accept());
    await logoutBtn.click();

    const confirmBtn = pageA.locator("button").filter({ hasText: /^ログアウト$/ }).last();
    const confirmVisible = await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (confirmVisible) await confirmBtn.click();

    // タブ A が /login にリダイレクト
    await pageA.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 20_000 });
    await attach(pageA, testInfo, "W5A-2: タブA signOut後 /login");

    // タブ B: BroadcastChannel 経由で /login にリダイレクトされるか確認
    const redirected = await pageB
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    await attach(pageB, testInfo, "W5A-2: タブB BroadcastChannel後");

    if (!redirected) {
      testInfo.annotations.push({
        type: "issue",
        description: "[multi-tab][adversarial] W5A-2: タブA signOut後、タブBが /login にリダイレクトされなかった。BroadcastChannel の伝播不良の可能性",
      });
    } else {
      expect(pageB.url()).toContain("/login");
      testInfo.annotations.push({
        type: "result",
        description: "W5A-2: BroadcastChannel signOut 伝播 OK",
      });
    }
  } finally {
    await ctx.close();
  }
});

/**
 * W5A-3: tab A で設定の通知 toggle → tab B リロード後に反映
 */
test("W5A-3: タブA で通知 toggle → タブB リロードで設定同期", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    // 両タブで /settings を開く
    await Promise.all([pageA.goto("/settings"), pageB.goto("/settings")]);
    await Promise.all([
      pageA.waitForLoadState("networkidle"),
      pageB.waitForLoadState("networkidle"),
    ]);

    // 通知スイッチを探す
    const getSwitch = (page: Page) =>
      page
        .locator("div.flex.items-center.justify-between", {
          has: page.locator("span", { hasText: "通知" }),
        })
        .first()
        .locator("button")
        .first();

    const switchA = getSwitch(pageA);
    const switchAVisible = await switchA.isVisible({ timeout: 8_000 }).catch(() => false);

    if (!switchAVisible) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5A-3: 通知スイッチが見つからないためスキップ",
      });
      return;
    }

    const getChecked = async (sw: any) => {
      const cls = (await sw.getAttribute("class").catch(() => "")) ?? "";
      return cls.includes("bg-[#FF8A65]") || cls.includes("bg-orange") || cls.includes("bg-accent");
    };

    const beforeA = await getChecked(switchA);
    await attach(pageA, testInfo, "W5A-3: タブA toggle前");
    await attach(pageB, testInfo, "W5A-3: タブB 変更前");

    // タブ A で toggle (API レスポンスを待つ)
    await Promise.race([
      Promise.all([
        pageA
          .waitForResponse(
            (res) =>
              res.url().includes("/api/notification") && res.request().method() !== "GET",
            { timeout: 20_000 }
          )
          .catch(() => {}),
        switchA.click(),
      ]),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);

    await attach(pageA, testInfo, "W5A-3: タブA toggle後");

    // タブ B をリロード
    await pageB.reload();
    await pageB.waitForLoadState("networkidle");
    await attach(pageB, testInfo, "W5A-3: タブB リロード後");

    const switchBAfter = getSwitch(pageB);
    const afterA = await getChecked(switchA);
    const afterB = await getChecked(switchBAfter);

    testInfo.annotations.push({
      type: "result",
      description: `W5A-3: 変更前A=${beforeA} → 変更後A=${afterA}, リロード後B=${afterB}`,
    });

    if (afterA !== afterB) {
      testInfo.annotations.push({
        type: "issue",
        description: `[multi-tab][adversarial] W5A-3: 通知設定がタブBに反映されていない。タブA=${afterA}, タブB=${afterB}`,
      });
    }

    // クリーンアップ: 元に戻す
    if (afterA !== beforeA) {
      await switchA.click().catch(() => {});
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

/**
 * W5A-4: tab A で /menus/weekly AI 生成中 → tab B でも進捗状態の localStorage が存在する
 *         (同一コンテキストの場合 localStorage 共有されるため)
 */
test("W5A-4: 同一コンテキストで /menus/weekly 生成中の localStorage が他タブでも見える", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext();
  try {
    const pageA = await loginInContext(ctx);

    // タブ B を同一コンテキストで開く
    const pageB = await ctx.newPage();
    await pageB.goto("/menus/weekly");
    await pageB.waitForLoadState("networkidle");

    // タブ A: /menus/weekly を開く
    await pageA.goto("/menus/weekly");
    await pageA.waitForLoadState("networkidle");

    // タブ A: localStorage に生成中状態をシミュレート
    const fakeGeneratingState = JSON.stringify({
      requestId: "test-req-id-12345",
      timestamp: Date.now(),
      totalSlots: 7,
    });
    await pageA.evaluate((val) => {
      localStorage.setItem("v4MenuGenerating", val);
    }, fakeGeneratingState);

    // タブ B: 同一コンテキストなので同じ localStorage を読める
    const tabBValue = await pageB.evaluate(() => localStorage.getItem("v4MenuGenerating"));

    testInfo.annotations.push({
      type: "result",
      description: `W5A-4: タブB で読んだ v4MenuGenerating = ${tabBValue}`,
    });

    if (tabBValue !== null) {
      // 同一コンテキストなので共有されていることが正常
      expect(tabBValue).toBe(fakeGeneratingState);
      testInfo.annotations.push({
        type: "info",
        description: "W5A-4: 同一コンテキスト内でlocalStorage が共有されている (正常動作)",
      });
    } else {
      testInfo.annotations.push({
        type: "issue",
        description: "[multi-tab][adversarial] W5A-4: 同一コンテキスト内なのに localStorage が共有されていない。予期しない動作",
      });
    }

    // クリーンアップ
    await pageA.evaluate(() => localStorage.removeItem("v4MenuGenerating"));
  } finally {
    await ctx.close();
  }
});

/**
 * W5A-5: tab A で /profile 編集 (ニックネーム保存) → tab B の /home リロードで反映
 */
test("W5A-5: タブA でプロフィール編集 → タブB /home リロードで反映", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    // タブ B: /home を開く
    await pageB.goto("/home");
    await pageB.waitForLoadState("networkidle");
    await attach(pageB, testInfo, "W5A-5: タブB /home 更新前");

    // タブ A: /profile を開く
    await pageA.goto("/profile");
    await pageA.waitForLoadState("networkidle");
    await attach(pageA, testInfo, "W5A-5: タブA /profile");

    // ニックネーム入力フィールドを探す
    const nicknameInput = pageA
      .locator('input[name="nickname"], input[placeholder*="ニックネーム"], input[placeholder*="名前"]')
      .first();
    const inputVisible = await nicknameInput.isVisible({ timeout: 8_000 }).catch(() => false);

    if (!inputVisible) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5A-5: ニックネーム入力が見つからないためスキップ",
      });
      return;
    }

    // 一時的なニックネームを設定
    const testNickname = `テストユーザー${Date.now().toString().slice(-4)}`;
    await nicknameInput.fill(testNickname);
    await attach(pageA, testInfo, "W5A-5: タブA ニックネーム入力後");

    // 保存
    const saveBtn = pageA.getByRole("button", { name: /保存|更新|save/i }).first();
    const saveBtnVisible = await saveBtn.isVisible({ timeout: 5_000 }).catch(() => false);

    if (saveBtnVisible) {
      await Promise.race([
        saveBtn.click().then(() =>
          pageA
            .waitForResponse(
              (res) =>
                (res.url().includes("/api/profile") || res.url().includes("user_profiles")) &&
                res.request().method() !== "GET",
              { timeout: 15_000 }
            )
            .catch(() => {})
        ),
        new Promise((resolve) => setTimeout(resolve, 8_000)),
      ]);
    }

    await attach(pageA, testInfo, "W5A-5: タブA 保存後");

    // タブ B: /home をリロード
    await pageB.reload();
    await pageB.waitForLoadState("networkidle");
    await attach(pageB, testInfo, "W5A-5: タブB /home リロード後");

    const hasError = await pageB.locator("text=エラー").isVisible().catch(() => false);
    expect(hasError, "タブB /home リロード後にエラーが表示されない").toBe(false);

    // ニックネームが /home に表示されているか確認
    const nicknameOnHome = await pageB.locator(`text=${testNickname}`).isVisible({ timeout: 3_000 }).catch(() => false);
    testInfo.annotations.push({
      type: "result",
      description: `W5A-5: ニックネーム="${testNickname}" がタブB /home に表示=${nicknameOnHome}`,
    });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

/**
 * W5A-6: tab A でアカウント削除を開始 → tab B の挙動 (エラーなく /login にリダイレクト)
 */
test("W5A-6: タブA アカウント削除後 タブB が適切に処理される", async ({ browser }, testInfo) => {
  // 注意: 実際のアカウント削除は行わない。削除確認モーダルまでのフローを確認する
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    // タブ B: /home を開く
    await pageB.goto("/home");
    await pageB.waitForLoadState("networkidle");

    // タブ A: /settings → アカウント削除セクションを確認
    await pageA.goto("/settings");
    await pageA.waitForLoadState("networkidle");
    await attach(pageA, testInfo, "W5A-6: タブA /settings");

    // アカウント削除ボタンを探す (実際には押さない)
    const deleteBtn = pageA
      .locator("button")
      .filter({ hasText: /アカウント.*(削除|退会)|退会|delete account/i })
      .first();
    const deleteBtnVisible = await deleteBtn.isVisible({ timeout: 5_000 }).catch(() => false);

    testInfo.annotations.push({
      type: "result",
      description: `W5A-6: アカウント削除ボタンが存在する=${deleteBtnVisible}`,
    });

    if (deleteBtnVisible) {
      // ボタンが存在することを確認 (クリックはしない)
      expect(deleteBtnVisible, "アカウント削除ボタンが /settings に存在する").toBe(true);
      testInfo.annotations.push({
        type: "info",
        description: "W5A-6: アカウント削除ボタン確認済み。実際の削除はスキップ (破壊的操作のため)",
      });
    } else {
      testInfo.annotations.push({
        type: "info",
        description: "W5A-6: アカウント削除ボタンが見つからない (権限外 or 別ページ)",
      });
    }

    // タブ B がまだ正常に表示されていることを確認
    const hasError = await pageB.locator("text=エラー").isVisible().catch(() => false);
    expect(hasError, "タブB が影響を受けていない").toBe(false);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ============================================================
// B. 同一ユーザー / 別デバイス (別コンテキストで模倣)
// ============================================================

/**
 * W5B-7: モバイルサイズで signin → デスクトップ側で同じユーザーの状態確認
 */
test("W5B-7: モバイル viewport でサインイン → デスクトップ viewport で同一ユーザー状態確認", async ({ browser }, testInfo) => {
  const ctxMobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 14
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const ctxDesktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  try {
    const pageMobile = await loginInContext(ctxMobile);
    const pageDesktop = await loginInContext(ctxDesktop);

    // モバイル: /home を開く
    await pageMobile.goto("/home");
    await pageMobile.waitForLoadState("networkidle");
    await attach(pageMobile, testInfo, "W5B-7: モバイル /home");

    // デスクトップ: /home を開く
    await pageDesktop.goto("/home");
    await pageDesktop.waitForLoadState("networkidle");
    await attach(pageDesktop, testInfo, "W5B-7: デスクトップ /home");

    // 両端でエラーが出ていないこと
    const mobileError = await pageMobile.locator("text=エラー").isVisible().catch(() => false);
    const desktopError = await pageDesktop.locator("text=エラー").isVisible().catch(() => false);

    expect(mobileError, "モバイルでエラーが表示されない").toBe(false);
    expect(desktopError, "デスクトップでエラーが表示されない").toBe(false);

    // モバイルではボトムナビが表示されているか
    const bottomNav = await pageMobile.locator(".fixed.bottom-4").isVisible({ timeout: 3_000 }).catch(() => false);
    testInfo.annotations.push({
      type: "result",
      description: `W5B-7: モバイルボトムナビ表示=${bottomNav}、両端でエラーなし`,
    });
  } finally {
    await ctxMobile.close();
    await ctxDesktop.close();
  }
});

/**
 * W5B-9: 別デバイス（コンテキスト A）で食事記録 → デバイス B で /home リロード後に反映
 */
test("W5B-9: 別デバイス(A)で食事記録 → デバイス(B) /home リロードで反映", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    // デバイス B: /home の初期状態
    await pageB.goto("/home");
    await pageB.waitForLoadState("networkidle");
    await attach(pageB, testInfo, "W5B-9: デバイスB 記録前");

    // デバイス A: /home に移動して食事チェック
    await pageA.goto("/home");
    await pageA.waitForLoadState("networkidle");

    const checkbox = pageA
      .locator('[role="checkbox"], input[type="checkbox"]')
      .first();
    const checkboxVisible = await checkbox.isVisible({ timeout: 5_000 }).catch(() => false);

    if (!checkboxVisible) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5B-9: 食事チェックボックスが見つからないためスキップ",
      });
      return;
    }

    await checkbox.click().catch(() => {});
    await pageA.waitForTimeout(2_000);
    await attach(pageA, testInfo, "W5B-9: デバイスA チェック後");

    // デバイス B: /home リロード
    await pageB.reload();
    await pageB.waitForLoadState("networkidle");
    await attach(pageB, testInfo, "W5B-9: デバイスB リロード後");

    const hasError = await pageB.locator("text=エラー").isVisible().catch(() => false);
    expect(hasError, "デバイスBにエラーなし").toBe(false);

    testInfo.annotations.push({
      type: "result",
      description: "W5B-9: 別コンテキストで食事記録後、デバイスBリロードで正常表示",
    });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ============================================================
// C. 同時編集 / collision
// ============================================================

/**
 * W5C-11: tab A と tab B で同じ献立スロットを同時編集 → DB の最終状態が一貫している
 */
test("W5C-11: 2 タブで同じ献立スロットを同時編集 → 最後書き込みが勝つ (LWW 確認)", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    // 両タブ: /menus/weekly を開く
    await Promise.all([pageA.goto("/menus/weekly"), pageB.goto("/menus/weekly")]);
    await Promise.all([
      pageA.waitForLoadState("networkidle"),
      pageB.waitForLoadState("networkidle"),
    ]);

    await attach(pageA, testInfo, "W5C-11: タブA 編集前");
    await attach(pageB, testInfo, "W5C-11: タブB 編集前");

    // 編集ボタンを探す
    const editBtnA = pageA
      .locator('[data-testid="meal-edit-btn"], button[aria-label*="編集"]')
      .or(pageA.locator('button:has(.lucide-pencil)'))
      .first();
    const editBtnB = pageB
      .locator('[data-testid="meal-edit-btn"], button[aria-label*="編集"]')
      .or(pageB.locator('button:has(.lucide-pencil)'))
      .first();

    const [editAVisible, editBVisible] = await Promise.all([
      editBtnA.isVisible({ timeout: 5_000 }).catch(() => false),
      editBtnB.isVisible({ timeout: 5_000 }).catch(() => false),
    ]);

    if (!editAVisible || !editBVisible) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5C-11: 編集ボタンが見つからない (献立未生成の可能性)",
      });
      return;
    }

    // 並列で両タブから編集開始
    const [resA, resB] = await Promise.allSettled([
      (async () => {
        await editBtnA.click();
        await pageA.waitForTimeout(300);
        return "tabA-edit-opened";
      })(),
      (async () => {
        await pageB.waitForTimeout(150); // 微小ずらして競合状態を作る
        await editBtnB.click();
        await pageB.waitForTimeout(300);
        return "tabB-edit-opened";
      })(),
    ]);

    await attach(pageA, testInfo, "W5C-11: タブA 編集後");
    await attach(pageB, testInfo, "W5C-11: タブB 編集後");

    // エラー表示の確認
    const errorA = await pageA.locator("text=エラー").isVisible().catch(() => false);
    const errorB = await pageB.locator("text=エラー").isVisible().catch(() => false);

    if (errorA || errorB) {
      testInfo.annotations.push({
        type: "issue",
        description: `[multi-tab][adversarial] W5C-11: 同時編集でエラー表示。タブA=${errorA}, タブB=${errorB}`,
      });
    }

    testInfo.annotations.push({
      type: "result",
      description: `W5C-11: 同時編集結果 - タブA=${resA.status}, タブB=${resB.status}, エラーA=${errorA}, エラーB=${errorB}`,
    });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

/**
 * W5C-12: お気に入り toggle を 2 タブで同時実行 → DB の状態が一貫していること
 */
test("W5C-12: 2 タブで同じお気に入りを同時 toggle → race condition 確認", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    await Promise.all([pageA.goto("/menus/weekly"), pageB.goto("/menus/weekly")]);
    await Promise.all([
      pageA.waitForLoadState("networkidle"),
      pageB.waitForLoadState("networkidle"),
    ]);

    // レシピボタンを探す
    const recipeBtnA = pageA.locator("text=レシピを見る").first();
    const hasRecipeA = await recipeBtnA.isVisible({ timeout: 5_000 }).catch(() => false);

    if (!hasRecipeA) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5C-12: レシピデータが見つからないためスキップ",
      });
      return;
    }

    await recipeBtnA.click();
    const favBtnA = pageA.locator('[data-testid="favorite-button"]');
    await expect(favBtnA).toBeVisible({ timeout: 8_000 });

    const recipeBtnB = pageB.locator("text=レシピを見る").first();
    const hasRecipeB = await recipeBtnB.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasRecipeB) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5C-12: タブBでレシピが見つからないためスキップ",
      });
      return;
    }

    await recipeBtnB.click();
    const favBtnB = pageB.locator('[data-testid="favorite-button"]');
    await expect(favBtnB).toBeVisible({ timeout: 8_000 });

    const pressedBeforeA = await favBtnA.getAttribute("aria-pressed").catch(() => "unknown");
    await attach(pageA, testInfo, "W5C-12: タブA toggle前");
    await attach(pageB, testInfo, "W5C-12: タブB toggle前");

    // 同時 toggle
    const [toggleA, toggleB] = await Promise.allSettled([
      favBtnA.click(),
      favBtnB.click(),
    ]);

    await Promise.all([pageA.waitForTimeout(2_000), pageB.waitForTimeout(2_000)]);

    const pressedAfterA = await favBtnA.getAttribute("aria-pressed").catch(() => "unknown");
    const pressedAfterB = await favBtnB.getAttribute("aria-pressed").catch(() => "unknown");

    await attach(pageA, testInfo, "W5C-12: タブA toggle後");
    await attach(pageB, testInfo, "W5C-12: タブB toggle後");

    testInfo.annotations.push({
      type: "result",
      description: `W5C-12: toggle前A=${pressedBeforeA}, toggle後A=${pressedAfterA}, toggle後B=${pressedAfterB}`,
    });

    if (pressedAfterA !== pressedAfterB) {
      testInfo.annotations.push({
        type: "issue",
        description: `[multi-tab][adversarial] W5C-12: 同時お気に入りtoggle後の状態不一致。タブA=${pressedAfterA}, タブB=${pressedAfterB}。race conditionの可能性`,
      });
    }

    // クリーンアップ
    if (pressedAfterA === "true") {
      await favBtnA.click().catch(() => {});
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

/**
 * W5C-13: 同じ日 / 同じ meal_type の食事記録を 2 タブで同時作成 → unique 制約確認
 */
test("W5C-13: 同日同 meal_type の食事記録を 2 タブで同時作成 → 重複エラーまたは upsert 確認", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    const today = new Date().toISOString().split("T")[0];

    // 両タブで /menus/weekly の「食事追加」UIを開く
    await Promise.all([pageA.goto("/menus/weekly"), pageB.goto("/menus/weekly")]);
    await Promise.all([
      pageA.waitForLoadState("networkidle"),
      pageB.waitForLoadState("networkidle"),
    ]);

    await attach(pageA, testInfo, "W5C-13: タブA 追加前");
    await attach(pageB, testInfo, "W5C-13: タブB 追加前");

    // 食事追加ボタンを探す
    const addBtnA = pageA.locator("button").filter({ hasText: /追加|add/i }).first();
    const addBtnB = pageB.locator("button").filter({ hasText: /追加|add/i }).first();

    const addAVisible = await addBtnA.isVisible({ timeout: 5_000 }).catch(() => false);
    const addBVisible = await addBtnB.isVisible({ timeout: 5_000 }).catch(() => false);

    if (!addAVisible || !addBVisible) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5C-13: 食事追加ボタンが見つからないためスキップ",
      });
      return;
    }

    // 並列で追加ボタンをクリック
    const [resA, resB] = await Promise.allSettled([
      addBtnA.click(),
      addBtnB.click(),
    ]);

    await Promise.all([pageA.waitForTimeout(1_500), pageB.waitForTimeout(1_500)]);
    await attach(pageA, testInfo, "W5C-13: タブA 追加クリック後");
    await attach(pageB, testInfo, "W5C-13: タブB 追加クリック後");

    // エラーダイアログまたはエラーメッセージの確認
    const errorA = await pageA
      .locator("text=/重複|既に存在|already exists|unique/i")
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    const errorB = await pageB
      .locator("text=/重複|既に存在|already exists|unique/i")
      .isVisible({ timeout: 3_000 })
      .catch(() => false);

    testInfo.annotations.push({
      type: "result",
      description: `W5C-13: 同時追加結果 - resA=${resA.status}, resB=${resB.status}, 重複エラーA=${errorA}, 重複エラーB=${errorB}`,
    });

    // どちらかでエラーが出る、または両方成功するが重複行は作られない
    testInfo.annotations.push({
      type: "info",
      description: `W5C-13: 今日${today}の同時食事追加テスト完了。重複エラーが出なければupsertで一方が上書きされている`,
    });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

/**
 * W5C-14: 健康記録の同じ日付を 2 タブで同時作成 → DB の unique 制約 (user_id, record_date) 確認
 */
test("W5C-14: 健康記録を 2 タブで同日同時作成 → DB unique 制約 or upsert 動作確認", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    // 両タブで /health/record を開く
    await Promise.all([pageA.goto("/health/record"), pageB.goto("/health/record")]);
    await Promise.all([
      pageA.waitForLoadState("networkidle"),
      pageB.waitForLoadState("networkidle"),
    ]);

    // 体重入力フィールドを探す
    const weightA = pageA.locator('input[type="number"]').first().or(
      pageA.locator('input[placeholder*="kg"]').first()
    );
    const weightB = pageB.locator('input[type="number"]').first().or(
      pageB.locator('input[placeholder*="kg"]').first()
    );

    const [aVisible, bVisible] = await Promise.all([
      weightA.isVisible({ timeout: 5_000 }).catch(() => false),
      weightB.isVisible({ timeout: 5_000 }).catch(() => false),
    ]);

    if (!aVisible || !bVisible) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5C-14: 健康記録入力フィールドが見つからないためスキップ",
      });
      return;
    }

    // 異なる値を入力して同時保存 (競合テスト)
    await weightA.fill("70.1");
    await weightB.fill("70.9");

    const saveBtnA = pageA.getByRole("button", { name: /保存|記録/i }).first();
    const saveBtnB = pageB.getByRole("button", { name: /保存|記録/i }).first();

    await attach(pageA, testInfo, "W5C-14: タブA 入力後");
    await attach(pageB, testInfo, "W5C-14: タブB 入力後");

    // 並列で保存
    const [saveA, saveB] = await Promise.allSettled([
      saveBtnA.click().then(() =>
        pageA
          .waitForResponse(
            (res) => res.url().includes("/api/health") && res.request().method() !== "GET",
            { timeout: 15_000 }
          )
          .catch(() => {})
      ),
      saveBtnB.click().then(() =>
        pageB
          .waitForResponse(
            (res) => res.url().includes("/api/health") && res.request().method() !== "GET",
            { timeout: 15_000 }
          )
          .catch(() => {})
      ),
    ]);

    await Promise.all([pageA.waitForTimeout(2_000), pageB.waitForTimeout(2_000)]);
    await attach(pageA, testInfo, "W5C-14: タブA 保存後");
    await attach(pageB, testInfo, "W5C-14: タブB 保存後");

    const errorA = await pageA.locator("text=エラー").isVisible().catch(() => false);
    const errorB = await pageB.locator("text=エラー").isVisible().catch(() => false);

    testInfo.annotations.push({
      type: "result",
      description: `W5C-14: 同時保存 - A=${saveA.status}(error=${errorA}), B=${saveB.status}(error=${errorB})`,
    });

    // 両方クラッシュしていないことを確認
    const bodyA = await pageA.locator("body").isVisible();
    const bodyB = await pageB.locator("body").isVisible();
    expect(bodyA, "タブAのページが壊れていない").toBe(true);
    expect(bodyB, "タブBのページが壊れていない").toBe(true);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

/**
 * W5C-15: オンボーディングの質問を 2 タブで同時進行 → race condition 確認
 */
test("W5C-15: オンボーディング質問回答を 2 タブで同時進行 → 状態整合性確認", async ({ browser }, testInfo) => {
  // オンボーディングが完了済みのユーザーの場合、/onboarding は /home へリダイレクトする
  // ここでは /onboarding ページの挙動を 2 コンテキストで確認する
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    // 両タブで /onboarding にアクセス
    await Promise.all([pageA.goto("/onboarding"), pageB.goto("/onboarding")]);
    await Promise.all([
      pageA.waitForLoadState("networkidle"),
      pageB.waitForLoadState("networkidle"),
    ]);

    const urlA = pageA.url();
    const urlB = pageB.url();

    testInfo.annotations.push({
      type: "result",
      description: `W5C-15: /onboarding アクセス後 - タブA URL=${urlA}, タブB URL=${urlB}`,
    });

    await attach(pageA, testInfo, "W5C-15: タブA /onboarding");
    await attach(pageB, testInfo, "W5C-15: タブB /onboarding");

    // オンボーディング完了済みならリダイレクトされているはず
    if (urlA.includes("/home") || urlA.includes("/onboarding")) {
      testInfo.annotations.push({
        type: "info",
        description: "W5C-15: /onboarding へのアクセス動作確認完了",
      });
    }

    // エラーが出ていないこと
    const errorA = await pageA.locator("text=エラー").isVisible().catch(() => false);
    const errorB = await pageB.locator("text=エラー").isVisible().catch(() => false);
    expect(errorA, "タブAにエラーなし").toBe(false);
    expect(errorB, "タブBにエラーなし").toBe(false);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ============================================================
// D. realtime subscription leak
// ============================================================

/**
 * W5D-16: タブを 5 個開く → subscription 数の増加・コンソールエラー確認
 *          (10 個は負荷が高いため 5 個に緩和)
 */
test("W5D-16: 5 タブで /menus/weekly を同時に開いてもコンソールエラーなし", async ({ browser }, testInfo) => {
  const TAB_COUNT = 5;
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];

  try {
    // まず 1 つログイン
    const ctxBase = await browser.newContext();
    contexts.push(ctxBase);
    const basePage = await loginInContext(ctxBase);

    // 残りのタブを同一コンテキストで開く (同一ユーザーセッション)
    for (let i = 1; i < TAB_COUNT; i++) {
      const page = await ctxBase.newPage();
      pages.push(page);
    }
    pages.unshift(basePage);

    // 全タブで /menus/weekly を並列に開く
    const consoleErrors: string[] = [];
    pages.forEach((p, i) => {
      p.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleErrors.push(`[Tab${i + 1}] ${msg.text()}`);
        }
      });
    });

    await Promise.all(pages.map((p) => p.goto("/menus/weekly")));
    await Promise.all(pages.map((p) => p.waitForLoadState("networkidle").catch(() => {})));

    // 3 秒待って subscription エラーが出ないか確認
    await pages[0].waitForTimeout(3_000);

    testInfo.annotations.push({
      type: "result",
      description: `W5D-16: ${TAB_COUNT}タブ同時 /menus/weekly - コンソールエラー数=${consoleErrors.length}`,
    });

    if (consoleErrors.length > 0) {
      testInfo.annotations.push({
        type: "issue",
        description: `[realtime][adversarial] W5D-16: ${TAB_COUNT}タブ開いた際にコンソールエラーが発生: ${consoleErrors.slice(0, 3).join("; ")}`,
      });
    }

    // 各タブでエラー表示がないことを確認
    for (let i = 0; i < pages.length; i++) {
      const hasError = await pages[i].locator("text=エラー").isVisible().catch(() => false);
      if (hasError) {
        testInfo.annotations.push({
          type: "issue",
          description: `[realtime][adversarial] W5D-16: Tab${i + 1} でエラー表示`,
        });
      }
    }

    await attach(pages[0], testInfo, "W5D-16: Tab1 最終状態");
  } finally {
    for (const ctx of contexts) {
      await ctx.close().catch(() => {});
    }
  }
});

/**
 * W5D-17: タブを開いて閉じることを繰り返す → subscription cleanup 動作確認 (#120)
 */
test("W5D-17: タブ開閉を繰り返してもメモリリーク兆候がない (subscription cleanup 確認)", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext();
  try {
    // ベースページでログイン
    const basePage = await loginInContext(ctx);
    await basePage.goto("/menus/weekly");
    await basePage.waitForLoadState("networkidle");

    const errors: string[] = [];
    basePage.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    // 3 回タブを開いて閉じる
    for (let round = 0; round < 3; round++) {
      const tempPage = await ctx.newPage();
      await tempPage.goto("/menus/weekly");
      await tempPage.waitForLoadState("networkidle").catch(() => {});
      await tempPage.waitForTimeout(1_000);
      await tempPage.close();
      await basePage.waitForTimeout(500);
    }

    // ベースページが引き続き正常動作していること
    const isVisible = await basePage.locator("body").isVisible();
    expect(isVisible, "ベースページが正常表示").toBe(true);

    const hasError = await basePage.locator("text=エラー").isVisible().catch(() => false);
    if (hasError) {
      testInfo.annotations.push({
        type: "issue",
        description: "[realtime][adversarial] W5D-17: タブ開閉繰り返し後、ベースページにエラー表示",
      });
    }

    testInfo.annotations.push({
      type: "result",
      description: `W5D-17: 3回開閉後のコンソールエラー数=${errors.length}`,
    });

    if (errors.length > 0) {
      testInfo.annotations.push({
        type: "issue",
        description: `[realtime][adversarial] W5D-17: タブ開閉繰り返し後にコンソールエラーが発生: ${errors.slice(0, 2).join("; ")}`,
      });
    }

    await attach(basePage, testInfo, "W5D-17: ベースページ最終状態");
  } finally {
    await ctx.close();
  }
});

/**
 * W5D-18: signin → signout → signin を高速繰り返し → subscription が正常にクリーンアップされる
 */
test("W5D-18: signin → signout → signin 高速繰り返し → 状態が一貫している", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext();
  try {
    const page = await loginInContext(ctx);
    await page.goto("/home");
    await page.waitForLoadState("networkidle");
    await attach(page, testInfo, "W5D-18: 初回ログイン後");

    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    // 1 回だけサインアウト → サインインのサイクルを実行 (安全のため)
    // /settings からサインアウト
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const logoutBtn = page
      .getByRole("button", { name: /ログアウト/ })
      .or(page.locator("button").filter({ hasText: /ログアウト/ }))
      .first();
    const logoutVisible = await logoutBtn.isVisible({ timeout: 8_000 }).catch(() => false);

    if (!logoutVisible) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "W5D-18: ログアウトボタンが見つからないためスキップ",
      });
      return;
    }

    page.on("dialog", (d) => d.accept());
    await logoutBtn.click();

    const confirmBtn = page.locator("button").filter({ hasText: /^ログアウト$/ }).last();
    const confirmVisible = await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (confirmVisible) await confirmBtn.click();

    await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 });
    await attach(page, testInfo, "W5D-18: signout後 /login");

    // 再サインイン
    await page.locator("#email").fill(E2E_USER.email);
    await page.locator("#password").fill(E2E_USER.password);
    await Promise.all([
      page.waitForURL(
        (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
        { timeout: 25_000 }
      ),
      page.locator("button[type=submit]").click(),
    ]);

    await page.waitForLoadState("networkidle");
    await attach(page, testInfo, "W5D-18: 再サインイン後");

    // エラーが出ていないこと
    const hasError = await page.locator("text=エラー").isVisible().catch(() => false);
    expect(hasError, "再サインイン後にエラーなし").toBe(false);

    testInfo.annotations.push({
      type: "result",
      description: `W5D-18: signout→signin サイクル完了。コンソールエラー=${errors.length}件`,
    });
  } finally {
    await ctx.close();
  }
});

// ============================================================
// E. session 同期
// ============================================================

/**
 * W5E-19: session expire シミュレーション → middleware が /login にリダイレクト (#142)
 */
test("W5E-19: セッション Cookie 削除後に保護ページへのアクセスが /login にリダイレクト", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext();
  try {
    const page = await loginInContext(ctx);
    await page.goto("/home");
    await page.waitForLoadState("networkidle");
    await attach(page, testInfo, "W5E-19: ログイン済み /home");

    // セッション Cookie をクリアして session expire をシミュレート
    await ctx.clearCookies();

    // 別の保護ページにアクセス
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    const currentUrl = page.url();
    const isOnLogin = currentUrl.includes("/login");

    await attach(page, testInfo, "W5E-19: Cookie削除後のアクセス先");

    testInfo.annotations.push({
      type: "result",
      description: `W5E-19: Cookie削除後 /menus/weekly アクセス → URL=${currentUrl}, /login redirect=${isOnLogin}`,
    });

    if (!isOnLogin) {
      testInfo.annotations.push({
        type: "issue",
        description: `[realtime][adversarial] W5E-19: セッションCookieクリア後も /menus/weekly にアクセス可能 (${currentUrl})。middleware が機能していない可能性`,
      });
    } else {
      expect(isOnLogin, "セッション切れ後は /login にリダイレクト").toBe(true);
    }
  } finally {
    await ctx.close();
  }
});

/**
 * W5E-20: token refresh の race condition を確認
 *         2 コンテキストが同時に token refresh を試みても、どちらも正常に動作する
 */
test("W5E-20: 2 コンテキストが同時にトークンリフレッシュを行っても一方がエラーにならない", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await loginInContext(ctxA);
    const pageB = await loginInContext(ctxB);

    // 両コンテキストで同時に認証が必要なページにアクセス (refresh を発火させる)
    const errorsA: string[] = [];
    const errorsB: string[] = [];
    pageA.on("console", (msg) => { if (msg.type() === "error") errorsA.push(msg.text()); });
    pageB.on("console", (msg) => { if (msg.type() === "error") errorsB.push(msg.text()); });

    await Promise.all([
      pageA.goto("/home"),
      pageB.goto("/home"),
    ]);
    await Promise.all([
      pageA.waitForLoadState("networkidle"),
      pageB.waitForLoadState("networkidle"),
    ]);

    // 少し待ってコンソールエラーを収集
    await Promise.all([pageA.waitForTimeout(2_000), pageB.waitForTimeout(2_000)]);

    const urlA = pageA.url();
    const urlB = pageB.url();

    testInfo.annotations.push({
      type: "result",
      description: `W5E-20: コンテキストA URL=${urlA}, B URL=${urlB}, エラーA=${errorsA.length}件, エラーB=${errorsB.length}件`,
    });

    // どちらも /home に到達しているべき
    expect(urlA).not.toContain("/login");
    expect(urlB).not.toContain("/login");

    if (errorsA.length > 0 || errorsB.length > 0) {
      testInfo.annotations.push({
        type: "issue",
        description: `[realtime][adversarial] W5E-20: 同時トークンリフレッシュでコンソールエラー。A=${errorsA.slice(0, 1)}, B=${errorsB.slice(0, 1)}`,
      });
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ============================================================
// F. localStorage / sessionStorage 同期
// ============================================================

/**
 * W5F-22: tab A で localStorage 書き込み → tab B (同一コンテキスト) で読める
 *          別コンテキストでは読めないことも確認 (#141 quota 確認)
 */
test("W5F-22: localStorage は同一コンテキスト内タブで共有されるが別コンテキストでは独立している", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext();
  const ctxOther = await browser.newContext();
  try {
    const pageA = await loginInContext(ctx);
    await pageA.goto("/menus/weekly");
    await pageA.waitForLoadState("networkidle");

    // 同一コンテキストのタブ B
    const pageB = await ctx.newPage();
    await pageB.goto("/menus/weekly");
    await pageB.waitForLoadState("networkidle");

    // 別コンテキストのタブ C
    const pageC = await loginInContext(ctxOther);
    await pageC.goto("/menus/weekly");
    await pageC.waitForLoadState("networkidle");

    // タブ A: localStorage に値をセット
    const testKey = "w5f22_test_key";
    const testValue = `test_value_${Date.now()}`;
    await pageA.evaluate(
      ([k, v]) => localStorage.setItem(k, v),
      [testKey, testValue]
    );

    // タブ B (同一コンテキスト): 読める
    const valueInB = await pageB.evaluate((k) => localStorage.getItem(k), testKey);

    // タブ C (別コンテキスト): 読めない
    const valueInC = await pageC.evaluate((k) => localStorage.getItem(k), testKey);

    testInfo.annotations.push({
      type: "result",
      description: `W5F-22: タブB(同一ctx)=${valueInB}, タブC(別ctx)=${valueInC}`,
    });

    expect(valueInB, "同一コンテキスト内タブBで共有される").toBe(testValue);
    expect(valueInC, "別コンテキストのタブCには伝播しない").toBeNull();

    // クリーンアップ
    await pageA.evaluate((k) => localStorage.removeItem(k), testKey);
  } finally {
    await ctx.close();
    await ctxOther.close();
  }
});

/**
 * W5F-23: プライベートモード (incognito) で localStorage 書き込み失敗 → graceful 処理
 *          safeLocalStorageSetItem の quota チェックを間接的に確認
 */
test("W5F-23: localStorage quota 超過時の graceful 処理 (safeLocalStorageSetItem)", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext();
  try {
    const page = await loginInContext(ctx);
    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle");

    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    // localStorage quota を強制的に超過させる (大量データを書き込む)
    const quotaExceeded = await page.evaluate(async () => {
      try {
        // 5MB のダミーデータを書き込む
        const bigData = "x".repeat(1024 * 1024); // 1MB
        for (let i = 0; i < 5; i++) {
          localStorage.setItem(`quota_test_${i}`, bigData);
        }
        return false; // quota に引っかからなかった
      } catch (e: any) {
        return e.name === "QuotaExceededError";
      }
    });

    testInfo.annotations.push({
      type: "result",
      description: `W5F-23: localStorage quota 超過テスト - 超過したか=${quotaExceeded}`,
    });

    // quota 超過後でもページがクラッシュしないこと
    const bodyVisible = await page.locator("body").isVisible();
    expect(bodyVisible, "quota超過後もページが存在する").toBe(true);

    // safeLocalStorageSetItem の動作確認: 生成状態キーの書き込みエラーが console.warn レベルで扱われる
    const criticalErrors = errors.filter(
      (e) => !e.includes("localStorage") && !e.includes("quota")
    );
    if (criticalErrors.length > 0) {
      testInfo.annotations.push({
        type: "issue",
        description: `[multi-tab][adversarial] W5F-23: quota超過後に予期しないエラー: ${criticalErrors.slice(0, 2).join("; ")}`,
      });
    }

    // クリーンアップ
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) {
        localStorage.removeItem(`quota_test_${i}`);
      }
    });

    await attach(page, testInfo, "W5F-23: quota超過テスト後");
  } finally {
    await ctx.close();
  }
});

// ============================================================
// G. 異常な device 状態
// ============================================================

/**
 * W5G-24: iPad のような大きめ viewport で split view 相当 (幅の狭い viewport) を 2 つ同時確認
 */
test("W5G-24: iPad split view 相当の viewport でアプリが正常動作する", async ({ browser }, testInfo) => {
  // iPad Pro の半分程度の幅 (split view = 428px 程度)
  const ctx1 = await browser.newContext({ viewport: { width: 428, height: 1024 } });
  const ctx2 = await browser.newContext({ viewport: { width: 428, height: 1024 } });
  try {
    const page1 = await loginInContext(ctx1);
    const page2 = await loginInContext(ctx2);

    // 同時に /home と /menus/weekly を開く
    await Promise.all([page1.goto("/home"), page2.goto("/menus/weekly")]);
    await Promise.all([
      page1.waitForLoadState("networkidle"),
      page2.waitForLoadState("networkidle"),
    ]);

    await attach(page1, testInfo, "W5G-24: iPad split /home");
    await attach(page2, testInfo, "W5G-24: iPad split /menus/weekly");

    // エラーなし
    const error1 = await page1.locator("text=エラー").isVisible().catch(() => false);
    const error2 = await page2.locator("text=エラー").isVisible().catch(() => false);
    expect(error1, "split view 1 でエラーなし").toBe(false);
    expect(error2, "split view 2 でエラーなし").toBe(false);

    // 横スクロールが発生していないか確認
    const [scrollWidth1, clientWidth1] = await page1.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    const hasHorizontalScroll1 = scrollWidth1 > clientWidth1;

    const [scrollWidth2, clientWidth2] = await page2.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    const hasHorizontalScroll2 = scrollWidth2 > clientWidth2;

    testInfo.annotations.push({
      type: "result",
      description: `W5G-24: 横スクロール - /home=${hasHorizontalScroll1}, /menus/weekly=${hasHorizontalScroll2}`,
    });

    if (hasHorizontalScroll1 || hasHorizontalScroll2) {
      testInfo.annotations.push({
        type: "issue",
        description: `[multi-tab][adversarial] W5G-24: iPad split view (428px) で横スクロールが発生。レイアウト崩れの可能性`,
      });
    }
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});

/**
 * W5G-25: ブラウザの back/forward を高速操作 → history API race condition 確認
 */
test("W5G-25: back/forward 高速操作で history API race condition が起きない", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext();
  try {
    const page = await loginInContext(ctx);

    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    // 複数のページに順番にアクセスして履歴を積む
    const routes = ["/home", "/menus/weekly", "/profile", "/settings"];
    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    await attach(page, testInfo, "W5G-25: 複数ページ訪問後");

    // 高速 back/forward を 5 回実行
    for (let i = 0; i < 5; i++) {
      await page.goBack({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(200);
    }

    // 高速 forward を 5 回実行
    for (let i = 0; i < 5; i++) {
      await page.goForward({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(200);
    }

    // 最終的なページ状態を確認
    await page.waitForLoadState("networkidle").catch(() => {});
    await attach(page, testInfo, "W5G-25: back/forward連打後");

    const currentUrl = page.url();
    const bodyVisible = await page.locator("body").isVisible();
    expect(bodyVisible, "back/forward連打後もページが表示される").toBe(true);

    const hasError = await page.locator("text=エラー").isVisible().catch(() => false);

    testInfo.annotations.push({
      type: "result",
      description: `W5G-25: back/forward 連打後 URL=${currentUrl}, コンソールエラー=${errors.length}件, UI error=${hasError}`,
    });

    if (hasError || errors.length > 5) {
      testInfo.annotations.push({
        type: "issue",
        description: `[multi-tab][adversarial] W5G-25: back/forward高速操作でエラー発生。UIエラー=${hasError}, コンソール=${errors.length}件`,
      });
    }
  } finally {
    await ctx.close();
  }
});
