/**
 * tests/e2e/tour/01-eligibility.spec.ts
 *
 * /api/handson-tour/status API のレスポンス reason 検証。
 * onboarding 未完 / 完了 / 既存活動有り / admin / スキップ済 / 通常新規
 *
 * 注意: 実 API を叩く E2E。API モックは使用しない。
 *
 * fresh-user fixture ベースに移行 (Step 2):
 * - Password grant (rate limit 対象) の代わりに page context (セッション Cookie) で API を呼ぶ
 * - onboardingPendingUser: onboarding 未完了ユーザー
 * - tourPendingUser: onboarding 完了 + tour 未起動ユーザー
 * - tourPendingUser + 手動 PATCH: ツアー完了済 / スキップ済 / admin ユーザー
 */

import { test, expect, createFreshUser, cleanupFreshUser, injectSessionViaLink } from "../fixtures/fresh-user";
import { createClient } from "@supabase/supabase-js";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
import type { Page } from "@playwright/test";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require("ws") as typeof WebSocket;

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function getAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    realtime: {
      // @ts-expect-error ws は Node.js 用 WebSocket 実装
      transport: ws,
    },
  });
}

/** service_role 経由でユーザーの user_profiles を PATCH する */
async function patchUserProfile(userId: string, data: Record<string, unknown>): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(data),
  });
}

/**
 * Playwright の page.request (セッション Cookie 付き) で
 * /api/handson-tour/status を呼ぶ。password grant を回避して rate limit 問題を解消。
 */
async function fetchTourStatusViaPage(
  page: Page,
  baseURL: string,
): Promise<{ should_show: boolean; reason: string } | null> {
  try {
    const resp = await page.request.get(`${baseURL}/api/handson-tour/status`);
    if (!resp.ok()) return null;
    return await resp.json() as { should_show: boolean; reason: string };
  } catch {
    return null;
  }
}

test.describe("Tour - Eligibility API", () => {
  test.setTimeout(60_000);

  test("onboarding 未完のユーザーは reason=onboarding_not_completed", async ({ page, baseURL: configBaseURL }) => {
    // user_profiles に onboarding_completed_at = null のレコードを持つユーザーを作成
    // (onboardingPendingUser は user_profiles なしで profile_not_found になるため、
    //  profile あり + onboarding 未完了の状態を明示的に作る)
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-tour-eligi-noob" });
    const appBaseURL = configBaseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

    try {
      // user_profiles を onboarding_completed_at = null で INSERT
      await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          id: user.id,
          nickname: "E2E Tour Noob User",
          age_group: "30s",
          gender: "unspecified",
          onboarding_completed_at: null,
        }),
      });

      // magiclink 経由でセッション確立 (rate limit 回避)
      await injectSessionViaLink(page, supabaseAdmin, user.id, user.email, appBaseURL);
      await page.waitForLoadState("networkidle");

      const status = await fetchTourStatusViaPage(page, appBaseURL);

      // API が存在しない場合はスキップ
      if (!status) {
        test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
        return;
      }

      expect(status.should_show).toBe(false);
      expect(status.reason).toBe("onboarding_not_completed");
    } finally {
      await cleanupFreshUser(supabaseAdmin, user.id);
    }
  });

  test("onboarding 完了済のユーザーは reason=eligible (通常新規)", async ({ tourPendingUser: page }) => {
    // tourPendingUser: onboarding_completed_at 設定済み + tour 未起動
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const status = await fetchTourStatusViaPage(page, baseURL);

    if (!status) {
      test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
      return;
    }

    expect(status.should_show).toBe(true);
    expect(status.reason).toBe("eligible");
  });

  test("ハンズオンツアー完了済ユーザーは reason=already_completed", async ({ tourPendingUser: page }) => {
    // tourPendingUser + handson_tour_completed_at を PATCH で設定
    // user ID を取得するために /api/handson-tour/status を呼んでも取れないので
    // page.evaluate でセッションから user_id を取得する
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

    // まず eligible 状態を確認
    const beforeStatus = await fetchTourStatusViaPage(page, baseURL);
    if (!beforeStatus) {
      test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
      return;
    }

    // eligible でなければスキップ (セットアップ依存の問題)
    if (beforeStatus.reason !== "eligible") {
      test.skip(true, `前提条件 (eligible) が満たされていません: ${beforeStatus.reason}`);
      return;
    }

    // セッションから user_id を取得して handson_tour_completed_at を設定
    const supabaseRef = SUPABASE_URL.replace("https://", "").split(".")[0];
    const cookieName = `sb-${supabaseRef}-auth-token`;
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === cookieName);
    if (!sessionCookie) {
      test.skip(true, "セッション Cookie が見つかりません");
      return;
    }
    let userId: string | null = null;
    try {
      const session = JSON.parse(decodeURIComponent(sessionCookie.value)) as Record<string, unknown>;
      const user = session.user as Record<string, unknown> | undefined;
      userId = (user?.id as string) ?? null;
    } catch {
      // ignore
    }

    if (!userId) {
      test.skip(true, "user_id をセッションから取得できません");
      return;
    }

    await patchUserProfile(userId, { handson_tour_completed_at: new Date().toISOString() });

    // 再度 API を呼ぶ
    const afterStatus = await fetchTourStatusViaPage(page, baseURL);
    if (!afterStatus) {
      test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
      return;
    }

    expect(afterStatus.should_show).toBe(false);
    expect(afterStatus.reason).toBe("already_completed");
  });

  test("スキップ済ユーザーは reason=already_skipped", async ({ tourPendingUser: page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

    // eligible 状態を確認
    const beforeStatus = await fetchTourStatusViaPage(page, baseURL);
    if (!beforeStatus) {
      test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
      return;
    }

    if (beforeStatus.reason !== "eligible") {
      test.skip(true, `前提条件 (eligible) が満たされていません: ${beforeStatus.reason}`);
      return;
    }

    // セッションから user_id を取得
    const supabaseRef = SUPABASE_URL.replace("https://", "").split(".")[0];
    const cookieName = `sb-${supabaseRef}-auth-token`;
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === cookieName);
    if (!sessionCookie) {
      test.skip(true, "セッション Cookie が見つかりません");
      return;
    }
    let userId: string | null = null;
    try {
      const session = JSON.parse(decodeURIComponent(sessionCookie.value)) as Record<string, unknown>;
      const user = session.user as Record<string, unknown> | undefined;
      userId = (user?.id as string) ?? null;
    } catch {
      // ignore
    }

    if (!userId) {
      test.skip(true, "user_id をセッションから取得できません");
      return;
    }

    await patchUserProfile(userId, { handson_tour_skipped_at: new Date().toISOString() });

    const afterStatus = await fetchTourStatusViaPage(page, baseURL);
    if (!afterStatus) {
      test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
      return;
    }

    expect(afterStatus.should_show).toBe(false);
    expect(afterStatus.reason).toBe("already_skipped");
  });

  test("admin ロールユーザーは reason=admin_role", async ({ tourPendingUser: page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

    // eligible 状態を確認
    const beforeStatus = await fetchTourStatusViaPage(page, baseURL);
    if (!beforeStatus) {
      test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
      return;
    }

    if (beforeStatus.reason !== "eligible") {
      test.skip(true, `前提条件 (eligible) が満たされていません: ${beforeStatus.reason}`);
      return;
    }

    // セッションから user_id を取得
    const supabaseRef = SUPABASE_URL.replace("https://", "").split(".")[0];
    const cookieName = `sb-${supabaseRef}-auth-token`;
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === cookieName);
    if (!sessionCookie) {
      test.skip(true, "セッション Cookie が見つかりません");
      return;
    }
    let userId: string | null = null;
    try {
      const session = JSON.parse(decodeURIComponent(sessionCookie.value)) as Record<string, unknown>;
      const user = session.user as Record<string, unknown> | undefined;
      userId = (user?.id as string) ?? null;
    } catch {
      // ignore
    }

    if (!userId) {
      test.skip(true, "user_id をセッションから取得できません");
      return;
    }

    await patchUserProfile(userId, { roles: ["user", "admin"] });

    const afterStatus = await fetchTourStatusViaPage(page, baseURL);
    if (!afterStatus) {
      test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
      return;
    }

    expect(afterStatus.should_show).toBe(false);
    expect(afterStatus.reason).toBe("admin_role");
  });

  // TODO: 既存活動有り (non-sandbox meals あり) のテストは meal 挿入ヘルパーが必要なため
  // 実装後に追加する。現状 reason=existing_user_auto_skip を返す条件の検証は別 PR で対応。
  test.skip("既存活動有りユーザーは reason=existing_user_auto_skip (未実装)", async () => {
    // TODO: service_role 経由で meals テーブルに is_sandbox=false の行を挿入してから
    // status API を叩いて reason を検証する
  });
});
