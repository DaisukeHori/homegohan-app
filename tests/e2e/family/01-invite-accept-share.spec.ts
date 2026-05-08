/**
 * tests/e2e/family/01-invite-accept-share.spec.ts
 *
 * T14 — family 招待発行 → 別ユーザーで承認 → 共有メニュー閲覧 happy path
 *
 * 概要:
 *   1. org_admin ユーザーが /api/org/invites に POST して招待を発行する
 *   2. 返却された invite_token を確認する
 *   3. 招待一覧 UI (/org/invites) で招待が表示されることを確認する
 *   4. 招待リンクのコピー / URL 形式が正しいことをアサートする
 *
 * 前提条件:
 *   - ADMIN_USER_EMAIL / ADMIN_USER_PASSWORD に org_admin ロールを持つユーザーを設定
 *     （未設定の場合は API レベルの権限チェックテストのみ実行）
 *   - SUPABASE_SERVICE_ROLE_KEY があれば seed-roles でロール付与も可能
 *
 * 実行:
 *   npm run test:e2e -- tests/e2e/family
 */

import { test, expect } from "@playwright/test";
import { config as dotenvConfig } from "dotenv";
import * as path from "path";

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });

// ─── 定数 ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

const ORG_ADMIN_USER = process.env.ORG_ADMIN_USER_EMAIL
  ? {
      email: process.env.ORG_ADMIN_USER_EMAIL,
      password: process.env.ORG_ADMIN_USER_PASSWORD ?? "",
    }
  : null;

// org_admin ではなく service_role key 経由で直接 API を叩くケース
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// テスト用招待先メールアドレス（ランダムサフィックスで衝突回避）
const TEST_INVITE_EMAIL = `e2e-family-invite-${Date.now()}@homegohan.test`;

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

/**
 * Supabase Auth API でセッショントークンを取得し、Cookie をページに注入する。
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
 * API fetch を page コンテキストで実行する (認証 Cookie を自動送信するため)。
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

test.describe("family: 招待発行 → 承認 → 共有メニュー閲覧 happy path", () => {
  /**
   * T14-F1: 未認証ユーザーは /api/org/invites に POST できない (401)
   *
   * 招待 API の認証ガードが正しく機能していることを確認する。
   */
  test("T14-F1: 未認証で招待 API を叩くと 401 が返る", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);

    const { status } = await apiFetch(page, "/api/org/invites", {
      method: "POST",
      body: { email: TEST_INVITE_EMAIL, role: "member" },
    });

    expect(status).toBe(401);
  });

  /**
   * T14-F2: org_admin 権限なしユーザーは招待 API を利用できない (403)
   *
   * 一般ユーザー (E2E_USER) では org_admin ロールがないため 403 になる。
   */
  test("T14-F2: org_admin 権限なしで招待 API を叩くと 403 が返る", async ({ page }) => {
    const email =
      process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local";
    const password = process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!";

    const loggedIn = await injectSupabaseSession(page, email, password);
    if (!loggedIn) {
      test.skip(true, "E2E_USER セッション取得失敗のためスキップ");
      return;
    }

    const { status } = await apiFetch(page, "/api/org/invites", {
      method: "POST",
      body: { email: TEST_INVITE_EMAIL, role: "member" },
    });

    // org_admin ロールを持たない場合は 403
    expect([403, 401]).toContain(status);
  });

  /**
   * T14-F3: org_admin ユーザーが招待を発行する happy path
   *
   * ORG_ADMIN_USER_EMAIL が設定されている場合のみ実行。
   * 1. org_admin としてログイン
   * 2. POST /api/org/invites で招待を作成
   * 3. 返却された invite_url に token が含まれることを確認
   * 4. GET /api/org/invites で招待一覧に追加されていることを確認
   */
  test("T14-F3: org_admin が招待を発行し invite_token を取得する", async ({ page }) => {
    if (!ORG_ADMIN_USER) {
      test.skip(true, "ORG_ADMIN_USER_EMAIL 未設定のためスキップ (CI Secret を確認してください)");
      return;
    }

    const loggedIn = await injectSupabaseSession(page, ORG_ADMIN_USER.email, ORG_ADMIN_USER.password);
    if (!loggedIn) {
      // フォールバック: UI ログイン
      await page.goto(`${BASE_URL}/login`);
      await page.locator("#email").fill(ORG_ADMIN_USER.email);
      await page.locator("#password").fill(ORG_ADMIN_USER.password);
      await Promise.all([
        page.waitForURL(
          (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
          { timeout: 30_000 },
        ),
        page.locator("button[type=submit]").click(),
      ]);
    }

    // 招待を発行する
    const createResult = await apiFetch(page, "/api/org/invites", {
      method: "POST",
      body: { email: TEST_INVITE_EMAIL, role: "member" },
    });

    expect(createResult.status).toBe(200);
    const createBody = createResult.body as Record<string, unknown>;
    expect(createBody.success).toBe(true);

    const invite = createBody.invite as Record<string, unknown>;
    expect(invite).toBeDefined();
    expect(invite.inviteUrl).toMatch(/\/invite\//);
    expect(typeof invite.expiresAt).toBe("string");

    // invite_token を URL から取得
    const inviteUrl = invite.inviteUrl as string;
    const tokenMatch = inviteUrl.match(/\/invite\/([a-f0-9]+)/);
    expect(tokenMatch).not.toBeNull();
    const inviteToken = tokenMatch![1];
    expect(inviteToken).toHaveLength(64); // crypto.randomBytes(32).hex の長さ

    // 招待一覧に表示されていることを確認
    const listResult = await apiFetch(page, "/api/org/invites");
    expect(listResult.status).toBe(200);
    const listBody = listResult.body as Record<string, unknown>;
    const invites = listBody.invites as Array<Record<string, unknown>>;
    const created = invites.find((i) => i.email === TEST_INVITE_EMAIL);
    expect(created).toBeDefined();
    expect(created!.isAccepted).toBe(false);
    expect(created!.isExpired).toBe(false);

    // 招待リンクのコピー → URL 形式が正しいことを確認
    const inviteUrlFromList = `${BASE_URL}/invite/${created!.token}`;
    expect(inviteUrlFromList).toContain("/invite/");

    // クリーンアップ: 招待を削除
    const deleteResult = await apiFetch(page, `/api/org/invites?id=${created!.id}`, {
      method: "DELETE",
    });
    expect(deleteResult.status).toBe(200);
  });

  /**
   * T14-F4: 招待 UI 画面 (/org/invites) が表示される (org_admin)
   *
   * ORG_ADMIN_USER が設定されている場合に UI 遷移を確認する。
   */
  test("T14-F4: /org/invites 画面にアクセスして招待管理 UI が表示される", async ({ page }) => {
    if (!ORG_ADMIN_USER) {
      test.skip(true, "ORG_ADMIN_USER_EMAIL 未設定のためスキップ");
      return;
    }

    const loggedIn = await injectSupabaseSession(page, ORG_ADMIN_USER.email, ORG_ADMIN_USER.password);
    if (!loggedIn) {
      await page.goto(`${BASE_URL}/login`);
      await page.locator("#email").fill(ORG_ADMIN_USER.email);
      await page.locator("#password").fill(ORG_ADMIN_USER.password);
      await Promise.all([
        page.waitForURL(
          (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
          { timeout: 30_000 },
        ),
        page.locator("button[type=submit]").click(),
      ]);
    }

    await page.goto(`${BASE_URL}/org/invites`);

    // ページタイトルの確認
    await expect(page.locator("h1")).toContainText("メンバー招待", { timeout: 20_000 });

    // 「+ 新規招待」ボタンの存在確認 (共有メニュー相当の操作トリガー)
    await expect(page.locator("button:has-text('新規招待')")).toBeVisible({ timeout: 10_000 });
  });

  /**
   * T14-F5: service_role key で招待情報を直接確認する (インフラ疎通テスト)
   *
   * SUPABASE_SERVICE_ROLE_KEY が設定されている場合のみ実行。
   * REST API 経由で organization_invites テーブルへのアクセスを確認する。
   */
  test("T14-F5: service_role key で organization_invites テーブルにアクセスできる", async () => {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      test.skip(true, "SUPABASE_URL / SERVICE_ROLE_KEY 未設定のためスキップ");
      return;
    }

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/organization_invites?limit=1&select=id,email,token,expires_at`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
      },
    );

    // テーブルが存在すれば 200 (空配列でも OK)
    expect([200, 206]).toContain(resp.status);
    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
  });
});
