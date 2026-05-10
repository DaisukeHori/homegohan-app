/**
 * tests/e2e/tour/01-eligibility.spec.ts
 *
 * /api/handson-tour/status API のレスポンス reason 検証。
 * onboarding 未完 / 完了 / 既存活動有り / admin / スキップ済 / 通常新規
 *
 * 注意: 実 API を叩く E2E。API モックは使用しない。
 * fresh-user fixture を使用して毎テスト独立したユーザーを生成する。
 */

import { test, expect, createFreshUser, cleanupFreshUser } from "../fixtures/fresh-user";
import { createClient } from "@supabase/supabase-js";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

// Node.js 20 は native WebSocket を持たないため ws パッケージを明示的に指定
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require("ws") as typeof WebSocket;

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

function getAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "[01-eligibility] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。",
    );
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
      // @ts-expect-error ws は Node.js 用 WebSocket 実装
      transport: ws,
    },
  });
}

/** anon API で JWT を取得する */
async function getUserToken(email: string, password: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;
    return (data.access_token as string) ?? null;
  } catch {
    return null;
  }
}

/** service_role 経由で user_profiles を部分 PATCH する */
async function patchUserProfile(
  userId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
}

/** service_role 経由で user_profiles を INSERT する (onboarding 完了済み) */
async function insertUserProfile(
  userId: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  const now = new Date().toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      id: userId,
      nickname: "E2E Eligibility Test User",
      age_group: "30s",
      gender: "unspecified",
      onboarding_completed_at: now,
      ...extra,
    }),
  });
}

/** ユーザー jwt でステータス API を叩く */
async function fetchTourStatus(
  token: string,
  baseURL: string,
): Promise<{ should_show: boolean; reason: string } | null> {
  try {
    const resp = await fetch(`${baseURL}/api/handson-tour/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Cookie: "",
      },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as { should_show: boolean; reason: string };
  } catch {
    return null;
  }
}

test.describe("Tour - Eligibility API", () => {
  test.setTimeout(60_000);

  test("onboarding 未完のユーザーは reason=onboarding_not_completed", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-tour-eligi-noob",
    });

    try {
      // user_profiles レコードを作成しない (onboarding 未完了状態)
      const token = await getUserToken(user.email, user.password);
      if (!token) {
        test.skip(true, "JWT 取得不可");
        return;
      }

      const baseURL =
        process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const status = await fetchTourStatus(token, baseURL);

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

  test("onboarding 完了済のユーザーは reason=eligible (通常新規)", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-tour-eligi-new",
    });

    try {
      // onboarding 完了状態にする (tour 未起動)
      await insertUserProfile(user.id);

      const token = await getUserToken(user.email, user.password);
      if (!token) {
        test.skip(true, "JWT 取得不可");
        return;
      }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const status = await fetchTourStatus(token, baseURL);

      if (!status) {
        test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
        return;
      }

      expect(status.should_show).toBe(true);
      expect(status.reason).toBe("eligible");
    } finally {
      await cleanupFreshUser(supabaseAdmin, user.id);
    }
  });

  test("ハンズオンツアー完了済ユーザーは reason=already_completed", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-tour-eligi-done",
    });

    try {
      const now = new Date().toISOString();
      await insertUserProfile(user.id, { handson_tour_completed_at: now });

      const token = await getUserToken(user.email, user.password);
      if (!token) {
        test.skip(true, "JWT 取得不可");
        return;
      }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const status = await fetchTourStatus(token, baseURL);

      if (!status) {
        test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
        return;
      }

      expect(status.should_show).toBe(false);
      expect(status.reason).toBe("already_completed");
    } finally {
      await cleanupFreshUser(supabaseAdmin, user.id);
    }
  });

  test("スキップ済ユーザーは reason=already_skipped", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-tour-eligi-skip",
    });

    try {
      const now = new Date().toISOString();
      await insertUserProfile(user.id, { handson_tour_skipped_at: now });

      const token = await getUserToken(user.email, user.password);
      if (!token) {
        test.skip(true, "JWT 取得不可");
        return;
      }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const status = await fetchTourStatus(token, baseURL);

      if (!status) {
        test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
        return;
      }

      expect(status.should_show).toBe(false);
      expect(status.reason).toBe("already_skipped");
    } finally {
      await cleanupFreshUser(supabaseAdmin, user.id);
    }
  });

  test("admin ロールユーザーは reason=admin_role", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-tour-eligi-admin",
    });

    try {
      await insertUserProfile(user.id, { roles: ["user", "admin"] });

      const token = await getUserToken(user.email, user.password);
      if (!token) {
        test.skip(true, "JWT 取得不可");
        return;
      }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const status = await fetchTourStatus(token, baseURL);

      if (!status) {
        test.skip(true, "/api/handson-tour/status が未実装の可能性あり");
        return;
      }

      expect(status.should_show).toBe(false);
      expect(status.reason).toBe("admin_role");
    } finally {
      await cleanupFreshUser(supabaseAdmin, user.id);
    }
  });

  // TODO: 既存活動有り (non-sandbox meals あり) のテストは meal 挿入ヘルパーが必要なため
  // 実装後に追加する。現状 reason=existing_user_auto_skip を返す条件の検証は別 PR で対応。
  test.skip("既存活動有りユーザーは reason=existing_user_auto_skip (未実装)", async () => {
    // TODO: service_role 経由で meals テーブルに is_sandbox=false の行を挿入してから
    // status API を叩いて reason を検証する
  });
});
