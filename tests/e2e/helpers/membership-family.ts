/**
 * tests/e2e/helpers/membership-family.ts
 *
 * family 系 E2E テスト共通ヘルパー関数群。
 * API 呼び出し・UI 操作の抽象化レイヤー。
 *
 * 各関数は Playwright の page オブジェクトや Supabase service_role key を使い、
 * spec ファイル内でのボイラープレートを削減する。
 */

import type { Page } from "@playwright/test";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });
// worktree 環境 (agent-XXXXXXXX 配下) では 6 段上が monorepo ルート
dotenvConfig({ path: path.resolve(__dirname, "../../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../../.env.local") });

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

function getSupabaseConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "[membership-family helper] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。",
    );
  }

  return { supabaseUrl, serviceRoleKey };
}

// ─────────────────────────────────────────────────────────────────────────────
// service_role 直接 API ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role key を使って Supabase REST API を直接叩く汎用ヘルパー。
 * テスト用の事前準備 / クリーンアップに使用する。
 */
async function serviceApiFetch(
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    prefer?: string;
  } = {},
): Promise<{ status: number; body: unknown }> {
  const { supabaseUrl, serviceRoleKey } = getSupabaseConfig();

  const headers: Record<string, string> = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  if (options.prefer) {
    headers["Prefer"] = options.prefer;
  }

  const resp = await fetch(`${supabaseUrl}/rest/v1/${endpoint}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    body = await resp.text();
  }

  return { status: resp.status, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// createFreshFamily
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role API 経由で family グループを直接作成する。
 * owner として指定したユーザを representative として family_members に INSERT する。
 *
 * @param ownerToken - owner ユーザの access_token (API 認証用ではなく user_id 取得に使用)
 * @param ownerUserId - owner の user_id
 * @param name - family グループ名
 * @returns family_id
 */
export async function createFreshFamily(params: {
  ownerUserId: string;
  name: string;
}): Promise<string> {
  const { supabaseUrl, serviceRoleKey } = getSupabaseConfig();

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
      name: params.name,
      representative_id: params.ownerUserId,
      plan_key: "free",
    }),
  });

  if (!groupResp.ok) {
    const text = await groupResp.text();
    throw new Error(
      `[membership-family] family_groups INSERT 失敗 (${groupResp.status}): ${text.substring(0, 300)}`,
    );
  }

  const groups = (await groupResp.json()) as Array<{ id: string }>;
  if (!groups[0]?.id) {
    throw new Error("[membership-family] family_groups INSERT: id が返却されませんでした");
  }
  const familyId = groups[0].id;

  // family_members (representative) INSERT
  const memberResp = await fetch(`${supabaseUrl}/rest/v1/family_members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      family_id: familyId,
      user_id: params.ownerUserId,
      role: "representative",
      display_name: "代表者",
      share_meals: true,
      share_health: false,
      share_menu: true,
    }),
  });

  if (!memberResp.ok) {
    const text = await memberResp.text();
    throw new Error(
      `[membership-family] family_members INSERT 失敗 (${memberResp.status}): ${text.substring(0, 300)}`,
    );
  }

  // user_profiles.family_id を更新
  const profileResp = await fetch(
    `${supabaseUrl}/rest/v1/user_profiles?id=eq.${params.ownerUserId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ family_id: familyId }),
    },
  );

  if (!profileResp.ok) {
    console.warn("[membership-family] user_profiles.family_id 更新失敗");
  }

  return familyId;
}

// ─────────────────────────────────────────────────────────────────────────────
// createFamilyInviteAsOwner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role API 経由で family 招待を直接作成する。
 * テスト用のため Resend メール送信は行わない (token を返すのみ)。
 *
 * @returns invite token (hex string)
 */
export async function createFamilyInviteAsOwner(params: {
  familyId: string;
  ownerUserId: string;
  email: string;
  role?: "adult";
}): Promise<string> {
  const { supabaseUrl, serviceRoleKey } = getSupabaseConfig();

  // token 生成 (32 bytes hex = 64 chars)
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const resp = await fetch(`${supabaseUrl}/rest/v1/family_invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      family_id: params.familyId,
      email: params.email.toLowerCase(),
      token,
      invited_role: params.role ?? "adult",
      status: "pending",
      expires_at: expiresAt,
      invited_by: params.ownerUserId,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[membership-family] family_invites INSERT 失敗 (${resp.status}): ${text.substring(0, 300)}`,
    );
  }

  return token;
}

// ─────────────────────────────────────────────────────────────────────────────
// acceptFamilyInvite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Playwright page を使って /invite/family/{token} ページで招待を受諾する。
 * 共有設定 toggle の状態を指定できる。
 *
 * @param token - 招待トークン
 * @param userPage - 招待受諾ユーザのログイン済み page
 * @param share_meals - 食事記録共有 (default: true)
 * @param share_health - 健康記録共有 (default: false)
 * @param share_menu - 週間献立共有 (default: true)
 */
export async function acceptFamilyInvite(params: {
  token: string;
  userPage: import("@playwright/test").Page;
  share_meals?: boolean;
  share_health?: boolean;
  share_menu?: boolean;
}): Promise<void> {
  const { token, userPage } = params;
  const share_meals = params.share_meals ?? true;
  const share_health = params.share_health ?? false;
  const share_menu = params.share_menu ?? true;

  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

  await userPage.goto(`${baseURL}/invite/family/${token}`);

  // 承諾モーダル / ページが表示されるまで待機
  await userPage.waitForSelector(
    '[data-testid="family-invite-accept"], button:has-text("承諾する"), h1:has-text("招待")',
    { timeout: 20_000 },
  );

  // 共有設定 toggle の操作
  const mealsToggle = userPage.locator('[data-testid="share-meals-toggle"], input[name="share_meals"]');
  const healthToggle = userPage.locator('[data-testid="share-health-toggle"], input[name="share_health"]');
  const menuToggle = userPage.locator('[data-testid="share-menu-toggle"], input[name="share_menu"]');

  // toggle が存在すれば desired state に設定
  const togglesVisible = await mealsToggle.count() > 0;
  if (togglesVisible) {
    const mealsChecked = await mealsToggle.isChecked().catch(() => null);
    if (mealsChecked !== null && mealsChecked !== share_meals) {
      await mealsToggle.click();
    }

    const healthChecked = await healthToggle.isChecked().catch(() => null);
    if (healthChecked !== null && healthChecked !== share_health) {
      await healthToggle.click();
    }

    const menuChecked = await menuToggle.isChecked().catch(() => null);
    if (menuChecked !== null && menuChecked !== share_menu) {
      await menuToggle.click();
    }
  }

  // 承諾ボタンクリック
  const acceptBtn = userPage.locator('button:has-text("承諾する")');
  await acceptBtn.click();

  // 成功後のリダイレクトを待つ
  await userPage.waitForURL(
    (url) =>
      url.pathname.startsWith("/family") ||
      url.pathname.startsWith("/home") ||
      url.pathname === "/",
    { timeout: 20_000 },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// addChild
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role API 経由で子供メンバを直接 INSERT する。
 * @returns family_members.id (member_id)
 */
export async function addChild(params: {
  familyId: string;
  ownerUserId: string;
  name: string;
  birth_date?: string;
  age?: number;
}): Promise<string> {
  const { supabaseUrl, serviceRoleKey } = getSupabaseConfig();

  const childProfile: Record<string, unknown> = {
    age: params.age ?? 8,
    gender: "unspecified",
    allergies: [],
  };
  if (params.birth_date) {
    childProfile.birth_date = params.birth_date;
  }

  const resp = await fetch(`${supabaseUrl}/rest/v1/family_members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      family_id: params.familyId,
      user_id: null,
      role: "child",
      display_name: params.name,
      child_profile: childProfile,
      share_meals: true,
      share_health: false,
      share_menu: true,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[membership-family] addChild: family_members INSERT 失敗 (${resp.status}): ${text.substring(0, 300)}`,
    );
  }

  const rows = (await resp.json()) as Array<{ id: string }>;
  if (!rows[0]?.id) {
    throw new Error("[membership-family] addChild: member id が返却されませんでした");
  }
  return rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// promoteChild
// ─────────────────────────────────────────────────────────────────────────────

/**
 * service_role API 経由で子供メンバを実 user に紐付ける (promote)。
 * family_members.user_id = userId を SET し、child_profile = NULL にする。
 */
export async function promoteChild(params: {
  memberId: string;
  ownerUserId: string;
  targetUserId: string;
}): Promise<void> {
  const { supabaseUrl, serviceRoleKey } = getSupabaseConfig();

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/family_members?id=eq.${params.memberId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: params.targetUserId,
        child_profile: null,
      }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[membership-family] promoteChild 失敗 (${resp.status}): ${text.substring(0, 300)}`,
    );
  }

  // user_profiles.family_id を更新
  const memberResp = await serviceApiFetch(
    `family_members?id=eq.${params.memberId}&select=family_id`,
  );
  const memberRows = memberResp.body as Array<{ family_id: string }>;
  if (memberRows[0]?.family_id) {
    await fetch(
      `${supabaseUrl}/rest/v1/user_profiles?id=eq.${params.targetUserId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ family_id: memberRows[0].family_id }),
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * テスト後のクリーンアップ。
 * family_groups を削除する (CASCADE で family_members / family_invites も消える)。
 * auth users は Supabase admin API で別途削除する。
 */
export async function cleanupFamily(params: {
  familyId: string;
  userIds?: string[];
}): Promise<void> {
  const { supabaseUrl, serviceRoleKey } = getSupabaseConfig();

  // family_groups DELETE (family_members は CASCADE で消える)
  const resp = await fetch(
    `${supabaseUrl}/rest/v1/family_groups?id=eq.${params.familyId}`,
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
      `[membership-family] cleanupFamily family_groups DELETE 失敗 (status: ${resp.status}): ${text.substring(0, 200)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getFamilyMemberFromDB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DB から family_members 行を直接取得する (assertion 用)。
 */
export async function getFamilyMemberFromDB(params: {
  familyId: string;
  userId?: string;
  memberId?: string;
}): Promise<Record<string, unknown> | null> {
  let endpoint = `family_members?family_id=eq.${params.familyId}`;
  if (params.userId) {
    endpoint += `&user_id=eq.${params.userId}`;
  }
  if (params.memberId) {
    endpoint += `&id=eq.${params.memberId}`;
  }
  endpoint += "&status=eq.active&select=*";

  const result = await serviceApiFetch(endpoint);
  const rows = result.body as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/**
 * DB から family_invites 行を token で直接取得する (assertion 用)。
 */
export async function getFamilyInviteFromDB(
  token: string,
): Promise<Record<string, unknown> | null> {
  const result = await serviceApiFetch(
    `family_invites?token=eq.${token}&select=*`,
  );
  const rows = result.body as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/**
 * DB から family_groups 行を id で直接取得する (assertion 用)。
 */
export async function getFamilyGroupFromDB(
  familyId: string,
): Promise<Record<string, unknown> | null> {
  const result = await serviceApiFetch(
    `family_groups?id=eq.${familyId}&select=*`,
  );
  const rows = result.body as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/**
 * DB から ownership_transfer_proposals 行を取得する (assertion 用)。
 * テーブル名は membership_audit を流用 (action = 'representative_transfer_proposed')
 */
export async function getTransferProposalFromDB(params: {
  familyId: string;
  actorId: string;
}): Promise<Record<string, unknown> | null> {
  const result = await serviceApiFetch(
    `membership_audit?scope=eq.family&scope_id=eq.${params.familyId}&action=eq.representative_transfer_proposed&actor_id=eq.${params.actorId}&select=*&order=created_at.desc&limit=1`,
  );
  const rows = result.body as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 子供メンバーの昇格 (本人同意フロー, #1232) 用ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ログイン済みの page から API を叩く (Cookie が自動で付く)。
 *
 * fixture から渡された直後の page は about:blank で、相対 URL の fetch が
 * "Failed to parse URL" になる。そのときだけ、アプリを描画しない静的ファイル
 * (middleware の matcher 対象外) を開いて、origin と Cookie を使える状態にする。
 */
export async function apiFetch(
  page: Page,
  apiPath: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  if (!/^https?:/.test(page.url())) {
    await page.goto(`${BASE_URL}/robots.txt`);
  }

  return page.evaluate(
    async ({ apiPath, options }: { apiPath: string; options: { method?: string; body?: unknown } }) => {
      const res = await fetch(apiPath, {
        method: options.method ?? "GET",
        headers: options.body ? { "Content-Type": "application/json" } : {},
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: "include",
      });
      let body: unknown;
      try { body = await res.json(); } catch { body = await res.text(); }
      return { status: res.status, body };
    },
    { apiPath, options },
  );
}

/**
 * 画面を開き、読み込みが落ち着くまでに未処理のクライアント例外 (pageerror) が出ていないことを確認する。
 *
 * 画面が壊れて真っ白 (またはエラー画面) になると、後続の「見出しが見える」系の検証は
 * 長いタイムアウトの末に「要素が無い」としか言わない。原因の例外メッセージを先に出すために使う。
 *
 * dev サーバはファイルの変更 (他の作業や Playwright の成果物の書き出しを含む) のたびに再ビルドし、
 * その最中に開くと、チャンクが欠けている・途中までしか書かれていない状態で配信されて
 * 一瞬だけ例外になることがある (ChunkLoadError / "Invalid or unexpected token" など)。
 * そのため、例外が出たときは警告を出して 1 回だけ開き直す。
 * アプリ側の不具合なら開き直しても同じ例外が出るので、2 回目で失敗として報告される。
 */
export async function gotoWithoutClientErrors(page: Page, url: string): Promise<void> {
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; ; attempt++) {
    const errors: string[] = [];
    const onPageError = (error: Error) => {
      errors.push(error.message);
    };

    page.on("pageerror", onPageError);
    try {
      await page.goto(url);
      // dev サーバの常時通信などで networkidle にならなくても、検証自体は続けられるようにする
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    } finally {
      page.off("pageerror", onPageError);
    }

    if (errors.length === 0) return;

    const summary = [...new Set(errors)].join(" / ");
    if (attempt < MAX_ATTEMPTS) {
      console.warn(
        `[membership-family] ${url} でクライアント例外 (${summary})。dev サーバの再ビルド中の可能性があるため、1 回だけ開き直します`,
      );
      continue;
    }
    throw new Error(`[membership-family] ${url} でクライアント例外が発生しました: ${summary}`);
  }
}

/**
 * service_role で user_profiles を UPSERT する (fresh user に事前に作るプロフィール)。
 *
 * - completed: オンボーディング完了済み (onboarding_completed_at = 現在時刻)
 * - pending:   オンボーディング未着手 (onboarding_started_at / onboarding_completed_at とも NULL)
 */
export async function upsertUserProfileDirect(params: {
  userId: string;
  nickname: string;
  onboarding: "completed" | "pending";
}): Promise<void> {
  const { supabaseUrl, serviceRoleKey } = getSupabaseConfig();

  const resp = await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      id: params.userId,
      nickname: params.nickname,
      age_group: "10s",
      gender: "unspecified",
      roles: ["user"],
      onboarding_started_at: null,
      onboarding_completed_at: params.onboarding === "completed" ? new Date().toISOString() : null,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[membership-family] user_profiles UPSERT 失敗 (${resp.status}): ${text.substring(0, 300)}`,
    );
  }
}

/**
 * DB から user_profiles.family_id を取得する (assertion 用)。
 * 行が無いときは NULL と区別するために throw する (「NULL のまま」の検証が空振りしないように)。
 */
export async function getUserFamilyIdFromDB(userId: string): Promise<string | null> {
  const result = await serviceApiFetch(`user_profiles?id=eq.${userId}&select=family_id`);
  const rows = result.body as Array<{ family_id: string | null }>;
  if (result.status !== 200 || !Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `[membership-family] user_profiles 行が取得できません (userId: ${userId}, status: ${result.status})`,
    );
  }
  return rows[0].family_id;
}

export type PromotionRequestRow = {
  id: string;
  member_id: string;
  email: string;
  /** 64 桁 hex。本人にだけメールで届く同意の証跡 (HTTP レスポンスには載らない) */
  token: string;
  status: "pending" | "accepted" | "rejected" | "revoked" | "expired";
  expires_at: string;
  resolved_by: string | null;
};

/**
 * DB から family_promotion_requests 行を member_id で取得する (新しい順)。
 *
 * token 列は authenticated ロールに列単位 GRANT で読ませていないため、
 * メールの代わりにここ (service_role) から読む。
 */
export async function getPromotionRequestsFromDB(memberId: string): Promise<PromotionRequestRow[]> {
  const result = await serviceApiFetch(
    `family_promotion_requests?member_id=eq.${memberId}&select=id,member_id,email,token,status,expires_at,resolved_by&order=created_at.desc`,
  );
  if (result.status !== 200 || !Array.isArray(result.body)) {
    throw new Error(
      `[membership-family] family_promotion_requests 取得失敗 (status: ${result.status}): ${JSON.stringify(result.body).substring(0, 300)}`,
    );
  }
  return result.body as PromotionRequestRow[];
}

/**
 * 昇格リクエストの有効期限を過去にする (期限切れのテスト用)。
 * status は 'pending' のまま変えない (期限切れは常に expires_at で判定される)。
 */
export async function expirePromotionRequestInDB(requestId: string): Promise<void> {
  const result = await serviceApiFetch(`family_promotion_requests?id=eq.${requestId}`, {
    method: "PATCH",
    body: { expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
    prefer: "return=minimal",
  });
  if (result.status >= 300) {
    throw new Error(
      `[membership-family] family_promotion_requests の期限切れ化に失敗 (status: ${result.status})`,
    );
  }
}

/**
 * pending の昇格リクエストを 1 件取得する (token 付き)。pending が 1 件でなければ throw。
 */
export async function getPendingPromotionRequest(memberId: string): Promise<PromotionRequestRow> {
  const pending = (await getPromotionRequestsFromDB(memberId)).filter((row) => row.status === "pending");
  if (pending.length !== 1) {
    throw new Error(
      `[membership-family] pending の昇格リクエストが ${pending.length} 件です (期待: 1 件, memberId: ${memberId})`,
    );
  }
  return pending[0];
}
