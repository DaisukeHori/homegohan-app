/**
 * tests/e2e/fixtures/fresh-user.ts
 *
 * 毎 test で fresh user を生成する Playwright fixture 群。
 * 既存の authedPage (storageState 共有) と共存し、signup/onboarding/tour 系テストで使用する。
 *
 * 3 種類の fixture:
 *   freshUserPage      — signup 直後 (確認メール確認済み + ログイン状態)
 *   onboardingPendingUser — 確認済み + onboarding 未完了
 *   tourPendingUser    — onboarding 完了 + tour 未起動
 */

import { test as base, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

// Node.js 20 は native WebSocket を持たないため ws パッケージを明示的に指定。
// Supabase Realtime クライアントが WebSocket を必要とするが admin API のみ使うため
// 実際の接続は行われない。transport を渡すことで初期化エラーを回避する。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require("ws") as typeof WebSocket;

// worktree 環境でも .env.local を読み込む (2段フォールバック)
dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

const FRESH_USER_PASSWORD = "TestE2E2026!secure";

// ─────────────────────────────────────────────────────────────────────────────
// Supabase admin クライアント (service_role)
// ─────────────────────────────────────────────────────────────────────────────

function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "[fresh-user fixture] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。" +
        ".env.local を確認してください。",
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    // Node.js 20 向け: ws パッケージを WebSocket transport として指定
    realtime: {
      // @ts-expect-error ws は Node.js 用 WebSocket 実装
      transport: ws,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー: ユーザー作成 / クリーンアップ / セッション注入
// ─────────────────────────────────────────────────────────────────────────────

export type FreshUserInfo = {
  id: string;
  email: string;
  password: string;
};

/**
 * admin API で fresh user を作成する。
 * email_confirm: true を指定して即時有効化 (確認メール不要)。
 */
export async function createFreshUser(
  supabaseAdmin: ReturnType<typeof createClient>,
  options?: { emailPrefix?: string },
): Promise<FreshUserInfo> {
  const prefix = options?.emailPrefix ?? "e2e-fresh";
  const random = Math.floor(Math.random() * 100000);
  const email = `${prefix}-${Date.now()}-${random}@homegohan.test`;
  const password = FRESH_USER_PASSWORD;

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(
      `[fresh-user fixture] admin.createUser 失敗: ${error?.message ?? "unknown error"}`,
    );
  }

  return { id: data.user.id, email, password };
}

/**
 * admin API でユーザーを削除する (cleanup)。
 * 失敗した場合は test fail としてエラーを throw する (DB ゴミ残り防止)。
 */
export async function cleanupFreshUser(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
): Promise<void> {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) {
    throw new Error(
      `[fresh-user fixture] admin.deleteUser 失敗 (userId: ${userId}): ${error.message}`,
    );
  }
}

/**
 * anon API でパスワードグラントを行い、Cookie を Playwright コンテキストに注入する。
 * @supabase/ssr は Cookie ベース認証を使用するため localStorage 注入では機能しない。
 * 429 (rate limit) の場合は最大 3 回、指数バックオフでリトライする。
 */
export async function injectSession(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error(
      "[fresh-user fixture] NEXT_PUBLIC_SUPABASE_URL または NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定です。",
    );
  }

  const MAX_RETRIES = 4;
  let resp: Response | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
      },
      body: JSON.stringify({ email, password }),
    });

    if (resp.status !== 429) break;

    // 429: rate limit — wait with exponential backoff before retry
    const waitMs = attempt * 3000; // 3s, 6s, 9s, 12s
    console.warn(
      `[fresh-user fixture] injectSession rate limited (429), attempt ${attempt}/${MAX_RETRIES}. 待機: ${waitMs}ms`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }

  if (!resp || !resp.ok) {
    const body = await resp?.text().catch(() => "") ?? "";
    throw new Error(
      `[fresh-user fixture] セッション取得失敗 (${resp?.status ?? "?"}) after ${MAX_RETRIES} attempts: ${body.substring(0, 300)}`,
    );
  }

  const session = (await resp.json()) as Record<string, unknown>;
  if (!session.access_token) {
    throw new Error("[fresh-user fixture] access_token が含まれていません");
  }

  const supabaseRef = supabaseUrl.replace("https://", "").split(".")[0];
  const cookieName = `sb-${supabaseRef}-auth-token`;

  // baseURL は playwright.config.ts の use.baseURL から取得
  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  const domain = new URL(baseURL).hostname;
  const isSecure = baseURL.startsWith("https");
  const cookieValue = encodeURIComponent(JSON.stringify(session));
  const expiresAt =
    (session.expires_at as number) ?? Math.floor(Date.now() / 1000) + 3600;

  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: cookieName,
      value: cookieValue,
      domain,
      path: "/",
      expires: expiresAt,
      httpOnly: false,
      secure: isSecure,
      sameSite: "Lax",
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー: user_profiles を service_role で REST API 経由 UPSERT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * user_profiles レコードを service_role REST API 経由で UPSERT する。
 * roles / onboarding_completed_at / organization_id を指定して作成する汎用ヘルパー。
 */
async function upsertUserProfile(
  userId: string,
  fields: {
    nickname?: string;
    age_group?: string;
    gender?: string;
    roles?: string[];
    organization_id?: string | null;
    onboarding_completed_at?: string | null;
  },
): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const body = {
    id: userId,
    nickname: fields.nickname ?? "E2E Test User",
    age_group: fields.age_group ?? "30s",
    gender: fields.gender ?? "unspecified",
    roles: fields.roles ?? ["user"],
    onboarding_completed_at: fields.onboarding_completed_at ?? new Date().toISOString(),
    ...(fields.organization_id !== undefined
      ? { organization_id: fields.organization_id }
      : {}),
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
      `[fresh-user fixture] user_profiles UPSERT 失敗 (${resp.status}): ${text.substring(0, 300)}`,
    );
  }
}

/**
 * organizations テーブルに test 用 fresh org を作成する。
 * service_role REST API 経由で INSERT し、新規作成された org の id を返す。
 */
async function createFreshOrganization(nameSuffix?: string): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const orgName = `E2E Test Org ${nameSuffix ?? Date.now()}`;

  const resp = await fetch(`${supabaseUrl}/rest/v1/organizations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ name: orgName, plan: "standard" }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[fresh-user fixture] organizations INSERT 失敗 (${resp.status}): ${text.substring(0, 300)}`,
    );
  }

  const rows = (await resp.json()) as Array<{ id: string }>;
  if (!rows[0]?.id) {
    throw new Error("[fresh-user fixture] organizations INSERT: id が返却されませんでした");
  }
  return rows[0].id;
}

/**
 * organizations テーブルから指定 ID の組織を削除する。
 */
async function deleteFreshOrganization(orgId: string): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/organizations?id=eq.${orgId}`,
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
      `[fresh-user fixture] organizations DELETE 失敗 (orgId: ${orgId}, status: ${resp.status}): ${text.substring(0, 200)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 型定義
// ─────────────────────────────────────────────────────────────────────────────

/**
 * adminUser / operatorUser で use() に渡す情報
 */
export type RoleUserFixtureValue = {
  page: Page;
  userId: string;
  email: string;
  password: string;
  /** operatorUser のみ非 null */
  organizationId: string | null;
};

type FreshUserFixtures = {
  /**
   * signup UI フロー検証用。
   * admin.generateLink で signup トークンを取得し /auth/callback 経由で確認済みにする。
   * use(page) 時点でログイン済み + /auth/verify か /onboarding に遷移した状態。
   */
  freshUserPage: Page;

  /**
   * onboarding テスト用。
   * admin.createUser (email_confirm: true) で即時作成 + session inject。
   * onboarding 未完了状態のため / や /home にアクセスすると /onboarding にリダイレクトされる。
   */
  onboardingPendingUser: Page;

  /**
   * tour テスト用。
   * admin.createUser + user_profiles.onboarding_completed_at = NOW() で挿入 + session inject。
   * onboarding 完了済み + tour 未起動状態。
   */
  tourPendingUser: Page;

  /**
   * admin ロールを持つ fresh user。
   * - createFreshUser + user_profiles に roles=['admin'] / onboarding 完了 を UPSERT
   * - session inject 済み
   * - afterAll で admin.deleteUser (cascade で user_profiles も削除)
   */
  adminUser: RoleUserFixtureValue;

  /**
   * org_admin ロールを持つ fresh user。
   * - createFreshUser + organizations に fresh org を INSERT
   * - user_profiles に roles=['org_admin'] / organization_id / onboarding 完了 を UPSERT
   * - session inject 済み
   * - afterAll で admin.deleteUser + organizations DELETE
   *
   * family/01-invite-accept-share.spec.ts など org 招待 API テストで使用する。
   */
  operatorUser: RoleUserFixtureValue;

  /**
   * super_admin ロールを持つ fresh user。
   * - createFreshUser + user_profiles に roles=['super_admin'] / onboarding 完了 を UPSERT
   * - session inject 済み
   * - afterAll で admin.deleteUser (cascade で user_profiles も削除)
   *
   * /super-admin/* エンドポイント / UI テスト、audit_log 閲覧テストで使用する。
   */
  superAdminUser: RoleUserFixtureValue;
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 実装
// ─────────────────────────────────────────────────────────────────────────────

export const test = base.extend<FreshUserFixtures>({
  /**
   * freshUserPage: signup 直後のページ。
   * admin.generateLink (type: "signup") でトークンを取得し /auth/callback に直接 goto。
   * これにより UI signup フォームを経由した場合と同等の確認済み状態を作る。
   */
  freshUserPage: async ({ page, baseURL }, use) => {
    const supabaseAdmin = getAdminClient();
    const prefix = "e2e-fresh-signup";
    const random = Math.floor(Math.random() * 100000);
    const email = `${prefix}-${Date.now()}-${random}@homegohan.test`;
    const password = FRESH_USER_PASSWORD;
    const appBaseURL = baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

    // 1. admin generateLink でユーザー作成 & 確認トークン取得
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "signup",
      email,
      password,
      options: {
        redirectTo: `${appBaseURL}/auth/callback`,
      },
    });

    if (error || !data.user) {
      throw new Error(
        `[freshUserPage] generateLink 失敗: ${error?.message ?? "unknown"}`,
      );
    }

    const userId = data.user.id;
    const hashedToken = data.properties?.hashed_token;

    if (!hashedToken) {
      await cleanupFreshUser(supabaseAdmin, userId).catch(() => {});
      throw new Error("[freshUserPage] hashed_token が取得できませんでした");
    }

    try {
      // 2. /auth/callback に token_hash を渡してメール確認フローをシミュレート
      const callbackUrl = `${appBaseURL}/auth/callback?token_hash=${hashedToken}&type=signup`;
      await page.goto(callbackUrl);

      // 3. onboarding または /auth/verify に遷移するまで待機
      await page.waitForURL(
        (url) =>
          url.pathname.startsWith("/onboarding") ||
          url.pathname.startsWith("/auth/verify") ||
          url.pathname.startsWith("/home") ||
          url.pathname === "/",
        { timeout: 20_000 },
      );

      await use(page);
    } finally {
      // cleanup: admin.deleteUser (cascade で user_profiles も削除)
      await cleanupFreshUser(supabaseAdmin, userId);
    }
  },

  /**
   * onboardingPendingUser: 確認済み + onboarding 未完了ユーザー。
   * admin.createUser (email_confirm: true) で即時作成し session inject。
   * user_profiles レコードは作成しない (onboarding 未着手状態)。
   */
  onboardingPendingUser: async ({ page }, use) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-fresh-onboarding",
    });

    try {
      // session inject のみ。user_profiles は作成しない (onboarding 未完了)
      await injectSession(page, user.email, user.password);
      await use(page);
    } finally {
      await cleanupFreshUser(supabaseAdmin, user.id);
    }
  },

  /**
   * tourPendingUser: onboarding 完了 + tour 未起動ユーザー。
   * admin.createUser + user_profiles に onboarding_completed_at = NOW() を INSERT。
   * handson_tour_completed_at / handson_tour_skipped_at は NULL (tour 未起動)。
   */
  tourPendingUser: async ({ page }, use) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-fresh-tour",
    });

    try {
      // user_profiles に onboarding 完了済みレコードを service_role で INSERT
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
      const now = new Date().toISOString();

      const profileResp = await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          id: user.id,
          nickname: "E2E Tour Test User",
          age_group: "30s",
          gender: "unspecified",
          onboarding_completed_at: now,
          // handson_tour_completed_at は NULL (デフォルト) — tour 未起動
          // handson_tour_skipped_at は NULL (デフォルト)
        }),
      });

      if (!profileResp.ok) {
        const body = await profileResp.text();
        throw new Error(
          `[tourPendingUser] user_profiles INSERT 失敗 (${profileResp.status}): ${body.substring(0, 300)}`,
        );
      }

      // session inject
      await injectSession(page, user.email, user.password);
      await use(page);
    } finally {
      // admin.deleteUser で cascade 削除 (user_profiles も消える)
      await cleanupFreshUser(supabaseAdmin, user.id);
    }
  },

  /**
   * adminUser: admin ロールを持つ fresh user。
   *
   * 1. admin.createUser (email_confirm: true) で即時ユーザー作成
   * 2. user_profiles に roles=['admin'] / onboarding 完了 を UPSERT
   *    (service_role REST API 経由 — RLS をバイパス)
   * 3. session inject
   * 4. afterAll: admin.deleteUser (cascade で user_profiles も削除)
   *
   * admin ロール判定: src/lib/auth/helpers.ts の requireRole(['admin']) が
   * user_profiles.roles TEXT[] に 'admin' が含まれるかで確認する。
   */
  adminUser: async ({ page }, use) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-fresh-admin",
    });

    try {
      // user_profiles: roles=['admin'] + onboarding 完了で UPSERT
      await upsertUserProfile(user.id, {
        nickname: "E2E Admin User",
        roles: ["admin"],
      });

      // session inject
      await injectSession(page, user.email, user.password);

      await use({
        page,
        userId: user.id,
        email: user.email,
        password: user.password,
        organizationId: null,
      });
    } finally {
      // admin.deleteUser で cascade 削除 (user_profiles も消える)
      await cleanupFreshUser(supabaseAdmin, user.id);
    }
  },

  /**
   * superAdminUser: super_admin ロールを持つ fresh user。
   *
   * 1. admin.createUser (email_confirm: true) で即時ユーザー作成
   * 2. user_profiles に roles=['super_admin'] / onboarding 完了 を UPSERT
   *    (service_role REST API 経由 — RLS をバイパス)
   * 3. session inject
   * 4. afterAll: admin.deleteUser (cascade で user_profiles も削除)
   *
   * super_admin ロール判定: src/app/api/admin/users/[id]/role/route.ts が
   * user_profiles.roles に 'super_admin' が含まれるかで確認する。
   * /super-admin/* 系 API・UI アクセステストに適切。
   */
  superAdminUser: async ({ page }, use) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-fresh-superadmin",
    });

    try {
      // user_profiles: roles=['super_admin'] + onboarding 完了 で UPSERT
      await upsertUserProfile(user.id, {
        nickname: "E2E Super Admin User",
        roles: ["super_admin"],
      });

      // session inject
      await injectSession(page, user.email, user.password);

      await use({
        page,
        userId: user.id,
        email: user.email,
        password: user.password,
        organizationId: null,
      });
    } finally {
      // admin.deleteUser で cascade 削除 (user_profiles も消える)
      await cleanupFreshUser(supabaseAdmin, user.id);
    }
  },

  /**
   * operatorUser: org_admin ロールを持つ fresh user + fresh organization。
   *
   * 1. admin.createUser (email_confirm: true) で即時ユーザー作成
   * 2. organizations テーブルに fresh org を INSERT (service_role REST API)
   * 3. user_profiles に roles=['org_admin'] / organization_id / onboarding 完了 を UPSERT
   * 4. session inject
   * 5. afterAll: admin.deleteUser (cascade) + organizations DELETE
   *
   * org_admin ロール判定: src/app/api/org/invites/route.ts が
   * user_profiles.roles に 'org_admin' が含まれるか AND
   * user_profiles.organization_id が非 null かで確認する。
   *
   * family/01-invite-accept-share.spec.ts の org 招待 API テストに適切。
   */
  operatorUser: async ({ page }, use) => {
    const supabaseAdmin = getAdminClient();
    const user = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-fresh-operator",
    });

    let orgId: string | null = null;

    try {
      // organizations に fresh org を作成
      orgId = await createFreshOrganization(
        `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      );

      // user_profiles: roles=['org_admin'] + organization_id + onboarding 完了 で UPSERT
      await upsertUserProfile(user.id, {
        nickname: "E2E Operator User",
        roles: ["org_admin"],
        organization_id: orgId,
      });

      // session inject
      await injectSession(page, user.email, user.password);

      await use({
        page,
        userId: user.id,
        email: user.email,
        password: user.password,
        organizationId: orgId,
      });
    } finally {
      // user を先に削除 (user_profiles.organization_id FK を解除してから org 削除)
      await cleanupFreshUser(supabaseAdmin, user.id);
      if (orgId) {
        await deleteFreshOrganization(orgId);
      }
    }
  },
});

export { expect } from "@playwright/test";
