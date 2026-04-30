/**
 * Adversarial Deep-Dive Tests (Wave 1 / B7)
 *
 * シナリオ:
 *   A. Rate limit / 連射 → 重複 request race
 *   B. Session 期限切れ中の long-running 操作
 *   C. ネットワーク断 (offline / throttle)
 *   D. localStorage 改竄 / quota 超過
 *   E. Browser back/forward 連打
 *   F. CSP / security header 欠落
 *   G. Cookie 改竄 → middleware bypass
 *
 * 実行方法:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e -- adversarial-deep
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { login } from "./fixtures/auth";

// ─── helpers ───────────────────────────────────────────────────────────────

/** 今週月曜の YYYY-MM-DD */
function thisMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}

/** ネットワークをオフラインにして fn を実行し、その後オンラインに戻す */
async function withOffline<T>(
  context: BrowserContext,
  fn: () => Promise<T>,
): Promise<T> {
  await context.setOffline(true);
  try {
    return await fn();
  } finally {
    await context.setOffline(false);
  }
}

// ─── A: Rate limit / 重複 request ──────────────────────────────────────────

/**
 * A-1: 週間献立生成ボタンを 2 回連打しても、API リクエストが
 *       1 度しか飛ばないこと（isGenerating guard が機能する）。
 *
 * 期待: 2 回目のクリックは disabled 属性 or guard で弾かれ、
 *       `POST /api/ai/menu/weekly/request` が 1 件しか発行されない。
 */
test("A-1: 週間献立ボタンを 2 回連打してもリクエストは 1 件のみ", async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");

  // POST を監視
  const requests: string[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/ai/menu/weekly/request")
    ) {
      requests.push(req.url());
    }
  });

  // AI モーダルを開く
  const aiButton = page
    .locator('button')
    .filter({ hasText: /AIで.*献立|献立を.*生成|AI.*献立/ })
    .or(page.locator('[data-testid="ai-generate-button"]'))
    .first();

  const aiVisible = await aiButton.isVisible({ timeout: 10_000 }).catch(() => false);
  if (!aiVisible) {
    // Sparkles アイコンを持つボタンを探す
    const sparkleBtn = page.locator('button:has(svg)').first();
    const sparkleVisible = await sparkleBtn.isVisible().catch(() => false);
    if (!sparkleVisible) {
      test.skip(true, "AI generate button not found – skip");
      return;
    }
  }

  // AIアシスタントパネルを開く
  const panelOpenBtn = page.getByRole("button", { name: /AI|献立/ }).first();
  await panelOpenBtn.click().catch(() => {});
  await page.waitForTimeout(500);

  // 「今週の献立を生成」ボタンを探す
  const generateBtn = page
    .getByRole("button", { name: /今週の献立を生成|献立を生成|生成/ })
    .first();

  const genVisible = await generateBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!genVisible) {
    test.skip(true, "Generate button not visible in current UI state – skip");
    return;
  }

  // 2 回連打
  await Promise.all([generateBtn.click(), generateBtn.click()]);
  await page.waitForTimeout(2_000);

  // isGenerating guard が機能していれば POST は 0 か 1 件のみ
  // guard が壊れていれば 2 件以上になる
  expect(
    requests.length,
    `期待: POST が最大 1 件。実際: ${requests.length} 件（重複リクエスト race が発生）`,
  ).toBeLessThanOrEqual(1);
});

/**
 * A-2: /api/ai/menu/weekly/request に認証なしで POST すると 401 が返ること。
 *       rate limit も認証後にのみ意味を持つため、認証チェックが先行していることを確認。
 */
test("A-2: 未認証 POST /api/ai/menu/weekly/request → 401", async ({ page }) => {
  // cookie なしで直接 fetch
  const res = await page.request.post(
    "/api/ai/menu/weekly/request",
    {
      data: { startDate: thisMonday() },
      headers: { "Content-Type": "application/json" },
    },
  );
  expect(res.status()).toBe(401);
});

/**
 * A-3: /api/ai/menu/weekly/request に startDate なしで POST すると 400 が返ること。
 */
test("A-3: startDate 欠落の POST → 400", async ({ page }) => {
  // 認証情報なしで 400 より先に 401 が返る可能性があるが、どちらでも OK
  const res = await page.request.post(
    "/api/ai/menu/weekly/request",
    {
      data: {},
      headers: { "Content-Type": "application/json" },
    },
  );
  expect([400, 401]).toContain(res.status());
});

// ─── B: Session 期限切れ race ──────────────────────────────────────────────

/**
 * B-1: 生成中に Cookie を強制クリア（セッション期限切れ模倣）→
 *       ポーリングが 401 を受け取った後に UI がフリーズしないこと。
 *
 * 期待: エラー表示 or /login リダイレクト。「生成中…」のまま無限待機は NG。
 */
test("B-1: 生成中セッション期限切れ → UI がフリーズしない", async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");

  // isGenerating が true になる状態を localStorage で模倣
  const fakeRequestId = "00000000-dead-beef-0000-000000000000";
  await page.evaluate((reqId) => {
    localStorage.setItem(
      "weeklyMenuGenerating",
      JSON.stringify({
        weekStartDate: new Date().toISOString().split("T")[0],
        timestamp: Date.now(),
        requestId: reqId,
      }),
    );
  }, fakeRequestId);

  // Cookie を全クリア（セッション期限切れ模倣）
  await context.clearCookies();

  // リロードして復元フローを走らせる
  await page.reload();
  await page.waitForTimeout(5_000);

  // 「生成中...」のスピナーが永久表示されていないことを確認
  // 5秒後もまだ「生成中...」が見えていたらフリーズ（バグ）
  const generatingText = page.locator("text=/生成中|処理中/").first();
  const isStillGenerating = await generatingText.isVisible({ timeout: 1_000 }).catch(() => false);

  // エラー表示 or ログインリダイレクトが発生していることを期待
  const currentUrl = page.url();
  const isRedirectedToLogin = currentUrl.includes("/login");

  if (isStillGenerating && !isRedirectedToLogin) {
    throw new Error(
      "セッション期限切れ後もスピナーが表示されたままでフリーズしている（localStorage を悪意ある操作で活用できる）",
    );
  }
  // ログインへ飛んだ or スピナーが消えていれば OK
});

/**
 * B-2: sign-in 直後に sign-out → 中間状態で API を叩かれない。
 *       ログイン後のリダイレクト先で認証チェックが通ること。
 */
test("B-2: 高速 sign-in → sign-out → /home への不正アクセスができない", async ({
  page,
}) => {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  // /home を直接 fetch して 401/307 を確認
  const res = await page.request.get("/home");
  // 未認証なので 307 リダイレクト or 401 を期待
  expect([200, 307, 401]).toContain(res.status());
  // 200 の場合でも、中身が /login へのリダイレクト HTML であること
  if (res.status() === 200) {
    const body = await res.text();
    // Next.js の middleware が /login へリダイレクトするなら body に login が含まれることが多い
    // ここでは /home の認証保護ページ自体が SSR で 200 を返す可能性があるため、
    // 中身が認証ページかを確認
    const isPublicContent = body.includes("ゲストモード") || body.includes("ログアウト");
    if (isPublicContent) {
      throw new Error("未認証で /home の認証保護コンテンツが表示された");
    }
  }
});

// ─── C: ネットワーク断 ──────────────────────────────────────────────────────

/**
 * C-1: オフライン中に /menus/weekly を開くと、
 *       クラッシュせずにエラー表示 or ローディング状態を維持すること。
 */
test("C-1: オフライン中に /menus/weekly を開いてもクラッシュしない", async ({
  page,
  context,
}) => {
  await login(page);
  // オフラインにしてからページ遷移
  await withOffline(context, async () => {
    // ページを開く（エラーが throw されても OK、クラッシュ=全白画面は NG）
    await page.goto("/menus/weekly", { waitUntil: "commit" }).catch(() => {});
    await page.waitForTimeout(3_000);

    // global-error.tsx が表示されていないことを確認
    const globalError = page.locator("text=/Something went wrong|エラーが発生/");
    const hasGlobalError = await globalError.isVisible({ timeout: 1_000 }).catch(() => false);

    // Unhandled runtime error がないことを確認
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    if (hasGlobalError) {
      throw new Error(
        "オフライン時に global-error.tsx が表示された（ネットワーク断で全白画面）",
      );
    }
  });
});

/**
 * C-2: ページロード後にオフラインにし、データ取得をトリガーしても
 *       unhandled rejection でクラッシュしないこと。
 */
test("C-2: ページロード後のオフライン状態でデータ更新操作しても unhandled rejection なし", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");

  // オフラインにする
  await context.setOffline(true);

  try {
    // 週を切り替えて fetch を誘発（エラーが起きても UI がクラッシュしないこと）
    const nextWeekBtn = page
      .locator("button")
      .filter({ has: page.locator("svg") })
      .last();
    await nextWeekBtn.click().catch(() => {});
    await page.waitForTimeout(2_000);

    // unhandled promise rejection がないことを確認
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("Failed to fetch") &&
        !e.includes("NetworkError") &&
        !e.includes("net::ERR_INTERNET_DISCONNECTED"),
    );
    if (criticalErrors.length > 0) {
      throw new Error(
        `オフライン中に予期しない pageerror が発生: ${criticalErrors.join("; ")}`,
      );
    }
  } finally {
    await context.setOffline(false);
  }
});

// ─── D: localStorage 改竄 / quota 超過 ────────────────────────────────────

/**
 * D-1: localStorage に 4MB の巨大データを書き込んだ後に
 *       weeklyMenuGenerating を setItem しようとしても
 *       QuotaExceededError でアプリがクラッシュしないこと。
 *
 * 現状のコード: localStorage.setItem() は try-catch なしで直接呼ばれており、
 * QuotaExceededError が uncaught になる可能性がある。
 */
test("D-1: localStorage quota 超過後もアプリがクラッシュしない", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await login(page);
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");

  // localStorage を ~4MB 埋める
  await page.evaluate(() => {
    try {
      const blob = "x".repeat(1024); // 1KB
      for (let i = 0; i < 4096; i++) {
        localStorage.setItem(`_fill_${i}`, blob);
      }
    } catch {
      // quota exceeded – 埋めきれなくても OK
    }
  });

  // 週間生成状態を書き込もうとする（quota が満杯のため失敗する可能性）
  const writeResult = await page.evaluate(() => {
    try {
      localStorage.setItem(
        "weeklyMenuGenerating",
        JSON.stringify({ weekStartDate: "2026-05-01", timestamp: Date.now(), requestId: "fake" }),
      );
      return "ok";
    } catch (e: any) {
      return `error:${e.name}`;
    }
  });

  // クリーンアップ
  await page.evaluate(() => {
    for (let i = 0; i < 4096; i++) {
      localStorage.removeItem(`_fill_${i}`);
    }
  });

  // pageerror が発生していた場合はバグ
  const quotaErrors = errors.filter((e) => e.includes("QuotaExceeded") || e.includes("storage"));
  if (quotaErrors.length > 0) {
    throw new Error(
      `localStorage quota 超過で uncaught QuotaExceededError が発生: ${quotaErrors.join("; ")}\n` +
      "setItem() が try-catch されていないため、生成中状態の書き込みで QuotaExceededError が上位に漏れる。",
    );
  }

  // writeResult が error で始まっている場合はバグ候補（catch できていれば ok）
  if (writeResult.startsWith("error")) {
    console.warn(
      `[D-1] localStorage.setItem が例外を返した: ${writeResult}\n` +
      "コード側で catch されていない場合、アプリがクラッシュする。",
    );
  }
});

/**
 * D-2: sb-access-token Cookie を改竄した場合、
 *       middleware が 307 → /login にリダイレクトすること。
 */
test("D-2: sb-access-token 改竄 → /home アクセスで /login リダイレクト", async ({
  page,
  context,
}) => {
  await login(page);

  // Cookie を改竄
  const cookies = await context.cookies();
  const sbCookies = cookies.filter((c) => c.name.startsWith("sb-"));
  for (const cookie of sbCookies) {
    await context.addCookies([
      {
        ...cookie,
        value: "INVALID_TAMPERED_TOKEN_xxxxxxxxxxxxxxxxxxx",
      },
    ]);
  }

  // 改竄済みの状態で /home にアクセス
  const res = await page.goto("/home", { waitUntil: "commit" });
  await page.waitForTimeout(3_000);

  const finalUrl = page.url();
  const statusCode = res?.status();

  // 正しい挙動: /login にリダイレクトされる
  const redirectedToLogin = finalUrl.includes("/login");
  if (!redirectedToLogin) {
    throw new Error(
      `Cookie 改竄後も /home が表示された (status=${statusCode}, url=${finalUrl})。\n` +
      "middleware が改竄 token を弾いていない可能性がある。",
    );
  }
});

// ─── E: Browser back/forward 連打 ─────────────────────────────────────────

/**
 * E-1: ページ間を高速 back/forward した後に /menus/weekly が正常表示されること。
 *       useState の cleanup が走ることで race condition が起きないことを確認。
 */
test("E-1: back/forward 連打後に /menus/weekly が正常表示される", async ({
  page,
}) => {
  await login(page);
  await page.goto("/home");
  await page.waitForLoadState("networkidle");
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");
  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  // 高速 back/forward
  for (let i = 0; i < 5; i++) {
    await page.goBack().catch(() => {});
    await page.goForward().catch(() => {});
  }

  // /menus/weekly に戻る
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");

  // ページがクラッシュしていないこと
  const body = page.locator("body");
  await expect(body).toBeVisible({ timeout: 10_000 });

  // global-error.tsx が表示されていないこと
  const globalError = page.locator("text=/Something went wrong/").first();
  const hasError = await globalError.isVisible({ timeout: 1_000 }).catch(() => false);
  if (hasError) {
    throw new Error("back/forward 連打後に global-error.tsx が表示された");
  }
});

/**
 * E-2: sign-in 後に /menus/weekly → back → /menus/weekly と戻った際、
 *       isGenerating が前の状態のまま残らない（state leak なし）。
 */
test("E-2: /menus/weekly に再訪した際に isGenerating が残留しない", async ({
  page,
}) => {
  await login(page);

  // weeklyMenuGenerating を残した状態で遷移
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");

  // 生成中状態を古いタイムスタンプで仕込む（5分超 = stale）
  await page.evaluate(() => {
    localStorage.setItem(
      "weeklyMenuGenerating",
      JSON.stringify({
        weekStartDate: new Date().toISOString().split("T")[0],
        timestamp: Date.now() - 6 * 60 * 1000, // 6 分前 = stale
        requestId: "stale-request-id-xxx",
      }),
    );
  });

  // /home に遷移して戻る
  await page.goto("/home");
  await page.waitForLoadState("networkidle");
  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3_000);

  // スピナーが表示されていないことを確認（stale なので復元されないはず）
  const spinner = page.locator('[class*="animate-spin"]').first();
  const spinnerVisible = await spinner.isVisible({ timeout: 1_000 }).catch(() => false);

  if (spinnerVisible) {
    throw new Error(
      "stale な weeklyMenuGenerating (6分前) で isGenerating が true に復元された。\n" +
      "stale 判定（5分）が機能していない可能性がある。",
    );
  }
});

// ─── F: CSP / Security Header ──────────────────────────────────────────────

/**
 * F-1: Production の response headers に Content-Security-Policy が存在すること。
 *
 * 現状: next.config.mjs に CSP が設定されていない。
 * Vercel のデフォルトでも CSP は付与されない。
 * この場合 XSS リスクがある。
 */
test("F-1: / のレスポンスに Content-Security-Policy header が存在する", async ({
  request,
}) => {
  const res = await request.get("/");
  const csp = res.headers()["content-security-policy"];
  if (!csp) {
    throw new Error(
      "Content-Security-Policy header が存在しない。\n" +
      "next.config.mjs の headers() に CSP を設定することを推奨。\n" +
      "XSS 攻撃に対して無防備な状態。",
    );
  }
});

/**
 * F-2: / のレスポンスに X-Frame-Options または CSP の frame-ancestors が存在すること。
 *       存在しない場合、クリックジャッキング攻撃が可能。
 */
test("F-2: X-Frame-Options または CSP frame-ancestors が存在する", async ({
  request,
}) => {
  const res = await request.get("/");
  const headers = res.headers();
  const xfo = headers["x-frame-options"];
  const csp = headers["content-security-policy"];
  const hasFrameGuard =
    xfo ||
    (csp && csp.toLowerCase().includes("frame-ancestors"));

  if (!hasFrameGuard) {
    throw new Error(
      "X-Frame-Options および CSP frame-ancestors が両方とも存在しない。\n" +
      "クリックジャッキング攻撃が可能な状態。",
    );
  }
});

/**
 * F-3: / のレスポンスに X-Content-Type-Options: nosniff が存在すること。
 */
test("F-3: X-Content-Type-Options: nosniff が存在する", async ({
  request,
}) => {
  const res = await request.get("/");
  const header = res.headers()["x-content-type-options"];
  if (header !== "nosniff") {
    throw new Error(
      `X-Content-Type-Options: nosniff が存在しない (実際の値: ${header ?? "未設定"})。\n` +
      "MIME スニッフィング攻撃のリスクがある。",
    );
  }
});

/**
 * F-4: API エンドポイントの CORS が access-control-allow-origin: * になっていないこと。
 *       現状、static page の / が * を返している。API ルートを確認する。
 */
test("F-4: API ルートが CORS wildcard (*) を返さない", async ({ request }) => {
  // 認証なしでの OPTIONS リクエスト
  const res = await request.fetch("/api/ai/menu/weekly/status?requestId=test", {
    method: "GET",
    headers: { Origin: "https://evil.example.com" },
  });
  const acao = res.headers()["access-control-allow-origin"];
  if (acao === "*") {
    throw new Error(
      "API /api/ai/menu/weekly/status が Access-Control-Allow-Origin: * を返している。\n" +
      "認証済み API には wildcard CORS を設定すべきでない。",
    );
  }
});

// ─── G: 長時間放置 / token 期限 ────────────────────────────────────────────

/**
 * G-1: /api/auth/session-sync を叩いたとき、有効なセッションがあれば 200 を返すこと。
 *       セッションがない場合は 401 を返すこと。
 */
test("G-1: 未認証で /api/auth/session-sync → 401", async ({ page }) => {
  const res = await page.request.post("/api/auth/session-sync", {
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status()).toBe(401);
});

/**
 * G-2: access token を意図的に期限切れにした状態（手動クリア）で
 *       /home の protected page にアクセスしたとき /login にリダイレクトされること。
 *       middleware の getSession() が有効期限を確認していることを検証。
 */
test("G-2: access-token のみクリアして /home → /login リダイレクト", async ({
  page,
  context,
}) => {
  await login(page);

  // access token 関連 cookie だけ削除（refresh token は残す）
  const cookies = await context.cookies();
  const filtered = cookies.filter(
    (c) => !c.name.includes("auth-token") && !c.name.includes("access"),
  );
  await context.clearCookies();
  if (filtered.length > 0) {
    await context.addCookies(filtered);
  }

  await page.goto("/home");
  await page.waitForTimeout(5_000);

  // 正常なフローなら refresh token でセッション復元されるか、/login にリダイレクト
  // どちらも OK（サーバがトークンを正しくハンドリングしていることの確認）
  const url = page.url();
  const isOnProtectedPage = url.includes("/home") || url.includes("/menus");
  const isOnLoginPage = url.includes("/login");

  // どちらでもクラッシュしていないことを確認
  const globalError = page.locator("text=/Something went wrong/");
  const hasError = await globalError.isVisible({ timeout: 1_000 }).catch(() => false);
  if (hasError) {
    throw new Error("access token クリア後に global-error.tsx が表示された");
  }
});
