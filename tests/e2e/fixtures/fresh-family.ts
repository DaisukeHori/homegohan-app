/**
 * tests/e2e/fixtures/fresh-family.ts
 *
 * family 系 E2E テスト用 Playwright fixture 群。
 * fresh-user.ts の createFreshUser / injectSession / getAdminClient を流用し、
 * 家族グループ + メンバを事前生成するヘルパーを提供する。
 *
 * 2 種類の fixture:
 *   freshFamilyWithOwner        — owner 1 名のみの family
 *   freshFamilyWithMembers      — owner + N 名 adult + M 名 child
 */

import { test as base, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
import {
  createFreshUser,
  cleanupFreshUser,
  injectSession,
  type FreshUserInfo,
} from "./fresh-user";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require("ws") as typeof WebSocket;

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });
// worktree 環境 (agent-XXXXXXXX 配下) では 6 段上が monorepo ルート
dotenvConfig({ path: path.resolve(__dirname, "../../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../../.env.local") });

// ─────────────────────────────────────────────────────────────────────────────
// Supabase admin クライアント
// ─────────────────────────────────────────────────────────────────────────────

function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "[fresh-family fixture] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。",
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
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

// ─────────────────────────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────────────────────────

export type FamilyMemberInfo = {
  userId: string;
  email: string;
  password: string;
  memberId: string;   // family_members.id
  role: "representative" | "adult" | "child";
};

export type FamilyInfo = {
  familyId: string;
  familyName: string;
  owner: FamilyMemberInfo;
  adults: FamilyMemberInfo[];
  children: FamilyMemberInfo[];
};

export type FreshFamilyFixtureValue = {
  /** owner としてセッションが inject された page */
  ownerPage: Page;
  family: FamilyInfo;
  /** cleanup 用 userIds (owner + adults; children は user_id NULL なので不要) */
  userIds: string[];
};

type FreshFamilyFixtures = {
  /**
   * owner 1 名のみの family。
   * ownerPage は session inject 済み、onboarding 完了状態。
   */
  freshFamilyWithOwner: FreshFamilyFixtureValue;

  /**
   * owner + N 名 adult + M 名 child の family。
   * デフォルト: adult=1, child=1
   * ownerPage は session inject 済み。
   */
  freshFamilyWithMembers: FreshFamilyFixtureValue;
};

// ─────────────────────────────────────────────────────────────────────────────
// 内部ヘルパー: service_role REST API でユーザプロファイルを UPSERT
// ─────────────────────────────────────────────────────────────────────────────

async function upsertUserProfile(
  userId: string,
  fields: {
    nickname?: string;
    family_id?: string | null;
    onboarding_completed_at?: string | null;
  },
): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const body = {
    id: userId,
    nickname: fields.nickname ?? "E2E Family User",
    age_group: "30s",
    gender: "unspecified",
    roles: ["user"],
    onboarding_completed_at:
      fields.onboarding_completed_at ?? new Date().toISOString(),
    ...(fields.family_id !== undefined ? { family_id: fields.family_id } : {}),
  };

  const resp = await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[fresh-family fixture] user_profiles UPSERT 失敗 (${resp.status}): ${text.substring(0, 300)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部ヘルパー: family_groups + 最初のメンバ (representative) を直接 INSERT
// ─────────────────────────────────────────────────────────────────────────────

async function createFamilyGroupDirect(
  familyName: string,
  representativeUserId: string,
): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  // family_groups INSERT
  const groupResp = await fetch(`${supabaseUrl}/rest/v1/family_groups`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      name: familyName,
      representative_id: representativeUserId,
      plan_key: "free",
    }),
  });

  if (!groupResp.ok) {
    const text = await groupResp.text();
    throw new Error(
      `[fresh-family fixture] family_groups INSERT 失敗 (${groupResp.status}): ${text.substring(0, 300)}`,
    );
  }

  const groups = (await groupResp.json()) as Array<{ id: string }>;
  if (!groups[0]?.id) {
    throw new Error("[fresh-family fixture] family_groups INSERT: id が返却されませんでした");
  }
  const familyId = groups[0].id;

  return familyId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部ヘルパー: family_members に行を直接 INSERT
// ─────────────────────────────────────────────────────────────────────────────

async function insertFamilyMember(params: {
  familyId: string;
  userId: string | null;
  role: "representative" | "adult" | "child";
  displayName: string;
  childProfile?: Record<string, unknown>;
}): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const body: Record<string, unknown> = {
    family_id: params.familyId,
    role: params.role,
    display_name: params.displayName,
    share_meals: true,
    share_health: false,
    share_menu: true,
  };
  if (params.userId !== null) {
    body.user_id = params.userId;
  }
  if (params.childProfile) {
    body.child_profile = params.childProfile;
  }

  const resp = await fetch(`${supabaseUrl}/rest/v1/family_members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[fresh-family fixture] family_members INSERT 失敗 (${resp.status}): ${text.substring(0, 300)}`,
    );
  }

  const rows = (await resp.json()) as Array<{ id: string }>;
  if (!rows[0]?.id) {
    throw new Error("[fresh-family fixture] family_members INSERT: id が返却されませんでした");
  }
  return rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部ヘルパー: family_groups / family_members / user_profiles.family_id をクリーンアップ
// ─────────────────────────────────────────────────────────────────────────────

async function deleteFamilyGroup(familyId: string): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  // family_members は CASCADE DELETE で連動して消える
  const resp = await fetch(
    `${supabaseUrl}/rest/v1/family_groups?id=eq.${familyId}`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=minimal",
      },
    },
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.warn(
      `[fresh-family fixture] family_groups DELETE 失敗 (familyId: ${familyId}, status: ${resp.status}): ${text.substring(0, 200)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部ヘルパー: family 全体を組み立てる
// ─────────────────────────────────────────────────────────────────────────────

async function buildFamilyFixture(opts: {
  supabaseAdmin: ReturnType<typeof createClient>;
  familyName: string;
  adultCount: number;
  childCount: number;
}): Promise<{ family: FamilyInfo; userIds: string[] }> {
  const { supabaseAdmin, familyName, adultCount, childCount } = opts;

  // 1. owner 作成
  const ownerUser = await createFreshUser(supabaseAdmin, {
    emailPrefix: "e2e-family-owner",
  });
  const userIds: string[] = [ownerUser.id];

  // 2. onboarding 完了プロファイルを作成
  await upsertUserProfile(ownerUser.id, { nickname: "E2E Family Owner" });

  // 3. family_groups を直接 INSERT
  const familyId = await createFamilyGroupDirect(familyName, ownerUser.id);

  // 4. representative メンバ行を INSERT
  const ownerMemberId = await insertFamilyMember({
    familyId,
    userId: ownerUser.id,
    role: "representative",
    displayName: "お母さん",
  });

  // 5. user_profiles.family_id を更新
  await upsertUserProfile(ownerUser.id, {
    nickname: "E2E Family Owner",
    family_id: familyId,
  });

  const owner: FamilyMemberInfo = {
    userId: ownerUser.id,
    email: ownerUser.email,
    password: ownerUser.password,
    memberId: ownerMemberId,
    role: "representative",
  };

  // 6. adult メンバを追加
  const adults: FamilyMemberInfo[] = [];
  for (let i = 0; i < adultCount; i++) {
    const adultUser = await createFreshUser(supabaseAdmin, {
      emailPrefix: `e2e-family-adult${i}`,
    });
    userIds.push(adultUser.id);

    await upsertUserProfile(adultUser.id, {
      nickname: `E2E Adult ${i}`,
      family_id: familyId,
    });

    const adultMemberId = await insertFamilyMember({
      familyId,
      userId: adultUser.id,
      role: "adult",
      displayName: `大人${i + 1}`,
    });

    adults.push({
      userId: adultUser.id,
      email: adultUser.email,
      password: adultUser.password,
      memberId: adultMemberId,
      role: "adult",
    });
  }

  // 7. child メンバを追加 (user_id=NULL)
  const children: FamilyMemberInfo[] = [];
  for (let i = 0; i < childCount; i++) {
    const childMemberId = await insertFamilyMember({
      familyId,
      userId: null,
      role: "child",
      displayName: `子供${i + 1}`,
      childProfile: {
        age: 8 + i,
        gender: i % 2 === 0 ? "male" : "female",
        allergies: [],
      },
    });

    children.push({
      userId: "",  // child は user_id なし
      email: "",
      password: "",
      memberId: childMemberId,
      role: "child",
    });
  }

  return {
    family: {
      familyId,
      familyName,
      owner,
      adults,
      children,
    },
    userIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 実装
// ─────────────────────────────────────────────────────────────────────────────

export const test = base.extend<FreshFamilyFixtures>({
  /**
   * freshFamilyWithOwner: owner 1 名のみの family。
   * ownerPage は session inject 済み + onboarding 完了。
   */
  freshFamilyWithOwner: async ({ page }, use) => {
    const supabaseAdmin = getAdminClient();
    const familyName = `E2E 家族 ${Date.now()}`;

    const { family, userIds } = await buildFamilyFixture({
      supabaseAdmin,
      familyName,
      adultCount: 0,
      childCount: 0,
    });

    try {
      await injectSession(page, family.owner.email, family.owner.password);

      await use({
        ownerPage: page,
        family,
        userIds,
      });
    } finally {
      // cleanup: family グループ削除 (CASCADE で family_members も消える)
      await deleteFamilyGroup(family.familyId);
      // cleanup: auth users 削除
      for (const userId of userIds) {
        await cleanupFreshUser(supabaseAdmin, userId);
      }
    }
  },

  /**
   * freshFamilyWithMembers: owner + 1 adult + 1 child の family (デフォルト)。
   * ownerPage は session inject 済み + onboarding 完了。
   */
  freshFamilyWithMembers: async ({ page }, use) => {
    const supabaseAdmin = getAdminClient();
    const familyName = `E2E 家族 ${Date.now()}`;

    const { family, userIds } = await buildFamilyFixture({
      supabaseAdmin,
      familyName,
      adultCount: 1,
      childCount: 1,
    });

    try {
      await injectSession(page, family.owner.email, family.owner.password);

      await use({
        ownerPage: page,
        family,
        userIds,
      });
    } finally {
      await deleteFamilyGroup(family.familyId);
      for (const userId of userIds) {
        await cleanupFreshUser(supabaseAdmin, userId);
      }
    }
  },
});

export { expect } from "@playwright/test";
