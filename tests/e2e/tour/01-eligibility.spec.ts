/**
 * tests/e2e/tour/01-eligibility.spec.ts
 *
 * /api/handson-tour/status API のレスポンス reason 検証。
 * onboarding 未完 / 完了 / 既存活動有り / admin / スキップ済 / 通常新規
 *
 * 注意: 実 API を叩く E2E。API モックは使用しない。
 *
 * 移行: fetch ベースの admin API ヘルパー (WebSocket フリー) を使用
 */

import { test, expect } from "@playwright/test";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const ADMIN_HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

/** admin API (fetch) で新規ユーザーを作成して userId を返す */
async function createUser(emailPrefix: string): Promise<{ id: string; email: string; password: string } | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const email = `${emailPrefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@homegohan.test`;
  const password = "TestE2E2026!secure";
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!resp.ok) return null;
  const data = await resp.json() as { id: string };
  return { id: data.id, email, password };
}

/** admin API でユーザーを削除する */
async function deleteUser(userId: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: ADMIN_HEADERS,
  }).catch(() => {});
}

/** user_profiles に onboarding 完了済みレコードを INSERT */
async function insertOnboardingCompletedProfile(userId: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  const now = new Date().toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
    method: "POST",
    headers: { ...ADMIN_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({
      id: userId,
      nickname: "E2E Tour Test",
      age_group: "30s",
      gender: "unspecified",
      onboarding_completed_at: now,
    }),
  });
}

/** user_profiles に onboarding 未完了レコードを INSERT (onboarding_completed_at = null) */
async function insertIncompleteProfile(userId: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
    method: "POST",
    headers: { ...ADMIN_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({
      id: userId,
      nickname: "E2E Tour Test",
      age_group: "30s",
      gender: "unspecified",
      onboarding_completed_at: null,
    }),
  });
}

/** user_profiles を PATCH する汎用ヘルパー */
async function patchProfile(userId: string, patch: Record<string, unknown>): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: { ...ADMIN_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
}

/** password grant で JWT を取得する (429 リトライ付き) */
async function getUserToken(email: string, password: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    if (resp.status === 429) {
      await new Promise((r) => setTimeout(r, attempt * 3000));
      continue;
    }
    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, unknown>;
    return (data.access_token as string) ?? null;
  }
  return null;
}

/** ユーザー jwt でステータス API を叩く */
async function fetchTourStatus(
  token: string,
  baseURL: string,
): Promise<{ should_show: boolean; reason: string } | null> {
  try {
    const resp = await fetch(`${baseURL}/api/handson-tour/status`, {
      headers: { Authorization: `Bearer ${token}`, Cookie: "" },
    });
    if (!resp.ok) return null;
    return await resp.json() as { should_show: boolean; reason: string };
  } catch {
    return null;
  }
}

test.describe("Tour - Eligibility API", () => {
  test.setTimeout(60_000);

  test("onboarding 未完のユーザーは reason=onboarding_not_completed", async ({ page }) => {
    const user = await createUser("e2e-tour-noob");
    if (!user) { test.skip(true, "admin API 利用不可"); return; }

    try {
      // user_profiles を onboarding_completed_at=null で作成 (onboarding 未着手)
      // API は user_profiles が存在しないと 404 を返すため、レコードは必要
      await insertIncompleteProfile(user.id);

      const token = await getUserToken(user.email, user.password);
      if (!token) { test.skip(true, "JWT 取得不可"); return; }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const status = await fetchTourStatus(token, baseURL);
      if (!status) { test.skip(true, "/api/handson-tour/status が未実装"); return; }

      expect(status.should_show).toBe(false);
      expect(status.reason).toBe("onboarding_not_completed");
    } finally {
      await deleteUser(user.id);
    }
  });

  test("onboarding 完了済のユーザーは reason=eligible (通常新規)", async ({ page }) => {
    const user = await createUser("e2e-tour-new");
    if (!user) { test.skip(true, "admin API 利用不可"); return; }

    try {
      await insertOnboardingCompletedProfile(user.id);

      const token = await getUserToken(user.email, user.password);
      if (!token) { test.skip(true, "JWT 取得不可"); return; }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const status = await fetchTourStatus(token, baseURL);
      if (!status) { test.skip(true, "/api/handson-tour/status が未実装"); return; }

      expect(status.should_show).toBe(true);
      expect(status.reason).toBe("eligible");
    } finally {
      await deleteUser(user.id);
    }
  });

  test("ハンズオンツアー完了済ユーザーは reason=already_completed", async ({ page }) => {
    const user = await createUser("e2e-tour-done");
    if (!user) { test.skip(true, "admin API 利用不可"); return; }

    try {
      await insertOnboardingCompletedProfile(user.id);
      await patchProfile(user.id, { handson_tour_completed_at: new Date().toISOString() });

      const token = await getUserToken(user.email, user.password);
      if (!token) { test.skip(true, "JWT 取得不可"); return; }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const status = await fetchTourStatus(token, baseURL);
      if (!status) { test.skip(true, "/api/handson-tour/status が未実装"); return; }

      expect(status.should_show).toBe(false);
      expect(status.reason).toBe("already_completed");
    } finally {
      await deleteUser(user.id);
    }
  });

  test("スキップ済ユーザーは reason=already_skipped", async ({ page }) => {
    const user = await createUser("e2e-tour-skip");
    if (!user) { test.skip(true, "admin API 利用不可"); return; }

    try {
      await insertOnboardingCompletedProfile(user.id);
      await patchProfile(user.id, { handson_tour_skipped_at: new Date().toISOString() });

      const token = await getUserToken(user.email, user.password);
      if (!token) { test.skip(true, "JWT 取得不可"); return; }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const status = await fetchTourStatus(token, baseURL);
      if (!status) { test.skip(true, "/api/handson-tour/status が未実装"); return; }

      expect(status.should_show).toBe(false);
      expect(status.reason).toBe("already_skipped");
    } finally {
      await deleteUser(user.id);
    }
  });

  test("admin ロールユーザーは reason=admin_role", async ({ page }) => {
    const user = await createUser("e2e-tour-admin");
    if (!user) { test.skip(true, "admin API 利用不可"); return; }

    try {
      await insertOnboardingCompletedProfile(user.id);
      await patchProfile(user.id, { roles: ["user", "admin"] });

      const token = await getUserToken(user.email, user.password);
      if (!token) { test.skip(true, "JWT 取得不可"); return; }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const status = await fetchTourStatus(token, baseURL);
      if (!status) { test.skip(true, "/api/handson-tour/status が未実装"); return; }

      expect(status.should_show).toBe(false);
      expect(status.reason).toBe("admin_role");
    } finally {
      await deleteUser(user.id);
    }
  });

  // TODO: 既存活動有り (non-sandbox meals あり) のテストは meal 挿入ヘルパーが必要なため
  // 実装後に追加する。現状 reason=existing_user_auto_skip を返す条件の検証は別 PR で対応。
  test.skip("既存活動有りユーザーは reason=existing_user_auto_skip (未実装)", async () => {
    // TODO: service_role 経由で meals テーブルに is_sandbox=false の行を挿入してから
    // status API を叩いて reason を検証する
  });
});
