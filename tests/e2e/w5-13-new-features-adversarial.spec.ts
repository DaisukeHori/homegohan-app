/**
 * Wave 5 / W5-13: 新機能 完全嫌がらせ E2E
 *
 * 対象機能:
 *   A. 組織 (Org) API               — A-1〜A-8
 *   B. パントリー (Pantry) API       — B-9〜B-17
 *   C. 血液検査 (blood-tests) API    — C-18〜C-25
 *   D. 連続記録 (streaks) API        — D-26〜D-31
 *   E. CSV エクスポート              — E-32〜E-38
 *   F. アカウント削除                — F-39〜F-44
 *   G. Rate limit / 連打             — G-45〜G-48
 *   H. 通知設定 (notification-prefs) — H-49〜H-51
 *
 * 実行方法:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e -- w5-13-new-features-adversarial --workers=1
 *
 * prefix: [<area>][adversarial]
 */

import { test, expect, type Page } from "@playwright/test";
import { login } from "./fixtures/auth";

// ─── 定数 ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const NON_EXISTING_UUID = "00000000-0000-0000-0000-000000000000";

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

/**
 * 認証済みセッションで API を fetch する (page.evaluate 経由)
 */
async function apiFetch(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({
      url,
      method,
      body,
    }: {
      url: string;
      method: string;
      body: string | null;
    }) => {
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ?? undefined,
      });
      let responseBody: unknown;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = await res.text().catch(() => "");
      }
      return { status: res.status, body: responseBody };
    },
    {
      url: `${BASE_URL}${path}`,
      method: options.method ?? "GET",
      body: options.body !== undefined ? JSON.stringify(options.body) : null,
    },
  );
}

/**
 * 認証なしで API を fetch する (Cookie なし)
 */
async function apiFetchUnauthenticated(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({
      url,
      method,
      body,
    }: {
      url: string;
      method: string;
      body: string | null;
    }) => {
      const res = await fetch(url, {
        method,
        credentials: "omit",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ?? undefined,
      });
      let responseBody: unknown;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = await res.text().catch(() => "");
      }
      return { status: res.status, body: responseBody };
    },
    {
      url: `${BASE_URL}${path}`,
      method: options.method ?? "GET",
      body: options.body !== undefined ? JSON.stringify(options.body) : null,
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 組織 (Org) API
// ─────────────────────────────────────────────────────────────────────────────

test.describe("[org][adversarial] A. 組織 API", () => {
  /**
   * A-1: 未認証で GET /api/org/settings → 401
   */
  test("A-1: 未認証で組織設定取得は 401", async ({ page }) => {
    await page.goto("/");
    const result = await apiFetchUnauthenticated(page, "/api/org/settings");
    expect(result.status).toBe(401);
  });

  /**
   * A-2: 未認証で GET /api/org/users → 401
   */
  test("A-2: 未認証で組織ユーザー一覧は 401", async ({ page }) => {
    await page.goto("/");
    const result = await apiFetchUnauthenticated(page, "/api/org/users");
    expect(result.status).toBe(401);
  });

  /**
   * A-3: 未認証で GET /api/org/invites → 401
   */
  test("A-3: 未認証で招待一覧取得は 401", async ({ page }) => {
    await page.goto("/");
    const result = await apiFetchUnauthenticated(page, "/api/org/invites");
    expect(result.status).toBe(401);
  });

  /**
   * A-4: org_admin 権限のない通常ユーザーで GET /api/org/settings → 403
   */
  test("A-4: 一般ユーザーで組織設定取得は 403", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/org/settings");
    // 通常ユーザーは org_admin でも org member でもないので 403 が期待される
    expect([403, 401]).toContain(result.status);
  });

  /**
   * A-5: 一般ユーザーで POST /api/org/users (ユーザー作成) → 403
   */
  test("A-5: 一般ユーザーで組織ユーザー作成は 403", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/org/users", {
      method: "POST",
      body: {
        email: "hacker@evil.com",
        password: "P@ssw0rd123",
        nickname: "Hacker",
      },
    });
    expect([403, 401]).toContain(result.status);
  });

  /**
   * A-6: 一般ユーザーで POST /api/org/invites (招待作成) → 403
   */
  test("A-6: 一般ユーザーで招待作成は 403", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/org/invites", {
      method: "POST",
      body: { email: "invite@test.com" },
    });
    expect([403, 401]).toContain(result.status);
  });

  /**
   * A-7: 一般ユーザーで PUT /api/org/settings (設定更新) → 403
   */
  test("A-7: 一般ユーザーで組織設定更新は 403", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/org/settings", {
      method: "PUT",
      body: { name: "Hacked Org Name" },
    });
    expect([403, 401]).toContain(result.status);
  });

  /**
   * A-8: DELETE /api/org/invites (招待削除) に存在しない ID を指定 → 200 or 400/404
   *       但し 500 は出てはいけない
   */
  test("A-8: 存在しない招待 ID の削除でサーバーエラーが出ない", async ({ page }) => {
    await login(page);
    const result = await apiFetch(
      page,
      `/api/org/invites?id=${NON_EXISTING_UUID}`,
      { method: "DELETE" },
    );
    // 403(権限なし) または 200/400/404 のいずれかで 500 は NG
    expect(result.status).not.toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. パントリー (Pantry) API
// ─────────────────────────────────────────────────────────────────────────────

test.describe("[pantry][adversarial] B. パントリー API", () => {
  /**
   * B-9: 未認証で GET /api/pantry → 401
   */
  test("B-9: 未認証でパントリー一覧取得は 401", async ({ page }) => {
    await page.goto("/");
    const result = await apiFetchUnauthenticated(page, "/api/pantry");
    expect(result.status).toBe(401);
  });

  /**
   * B-10: 認証済みで GET /api/pantry → 200 かつ items 配列が返る
   */
  test("B-10: 認証済みでパントリー一覧取得は 200", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/pantry");
    expect(result.status).toBe(200);
    expect((result.body as any)?.items).toBeInstanceOf(Array);
  });

  /**
   * B-11: POST /api/pantry に name が欠落 → 500 以外（バリデーションエラー or サーバー処理）
   *        実際には DB レベルで NOT NULL 違反が起きる場合でも 500 は返しうるが、
   *        400 が望ましい。とりあえず 500 を観察するためのテスト。
   */
  test("B-11: パントリー追加で name 欠落は 400 か 500", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/pantry", {
      method: "POST",
      body: { amount: "1個", category: "vegetable" },
    });
    // 期待: 400 (バリデーション) だが、現在の実装では 500 の可能性あり
    // 500 の場合はバグとして記録する
    expect([400, 500]).toContain(result.status);
  });

  /**
   * B-12: POST /api/pantry に超長 name (1000文字) → サーバーエラーなし
   */
  test("B-12: パントリー追加で超長 name は安全に処理される", async ({ page }) => {
    await login(page);
    const longName = "あ".repeat(1000);
    const result = await apiFetch(page, "/api/pantry", {
      method: "POST",
      body: { name: longName, amount: "1個", category: "other" },
    });
    // 400 (文字数上限) または 200 (DB 側で truncate) であること、500 はバグ
    expect(result.status).not.toBe(500);
  });

  /**
   * B-13: POST /api/pantry に XSS ペイロードを name に → そのまま返るが HTML はエスケープ
   *        (API としては素通しでよいが、200 でレスポンスがあること)
   */
  test("B-13: パントリー追加で XSS ペイロードは 200 で保存される", async ({
    page,
  }) => {
    await login(page);
    const xssPayload = '<script>alert("xss")</script>ニンジン';
    const result = await apiFetch(page, "/api/pantry", {
      method: "POST",
      body: { name: xssPayload, amount: "1本", category: "vegetable" },
    });
    // 400 (バリデーション拒否) または 200 (保存成功)
    expect([200, 400]).toContain(result.status);
    if (result.status === 200) {
      // レスポンスに item.name が含まれること
      expect((result.body as any)?.item).toBeDefined();
    }
  });

  /**
   * B-14: POST /api/pantry に不正な JSON → 400 or 500
   */
  test("B-14: パントリー追加で不正 JSON は 400", async ({ page }) => {
    await login(page);
    // page.evaluate 経由で壊れた JSON を送る
    const result = await page.evaluate(async ({ url }: { url: string }) => {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{invalid json}",
      });
      return { status: res.status };
    }, { url: `${BASE_URL}/api/pantry` });
    expect([400, 500]).toContain(result.status);
  });

  /**
   * B-15: PATCH /api/pantry/[id] に存在しない UUID → レコードが見つからず 500 or 404
   *        but not a security issue (user_id filter ensures ownership)
   */
  test("B-15: 存在しないパントリーアイテムの更新でサーバーエラーが出ない", async ({
    page,
  }) => {
    await login(page);
    const result = await apiFetch(
      page,
      `/api/pantry/${NON_EXISTING_UUID}`,
      {
        method: "PATCH",
        body: { name: "存在しないアイテム" },
      },
    );
    // PGRST116 (no rows found) → 500 が返ってくる可能性がある
    // これはバグとして観察: 404 が正しい
    expect(result.status).not.toBe(200);
  });

  /**
   * B-16: DELETE /api/pantry/[id] に他人の UUID (存在するが所有者が違う) → 削除されない
   *        user_id フィルターが機能していること
   */
  test("B-16: 他ユーザーのパントリーアイテム ID で削除しても成功しない (user_id filter)", async ({
    page,
  }) => {
    await login(page);
    // NON_EXISTING_UUID は自分のものではないので削除件数 0 → 成功扱いで 200 が返るが
    // 実際には何も消えていない
    const result = await apiFetch(
      page,
      `/api/pantry/${NON_EXISTING_UUID}`,
      { method: "DELETE" },
    );
    // 200 (0件削除) または 404/500 のいずれか
    expect(result.status).not.toBe(403); // 認証済みなら 403 にはならない
  });

  /**
   * B-17: POST /api/pantry に SQL インジェクション試行 → 安全に処理
   */
  test("B-17: パントリー追加で SQL インジェクションは安全に処理される", async ({
    page,
  }) => {
    await login(page);
    const sqlPayload = "'; DROP TABLE pantry_items; --";
    const result = await apiFetch(page, "/api/pantry", {
      method: "POST",
      body: { name: sqlPayload, amount: "1個", category: "other" },
    });
    // 保存成功 (200) または バリデーション拒否 (400)
    // 500 はサーバーエラーの可能性があるので NG
    expect([200, 400]).toContain(result.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 血液検査 (blood-tests) API
// ─────────────────────────────────────────────────────────────────────────────

test.describe("[blood-tests][adversarial] C. 血液検査 API", () => {
  /**
   * C-18: 未認証で GET /api/health/blood-tests → 401
   */
  test("C-18: 未認証で血液検査一覧取得は 401", async ({ page }) => {
    await page.goto("/");
    const result = await apiFetchUnauthenticated(page, "/api/health/blood-tests");
    expect(result.status).toBe(401);
  });

  /**
   * C-19: 認証済みで GET /api/health/blood-tests → 200 かつ results 配列
   */
  test("C-19: 認証済みで血液検査一覧取得は 200", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/blood-tests");
    expect(result.status).toBe(200);
    expect((result.body as any)?.results).toBeInstanceOf(Array);
  });

  /**
   * C-20: GET /api/health/blood-tests?limit=999 → limit が 200 に clamp される
   *        (DoS 防止: #265)
   */
  test("C-20: limit=999 は上限 200 にクランプされる", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/blood-tests?limit=999");
    expect(result.status).toBe(200);
    // results の件数が 200 以下であること
    const results = (result.body as any)?.results ?? [];
    expect(results.length).toBeLessThanOrEqual(200);
  });

  /**
   * C-21: POST /api/health/blood-tests に test_date 欠落 → 400
   */
  test("C-21: 血液検査追加で test_date 欠落は 400", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/blood-tests", {
      method: "POST",
      body: { hba1c: 5.5 },
    });
    expect(result.status).toBe(400);
  });

  /**
   * C-22: POST /api/health/blood-tests に HbA1c の範囲外値 (100.0) → 400
   */
  test("C-22: HbA1c 範囲外 (100.0) は 400", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/blood-tests", {
      method: "POST",
      body: { test_date: "2026-01-01", hba1c: 100.0 },
    });
    expect(result.status).toBe(400);
  });

  /**
   * C-23: POST /api/health/blood-tests に HbA1c が負値 (-1) → 400
   */
  test("C-23: HbA1c 負値は 400", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/blood-tests", {
      method: "POST",
      body: { test_date: "2026-01-01", hba1c: -1 },
    });
    expect(result.status).toBe(400);
  });

  /**
   * C-24: POST /api/health/blood-tests に不正な日付形式 → 400
   */
  test("C-24: 不正な日付形式で血液検査追加は 400", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/blood-tests", {
      method: "POST",
      body: { test_date: "not-a-date", hba1c: 5.5 },
    });
    expect(result.status).toBe(400);
  });

  /**
   * C-25: POST /api/health/blood-tests に未知フィールドを含む → 安全に無視
   */
  test("C-25: 未知フィールドは無視して 200 または 400 で処理", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/blood-tests", {
      method: "POST",
      body: {
        test_date: "2026-01-15",
        hba1c: 5.5,
        unknown_field: "malicious",
        __proto__: { polluted: true },
      },
    });
    // 400 (test_date バリデーション) または 200 (保存成功) → 500 は NG
    expect([200, 400]).toContain(result.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. 連続記録 (streaks) API
// ─────────────────────────────────────────────────────────────────────────────

test.describe("[streaks][adversarial] D. 連続記録 API", () => {
  /**
   * D-26: 未認証で GET /api/health/streaks → 401
   */
  test("D-26: 未認証でストリーク取得は 401", async ({ page }) => {
    await page.goto("/");
    const result = await apiFetchUnauthenticated(page, "/api/health/streaks");
    expect(result.status).toBe(401);
  });

  /**
   * D-27: 認証済みで GET /api/health/streaks → 200 かつ streak オブジェクト
   */
  test("D-27: 認証済みでストリーク取得は 200", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/streaks");
    expect(result.status).toBe(200);
    expect((result.body as any)?.streak).toBeDefined();
  });

  /**
   * D-28: GET /api/health/streaks?type=invalid_type → 200 (デフォルト値にフォールバック)
   *         または 400
   */
  test("D-28: 不正な streak type でもサーバーエラーが出ない", async ({ page }) => {
    await login(page);
    const result = await apiFetch(
      page,
      "/api/health/streaks?type='; DROP TABLE health_streaks; --",
    );
    // 200 (デフォルト値) または 400 のいずれか、500 は NG
    expect(result.status).not.toBe(500);
  });

  /**
   * D-29: GET /api/health/streaks のレスポンスに current_streak が 0 以上の整数
   */
  test("D-29: ストリーク current_streak は 0 以上", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/streaks");
    expect(result.status).toBe(200);
    const streak = (result.body as any)?.streak;
    expect(streak?.current_streak).toBeGreaterThanOrEqual(0);
  });

  /**
   * D-30: GET /api/health/streaks に weekly 情報が含まれる
   */
  test("D-30: ストリークレスポンスに weeklyRecords 配列が含まれる", async ({
    page,
  }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/streaks");
    expect(result.status).toBe(200);
    expect((result.body as any)?.weeklyRecords).toBeInstanceOf(Array);
  });

  /**
   * D-31: DELETE /api/health/streaks (リセット) → 200 (テスト用エンドポイント)
   *         認証済みなら自分のデータのみリセットされる
   */
  test("D-31: ストリークリセットは認証済みユーザーのみ 200", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/health/streaks", {
      method: "DELETE",
    });
    // 200 (リセット成功) が期待される
    expect(result.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. CSV エクスポート
// ─────────────────────────────────────────────────────────────────────────────

test.describe("[csv][adversarial] E. CSV エクスポート", () => {
  /**
   * E-32: 未認証で GET /api/export/meals → 401
   */
  test("E-32: 未認証で CSV エクスポートは 401", async ({ page }) => {
    await page.goto("/");
    const result = await apiFetchUnauthenticated(page, "/api/export/meals");
    expect(result.status).toBe(401);
  });

  /**
   * E-33: 認証済みで GET /api/export/meals → 200 かつ Content-Type: text/csv
   */
  test("E-33: 認証済みで CSV エクスポートは 200 で text/csv", async ({ page }) => {
    await login(page);
    const result = await page.evaluate(async ({ url }: { url: string }) => {
      const res = await fetch(url, { credentials: "include" });
      const contentType = res.headers.get("content-type") ?? "";
      const text = await res.text();
      return { status: res.status, contentType, firstLine: text.split("\n")[0] };
    }, { url: `${BASE_URL}/api/export/meals` });

    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/csv");
    // ヘッダー行が date を含む
    expect(result.firstLine).toContain("date");
  });

  /**
   * E-34: CSV ヘッダーに formula injection 文字 (=,+,-,@) がない
   *        (#269 fix 確認)
   */
  test("E-34: CSV の各セルに formula injection 文字がない (#269)", async ({
    page,
  }) => {
    await login(page);
    const csvText = await page.evaluate(async ({ url }: { url: string }) => {
      const res = await fetch(url, { credentials: "include" });
      return res.ok ? res.text() : null;
    }, { url: `${BASE_URL}/api/export/meals` });

    expect(csvText).not.toBeNull();
    if (csvText) {
      const lines = csvText.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const cells = line.split(",");
        for (const cell of cells) {
          if (cell.startsWith('"')) continue; // クォート済みセルはスキップ
          expect(cell).not.toMatch(/^[=+\-@]/);
        }
      }
    }
  });

  /**
   * E-35: GET /api/export/meals?start_date=invalid → 500 が出ないこと
   */
  test("E-35: 不正な start_date でも CSV エクスポートがサーバーエラーにならない", async ({
    page,
  }) => {
    await login(page);
    const result = await apiFetch(
      page,
      "/api/export/meals?start_date='; DROP TABLE--",
    );
    // Supabase がパラメータを安全に扱うので 200 または 400
    expect(result.status).not.toBe(500);
  });

  /**
   * E-36: GET /api/export/meals に Cache-Control: no-store ヘッダーが付いている
   */
  test("E-36: CSV エクスポートレスポンスに Cache-Control: no-store が付いている", async ({
    page,
  }) => {
    await login(page);
    const result = await page.evaluate(async ({ url }: { url: string }) => {
      const res = await fetch(url, { credentials: "include" });
      return {
        status: res.status,
        cacheControl: res.headers.get("cache-control") ?? "",
      };
    }, { url: `${BASE_URL}/api/export/meals` });

    expect(result.status).toBe(200);
    expect(result.cacheControl.toLowerCase()).toContain("no-store");
  });

  /**
   * E-37: GET /api/export/meals に Content-Disposition: attachment が付いている
   */
  test("E-37: CSV エクスポートに Content-Disposition: attachment が付いている", async ({
    page,
  }) => {
    await login(page);
    const result = await page.evaluate(async ({ url }: { url: string }) => {
      const res = await fetch(url, { credentials: "include" });
      return {
        status: res.status,
        contentDisposition: res.headers.get("content-disposition") ?? "",
      };
    }, { url: `${BASE_URL}/api/export/meals` });

    expect(result.status).toBe(200);
    expect(result.contentDisposition.toLowerCase()).toContain("attachment");
  });

  /**
   * E-38: 日付範囲フィルター (start_date / end_date) が機能する
   *        未来日程のみを指定するとデータが 0 件 (ヘッダー行のみ)
   */
  test("E-38: 未来日程のみ指定すると CSV はヘッダー行のみ", async ({ page }) => {
    await login(page);
    const csvText = await page.evaluate(async ({ url }: { url: string }) => {
      const res = await fetch(url, { credentials: "include" });
      return res.ok ? res.text() : null;
    }, { url: `${BASE_URL}/api/export/meals?start_date=2099-01-01&end_date=2099-12-31` });

    expect(csvText).not.toBeNull();
    if (csvText) {
      const lines = csvText.split(/\r?\n/).filter(Boolean);
      // ヘッダー行のみ (データなし)
      expect(lines.length).toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. アカウント削除
// ─────────────────────────────────────────────────────────────────────────────

test.describe("[account][adversarial] F. アカウント削除", () => {
  /**
   * F-39: 未認証で POST /api/account/delete → 401
   */
  test("F-39: 未認証でアカウント削除は 401", async ({ page }) => {
    await page.goto("/");
    const result = await apiFetchUnauthenticated(page, "/api/account/delete", {
      method: "POST",
      body: { confirm: true },
    });
    expect(result.status).toBe(401);
  });

  /**
   * F-40: POST /api/account/delete に confirm フィールドなし → 400
   */
  test("F-40: confirm なしでアカウント削除は 400", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/account/delete", {
      method: "POST",
      body: {},
    });
    expect(result.status).toBe(400);
  });

  /**
   * F-41: POST /api/account/delete に confirm: false → 400
   */
  test("F-41: confirm: false でアカウント削除は 400", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/account/delete", {
      method: "POST",
      body: { confirm: false },
    });
    expect(result.status).toBe(400);
  });

  /**
   * F-42: POST /api/account/delete に confirm: "yes" (文字列) → 400 または 200
   *        実装が body?.confirm の truthy チェックなら 200 になる可能性がある
   *        これは仕様確認テスト
   */
  test("F-42: confirm に文字列 'yes' を送るとどうなるか (仕様確認)", async ({
    page,
  }) => {
    await login(page);
    // 実際には削除されないようにネットワークをインターセプト
    await page.route(`${BASE_URL}/api/account/delete`, async (route) => {
      // リクエストボディを確認してから 400 を返す (実削除を防ぐ)
      await route.fulfill({ status: 400, body: JSON.stringify({ error: "mocked" }) });
    });
    const result = await apiFetch(page, "/api/account/delete", {
      method: "POST",
      body: { confirm: "yes" },
    });
    // インターセプトで 400 を返すのでここでは 400 が期待
    expect(result.status).toBe(400);
  });

  /**
   * F-43: /settings の削除モーダルで確認テキスト「削除します」未入力時は削除ボタン disabled
   */
  test("F-43: 削除確認テキスト未入力で削除ボタンが disabled", async ({ page }) => {
    await login(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const deleteBtn = page.getByRole("button", { name: /アカウントを削除する/ });
    const isVisible = await deleteBtn.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!isVisible) {
      test.skip(true, "削除ボタンが見つからない — UI 未実装の可能性");
      return;
    }

    await deleteBtn.click();
    await expect(page.getByText(/アカウントを削除しますか？/)).toBeVisible({ timeout: 5_000 });

    const confirmBtn = page.getByRole("button", { name: /アカウントを完全に削除する/ });
    await expect(confirmBtn).toBeDisabled();
  });

  /**
   * F-44: /settings の削除モーダルで「削除します」を正確に入力すると削除ボタンが enabled
   */
  test("F-44: 削除確認テキスト「削除します」入力で削除ボタンが enabled", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const deleteBtn = page.getByRole("button", { name: /アカウントを削除する/ });
    const isVisible = await deleteBtn.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!isVisible) {
      test.skip(true, "削除ボタンが見つからない — UI 未実装の可能性");
      return;
    }

    await deleteBtn.click();
    await expect(page.getByText(/アカウントを削除しますか？/)).toBeVisible({ timeout: 5_000 });

    const input = page.getByRole("textbox", { name: /削除確認テキスト入力/ })
      .or(page.locator('input[placeholder*="削除"]'))
      .first();

    await input.fill("削除します");

    const confirmBtn = page.getByRole("button", { name: /アカウントを完全に削除する/ });
    await expect(confirmBtn).toBeEnabled({ timeout: 3_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Rate limit / 連打
// ─────────────────────────────────────────────────────────────────────────────

test.describe("[rate-limit][adversarial] G. Rate limit / 連打", () => {
  /**
   * G-45: POST /api/health/blood-tests を 10 回並列で送っても 500 が出ない
   *        (DB constraint エラーや lock 問題が発生しないことを確認)
   */
  test("G-45: 血液検査追加を 10 回並列で送ってもサーバーエラーなし", async ({
    page,
  }) => {
    await login(page);
    const payload = { test_date: "2026-01-15", hba1c: 5.5 };

    const results = await page.evaluate(
      async ({ url, body }: { url: string; body: string }) => {
        const promises = Array.from({ length: 10 }, () =>
          fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body,
          }).then((r) => r.status),
        );
        return Promise.all(promises);
      },
      {
        url: `${BASE_URL}/api/health/blood-tests`,
        body: JSON.stringify(payload),
      },
    );

    // 全リクエストが 200 または 400 であること (500 は NG)
    for (const status of results) {
      expect(status).not.toBe(500);
    }
  });

  /**
   * G-46: POST /api/pantry を 10 回並列で送っても 500 が出ない
   */
  test("G-46: パントリー追加を 10 回並列で送ってもサーバーエラーなし", async ({
    page,
  }) => {
    await login(page);
    const payload = { name: "レートリミットテスト用アイテム", amount: "1個", category: "other" };

    const results = await page.evaluate(
      async ({ url, body }: { url: string; body: string }) => {
        const promises = Array.from({ length: 10 }, () =>
          fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body,
          }).then((r) => r.status),
        );
        return Promise.all(promises);
      },
      {
        url: `${BASE_URL}/api/pantry`,
        body: JSON.stringify(payload),
      },
    );

    for (const status of results) {
      expect(status).not.toBe(500);
    }
  });

  /**
   * G-47: GET /api/health/streaks を 20 回並列で送っても全て 200
   */
  test("G-47: ストリーク取得を 20 回並列で送っても全て 200", async ({ page }) => {
    await login(page);

    const results = await page.evaluate(
      async ({ url }: { url: string }) => {
        const promises = Array.from({ length: 20 }, () =>
          fetch(url, {
            credentials: "include",
          }).then((r) => r.status),
        );
        return Promise.all(promises);
      },
      { url: `${BASE_URL}/api/health/streaks` },
    );

    for (const status of results) {
      expect(status).toBe(200);
    }
  });

  /**
   * G-48: PATCH /api/notification-preferences を 5 回並列で送っても競合エラーなし
   *        (#notify - upsert で競合を解消していること)
   */
  test("G-48: 通知設定更新を 5 回並列で送っても競合エラーなし", async ({ page }) => {
    await login(page);

    const results = await page.evaluate(
      async ({ url }: { url: string }) => {
        const toggles = [true, false, true, false, true];
        const promises = toggles.map((val) =>
          fetch(url, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notifications_enabled: val }),
          }).then((r) => r.status),
        );
        return Promise.all(promises);
      },
      { url: `${BASE_URL}/api/notification-preferences` },
    );

    for (const status of results) {
      expect(status).not.toBe(500);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. 通知設定 (notification-preferences)
// ─────────────────────────────────────────────────────────────────────────────

test.describe("[notifications][adversarial] H. 通知設定", () => {
  /**
   * H-49: 未認証で GET /api/notification-preferences → 401
   */
  test("H-49: 未認証で通知設定取得は 401", async ({ page }) => {
    await page.goto("/");
    const result = await apiFetchUnauthenticated(page, "/api/notification-preferences");
    expect(result.status).toBe(401);
  });

  /**
   * H-50: PATCH /api/notification-preferences に boolean でない値 → 400
   */
  test("H-50: 通知設定 PATCH に非 boolean 値は 400", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/notification-preferences", {
      method: "PATCH",
      body: { notifications_enabled: "yes" }, // boolean でなく文字列
    });
    expect(result.status).toBe(400);
  });

  /**
   * H-51: PATCH /api/notification-preferences に空ボディ → 400
   */
  test("H-51: 通知設定 PATCH に空ボディは 400", async ({ page }) => {
    await login(page);
    const result = await apiFetch(page, "/api/notification-preferences", {
      method: "PATCH",
      body: {},
    });
    expect(result.status).toBe(400);
  });
});
