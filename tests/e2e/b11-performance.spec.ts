/**
 * Wave 1.5 / B11: パフォーマンス & 負荷 探索
 *
 * 計測観点:
 *   1. Core Web Vitals (LCP / CLS) — 各主要ページ
 *   2. メモリリーク — /home → /menus/weekly → /health → /home を繰り返し
 *   3. 大量データ耐性 — 1000件 planned_meals / 500件 health_records 状態を模倣
 *   4. 連打耐性 — meal toggle を高速連打して重複リクエストが送出されるか
 *   5. Bundle サイズ (JS 転送量)
 *   6. 画像最適化 — <img> タグの lazy loading / WebP / next/image 使用チェック
 *
 * 注意:
 *   - 計測は https://homegohan-app.vercel.app/ に対して実行する。
 *   - PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npx playwright test b11-performance
 *   - 認証が必要なページは authedPage fixture を使用する。
 */

import { test, expect } from "./fixtures/auth";

// ============================================================
// 定数
// ============================================================

/** LCP の警告閾値 (ms) — 3000ms を超えるページは Issue 対象 */
const LCP_WARN_MS = 3000;

/** CLS の警告閾値 — 0.25 を超えると "Poor" */
const CLS_WARN = 0.25;

/** メモリリーク判定閾値 (bytes) — 50 往復後に 100MB 超増加で leak 認定 */
const MEMORY_LEAK_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** 初回 JS ロード上限 (bytes) — 1MB 超で Issue 対象 */
const JS_SIZE_WARN_BYTES = 1 * 1024 * 1024;

// ============================================================
// ヘルパー
// ============================================================

/**
 * ページ遷移後に LCP / CLS を収集する。
 * Performance Observer を page.evaluate() 内で動かし、
 * 最大 5 秒待機して値を返す。
 */
async function collectWebVitals(
  page: import("@playwright/test").Page,
  path: string,
): Promise<{ lcp: number; cls: number; path: string }> {
  await page.goto(path, { waitUntil: "networkidle" });

  const vitals = await page.evaluate((): Promise<{ lcp: number; cls: number }> => {
    return new Promise((resolve) => {
      let lcpValue = 0;
      let clsValue = 0;

      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) {
          lcpValue = (entries[entries.length - 1] as PerformanceEntry & { startTime: number }).startTime;
        }
      });

      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!e.hadRecentInput) {
            clsValue += e.value;
          }
        }
      });

      try {
        lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
        clsObserver.observe({ type: "layout-shift", buffered: true });
      } catch {
        // ブラウザが未対応の場合は 0 を返す
        resolve({ lcp: 0, cls: 0 });
        return;
      }

      // 5秒後に収集を終了
      setTimeout(() => {
        lcpObserver.disconnect();
        clsObserver.disconnect();
        resolve({ lcp: lcpValue, cls: clsValue });
      }, 5000);
    });
  });

  return { ...vitals, path };
}

// ============================================================
// 1. Core Web Vitals — 各ページ
// ============================================================

test.describe("B11-1: Core Web Vitals", () => {
  const pages = ["/home", "/menus/weekly", "/health/graphs", "/settings", "/profile"];

  for (const pagePath of pages) {
    test(`LCP < 3000ms and CLS < 0.25 on ${pagePath}`, async ({ authedPage }) => {
      const result = await collectWebVitals(authedPage, pagePath);

      console.log(
        `[B11-1] ${pagePath} — LCP: ${result.lcp.toFixed(0)}ms, CLS: ${result.cls.toFixed(4)}`,
      );

      // LCP が閾値を超える場合はテスト失敗 (Issue 対象)
      expect(
        result.lcp,
        `${pagePath} の LCP が ${LCP_WARN_MS}ms を超えています (実測: ${result.lcp.toFixed(0)}ms)`,
      ).toBeLessThan(LCP_WARN_MS);

      // CLS が閾値を超える場合はテスト失敗 (Issue 対象)
      expect(
        result.cls,
        `${pagePath} の CLS が ${CLS_WARN} を超えています (実測: ${result.cls.toFixed(4)})`,
      ).toBeLessThan(CLS_WARN);
    });
  }
});

// ============================================================
// 2. メモリリーク — ページ遷移を繰り返し
// ============================================================

test(
  "B11-2: メモリリーク — /home→/menus/weekly→/health→/home を50回繰り返し",
  { timeout: 180_000 },
  async ({ authedPage }) => {
  // performance.memory は Chrome の非標準 API。
  // Chromium で --enable-precise-memory-info フラグが無い場合は usedJSHeapSize が 0 になるため
  // ブラウザ対応確認後にスキップ判定する。
  const initialHeap = await authedPage.evaluate((): number => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return perf.memory?.usedJSHeapSize ?? 0;
  });

  if (initialHeap === 0) {
    test.skip(true, "performance.memory API が利用不可 (非 Chromium or --enable-precise-memory-info 未設定)");
    return;
  }

  const routes = ["/home", "/menus/weekly", "/health/graphs", "/home"];
  const ITERATIONS = 50;

  for (let i = 0; i < ITERATIONS; i++) {
    for (const route of routes) {
      await authedPage.goto(route, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
  }

  // GC を促すため少し待機してから計測
  await authedPage.waitForTimeout(2000);

  const finalHeap = await authedPage.evaluate((): number => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return perf.memory?.usedJSHeapSize ?? 0;
  });

  const delta = finalHeap - initialHeap;
  console.log(
    `[B11-2] メモリ増加量: ${(delta / 1024 / 1024).toFixed(2)} MB` +
      ` (初期: ${(initialHeap / 1024 / 1024).toFixed(2)} MB → 最終: ${(finalHeap / 1024 / 1024).toFixed(2)} MB)`,
  );

  expect(
    delta,
    `50 往復後の JS ヒープ増加量が ${MEMORY_LEAK_THRESHOLD_BYTES / 1024 / 1024}MB を超えています ` +
      `(実測: ${(delta / 1024 / 1024).toFixed(2)}MB) — メモリリークの疑い`,
  ).toBeLessThan(MEMORY_LEAK_THRESHOLD_BYTES);
});

// ============================================================
// 3. 大量データ耐性
// ============================================================

test.describe("B11-3: 大量データ耐性", () => {
  /**
   * 1000件の planned_meals をモックして /menus/weekly を描画し、
   * ページが 10 秒以内に応答することを確認する。
   * ページネーション / 仮想スクロールが無い場合は描画が重くなる。
   */
  test("1000件の planned_meals — /menus/weekly が 10秒以内に描画される", async ({
    authedPage,
  }) => {
    // 1000件分のダミーデータ
    const meals = Array.from({ length: 1000 }, (_, i) => ({
      id: `meal-${i}`,
      day_date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      meal_type: ["breakfast", "lunch", "dinner"][i % 3],
      dish_name: `テスト料理 ${i}`,
      calories: 500 + (i % 300),
      mode: "cook",
      is_completed: false,
    }));

    // API をモックして大量データを注入
    await authedPage.route("**/api/meals/daily*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          dailyMeals: meals.slice(0, 7),
          plannedMeals: meals,
          total: meals.length,
        }),
      });
    });

    const start = Date.now();
    await authedPage.goto("/menus/weekly", { waitUntil: "domcontentloaded" });

    // ページが 10 秒以内に主要コンテンツを表示すること
    try {
      await authedPage.waitForSelector("main, [data-testid], h1, h2", { timeout: 10_000 });
    } catch {
      // セレクタが見つからなくても描画時間を記録
    }
    const elapsed = Date.now() - start;

    console.log(`[B11-3] 1000件 planned_meals — 描画時間: ${elapsed}ms`);

    expect(
      elapsed,
      `1000件の planned_meals がある状態で /menus/weekly の描画が 10秒を超えています (実測: ${elapsed}ms)` +
        " — ページネーションまたは仮想スクロールの実装が推奨されます",
    ).toBeLessThan(10_000);
  });

  /**
   * 500件の health_records をモックして /health/graphs を描画し、
   * ページが 10 秒以内に応答することを確認する。
   */
  test("500件の health_records — /health/graphs が 10秒以内に描画される", async ({
    authedPage,
  }) => {
    const records = Array.from({ length: 500 }, (_, i) => ({
      id: `record-${i}`,
      record_date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      weight: 60 + (i % 10) * 0.5,
      body_fat_percentage: 20 + (i % 5),
      systolic_bp: 120 + (i % 10),
      diastolic_bp: 80 + (i % 8),
      sleep_hours: 6 + (i % 3),
    }));

    await authedPage.route("**/api/health/records*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ records, total: records.length }),
      });
    });

    const start = Date.now();
    await authedPage.goto("/health/graphs", { waitUntil: "domcontentloaded" });

    try {
      await authedPage.waitForSelector("main, [data-testid], h1, h2, canvas, svg", {
        timeout: 10_000,
      });
    } catch {
      // セレクタが見つからなくても描画時間を記録
    }
    const elapsed = Date.now() - start;

    console.log(`[B11-3] 500件 health_records — 描画時間: ${elapsed}ms`);

    expect(
      elapsed,
      `500件の health_records がある状態で /health/graphs の描画が 10秒を超えています (実測: ${elapsed}ms)` +
        " — データの間引きまたは仮想スクロールが推奨されます",
    ).toBeLessThan(10_000);
  });

  /**
   * ページネーションまたは仮想スクロールの存在を確認する静的チェック。
   * モックデータ 1000件の状態で DOM 要素数が 500 を超えない場合は OK。
   * 超えている場合は「仮想化なし」として警告 Issue を起票する。
   */
  test("B11-3c: /menus/weekly — 仮想スクロールまたはページネーションの存在確認", async ({
    authedPage,
  }) => {
    const meals = Array.from({ length: 100 }, (_, i) => ({
      id: `meal-${i}`,
      day_date: new Date(Date.now() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      meal_type: ["breakfast", "lunch", "dinner"][i % 3],
      dish_name: `料理 ${i}`,
      calories: 500,
      mode: "cook",
      is_completed: false,
    }));

    await authedPage.route("**/api/meals/daily*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ dailyMeals: meals, plannedMeals: meals, total: meals.length }),
      });
    });

    await authedPage.goto("/menus/weekly", { waitUntil: "networkidle" });

    // li / article / [role=listitem] 数が 200 以下であれば仮想化あり or ページネーションありと判断
    const itemCount = await authedPage.evaluate(() => {
      return document.querySelectorAll("li, article, [role='listitem']").length;
    });

    console.log(`[B11-3c] /menus/weekly DOM アイテム数 (100件モック): ${itemCount}`);

    // 100件モック時に 200件以上の DOM 要素があれば無制限レンダリングとみなす
    // 失敗してもテスト全体は止めないが、警告ログで記録する
    if (itemCount > 200) {
      console.warn(
        `[B11-3c][WARN] /menus/weekly に仮想スクロール/ページネーションが存在しない可能性があります` +
          ` (DOM アイテム数: ${itemCount})`,
      );
    }
    // このテストはソフトアサーションのみ — Issue 起票は別途
    // 強制失敗しないが、500件以上は確実に問題として扱う
    expect(itemCount, "DOM アイテム数が異常に多い (仮想化なしの可能性)").toBeLessThan(500);
  });
});

// ============================================================
// 4. 連打耐性
// ============================================================

test.describe("B11-4: 連打耐性", () => {
  /**
   * /home のミール完了トグルを高速連打して API 呼び出し回数を計測する。
   * debounce / throttle がない場合は連打回数と同数の API コールが発生する。
   * 仕様: 100ms 以内の連続クリック 10 回で API 呼び出しが 3 回以下であること。
   */
  test("B11-4a: meal toggle 高速連打 — API 重複呼び出し防止の確認", async ({ authedPage }) => {
    // planned_meals API をモック (チェックボックスがある状態にする)
    const fakeMeals = [
      {
        id: "fake-meal-1",
        meal_type: "breakfast",
        dish_name: "テスト朝食",
        calories: 400,
        is_completed: false,
        mode: "cook",
      },
    ];

    await authedPage.route("**/api/meals/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          meals: fakeMeals,
          summary: { completedCount: 0, totalCount: 1, caloriesConsumed: 0 },
        }),
      });
    });

    // Supabase REST への PATCH/UPDATE リクエストを追跡
    let apiCallCount = 0;
    await authedPage.route("**/rest/v1/planned_meals*", async (route) => {
      if (["PATCH", "POST", "PUT"].includes(route.request().method())) {
        apiCallCount++;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "fake-meal-1", is_completed: true }]),
      });
    });

    await authedPage.goto("/home", { waitUntil: "networkidle" });

    // 食事トグルボタンを探す (data-testid または aria-label で判断)
    const toggleSelectors = [
      '[data-testid="meal-toggle-breakfast"]',
      '[data-testid="meal-toggle-lunch"]',
      '[data-testid="meal-toggle-dinner"]',
      '[aria-label*="complete"], [aria-label*="完了"], [aria-label*="チェック"]',
      'button:has-text("朝食"), button:has-text("昼食"), button:has-text("夕食")',
    ];

    let toggleBtn = null;
    for (const sel of toggleSelectors) {
      const el = authedPage.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        toggleBtn = el;
        break;
      }
    }

    if (!toggleBtn) {
      test.skip(true, "meal toggle ボタンが見つからないため連打テストをスキップ");
      return;
    }

    // 10回高速連打 (各クリック間 20ms)
    const RAPID_CLICK_COUNT = 10;
    apiCallCount = 0; // カウンタリセット

    for (let i = 0; i < RAPID_CLICK_COUNT; i++) {
      await toggleBtn.click({ force: true });
      await authedPage.waitForTimeout(20);
    }

    // 最後の API コールが完了するまで最大 3 秒待機
    await authedPage.waitForTimeout(3000);

    console.log(
      `[B11-4a] 10回連打後の Supabase API 呼び出し回数: ${apiCallCount}` +
        ` (debounce/throttle がある場合は 3回以下が望ましい)`,
    );

    // debounce/throttle がない場合は 10回呼ばれる → これが Bug
    // 3回以下を許容閾値とする
    expect(
      apiCallCount,
      `meal toggle を 10回高速連打した際に Supabase API が ${apiCallCount}回呼ばれました。` +
        " debounce / throttle がないため DB への重複リクエストが発生しています。",
    ).toBeLessThanOrEqual(3);
  });

  /**
   * /settings の「データエクスポート」ボタン連打で API が複数回呼ばれないか確認。
   * disabled フラグで防御されているか検証する。
   */
  test("B11-4b: settings エクスポートボタン連打 — disabled による防御の確認", async ({
    authedPage,
  }) => {
    let exportCallCount = 0;

    await authedPage.route("**/api/account/export*", async (route) => {
      exportCallCount++;
      // 意図的に遅延させて連打の影響を計測
      await new Promise((r) => setTimeout(r, 500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exported: true }),
      });
    });

    await authedPage.goto("/settings", { waitUntil: "networkidle" });

    // エクスポートボタンを探す
    const exportBtn = authedPage.locator(
      'button:has-text("エクスポート"), button:has-text("export"), [data-testid*="export"]',
    ).first();

    if (!(await exportBtn.isVisible().catch(() => false))) {
      test.skip(true, "エクスポートボタンが見つからないためスキップ");
      return;
    }

    exportCallCount = 0;

    // 10回高速クリック
    for (let i = 0; i < 10; i++) {
      await exportBtn.click({ force: true });
      await authedPage.waitForTimeout(30);
    }

    await authedPage.waitForTimeout(2000);

    console.log(`[B11-4b] エクスポートボタン 10回連打後の API 呼び出し: ${exportCallCount}回`);

    // disabled で防御されているなら 1回のみ
    expect(
      exportCallCount,
      `エクスポートボタンを 10回連打した際に API が ${exportCallCount}回呼ばれました。` +
        " disabled による防御が機能していない可能性があります。",
    ).toBeLessThanOrEqual(2);
  });
});

// ============================================================
// 5. Bundle サイズ
// ============================================================

test("B11-5: 初回 JS ロードサイズ — /home ページの JS 転送量", async ({ authedPage }) => {
  // ネットワークリクエストを監視
  let totalJsBytes = 0;
  const jsResources: { url: string; size: number }[] = [];

  authedPage.on("response", async (response) => {
    const url = response.url();
    const contentType = response.headers()["content-type"] ?? "";
    if (
      contentType.includes("javascript") ||
      url.includes(".js") ||
      url.includes("/_next/static/chunks/")
    ) {
      try {
        const body = await response.body().catch(() => null);
        if (body) {
          totalJsBytes += body.length;
          jsResources.push({ url, size: body.length });
        }
      } catch {
        // ignore
      }
    }
  });

  await authedPage.goto("/home", { waitUntil: "networkidle" });
  await authedPage.waitForTimeout(2000);

  console.log(`[B11-5] 総 JS 転送量: ${(totalJsBytes / 1024).toFixed(1)} KB`);
  console.log(
    `[B11-5] 上位 5 JS チャンク:\n` +
      jsResources
        .sort((a, b) => b.size - a.size)
        .slice(0, 5)
        .map((r) => `  ${(r.size / 1024).toFixed(1)}KB — ${r.url.split("/").slice(-2).join("/")}`)
        .join("\n"),
  );

  expect(
    totalJsBytes,
    `/home ページの初回 JS ロードが ${(JS_SIZE_WARN_BYTES / 1024).toFixed(0)}KB を超えています` +
      ` (実測: ${(totalJsBytes / 1024).toFixed(1)}KB)` +
      " — dynamic import / code splitting の導入を検討してください",
  ).toBeLessThan(JS_SIZE_WARN_BYTES);
});

// ============================================================
// 6. 画像最適化
// ============================================================

test.describe("B11-6: 画像最適化", () => {
  /**
   * /menus/weekly で <img> タグ (next/image ではなく生の img) が
   * loading="lazy" 属性なしで使われていないか確認する。
   */
  test("B11-6a: /menus/weekly — <img> タグに loading=lazy が設定されているか", async ({
    authedPage,
  }) => {
    await authedPage.goto("/menus/weekly", { waitUntil: "networkidle" });

    const result = await authedPage.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      const withoutLazy = imgs.filter(
        (img) =>
          img.loading !== "lazy" &&
          !img.closest("[data-nimg]") && // next/image は data-nimg を付ける
          img.src && // src がある (データ URI や空は除外)
          !img.src.startsWith("data:"), // inline base64 は除外
      );
      return {
        total: imgs.length,
        withoutLazy: withoutLazy.map((img) => ({
          src: img.src.slice(0, 100),
          loading: img.loading,
          isNextImage: img.hasAttribute("data-nimg"),
        })),
      };
    });

    console.log(
      `[B11-6a] /menus/weekly — img 要素数: ${result.total}, lazy なし: ${result.withoutLazy.length}`,
    );
    if (result.withoutLazy.length > 0) {
      console.log(
        "[B11-6a] lazy なし img:\n" +
          result.withoutLazy.map((i) => `  ${i.src}`).join("\n"),
      );
    }

    expect(
      result.withoutLazy.length,
      `/menus/weekly に loading="lazy" なしの <img> が ${result.withoutLazy.length} 個あります。` +
        " next/image に置き換えるか loading='lazy' を追加してください。",
    ).toBe(0);
  });

  /**
   * /menus/weekly の食事画像が WebP または AVIF 形式で配信されているか確認する。
   * next/image を使っていれば自動で最適化されるが、生 <img> は確認が必要。
   */
  test("B11-6b: 画像リソースが WebP/AVIF 形式で配信されているか", async ({ authedPage }) => {
    const nonOptimizedImages: { url: string; contentType: string }[] = [];

    authedPage.on("response", async (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] ?? "";
      if (
        contentType.startsWith("image/") &&
        !contentType.includes("webp") &&
        !contentType.includes("avif") &&
        !contentType.includes("svg") &&
        !contentType.includes("gif") && // アニメーション GIF は除外
        !url.includes("/_next/static/") // next.js 内部アセットは除外
      ) {
        nonOptimizedImages.push({ url, contentType });
      }
    });

    await authedPage.goto("/menus/weekly", { waitUntil: "networkidle" });
    await authedPage.waitForTimeout(2000);

    console.log(
      `[B11-6b] 非最適化画像 (WebP/AVIF 以外): ${nonOptimizedImages.length}件`,
    );
    nonOptimizedImages.forEach((img) => {
      console.log(`  [${img.contentType}] ${img.url.slice(0, 120)}`);
    });

    expect(
      nonOptimizedImages.length,
      `/menus/weekly で WebP/AVIF 以外のフォーマットで配信されている画像が` +
        ` ${nonOptimizedImages.length} 件あります。` +
        " next/image を使うか、CDN での WebP 変換を設定してください。",
    ).toBe(0);
  });

  /**
   * next/image の使用状況確認。
   * data-nimg 属性付きの img と生 img の比率を記録する。
   */
  test("B11-6c: /menus/weekly — next/image 使用率の確認", async ({ authedPage }) => {
    await authedPage.goto("/menus/weekly", { waitUntil: "networkidle" });

    const imageStats = await authedPage.evaluate(() => {
      const allImgs = Array.from(document.querySelectorAll("img"));
      const nextImgs = allImgs.filter((img) => img.hasAttribute("data-nimg"));
      const rawImgs = allImgs.filter(
        (img) => !img.hasAttribute("data-nimg") && !img.src.startsWith("data:"),
      );
      return {
        total: allImgs.length,
        nextImage: nextImgs.length,
        rawImg: rawImgs.length,
        rawSrcs: rawImgs.map((img) => img.src.slice(0, 100)),
      };
    });

    console.log(
      `[B11-6c] /menus/weekly — 全 img: ${imageStats.total}, next/image: ${imageStats.nextImage}, 生 img: ${imageStats.rawImg}`,
    );
    if (imageStats.rawSrcs.length > 0) {
      console.log("[B11-6c] 生 img の src:\n" + imageStats.rawSrcs.map((s) => `  ${s}`).join("\n"));
    }

    // 生 img が 0 であることが理想。それ以外は警告として記録
    if (imageStats.rawImg > 0) {
      console.warn(
        `[B11-6c][WARN] ${imageStats.rawImg} 個の生 <img> タグが使われています。` +
          " next/image への移行を検討してください。",
      );
    }

    // 強制失敗は B11-6a が担うが、確認のため記録値を残す
    // 今回は情報収集のみ — 0 でなくても fail させない (ソフトアサーション)
    expect(imageStats.total).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================

/**
 * ビルド済みページの HTTP ヘッダーで gzip/Brotli 圧縮を確認する。
=======
// 7. next.config.mjs — 設定確認 (静的解析相当)
// ============================================================

/**
 * next.config.mjs に bundle analyzer / compress 設定が存在するか確認する。
 * 実際のファイルは spec 内では読めないため、
 * ビルド済みページの HTTP ヘッダーで確認する。
 */
test("B11-7: HTTP レスポンスの Content-Encoding — gzip/br 圧縮の確認", async ({
  authedPage,
}) => {
  const response = await authedPage.goto("/home", { waitUntil: "domcontentloaded" });
  const encoding = response?.headers()["content-encoding"] ?? "";

  console.log(`[B11-7] /home Content-Encoding: "${encoding}"`);

  // gzip または br (Brotli) 圧縮が有効であること
  // Vercel は通常 br を返すが、ローカル dev では無い場合もある
  const isCompressed = encoding.includes("gzip") || encoding.includes("br");

  if (!isCompressed) {
    console.warn(
      "[B11-7][WARN] /home のレスポンスに gzip/Brotli 圧縮が設定されていません。" +
        " Vercel 本番環境では通常有効ですが、設定を確認してください。",
    );
  }

  // 本番 (Vercel) では必須。ローカルでは skip。
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "";
  if (baseUrl.includes("vercel.app") || baseUrl.includes("homegohan")) {
    expect(
      isCompressed,
      "本番環境 (Vercel) でレスポンス圧縮 (gzip/br) が有効ではありません。",
    ).toBe(true);
  } else {
    // ローカルでは情報のみ
    console.log("[B11-7] ローカル環境のため圧縮チェックはスキップ");
  }
});
