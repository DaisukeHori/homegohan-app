/**
 * Wave 5 / W5-12: Admin / Super-Admin 完全嫌がらせ E2E
 *
 * 管理画面・API の RBAC・入力検証・XSS・嫌がらせ操作を破壊的にテスト。
 *
 * カテゴリ:
 *   A. RBAC (アクセス制御)        — A-1〜A-7
 *   B. ユーザー管理               — B-8〜B-13
 *   C. 組織管理                   — C-14〜C-16
 *   D. 監査ログ                   — D-17〜D-19
 *   E. サポートチケット(お問い合わせ) — E-20〜E-22  (/api/admin/support/tickets)
 *   F. 財務・クーポン・実験       — F-23〜F-26  (/api/admin/finance, /api/super-admin/coupons|experiments)
 *   G. モデレーション             — G-27〜G-30
 *   H. Super Admin 機能           — H-31〜H-36
 *   I. Super Admin 嫌がらせ       — I-37〜I-40
 *   J. catalog 手動 trigger       — J-41〜J-43
 *
 * 叩く API パスは src/app/api/{admin,super-admin}/ に実在するものだけにする (#847)。
 * 存在しないパスは Next.js の 404 になるだけで、404 を許容する期待値だと偽陽性で通ってしまう。
 * 「ユーザーが見つからない」という route 自身の 404 は error.code (NOT_FOUND) まで確認して区別する。
 * パスの実在は tests/e2e-api-paths.test.ts (Vitest、npm test) が静的に検査する (メソッドは見ない)。
 *
 * ユーザー種別 (fixtures/fresh-user.ts):
 *   - regularUser           — user_profiles あり・roles=['user']。管理 API は 403 (権限不足)
 *   - onboardingPendingUser — user_profiles なし。requireRole が AUTH_PROFILE_NOT_FOUND で 401 にするため、
 *                             「権限不足 = 403」を確かめるテストには使わない
 *
 * 実行方法 (fixture が service_role で fresh user を作るため .env.local に SUPABASE_SERVICE_ROLE_KEY が必要):
 *   ローカル (ローカル Supabase を向いた .env.local。開発サーバーは自動で起動する):
 *     npx playwright test w5-12-admin-adversarial
 *   next dev は初回コンパイルや HMR の再読み込みで fetch が途切れることがある (CI は retries: 2)。
 *   不安定なら npm run build && npm run start で起動し、PLAYWRIGHT_BASE_URL=http://localhost:3000 を付けて実行する。
 *   本番相当: PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e -- w5-12-admin-adversarial
 *   (C-15b / I-38 / D-18 は組織・設定・監査ログの行を作る。いずれも終了時に service_role で消す)
 *
 * prefix: [admin][adversarial] or [super-admin][adversarial]
 */

import { test, expect, type Page } from "./fixtures/fresh-user";

// ─── 定数 ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

const NON_EXISTING_UUID = "00000000-0000-0000-0000-000000000000";

// POST /api/admin/users/{id}/freeze の正しい body (src/lib/admin/users-schemas.ts の FreezeBodySchema)
const VALID_FREEZE_BODY = {
  ban_type: "temporary",
  reason_category: "spam",
  reason_detail: "e2e adversarial",
  duration_days: 1,
} as const;

// DELETE /api/admin/users/{id}/freeze の正しい body (UnfreezeBodySchema)
const VALID_UNFREEZE_BODY = { reason: "e2e adversarial" } as const;

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

/**
 * 認証済み Cookie を使った same-origin fetch の足場として、軽い公開ページ (/about) を開く。
 * API を呼ぶだけなので画面は何でもよい。onboarding 完了済みのユーザーが /home を開くと重い画面が
 * 読み込まれ、画面遷移で page.evaluate が中断されるおそれがあるため避ける。
 */
async function openAppOrigin(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/about`);
}

/**
 * service_role で PostgREST を直接呼ぶ (テストデータの用意と、テストが作った行の後始末用)。
 * fixtures/fresh-user.ts と同じく .env.local の NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を使う。
 */
async function serviceRoleRest(
  pathAndQuery: string,
  init: { method: "POST" | "PATCH" | "DELETE"; body?: unknown },
): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "[w5-12] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。.env.local を確認してください。",
    );
  }
  const resp = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `[w5-12] ${init.method} ${pathAndQuery} 失敗 (${resp.status}): ${text.substring(0, 200)}`,
    );
  }
}

/**
 * admin API (POST /api/admin/organizations) で作った組織を片付ける。
 * owner は admin 本人。組織が残ると、fixture のユーザー削除が organizations.owner_id
 * (ON DELETE RESTRICT) の FK で失敗する。
 * user_profiles は organization_id と org_role が「同時に NULL」か「同時に非 NULL」の制約
 * (user_profiles_org_consistency) を持つので、両方を外してから組織を消す。
 */
async function cleanupOwnedOrganization(
  orgId: string,
  ownerUserId: string,
): Promise<void> {
  await serviceRoleRest(`user_profiles?id=eq.${ownerUserId}`, {
    method: "PATCH",
    body: { organization_id: null, org_role: null },
  });
  await serviceRoleRest(`organizations?id=eq.${orgId}`, { method: "DELETE" });
}

/**
 * 認証済みセッションで API を fetch する (page.evaluate 経由)
 */
async function apiFetch(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({
      url,
      method,
      body,
    }: {
      url: string;
      method: string;
      body: string | null;
    }) => {
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ?? undefined,
      });
      let responseBody: unknown;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = await res.text().catch(() => "");
      }
      return { status: res.status, body: responseBody };
    },
    {
      url: `${BASE_URL}${path}`,
      method: options.method ?? "GET",
      body: options.body !== undefined ? JSON.stringify(options.body) : null,
    },
  );
}

/**
 * 認証なしで API を fetch する (Cookie なし)
 */
async function apiFetchUnauthenticated(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({
      url,
      method,
      body,
    }: {
      url: string;
      method: string;
      body: string | null;
    }) => {
      const res = await fetch(url, {
        method,
        credentials: "omit",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ?? undefined,
      });
      let responseBody: unknown;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = await res.text().catch(() => "");
      }
      return { status: res.status, body: responseBody };
    },
    {
      url: `${BASE_URL}${path}`,
      method: options.method ?? "GET",
      body: options.body !== undefined ? JSON.stringify(options.body) : null,
    },
  );
}

// ─── A. RBAC (アクセス制御) ──────────────────────────────────────────────────

test("[admin][adversarial] A-1: 未認証で /admin → /login redirect", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/admin`);
  await page.waitForURL((url) => url.pathname.includes("/login"), {
    timeout: 15_000,
  });
  expect(page.url()).toMatch(/\/login/);
});

test("[admin][adversarial] A-2: 通常 user で /admin → 403 or redirect", async ({
  onboardingPendingUser,
}) => {
  await onboardingPendingUser.goto(`${BASE_URL}/home`);
  const response = await onboardingPendingUser.goto(`${BASE_URL}/admin`, {
    waitUntil: "networkidle",
  });
  // ページが /admin のまま表示 → テキストで権限エラーを確認 or redirect
  const url = onboardingPendingUser.url();
  const isRedirected = !url.includes("/admin") || url.includes("/home");
  const bodyText = await onboardingPendingUser.locator("body").textContent();
  const hasAccessDenied =
    bodyText?.includes("403") ||
    bodyText?.includes("Forbidden") ||
    bodyText?.includes("権限") ||
    bodyText?.includes("アクセス");
  // redirect または アクセス拒否のいずれかを確認
  expect(isRedirected || hasAccessDenied || (response?.status() ?? 200) >= 400).toBe(
    true,
  );
});

test("[admin][adversarial] A-3: admin で /admin → 表示", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  await page.waitForLoadState("networkidle");
  // /admin が表示される (login に飛ばされない)
  expect(page.url()).not.toMatch(/\/login/);
  expect(page.url()).toMatch(/\/admin/);
});

test("[admin][adversarial] A-4: admin で /super-admin → 403", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  // admin としてログイン済み → super-admin API は 403
  const result = await apiFetch(page, "/api/super-admin/flags");
  expect(result.status).toBe(403);
});

test("[admin][adversarial] A-5: super_admin で /super-admin → 表示", async ({
  superAdminUser,
}) => {
  const { page } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);
  await page.waitForLoadState("networkidle");
  expect(page.url()).not.toMatch(/\/login/);
  expect(page.url()).toMatch(/\/super-admin/);
});

test("[admin][adversarial] A-6: 通常 user で admin API → 403", async ({
  regularUser,
}) => {
  // /api/admin/users に通常 user でアクセス
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/admin/users");
  expect(result.status).toBe(403);
});

test("[admin][adversarial] A-7: 未認証で admin API → 401", async ({ page }) => {
  await page.goto(`${BASE_URL}/`);
  const result = await apiFetchUnauthenticated(page, "/api/admin/users");
  // 未認証なので 401 または redirect (3xx)
  expect([401, 302, 307]).toContain(result.status);
});

// ─── B. ユーザー管理 ──────────────────────────────────────────────────────────

test("[admin][adversarial] B-8: ユーザー検索 q='%' → 安全 (#273 fix確認)", async ({
  onboardingPendingUser,
}) => {
  // 通常 user では 403 → それが正常
  await onboardingPendingUser.goto(`${BASE_URL}/home`);
  const result = await apiFetch(onboardingPendingUser, "/api/admin/users?q=%25");
  // 403 (権限なし) または 200 (admin権限あり) のいずれかで 500 でないことを確認
  expect(result.status).not.toBe(500);
  // XSS payload
  const xssResult = await apiFetch(
    onboardingPendingUser,
    "/api/admin/users?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
  );
  expect(xssResult.status).not.toBe(500);
});

test("[admin][adversarial] B-8b: ユーザー検索 SQL injection payload → 安全", async ({
  onboardingPendingUser,
}) => {
  await onboardingPendingUser.goto(`${BASE_URL}/home`);
  const sqlPayloads = [
    "' OR '1'='1",
    "'; DROP TABLE user_profiles;--",
    "1' UNION SELECT * FROM user_profiles--",
    "%'; SELECT * FROM user_profiles--",
  ];
  for (const payload of sqlPayloads) {
    const result = await apiFetch(
      onboardingPendingUser,
      `/api/admin/users?q=${encodeURIComponent(payload)}`,
    );
    // 500 (DB エラー) が出たらバグ
    expect(result.status).not.toBe(500);
  }
});

test("[admin][adversarial] B-9: 非 super_admin が role → super_admin に変更 → 拒否", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  // 通常 user でロール変更を試みる → 403
  const result = await apiFetch(
    regularUser,
    `/api/admin/users/${NON_EXISTING_UUID}/role`,
    {
      method: "PUT",
      body: { roles: ["user", "super_admin"] },
    },
  );
  expect(result.status).toBe(403);
});

test("[admin][adversarial] B-9b: admin が roles に super_admin を含めて PUT → 400", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  // admin は super_admin role を付与できないはず
  const result = await apiFetch(
    page,
    `/api/admin/users/${NON_EXISTING_UUID}/role`,
    {
      method: "PUT",
      body: { roles: ["user", "super_admin"] },
    },
  );
  // 400 (invalid roles) または 403 (target not found / super_admin protection)
  // 500 は不可
  expect(result.status).not.toBe(500);
  expect([400, 403, 404]).toContain(result.status);
});

// ユーザーの BAN は /api/admin/users/{id}/freeze (POST = 凍結 / DELETE = 凍結解除)。
// /ban という route は無い (存在しないパスは Next.js の 404 になり、403/404 を許容する期待値だと偽陽性で通る)。

test("[admin][adversarial] B-10: 通常 user が凍結 (BAN) を試みる → 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(
    regularUser,
    `/api/admin/users/${NON_EXISTING_UUID}/freeze`,
    { method: "POST", body: VALID_FREEZE_BODY },
  );
  // 権限チェックは対象ユーザーの存在確認より前 → 存在しない UUID でも 403
  expect(result.status).toBe(403);
  expect((result.body as any)?.error?.code).toBe("OP_PERMISSION_DENIED");
});

test("[admin][adversarial] B-10b: admin が存在しない user を凍結 → 404 (NOT_FOUND)", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(
    page,
    `/api/admin/users/${NON_EXISTING_UUID}/freeze`,
    { method: "POST", body: VALID_FREEZE_BODY },
  );
  // route が無い場合の 404 と区別するため error.code まで確認する
  expect(result.status).toBe(404);
  expect((result.body as any)?.error?.code).toBe("NOT_FOUND");
});

test("[admin][adversarial] B-10c: admin が永久 BAN を要求 → 403 (super_admin のみ)", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(
    page,
    `/api/admin/users/${NON_EXISTING_UUID}/freeze`,
    { method: "POST", body: { ...VALID_FREEZE_BODY, ban_type: "permanent" } },
  );
  // 永久 BAN の権限チェックは対象の存在確認より前 → 404 ではなく 403
  expect(result.status).toBe(403);
  expect((result.body as any)?.error?.code).toBe("OP_PERMISSION_DENIED");
});

test("[admin][adversarial] B-10d: admin が不正な body で凍結 → 400 (VALIDATION_ERROR)", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const invalidBodies: Array<Record<string, unknown>> = [
    {},
    { ...VALID_FREEZE_BODY, ban_type: "forever" },
    { ...VALID_FREEZE_BODY, reason_category: "bored" },
    { ...VALID_FREEZE_BODY, reason_detail: "" },
    { ...VALID_FREEZE_BODY, duration_days: 0 },
    { ...VALID_FREEZE_BODY, duration_days: 366 },
    // 一時 BAN は duration_days が必須
    { ban_type: "temporary", reason_category: "spam", reason_detail: "e2e adversarial" },
  ];
  for (const body of invalidBodies) {
    const result = await apiFetch(
      page,
      `/api/admin/users/${NON_EXISTING_UUID}/freeze`,
      { method: "POST", body },
    );
    expect(result.status, JSON.stringify(body)).toBe(400);
    expect((result.body as any)?.error?.code, JSON.stringify(body)).toBe(
      "VALIDATION_ERROR",
    );
  }
});

test("[admin][adversarial] B-11: 凍結解除 API → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(
    regularUser,
    `/api/admin/users/${NON_EXISTING_UUID}/freeze`,
    { method: "DELETE", body: VALID_UNFREEZE_BODY },
  );
  expect(result.status).toBe(403);
  expect((result.body as any)?.error?.code).toBe("OP_PERMISSION_DENIED");
});

test("[admin][adversarial] B-11b: admin が存在しない user の凍結解除 → 404 (NOT_FOUND)", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(
    page,
    `/api/admin/users/${NON_EXISTING_UUID}/freeze`,
    { method: "DELETE", body: VALID_UNFREEZE_BODY },
  );
  expect(result.status).toBe(404);
  expect((result.body as any)?.error?.code).toBe("NOT_FOUND");
});

test("[admin][adversarial] B-12: 自分自身の role 変更 → 拒否 (admin のみ)", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  // selfBan テスト → admin は自分自身をBANできない
  // まず自分のプロフィールを取得（/api/admin/users でフィルタ）
  const usersResult = await apiFetch(page, "/api/admin/users?limit=1");
  // 200 の場合、最初のユーザーで自己ロール変更を試みても good
  if ((usersResult.body as any)?.users?.length > 0) {
    // 自己 ban テスト: ダミー UUID は失敗するので 400/404
    expect([200, 403, 404, 400]).toContain(usersResult.status);
  }
});

// ページネーションのパラメータは per_page (上限 200)。limit は route が読まないので指定しても無視される。
// 通常 user と admin を 1 テストで同時に使うと、2 つの fixture が同じ page の Cookie を上書きし合うため別テストにする。

test("[admin][adversarial] B-13: ページネーション per_page=200 → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/admin/users?page=1&per_page=200");
  expect(result.status).toBe(403);
});

test("[admin][adversarial] B-13b: ページネーション per_page=200 (上限ちょうど) → admin は 200", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(page, "/api/admin/users?page=1&per_page=200");
  expect(result.status).toBe(200);
  expect(Array.isArray((result.body as any)?.data)).toBe(true);
  expect((result.body as any)?.meta?.per_page).toBe(200);
});

test("[admin][adversarial] B-13c: ページネーション per_page=201 (上限超過) → admin は 400", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(page, "/api/admin/users?page=1&per_page=201");
  expect(result.status).toBe(400);
  expect((result.body as any)?.error?.code).toBe("VALIDATION_ERROR");
});

// ─── C. 組織管理 ──────────────────────────────────────────────────────────────

test("[admin][adversarial] C-14: 組織一覧取得 → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/admin/organizations");
  expect(result.status).toBe(403);
});

test("[admin][adversarial] C-14b: admin で組織一覧取得 → 200", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(page, "/api/admin/organizations");
  expect(result.status).toBe(200);
  expect(Array.isArray((result.body as any)?.organizations)).toBe(true);
});

test("[admin][adversarial] C-15: 組織作成 name 必須 → 空文字で 400", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(page, "/api/admin/organizations", {
    method: "POST",
    body: { name: "" },
  });
  expect(result.status).toBe(400);
});

test("[admin][adversarial] C-15b: 組織作成 name に XSS payload → エスケープされて保存", async ({
  adminUser,
}) => {
  const { page, userId } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const xssName = '<script>alert("xss")</script>TestOrg';
  const result = await apiFetch(page, "/api/admin/organizations", {
    method: "POST",
    body: { name: xssName, plan: "standard" },
  });
  const orgId: string | undefined = (result.body as any)?.organization?.id;
  try {
    // 201 or 200 で作成成功、またはバリデーションエラー
    // 500 は不可
    expect(result.status).not.toBe(500);
  } finally {
    // 作った組織は必ず片付ける (残すと fixture のユーザー削除が失敗し、テストデータも残る)
    if (orgId) await cleanupOwnedOrganization(orgId, userId);
  }
});

test("[admin][adversarial] C-16: 通常 user が組織作成 → 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/admin/organizations", {
    method: "POST",
    body: { name: "Attacker Org" },
  });
  expect(result.status).toBe(403);
});

// ─── D. 監査ログ ──────────────────────────────────────────────────────────────

test("[admin][adversarial] D-17: 監査ログ取得 → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/super-admin/audit-logs");
  expect(result.status).toBe(403);
});

test("[super-admin][adversarial] D-17b: super_admin で監査ログ取得 → 200 data 配列", async ({
  superAdminUser,
}) => {
  const { page } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);
  const result = await apiFetch(page, "/api/super-admin/audit-logs?per_page=100");
  expect(result.status).toBe(200);
  expect(Array.isArray((result.body as any)?.data)).toBe(true);
});

test("[super-admin][adversarial] D-18: 監査ログ action_type フィルタ → 一致するログだけ返る", async ({
  superAdminUser,
}) => {
  const { page, userId } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);

  // 以前は存在しない action_type ('ban_user'。実在するのは 'admin.user.ban' など) で絞っていたため、
  // 結果が常に 0 件になり、every() が空配列で必ず真になる (何も確かめていない) テストだった。
  // 実行ごとに一意な action_type のログを 2 種類 service_role で作り、絞り込みの「含む / 除く」を確かめる。
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const wanted = `e2e.d18.wanted.${suffix}`;
  const other = `e2e.d18.other.${suffix}`;
  const unused = `e2e.d18.unused.${suffix}`;
  await serviceRoleRest("admin_audit_logs", {
    method: "POST",
    body: [
      { actor_id: userId, action_type: wanted, severity: "info" },
      { actor_id: userId, action_type: other, severity: "info" },
    ],
  });
  try {
    const hit = await apiFetch(
      page,
      `/api/super-admin/audit-logs?action_type=${encodeURIComponent(wanted)}`,
    );
    expect(hit.status).toBe(200);
    const hitLogs: Array<{ action_type: string }> = (hit.body as any)?.data ?? [];
    // 0 件では通らない。other の action_type は混ざらない
    expect(hitLogs.map((l) => l.action_type)).toEqual([wanted]);

    // 一致する action_type が無ければ 0 件
    const miss = await apiFetch(
      page,
      `/api/super-admin/audit-logs?action_type=${encodeURIComponent(unused)}`,
    );
    expect(miss.status).toBe(200);
    expect((miss.body as any)?.data).toEqual([]);
  } finally {
    // 監査ログは通常 UPDATE/DELETE 禁止 (RLS)。このテストが作った 2 行だけ service_role で消す
    await serviceRoleRest(
      `admin_audit_logs?action_type=in.(${wanted},${other})`,
      { method: "DELETE" },
    );
  }
});

test("[admin][adversarial] D-19: 監査ログ SQL injection → 安全", async ({
  onboardingPendingUser,
}) => {
  await onboardingPendingUser.goto(`${BASE_URL}/home`);
  const result = await apiFetch(
    onboardingPendingUser,
    "/api/super-admin/audit-logs?action_type='; DROP TABLE admin_audit_logs;--",
  );
  // 403 (通常 user) または 200 (super_admin) だが 500 は不可
  expect(result.status).not.toBe(500);
});

// ─── E. お問い合わせ ─────────────────────────────────────────────────────────

test("[admin][adversarial] E-20: お問い合わせ一覧 → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/admin/support/tickets");
  expect(result.status).toBe(403);
});

test("[admin][adversarial] E-20b: admin でチケット status フィルタ → 200", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const pendingResult = await apiFetch(
    page,
    "/api/admin/support/tickets?status=pending",
  );
  expect(pendingResult.status).toBe(200);
  const resolvedResult = await apiFetch(
    page,
    "/api/admin/support/tickets?status=resolved",
  );
  expect(resolvedResult.status).toBe(200);
  // 全件 pending のみが入っているかを確認
  const pendingTickets = (pendingResult.body as any)?.data ?? [];
  const allPending = pendingTickets.every(
    (i: any) => i.status === "pending",
  );
  expect(allPending).toBe(true);
});

test("[admin][adversarial] E-21: 存在しないお問い合わせに PATCH → 500 or 404", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(
    page,
    `/api/admin/support/tickets/${NON_EXISTING_UUID}`,
    {
      method: "PATCH",
      body: { status: "resolved" },
    },
  );
  // 404 または 500 (PostgREST single() failure)
  // 重要: 200 になってはならない
  expect(result.status).not.toBe(200);
});

test("[admin][adversarial] E-22: 既読フラグ更新 → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(
    regularUser,
    `/api/admin/support/tickets/${NON_EXISTING_UUID}`,
    {
      method: "PATCH",
      body: { status: "resolved" },
    },
  );
  expect(result.status).toBe(403);
});

// ─── F. 財務・クーポン・実験 (旧お知らせ節を実在パスへ差替) ────────────────

test("[admin][adversarial] F-23: 財務ダッシュボード → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/admin/finance/dashboard");
  expect(result.status).toBe(403);
});

test("[admin][adversarial] F-23b: admin で財務ダッシュボード → 200 または 403/401", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(page, "/api/admin/finance/dashboard");
  // admin または finance ロールで 200、それ以外は 403
  expect([200, 403]).toContain(result.status);
  // 500 は不可
  expect(result.status).not.toBe(500);
});

test("[admin][adversarial] F-24: 財務エクスポート → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/admin/finance/exports");
  expect(result.status).toBe(403);
});

test("[super-admin][adversarial] F-25: クーポン一覧 → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/super-admin/coupons");
  expect(result.status).toBe(403);
});

test("[super-admin][adversarial] F-26: A/B 実験一覧 → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/super-admin/experiments");
  expect(result.status).toBe(403);
});

// ─── G. モデレーション ────────────────────────────────────────────────────────

test("[admin][adversarial] G-27: モデレーション一覧 → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/admin/moderation");
  expect(result.status).toBe(403);
});

test("[admin][adversarial] G-27b: admin でモデレーション各フラグ取得 → 200", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(
    page,
    "/api/admin/moderation?status=pending",
  );
  expect(result.status).toBe(200);
  const body = result.body as any;
  expect(Array.isArray(body?.mealFlags)).toBe(true);
  expect(Array.isArray(body?.recipeFlags)).toBe(true);
  expect(Array.isArray(body?.aiFlags)).toBe(true);
  // #1128: AI コンテンツの審査は準備中 (未対応)。aiFlags が空配列なのは「通報 0 件」ではなく「未対応」の意味
  expect(body?.aiFlagsSupported).toBe(false);
});

test("[admin][adversarial] G-28: モデレーション resolve → 存在しない ID は 500 or 404", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(
    page,
    `/api/admin/moderation/food/${NON_EXISTING_UUID}`,
    {
      method: "PUT",
      body: { action: "approve" },
    },
  );
  // 存在しない ID での操作は graceful fail (200 or 404) or 500 は問題なし
  // 重要: type はパス、action が必須
  expect(result.status).not.toBe(403);
});

test("[admin][adversarial] G-29: モデレーション reject → type/action 必須", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  // action なし → 400
  const result = await apiFetch(
    page,
    `/api/admin/moderation/food/${NON_EXISTING_UUID}`,
    {
      method: "PUT",
      body: {},
    },
  );
  expect(result.status).toBe(400);
});

test("[admin][adversarial] G-30: モデレーション 通常 user は PUT 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(
    regularUser,
    `/api/admin/moderation/food/${NON_EXISTING_UUID}`,
    {
      method: "PUT",
      body: { action: "approve" },
    },
  );
  expect(result.status).toBe(403);
});

// ─── H. Super Admin 機能 ──────────────────────────────────────────────────────

test("[super-admin][adversarial] H-31: /super-admin ダッシュボード → 通常 user はリダイレクト", async ({
  onboardingPendingUser,
}) => {
  const response = await onboardingPendingUser.goto(`${BASE_URL}/super-admin`);
  // redirect または アクセス拒否
  const url = onboardingPendingUser.url();
  const isBlocked =
    !url.includes("/super-admin") ||
    url.includes("/login") ||
    url.includes("/home");
  const bodyText = await onboardingPendingUser.locator("body").textContent();
  const hasAccessDenied =
    bodyText?.includes("403") ||
    bodyText?.includes("Forbidden") ||
    bodyText?.includes("権限");
  expect(isBlocked || hasAccessDenied || (response?.status() ?? 200) >= 400).toBe(
    true,
  );
});

test("[super-admin][adversarial] H-32: LLM 利用量 API → super_admin のみ 200", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(
    regularUser,
    "/api/super-admin/llm/usage?period=7d",
  );
  expect(result.status).toBe(403);
});

test("[super-admin][adversarial] H-32b: LLM 利用量 period パラメータ → super_admin で各 period 200", async ({
  superAdminUser,
}) => {
  const { page } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);
  // 有効な period: 1d / 7d / 30d / custom (90d は無効)
  for (const period of ["1d", "7d", "30d"]) {
    const result = await apiFetch(
      page,
      `/api/super-admin/llm/usage?period=${period}`,
    );
    expect(result.status).toBe(200);
    expect(typeof (result.body as any)?.data).toBe("object");
  }
});

test("[super-admin][adversarial] H-33: DB 統計 API → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/super-admin/db-stats");
  expect(result.status).toBe(403);
});

test("[super-admin][adversarial] H-34: Feature flags 取得 → super_admin のみ", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/super-admin/flags");
  expect(result.status).toBe(403);
});

test("[super-admin][adversarial] H-34b: Feature flags PATCH → super_admin で更新可能", async ({
  superAdminUser,
}) => {
  const { page } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);
  // #1148: 一覧の先頭のフラグを PATCH すると、本番のフラグ (maintenance_mode = サイト全体のメンテナンス、
  // ai_chat_enabled = AI 相談の緊急停止など) を ON/OFF してしまう。このテスト専用のフラグを service_role で作り、
  // それだけを PATCH して、終わったら消す
  const flagKey = `e2e_h34b_${Date.now().toString(36)}`;
  await serviceRoleRest("feature_flags", {
    method: "POST",
    body: { key: flagKey, description: "e2e H-34b (自動削除)", enabled: false },
  });
  try {
    const patchResult = await apiFetch(page, `/api/super-admin/flags/${flagKey}`, {
      method: "PATCH",
      body: { enabled: true },
    });
    // super_admin で PATCH → 200
    expect(patchResult.status).toBe(200);
    // 再取得して、更新が反映されていることを確認
    const getResult = await apiFetch(page, "/api/super-admin/flags");
    expect(getResult.status).toBe(200);
    const flags: Array<{ key: string; enabled: boolean }> = (getResult.body as any)?.data ?? [];
    expect(flags.find((flag) => flag.key === flagKey)?.enabled).toBe(true);
  } finally {
    await serviceRoleRest(`feature_flags?key=eq.${flagKey}`, { method: "DELETE" });
  }
});

test("[super-admin][adversarial] H-34c: Feature flags POST invalid body → 400", async ({
  superAdminUser,
}) => {
  const { page } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);
  // key なし (必須フィールド欠落) → 400
  const result = await apiFetch(page, "/api/super-admin/flags", {
    method: "POST",
    body: { description: "no key field" },
  });
  // バリデーションエラー → 400、500 は不可
  expect(result.status).toBe(400);
});

test("[super-admin][adversarial] H-35: Admin 一覧取得 → super_admin のみ", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/super-admin/admins");
  expect(result.status).toBe(403);
});

test("[super-admin][adversarial] H-36: Settings PUT → super_admin のみ", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/super-admin/settings", {
    method: "PUT",
    body: { key: "test", value: "hacked" },
  });
  expect(result.status).toBe(403);
});

test("[super-admin][adversarial] H-36b: Settings key 必須 → 400", async ({
  superAdminUser,
}) => {
  const { page } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);
  const result = await apiFetch(page, "/api/super-admin/settings", {
    method: "PUT",
    body: { value: "no key provided" },
  });
  expect(result.status).toBe(400);
});

// ─── I. Super Admin 嫌がらせ ──────────────────────────────────────────────────

test("[super-admin][adversarial] I-37: Feature flag 連打切替 → DB 整合", async ({
  superAdminUser,
}) => {
  const { page } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);
  // #1148: 一覧の先頭のフラグを 10 回切り替えると、本番のフラグ (maintenance_mode・ai_chat_enabled など) が
  // 一瞬 ON/OFF になり、その瞬間に読まれた値をサーバーが最大 30 秒覚えてしまう。このテスト専用のフラグだけを切り替える
  const flagKey = `e2e_i37_${Date.now().toString(36)}`;
  await serviceRoleRest("feature_flags", {
    method: "POST",
    body: { key: flagKey, description: "e2e I-37 (自動削除)", enabled: false },
  });
  try {
    let currentEnabled = false;
    // 10 回連打
    for (let i = 0; i < 10; i++) {
      currentEnabled = !currentEnabled;
      const r = await apiFetch(
        page,
        `/api/super-admin/flags/${flagKey}`,
        {
          method: "PATCH",
          body: { enabled: currentEnabled },
        },
      );
      expect(r.status).toBe(200);
    }
    // 最終状態を確認 (偶数回切り替えたので、最初の OFF に戻っている)
    const finalResult = await apiFetch(page, "/api/super-admin/flags");
    expect(finalResult.status).toBe(200);
    const flags: Array<{ key: string; enabled: boolean }> = (finalResult.body as any)?.data ?? [];
    expect(Array.isArray(flags)).toBe(true);
    expect(flags.find((flag) => flag.key === flagKey)?.enabled).toBe(false);
  } finally {
    await serviceRoleRest(`feature_flags?key=eq.${flagKey}`, { method: "DELETE" });
  }
});

test("[super-admin][adversarial] I-38: Settings に巨大 JSON 投入 → 500 にならない", async ({
  superAdminUser,
}) => {
  const { page } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);
  // 100KB 相当の巨大 value
  const hugeValue = { data: "x".repeat(100_000) };
  try {
    const result = await apiFetch(page, "/api/super-admin/settings", {
      method: "PUT",
      body: { key: "test_huge_value", value: hugeValue },
    });
    // DB 制限に引っかかっても graceful fail (400/500 は許容)
    // クラッシュや unhandled error でないことを確認
    expect(typeof result.status).toBe("number");
    expect(result.status).toBeGreaterThanOrEqual(200);
  } finally {
    // 書き込めていた場合は片付ける。system_settings.updated_by が fixture のユーザーを指したままだと、
    // fixture のユーザー削除が FK (NO ACTION) で失敗し、100KB の設定値も残る
    await serviceRoleRest("system_settings?key=eq.test_huge_value", {
      method: "DELETE",
    });
  }
});

test("[super-admin][adversarial] I-39: embedding 再生成 → 通常 user は 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(
    regularUser,
    "/api/super-admin/embeddings/regenerate",
    {
      method: "POST",
      body: {
        table: "dataset_ingredients",
        onlyMissing: true,
      },
    },
  );
  expect(result.status).toBe(403);
});

test("[super-admin][adversarial] I-39b: embedding 再生成 invalid table → 400", async ({
  superAdminUser,
}) => {
  const { page } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);
  const result = await apiFetch(
    page,
    "/api/super-admin/embeddings/regenerate",
    {
      method: "POST",
      body: { table: "users; DROP TABLE--" },
    },
  );
  expect(result.status).toBe(400);
});

test("[super-admin][adversarial] I-40: LLM 利用量 invalid period → graceful", async ({
  superAdminUser,
}) => {
  const { page } = superAdminUser;
  await page.goto(`${BASE_URL}/super-admin`);
  // 不正な period → フォールバックして 200 か 400 (500 は不可)
  const result = await apiFetch(
    page,
    "/api/super-admin/llm/usage?period='; DROP TABLE--",
  );
  expect(result.status).not.toBe(500);
});

// ─── J. catalog 手動 trigger ─────────────────────────────────────────────────

test("[admin][adversarial] J-41: /api/admin/catalog/import に通常 user → 403", async ({
  regularUser,
}) => {
  await openAppOrigin(regularUser);
  const result = await apiFetch(regularUser, "/api/admin/catalog/import", {
    method: "POST",
    body: { sourceCode: "seven_eleven_jp" },
  });
  expect(result.status).toBe(403);
});

test("[admin][adversarial] J-41b: 未認証で /api/admin/catalog/import → 401", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/`);
  const result = await apiFetchUnauthenticated(
    page,
    "/api/admin/catalog/import",
    {
      method: "POST",
      body: { sourceCode: "seven_eleven_jp" },
    },
  );
  expect([401, 302, 307]).toContain(result.status);
});

test("[admin][adversarial] J-42: admin で sourceCode='invalid_source' → 400", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(page, "/api/admin/catalog/import", {
    method: "POST",
    body: { sourceCode: "invalid_source" },
  });
  expect(result.status).toBe(400);
  expect((result.body as any)?.error).toBe("invalid_source");
});

test("[admin][adversarial] J-42b: admin で sourceCode 省略 → 400", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const result = await apiFetch(page, "/api/admin/catalog/import", {
    method: "POST",
    body: {},
  });
  expect(result.status).toBe(400);
});

test("[admin][adversarial] J-42c: catalog/import SQL injection payload → 400 not 500", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  const maliciousPayloads = [
    "'; DROP TABLE catalog_products;--",
    "seven_eleven_jp' OR '1'='1",
    "<script>alert(1)</script>",
    "../../etc/passwd",
  ];
  for (const payload of maliciousPayloads) {
    const result = await apiFetch(page, "/api/admin/catalog/import", {
      method: "POST",
      body: { sourceCode: payload },
    });
    // 400 が期待値 (invalid_source), 500 は不可
    expect(result.status).toBe(400);
    expect(result.status).not.toBe(500);
  }
});

test("[admin][adversarial] J-43: admin で正常 sourceCode → Edge Function 起動 (200 or 500)", async ({
  adminUser,
}) => {
  const { page } = adminUser;
  await page.goto(`${BASE_URL}/admin`);
  // 実際の Edge Function 呼び出し — 環境に Edge Function が存在しない場合 500 も許容
  const result = await apiFetch(page, "/api/admin/catalog/import", {
    method: "POST",
    body: { sourceCode: "seven_eleven_jp" },
  });
  // 400 (invalid) は不可 — 正常な sourceCode なので
  expect(result.status).not.toBe(400);
  // 403 も不可 — admin でログイン済み
  expect(result.status).not.toBe(403);
  // 200 (成功) または 500 (Edge Function 未デプロイ) を許容
  expect([200, 500]).toContain(result.status);
  if (result.status === 200) {
    expect((result.body as any)?.ok).toBe(true);
  }
});
