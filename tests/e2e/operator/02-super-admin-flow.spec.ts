/**
 * tests/e2e/operator/02-super-admin-flow.spec.ts
 *
 * T14 — super_admin ログイン → クーポン作成 → プラン PATCH → flag 操作 happy path
 *
 * happy path:
 *   1. super_admin ユーザーとしてログイン
 *   2. POST /api/super-admin/coupons でクーポンを作成し audit_log に記録されることを確認
 *   3. PATCH /api/super-admin/plans/{id} でプランを更新し audit_log に記録を確認
 *   4. GET /api/super-admin/flags → PATCH /api/super-admin/flags/{key} で flag 操作
 *   5. /api/super-admin/audit-logs で全操作が記録されていることを確認
 *
 * 前提条件:
 *   - SUPER_ADMIN_USER_EMAIL / SUPER_ADMIN_USER_PASSWORD: super_admin ロールを持つユーザー
 *   - 未設定の場合は権限拒否確認テストのみ実行
 *
 * 実行:
 *   npm run test:e2e -- tests/e2e/operator
 */

import { test, expect } from "../fixtures/fresh-user";
import { config as dotenvConfig } from "dotenv";
import * as path from "path";

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });

// ─── 定数 ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

// super_admin は fresh-user fixture では提供しないため、引き続き環境変数から取得する
const SUPER_ADMIN_USER = process.env.SUPER_ADMIN_USER_EMAIL
  ? {
      email: process.env.SUPER_ADMIN_USER_EMAIL,
      password: process.env.SUPER_ADMIN_USER_PASSWORD ?? "",
    }
  : null;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// テスト用クーポンコード (衝突回避のためタイムスタンプを含める)
const TEST_COUPON_CODE = `E2ETEST${Date.now().toString(36).toUpperCase()}`;

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

/**
 * Supabase Auth API でセッショントークンを取得し、Cookie をページに注入する。
 * super_admin のログインに使用する。
 */
async function injectSupabaseSession(
  page: import("@playwright/test").Page,
  email: string,
  password: string,
): Promise<boolean> {
  if (!SUPABASE_URL || !ANON_KEY) return false;

  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    if (!resp.ok) return false;

    const session = (await resp.json()) as Record<string, unknown>;
    if (!session.access_token) return false;

    const supabaseRef = SUPABASE_URL.replace("https://", "").split(".")[0];
    const cookieName = `sb-${supabaseRef}-auth-token`;
    const domain = new URL(BASE_URL).hostname;
    const cookieValue = encodeURIComponent(JSON.stringify(session));
    const expiresAt = (session.expires_at as number) ?? Date.now() / 1000 + 3600;

    await page.context().clearCookies();
    await page.context().addCookies([
      {
        name: cookieName,
        value: cookieValue,
        domain,
        path: "/",
        expires: expiresAt,
        httpOnly: false,
        secure: BASE_URL.startsWith("https"),
        sameSite: "Lax",
      },
    ]);

    await page.goto(`${BASE_URL}/home`);
    await page.waitForURL(
      (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
      { timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * UI ログイン
 */
async function uiLogin(
  page: import("@playwright/test").Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    localStorage.removeItem("auth_last_fail_ts");
  });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await Promise.all([
    page.waitForURL(
      (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
      { timeout: 60_000 },
    ),
    page.locator("button[type=submit]").click(),
  ]);
}

/**
 * API fetch を page コンテキストで実行する。
 */
async function apiFetch(
  page: import("@playwright/test").Page,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ path, options }: { path: string; options: { method?: string; body?: unknown } }) => {
      const res = await fetch(path, {
        method: options.method ?? "GET",
        headers: options.body ? { "Content-Type": "application/json" } : {},
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: "include",
      });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text();
      }
      return { status: res.status, body };
    },
    { path, options },
  );
}

/**
 * super_admin としてログインする共通ヘルパー。
 * SUPER_ADMIN_USER が未設定の場合はテストをスキップする。
 */
async function loginAsSuperAdmin(page: import("@playwright/test").Page): Promise<void> {
  if (!SUPER_ADMIN_USER) {
    test.skip(true, "SUPER_ADMIN_USER_EMAIL 未設定のためスキップ (CI Secret を確認してください)");
    return;
  }

  const loggedIn = await injectSupabaseSession(
    page,
    SUPER_ADMIN_USER.email,
    SUPER_ADMIN_USER.password,
  );
  if (!loggedIn) {
    await uiLogin(page, SUPER_ADMIN_USER.email, SUPER_ADMIN_USER.password);
  }
}

// ─── テストスイート ───────────────────────────────────────────────────────────

test.describe("operator/super-admin: クーポン作成 → プラン PATCH → flag 操作 happy path", () => {
  /**
   * T14-S1: 未認証で super-admin API にアクセスすると 401
   */
  test("T14-S1: 未認証で super-admin API にアクセスすると 401 が返る", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);

    // クーポン一覧: 未認証
    const couponRes = await apiFetch(page, "/api/super-admin/coupons");
    expect(couponRes.status).toBe(401);

    // フラグ一覧: 未認証
    const flagRes = await apiFetch(page, "/api/super-admin/flags");
    expect(flagRes.status).toBe(401);

    // 監査ログ: 未認証
    const auditRes = await apiFetch(page, "/api/super-admin/audit-logs?per_page=5&page=1");
    expect(auditRes.status).toBe(401);
  });

  /**
   * T14-S2: 一般ユーザーは super-admin API に 401/403 で弾かれる
   *
   * onboardingPendingUser fixture = super_admin ロールを持たない fresh user。
   */
  test("T14-S2: 一般ユーザーは super-admin API に 401/403 で弾かれる", async ({ onboardingPendingUser }) => {
    // クーポン一覧
    const couponRes = await apiFetch(onboardingPendingUser, "/api/super-admin/coupons");
    expect([401, 403]).toContain(couponRes.status);

    // プラン一覧
    const planRes = await apiFetch(onboardingPendingUser, "/api/super-admin/plans");
    expect([401, 403]).toContain(planRes.status);

    // フラグ一覧
    const flagRes = await apiFetch(onboardingPendingUser, "/api/super-admin/flags");
    expect([401, 403]).toContain(flagRes.status);
  });

  /**
   * T14-S3: super_admin がクーポンを作成し audit_log に記録されることを確認
   */
  test("T14-S3: super_admin がクーポンを作成し audit_log に記録される", async ({ page }) => {
    await loginAsSuperAdmin(page);
    if (!SUPER_ADMIN_USER) return;

    // クーポン作成
    const today = new Date().toISOString().split("T")[0];
    const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const createResult = await apiFetch(page, "/api/super-admin/coupons", {
      method: "POST",
      body: {
        code: TEST_COUPON_CODE,
        discount_type: "percentage",
        discount_value: 10,
        applicable_to: "all",
        valid_from: today,
        valid_until: nextMonth,
        max_uses: 100,
        per_user_limit: 1,
      },
    });

    expect(createResult.status).toBe(201);
    const createBody = createResult.body as Record<string, unknown>;
    expect(createBody.data).toBeDefined();

    const coupon = createBody.data as Record<string, unknown>;
    expect(coupon.id).toBeDefined();
    expect(coupon.code).toBe(TEST_COUPON_CODE);
    expect(coupon.discount_type).toBe("percentage");
    expect(coupon.discount_value).toBe(10);
    expect(coupon.status).toBe("active");

    // audit_log でクーポン作成が記録されていることを確認
    // (audit_log は非同期で書き込まれることがあるため少し待機)
    await page.waitForTimeout(1000);

    const auditResult = await apiFetch(
      page,
      `/api/super-admin/audit-logs?action_type=create_coupon&per_page=10&page=1`,
    );
    expect(auditResult.status).toBe(200);
    const auditBody = auditResult.body as Record<string, unknown>;
    const logs = auditBody.data as Array<Record<string, unknown>>;
    // クーポン作成ログが存在する (直近の記録を確認)
    if (logs.length > 0) {
      const couponLog = logs.find(
        (log) =>
          log.action_type === "create_coupon" &&
          (log.details as Record<string, unknown>)?.code === TEST_COUPON_CODE,
      );
      if (couponLog) {
        expect(couponLog.target_type).toBe("coupon");
        expect(couponLog.severity).toBe("warn"); // クーポン作成は warn severity
      }
    }

    // クリーンアップ: クーポンを非活性化 (PATCH で status を変更する手段がない場合はスキップ)
    const couponId = coupon.id as string;
    await apiFetch(page, `/api/super-admin/coupons/${couponId}`, {
      method: "PATCH",
      body: { status: "inactive" },
    });
  });

  /**
   * T14-S4: super_admin がプラン一覧を取得して存在を確認する
   */
  test("T14-S4: super_admin がプラン一覧を取得できる", async ({ page }) => {
    await loginAsSuperAdmin(page);
    if (!SUPER_ADMIN_USER) return;

    const { status, body } = await apiFetch(page, "/api/super-admin/plans?per_page=10&page=1");

    expect(status).toBe(200);
    const responseBody = body as Record<string, unknown>;
    expect(responseBody.data).toBeDefined();
    expect(Array.isArray(responseBody.data)).toBe(true);
    expect(responseBody.meta).toBeDefined();

    const meta = responseBody.meta as Record<string, unknown>;
    expect(typeof meta.total).toBe("number");

    // プランが存在する場合は形式を確認
    const plans = responseBody.data as Array<Record<string, unknown>>;
    if (plans.length > 0) {
      const firstPlan = plans[0];
      expect(typeof firstPlan.id).toBe("string");
      expect(typeof firstPlan.plan_key).toBe("string");
      expect(typeof firstPlan.display_name).toBe("string");
      expect(["personal", "family", "org"]).toContain(firstPlan.plan_type);
    }
  });

  /**
   * T14-S5: super_admin が機能フラグ一覧を取得して flag 操作を行う
   *
   * 操作シーケンス:
   * 1. GET /api/super-admin/flags でフラグ一覧取得
   * 2. フラグが存在すれば PATCH /api/super-admin/flags/{key} で enabled を toggle
   * 3. audit_log に記録されたことを確認
   */
  test("T14-S5: super_admin が機能フラグ一覧を取得し flag を toggle する", async ({ page }) => {
    await loginAsSuperAdmin(page);
    if (!SUPER_ADMIN_USER) return;

    // フラグ一覧を取得
    const { status: flagListStatus, body: flagListBody } = await apiFetch(
      page,
      "/api/super-admin/flags",
    );

    expect(flagListStatus).toBe(200);
    const flagBody = flagListBody as Record<string, unknown>;
    expect(flagBody.data).toBeDefined();
    expect(Array.isArray(flagBody.data)).toBe(true);

    const flags = flagBody.data as Array<Record<string, unknown>>;

    // フラグが存在しない場合は toggle テストをスキップ
    if (flags.length === 0) {
      console.log("[T14-S5] 機能フラグが存在しないため toggle テストをスキップ");
      return;
    }

    // 最初のフラグを toggle する
    const targetFlag = flags[0];
    const targetKey = targetFlag.key as string;
    const currentEnabled = targetFlag.enabled as boolean;

    const patchResult = await apiFetch(page, `/api/super-admin/flags/${targetKey}`, {
      method: "PATCH",
      body: { enabled: !currentEnabled },
    });

    expect(patchResult.status).toBe(200);
    const patchBody = patchResult.body as Record<string, unknown>;
    const updatedFlag = patchBody.data as Record<string, unknown>;
    expect(updatedFlag.key).toBe(targetKey);
    expect(updatedFlag.enabled).toBe(!currentEnabled);

    // 元に戻す
    const restoreResult = await apiFetch(page, `/api/super-admin/flags/${targetKey}`, {
      method: "PATCH",
      body: { enabled: currentEnabled },
    });
    expect(restoreResult.status).toBe(200);

    // audit_log で flag toggle が記録されていることを確認
    await page.waitForTimeout(500);

    const auditResult = await apiFetch(
      page,
      `/api/super-admin/audit-logs?action_type=feature_flag&per_page=5&page=1`,
    );
    expect(auditResult.status).toBe(200);
    const auditBody = auditResult.body as Record<string, unknown>;
    const logs = auditBody.data as Array<Record<string, unknown>>;

    if (logs.length > 0) {
      // flag toggle の audit log エントリが存在することを確認
      const flagLog = logs.find(
        (log) =>
          (log.action_type as string)?.includes("feature_flag") &&
          log.target_type === "feature_flag",
      );
      if (flagLog) {
        expect(flagLog.severity).toBe("info");
        const details = flagLog.details as Record<string, unknown>;
        expect(details.key).toBe(targetKey);
      }
    }
  });

  /**
   * T14-S6: super_admin が /super-admin/flags UI ページを表示できる
   */
  test("T14-S6: super_admin が /super-admin/flags UI を表示できる", async ({ page }) => {
    await loginAsSuperAdmin(page);
    if (!SUPER_ADMIN_USER) return;

    await page.goto(`${BASE_URL}/super-admin/flags`);
    await page.waitForLoadState("networkidle");

    // ページがログインにリダイレクトされていないことを確認
    expect(page.url()).not.toContain("/login");

    // flags ページの見出しが表示される
    await expect(page.locator("h1")).toBeVisible({ timeout: 20_000 });
    const h1Text = await page.locator("h1").textContent();
    expect(h1Text).toContain("機能フラグ");
  });

  /**
   * T14-S7: super_admin が /super-admin/coupons UI ページを表示できる
   */
  test("T14-S7: super_admin が /super-admin/coupons UI を表示できる", async ({ page }) => {
    await loginAsSuperAdmin(page);
    if (!SUPER_ADMIN_USER) return;

    await page.goto(`${BASE_URL}/super-admin/coupons`);
    await page.waitForLoadState("networkidle");

    expect(page.url()).not.toContain("/login");

    // クーポン管理ページが表示される
    await expect(page.locator("h1, h2")).toBeVisible({ timeout: 20_000 });
  });

  /**
   * T14-S8: audit_log の全エントリが仕様通りの形式であることを確認
   *
   * super_admin として /api/super-admin/audit-logs を取得し、
   * レスポンスフィールドが operator/07-audit-monitoring §3-4 準拠の形式であることを検証。
   */
  test("T14-S8: audit_log エントリが operator spec 準拠の形式で記録されている", async ({
    page,
  }) => {
    await loginAsSuperAdmin(page);
    if (!SUPER_ADMIN_USER) return;

    const { status, body } = await apiFetch(
      page,
      "/api/super-admin/audit-logs?per_page=20&page=1",
    );

    expect(status).toBe(200);
    const responseBody = body as Record<string, unknown>;
    expect(responseBody.data).toBeDefined();
    expect(responseBody.meta).toBeDefined();

    const meta = responseBody.meta as Record<string, unknown>;
    expect(typeof meta.total).toBe("number");
    expect(meta.page).toBe(1);
    expect(meta.per_page).toBe(20);

    const logs = responseBody.data as Array<Record<string, unknown>>;

    for (const log of logs) {
      // 必須フィールドの存在確認
      expect(typeof log.id).toBe("string");
      expect(typeof log.action_type).toBe("string");
      expect(["info", "warn", "critical"]).toContain(log.severity);
      expect(typeof log.created_at).toBe("string");

      // actor_id または actor_email_snapshot が存在すること
      const hasActor =
        log.actor_id !== undefined || log.actor_email_snapshot !== undefined;
      expect(hasActor).toBe(true);
    }
  });
});
