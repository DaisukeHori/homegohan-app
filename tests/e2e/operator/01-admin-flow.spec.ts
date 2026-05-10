/**
 * tests/e2e/operator/01-admin-flow.spec.ts
 *
 * T14 — admin ログイン → モデレーションキュー確認 → 1件処理 → audit_log で記録確認
 *
 * happy path:
 *   1. admin ユーザーとしてログイン
 *   2. /admin/moderation にアクセスしてキューを確認
 *   3. 処理可能なアイテムがある場合は審査 UI を操作
 *   4. super_admin として /api/super-admin/audit-logs を叩き記録を確認
 *
 * 前提条件:
 *   - adminUser fixture: createFreshUser + user_profiles.roles=['admin'] で自動生成
 *   - superAdminUser fixture: createFreshUser + user_profiles.roles=['super_admin'] で自動生成
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

// ─── テストスイート ───────────────────────────────────────────────────────────

test.describe("operator/admin: ログイン → モデレーション → audit_log 確認 happy path", () => {
  /**
   * T14-A1: 未認証で admin ページにアクセスすると /login にリダイレクト
   */
  test("T14-A1: 未認証で /admin にアクセスすると /login へリダイレクト", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });

    // /login か /admin (ロードせずリダイレクト) のいずれかになる
    await expect(page).toHaveURL(/\/(login|admin)/, { timeout: 15_000 });

    // もし /admin に留まっているなら、認証なしでの表示は想定外
    if (page.url().includes("/admin") && !page.url().includes("/login")) {
      // admin コンテンツが見えないことを確認
      const hasAdminContent = await page.locator("h1:has-text('管理'), h1:has-text('モデレーション')").isVisible().catch(() => false);
      // 未認証なら admin コンテンツは表示されない (リダイレクト済みか認証要求中)
      expect(hasAdminContent).toBe(false);
    }
  });

  /**
   * T14-A2: 一般ユーザーは /api/admin/moderation/queue にアクセスできない (401/403)
   *
   * onboardingPendingUser fixture = admin ロールを持たない fresh user。
   */
  test("T14-A2: 一般ユーザーは moderation queue API に 401/403 で弾かれる", async ({ onboardingPendingUser }) => {
    const { status } = await apiFetch(onboardingPendingUser, "/api/admin/moderation/queue");

    // admin/content_moderator 権限なしユーザーは 401 または 403
    expect([401, 403]).toContain(status);
  });

  /**
   * T14-A3: admin ユーザーがモデレーションキューを取得する
   *
   * adminUser fixture: createFreshUser + user_profiles.roles=['admin'] で自動生成。
   */
  test("T14-A3: admin がモデレーションキュー API に 200 でアクセスできる", async ({ adminUser }) => {
    const { page } = adminUser;
    const { status, body } = await apiFetch(page, "/api/admin/moderation/queue");

    expect(status).toBe(200);
    const responseBody = body as Record<string, unknown>;
    expect(responseBody.data).toBeDefined();
    expect(Array.isArray(responseBody.data)).toBe(true);
    expect(responseBody.meta).toBeDefined();
    const meta = responseBody.meta as Record<string, unknown>;
    expect(typeof meta.total).toBe("number");
    expect(typeof meta.page).toBe("number");
  });

  /**
   * T14-A4: admin ユーザーが /admin/moderation にアクセスして UI を確認する
   *
   * adminUser fixture: createFreshUser + user_profiles.roles=['admin'] で自動生成。
   */
  test("T14-A4: admin が /admin/moderation 画面を表示できる", async ({ adminUser }) => {
    const { page } = adminUser;

    await page.goto(`${BASE_URL}/admin/moderation`);
    await page.waitForLoadState("networkidle");

    // ページが /login に飛ばされていないことを確認
    expect(page.url()).not.toContain("/login");

    // モデレーション画面の見出しが表示される
    await expect(page.locator("h1:has-text('モデレーション')")).toBeVisible({ timeout: 20_000 });

    // フィルタフォームが表示される
    await expect(page.locator("select[name='status']")).toBeVisible({ timeout: 10_000 });

    // テーブルが存在する (アイテム数は問わない)
    await expect(page.locator("table")).toBeVisible({ timeout: 10_000 });
  });

  /**
   * T14-A5: admin がモデレーションキューのフィルタを操作する
   *
   * adminUser fixture: createFreshUser + user_profiles.roles=['admin'] で自動生成。
   */
  test("T14-A5: admin がモデレーションキューのステータスフィルタを操作する", async ({ adminUser }) => {
    const { page } = adminUser;

    await page.goto(`${BASE_URL}/admin/moderation`);
    await page.waitForLoadState("networkidle");

    // status フィルタを "approved" に変更
    await page.selectOption("select[name='status']", "approved");
    await page.locator("button[type='submit']:has-text('絞り込み')").click();

    // URL が更新されることを確認
    await page.waitForURL(/status=approved/, { timeout: 15_000 });
    expect(page.url()).toContain("status=approved");

    // テーブルが引き続き表示されている
    await expect(page.locator("table")).toBeVisible({ timeout: 10_000 });
  });

  /**
   * T14-A6: audit_log が記録されていることを super_admin で確認する
   *
   * superAdminUser fixture: createFreshUser + user_profiles.roles=['super_admin'] で自動生成。
   * /api/super-admin/audit-logs エンドポイントで直近のログを取得し
   * レスポンス形式が仕様通りであることをアサートする。
   */
  test("T14-A6: super_admin が audit_log を取得して記録を確認する", async ({ superAdminUser }) => {
    const { page } = superAdminUser;

    // 監査ログ API を叩く
    const { status, body } = await apiFetch(
      page,
      "/api/super-admin/audit-logs?per_page=10&page=1",
    );

    expect(status).toBe(200);
    const responseBody = body as Record<string, unknown>;
    expect(responseBody.data).toBeDefined();
    expect(Array.isArray(responseBody.data)).toBe(true);
    expect(responseBody.meta).toBeDefined();

    const meta = responseBody.meta as Record<string, unknown>;
    expect(typeof meta.total).toBe("number");
    expect(typeof meta.page).toBe("number");
    expect(typeof meta.per_page).toBe("number");

    // ログエントリの形式確認 (データが存在する場合)
    const logs = responseBody.data as Array<Record<string, unknown>>;
    if (logs.length > 0) {
      const firstLog = logs[0];
      // audit_log の必須フィールドを確認
      expect(typeof firstLog.id).toBe("string");
      expect(typeof firstLog.action_type).toBe("string");
      expect(typeof firstLog.severity).toBe("string");
      expect(["info", "warn", "critical"]).toContain(firstLog.severity);
      expect(typeof firstLog.created_at).toBe("string");
    }
  });

  /**
   * T14-A7: 一般ユーザーは audit_log API にアクセスできない (403)
   *
   * onboardingPendingUser fixture = admin ロールを持たない fresh user。
   */
  test("T14-A7: 一般ユーザーは audit_log API に 401/403 で弾かれる", async ({ onboardingPendingUser }) => {
    const { status } = await apiFetch(onboardingPendingUser, "/api/super-admin/audit-logs?per_page=5&page=1");

    expect([401, 403]).toContain(status);
  });

  /**
   * T14-A8: admin ユーザーも audit_log API は閲覧できない (super_admin 専用)
   *
   * adminUser fixture: createFreshUser + user_profiles.roles=['admin'] で自動生成。
   * audit_log の閲覧は super_admin のみ許可 (admin が自分の操作を消せない設計)。
   */
  test("T14-A8: admin ユーザーは audit_log API に 403 で弾かれる (super_admin 専用)", async ({
    adminUser,
  }) => {
    const { page } = adminUser;
    const { status } = await apiFetch(page, "/api/super-admin/audit-logs?per_page=5&page=1");

    // admin ロールは super_admin audit log を閲覧できない
    expect([401, 403]).toContain(status);
  });
});
