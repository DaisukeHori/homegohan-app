/**
 * tests/e2e/helpers/membership-paste.ts
 *
 * spec 09-11 (meal paste / share settings / operator emergency) 用ヘルパー。
 * service_role REST API を直接叩いて DB 状態を準備する。
 */

import { createClient } from "@supabase/supabase-js";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

// worktree 環境でも .env.local を読み込む (3段フォールバック)
// helpers/ から worktree root は 3 段上、main repo は 6 段上
dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../../.env.local") });

// ─────────────────────────────────────────────────────────────────────────────
// Supabase admin クライアント
// ─────────────────────────────────────────────────────────────────────────────

export function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "[membership-paste] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ws = require("ws") as typeof WebSocket;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
      // @ts-expect-error ws は Node.js 用 WebSocket 実装
      transport: ws,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────────────────────────

export interface MealRecord {
  id: string;
  user_id: string;
  eaten_at: string;
  meal_type: "breakfast" | "lunch" | "dinner" | "snack";
  paste_group_id: string | null;
}

export interface FamilySetup {
  /** family_groups.id */
  familyId: string;
  /** 代表者 (owner) の user_id */
  ownerId: string;
  ownerEmail: string;
  /** adult member の user_id */
  memberId: string;
  memberEmail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー: family_groups / family_members を直接セットアップ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 2 名の fresh family を service_role で組み立てる。
 *   - ownerId: 代表者 (representative)
 *   - memberId: adult メンバー
 * user_profiles は既に作成済みであることを前提とする。
 */
export async function setupFamilyWithTwoMembers(params: {
  ownerId: string;
  ownerEmail: string;
  memberId: string;
  memberEmail: string;
  familyName?: string;
}): Promise<FamilySetup> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const { ownerId, ownerEmail, memberId, memberEmail, familyName } = params;
  const name = familyName ?? `E2E Family ${Date.now()}`;

  // 1. family_groups を INSERT
  const fgResp = await fetch(`${supabaseUrl}/rest/v1/family_groups`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      name,
      plan_key: "free",
      representative_id: ownerId,
      status: "active",
    }),
  });
  if (!fgResp.ok) {
    const text = await fgResp.text();
    throw new Error(`[membership-paste] family_groups INSERT 失敗 (${fgResp.status}): ${text.substring(0, 300)}`);
  }
  const fgRows = (await fgResp.json()) as Array<{ id: string }>;
  const familyId = fgRows[0]?.id;
  if (!familyId) throw new Error("[membership-paste] family_groups INSERT: id が返却されませんでした");

  // 2. owner を family_members に INSERT (representative)
  await insertFamilyMember({ familyId, userId: ownerId, role: "representative", supabaseUrl, serviceRoleKey });

  // 3. member を family_members に INSERT (adult)
  await insertFamilyMember({ familyId, userId: memberId, role: "adult", supabaseUrl, serviceRoleKey });

  // 4. user_profiles.family_id を更新
  await updateUserFamilyId({ userId: ownerId, familyId, supabaseUrl, serviceRoleKey });
  await updateUserFamilyId({ userId: memberId, familyId, supabaseUrl, serviceRoleKey });

  return { familyId, ownerId, ownerEmail, memberId, memberEmail };
}

async function insertFamilyMember(params: {
  familyId: string;
  userId: string;
  role: "representative" | "adult" | "child";
  supabaseUrl: string;
  serviceRoleKey: string;
}): Promise<void> {
  const { familyId, userId, role, supabaseUrl, serviceRoleKey } = params;
  const resp = await fetch(`${supabaseUrl}/rest/v1/family_members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      family_id: familyId,
      user_id: userId,
      role,
      status: "active",
      share_meals: true,
      share_health: false,
      share_menu: true,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[membership-paste] family_members INSERT 失敗 (${resp.status}): ${text.substring(0, 300)}`);
  }
}

async function updateUserFamilyId(params: {
  userId: string;
  familyId: string | null;
  supabaseUrl: string;
  serviceRoleKey: string;
}): Promise<void> {
  const { userId, familyId, supabaseUrl, serviceRoleKey } = params;
  const resp = await fetch(`${supabaseUrl}/rest/v1/user_profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ family_id: familyId }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[membership-paste] user_profiles PATCH family_id 失敗 (${resp.status}): ${text.substring(0, 300)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー: meal 作成 (service_role 経由 direct INSERT)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * meals テーブルに直接 INSERT して meal_id を返す。
 * spec09 の「owner が事前に食事レコードを持っている」前提条件を満たすために使用。
 *
 * 実際の meals スキーマ: id, user_id, eaten_at (TIMESTAMPTZ), meal_type TEXT, photo_url, memo, paste_group_id
 */
export async function createMealForUser(params: {
  userId: string;
  mealDate?: string; // "YYYY-MM-DD" (eaten_at の日付部分; 省略時は today)
  mealTime?: "breakfast" | "lunch" | "dinner" | "snack"; // meal_type にマップ
  menuName?: string; // memo として保存
}): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const { userId, mealDate, mealTime, menuName } = params;
  const dateStr = mealDate ?? new Date().toISOString().split("T")[0];
  const mealTypeStr = mealTime ?? "dinner";
  // eaten_at: 指定日付の 19:00 (JST=UTC+9 → 10:00 UTC) に設定
  const eatenAt = `${dateStr}T10:00:00Z`;

  const resp = await fetch(`${supabaseUrl}/rest/v1/meals`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      user_id: userId,
      eaten_at: eatenAt,
      meal_type: mealTypeStr,
      memo: menuName ?? "E2E Test Meal",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[membership-paste] meals INSERT 失敗 (${resp.status}): ${text.substring(0, 300)}`);
  }

  const rows = (await resp.json()) as Array<{ id: string }>;
  const mealId = rows[0]?.id;
  if (!mealId) throw new Error("[membership-paste] meals INSERT: id が返却されませんでした");
  return mealId;
}

/**
 * POST /api/meals/paste を page コンテキストで呼び出す。
 * 認証 Cookie を自動送信するために page.evaluate を経由する。
 */
export async function pasteToFamily(
  page: import("@playwright/test").Page,
  params: {
    sourceMealId: string;
    targetUserIds: string[];
  },
): Promise<{ status: number; pasteGroupId: string | null; insertedCount: number }> {
  const { sourceMealId, targetUserIds } = params;

  const result = await page.evaluate(
    async (args: { sourceMealId: string; targetUserIds: string[] }) => {
      const res = await fetch("/api/meals/paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          source_meal_id: args.sourceMealId,
          target_user_ids: args.targetUserIds,
        }),
      });
      const body = await res.json().catch(() => ({}));
      return {
        status: res.status,
        body,
      };
    },
    { sourceMealId, targetUserIds },
  );

  const body = result.body as {
    data?: { paste_group_id: string; inserted_count: number };
    error?: { code: string; message: string };
  };

  return {
    status: result.status,
    pasteGroupId: body.data?.paste_group_id ?? null,
    insertedCount: body.data?.inserted_count ?? 0,
  };
}

/**
 * 指定ユーザーの meals 件数を service_role で確認する。
 */
export async function verifyMealsCount(params: {
  userIds: string[];
  expectedCount: number;
  pasteGroupId?: string;
}): Promise<{ counts: Record<string, number> }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const { userIds, pasteGroupId } = params;
  const counts: Record<string, number> = {};

  for (const userId of userIds) {
    let url = `${supabaseUrl}/rest/v1/meals?user_id=eq.${userId}&select=id`;
    if (pasteGroupId) {
      url += `&paste_group_id=eq.${pasteGroupId}`;
    }

    const resp = await fetch(url, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "count=exact",
      },
    });

    if (!resp.ok) {
      counts[userId] = -1;
      continue;
    }

    const contentRange = resp.headers.get("Content-Range");
    if (contentRange) {
      const match = /\/(\d+)$/.exec(contentRange);
      counts[userId] = match ? parseInt(match[1], 10) : 0;
    } else {
      const rows = (await resp.json()) as unknown[];
      counts[userId] = Array.isArray(rows) ? rows.length : 0;
    }
  }

  return { counts };
}

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー: family クリーンアップ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * family_groups / family_members / user_profiles.family_id を一括クリーンアップ。
 * spec 完了後に呼ぶ。
 */
export async function cleanupFamily(params: {
  familyId: string;
  memberIds: string[];
}): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const { familyId, memberIds } = params;

  // user_profiles.family_id をリセット
  for (const userId of memberIds) {
    await updateUserFamilyId({ userId, familyId: null, supabaseUrl, serviceRoleKey }).catch(
      (e) => console.warn("[membership-paste] cleanup user_profiles family_id:", e),
    );
  }

  // family_members 削除
  await fetch(`${supabaseUrl}/rest/v1/family_members?family_id=eq.${familyId}`, {
    method: "DELETE",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
  }).catch((e) => console.warn("[membership-paste] cleanup family_members:", e));

  // family_groups 削除
  await fetch(`${supabaseUrl}/rest/v1/family_groups?id=eq.${familyId}`, {
    method: "DELETE",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
  }).catch((e) => console.warn("[membership-paste] cleanup family_groups:", e));
}

/**
 * 指定ユーザーの meals を全件削除 (クリーンアップ用)。
 */
export async function cleanupUserMeals(userId: string): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  await fetch(`${supabaseUrl}/rest/v1/meals?user_id=eq.${userId}`, {
    method: "DELETE",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
  }).catch((e) => console.warn("[membership-paste] cleanup meals:", e));
}

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー: share_settings 確認
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role で family_members.share_* を確認する。
 */
export async function getFamilyMemberShareSettings(params: {
  familyId: string;
  userId: string;
}): Promise<{ share_meals: boolean; share_health: boolean; share_menu: boolean } | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/family_members?family_id=eq.${params.familyId}&user_id=eq.${params.userId}&select=share_meals,share_health,share_menu`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );

  if (!resp.ok) return null;

  const rows = (await resp.json()) as Array<{
    share_meals: boolean;
    share_health: boolean;
    share_menu: boolean;
  }>;
  return rows[0] ?? null;
}

/**
 * PATCH /api/family/members/me/share を page コンテキストで呼び出す。
 */
export async function patchShareSettings(
  page: import("@playwright/test").Page,
  settings: {
    share_meals?: boolean;
    share_health?: boolean;
    share_menu?: boolean;
  },
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async (args: { share_meals?: boolean; share_health?: boolean; share_menu?: boolean }) => {
      const res = await fetch("/api/family/members/me/share", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(args),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    },
    settings,
  );
}
