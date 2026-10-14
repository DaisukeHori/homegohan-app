/**
 * tests/e2e/operator/01-admin-flow.spec.ts
 *
 * T14 (#856) — admin のペルソナの happy path: ログイン → モデレーション (通報を 1 件審査) → 監査ログで記録を確かめる
 *
 *   T14-A1: 未ログインで /admin を開くと /login へ回される
 *   T14-A2: 一般の利用者はモデレーションのキューの API を使えない (403)
 *   T14-A3: admin はモデレーションのキューを取得できる
 *   T14-A4: admin はモデレーションの画面を開ける
 *   T14-A5: admin はモデレーションの画面で状態の絞り込みを使える
 *   T14-A6: admin が審査待ちの通報を 1 件承認すると、キューから外れ、super_admin が監査ログで admin の操作の記録を読める
 *   T14-A7: 一般の利用者は監査ログの API を使えない (403)
 *   T14-A8: admin も監査ログの API は使えない (super_admin 専用。403)
 *
 * ユーザー: fixtures/fresh-user.ts の adminUser / regularUser (test ごとに新しく作る)。T14-A6 の監査ログを読む super_admin は、
 * テストの中で作り、別のブラウザのコンテキストで動かす (helpers/persona-api.ts)。
 * 審査する通報は、テスト専用に service_role で作り、終わったら消す (食事に紐づかない通報。承認しても何も隠さない)。
 *
 * 実行:
 *   npx playwright test tests/e2e/operator
 */

import { test, expect } from "../fixtures/fresh-user";
import {
  EMPTY_STORAGE_STATE,
  apiRequest,
  createRoleUser,
  dataOf,
  deleteRoleUser,
  expectAuditLogEntryShape,
  fetchAuditLogs,
  openUserContext,
  serviceRoleRest,
} from "../helpers/persona-api";

// 共有のログイン状態 (playwright.config.ts の storageState) を引き継がず、各テストが自分のユーザーで入る
test.use({ storageState: EMPTY_STORAGE_STATE });

// ─── 定数 ────────────────────────────────────────────────────────────────────

/** 画面の要素が出るまで待つ上限 (ほかの spec と同じ。本番ビルドの初回の描画を含めて足りる長さ) */
const PAGE_READY_TIMEOUT_MS = 20_000;

/** モデレーションのキューの API から 1 回に読む件数 (src/lib/admin/moderation-schemas.ts の per_page の上限) */
const MODERATION_QUEUE_PAGE_SIZE = 100;

/** 審査の操作の監査ログの action_type (src/app/api/admin/moderation/[type]/[id]/route.ts が admin.moderation.{action} で書く) */
const MODERATION_APPROVE_ACTION_TYPE = "admin.moderation.approve";

type ModerationItem = { id?: unknown; type?: unknown; status?: unknown };

/** モデレーションのキュー (食事の通報) に、指定した状態の通報 flagId があるか */
async function queueContains(
  page: import("@playwright/test").Page,
  status: "pending" | "approved",
  flagId: string,
): Promise<boolean> {
  const { status: httpStatus, body } = await apiRequest(
    page,
    `/api/admin/moderation/queue?status=${status}&type=food&per_page=${MODERATION_QUEUE_PAGE_SIZE}&page=1`,
  );
  expect(httpStatus).toBe(200);
  const items = dataOf(body);
  expect(Array.isArray(items)).toBe(true);
  return (items as ModerationItem[]).some((item) => item.id === flagId);
}

// ─── テスト ──────────────────────────────────────────────────────────────────

test.describe("operator/admin: ログイン → モデレーション → 監査ログ (T14)", () => {
  test("T14-A1: 未ログインで /admin を開くと /login へ回される", async ({ page }) => {
    await page.goto("/admin");

    await expect(page).toHaveURL(/\/login(\?|$)/, { timeout: PAGE_READY_TIMEOUT_MS });
  });

  test("T14-A2: 一般の利用者はモデレーションのキューの API に 403 で弾かれる", async ({ regularUser }) => {
    const { status } = await apiRequest(regularUser, "/api/admin/moderation/queue");

    expect(status).toBe(403);
  });

  test("T14-A3: admin がモデレーションのキューの API を 200 で取得できる", async ({ adminUser }) => {
    const { status, body } = await apiRequest(adminUser.page, "/api/admin/moderation/queue");

    expect(status).toBe(200);
    expect(Array.isArray(dataOf(body))).toBe(true);
    const meta = (body as { meta?: Record<string, unknown> }).meta;
    expect(typeof meta?.total).toBe("number");
    expect(meta?.page).toBe(1);
  });

  test("T14-A4: admin が /admin/moderation 画面を表示できる", async ({ adminUser }) => {
    const { page } = adminUser;

    await page.goto("/admin/moderation");

    await expect(page.getByRole("heading", { level: 1, name: "モデレーション" })).toBeVisible({
      timeout: PAGE_READY_TIMEOUT_MS,
    });
    expect(new URL(page.url()).pathname).toBe("/admin/moderation");
    await expect(page.locator("select[name='status']")).toBeVisible();
    await expect(page.locator("table")).toBeVisible();
  });

  test("T14-A5: admin がモデレーションの画面で状態の絞り込みを使える", async ({ adminUser }) => {
    const { page } = adminUser;

    await page.goto("/admin/moderation");
    await expect(page.locator("select[name='status']")).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });

    await page.selectOption("select[name='status']", "approved");
    await page.getByRole("button", { name: "絞り込み" }).click();

    await page.waitForURL(/status=approved/, { timeout: PAGE_READY_TIMEOUT_MS });
    await expect(page.locator("select[name='status']")).toHaveValue("approved");
    await expect(page.locator("table")).toBeVisible();
  });

  test("T14-A6: admin が通報を承認すると、キューから外れ、super_admin が監査ログで記録を読める", async ({
    adminUser,
    browser,
  }) => {
    // テスト専用の審査待ちの通報 (食事に紐づかない。承認しても何も隠さない)
    const [flag] = await serviceRoleRest<{ id: string }>("moderation_flags", {
      method: "POST",
      body: { reason: "e2e T14-A6 (自動削除)", status: "pending" },
    });
    const flagId = flag.id;
    const auditViewer = await createRoleUser({
      emailPrefix: "e2e-t14-audit-viewer",
      nickname: "E2E T14 Audit Viewer",
      roles: ["super_admin"],
    });
    let viewerContext: Awaited<ReturnType<typeof openUserContext>>["context"] | null = null;

    try {
      // 1. admin がキューで審査待ちの通報を見つけ、内容を開いて承認する
      expect(await queueContains(adminUser.page, "pending", flagId)).toBe(true);

      const detail = await apiRequest(adminUser.page, `/api/admin/moderation/food/${flagId}`);
      expect(detail.status).toBe(200);
      expect((dataOf(detail.body) as ModerationItem).status).toBe("pending");

      const resolved = await apiRequest(adminUser.page, `/api/admin/moderation/food/${flagId}`, {
        method: "POST",
        body: { action: "approve", resolution_note: "e2e T14-A6" },
      });
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(dataOf(resolved.body)).toEqual(expect.objectContaining({ success: true, status: "approved" }));

      // 2. 承認した通報は審査待ちのキューから外れ、承認済みのキューに入る
      expect(await queueContains(adminUser.page, "pending", flagId)).toBe(false);
      expect(await queueContains(adminUser.page, "approved", flagId)).toBe(true);

      // 3. super_admin が監査ログで、admin の承認の記録を読める
      const viewer = await openUserContext(browser, auditViewer.email);
      viewerContext = viewer.context;
      const { status, logs } = await fetchAuditLogs(viewer.page, {
        actionType: MODERATION_APPROVE_ACTION_TYPE,
        targetId: flagId,
      });
      expect(status).toBe(200);
      expect(logs).toHaveLength(1);
      const [entry] = logs;
      expectAuditLogEntryShape(entry, { actorId: adminUser.userId });
      expect(entry.action_type).toBe(MODERATION_APPROVE_ACTION_TYPE);
      expect(entry.target_type).toBe("moderation_item:food");
      expect(entry.severity).toBe("info");
      expect(entry.details).toEqual(
        expect.objectContaining({ action: "approve", moderation_type: "food", status_saved: true, hidden: false }),
      );
    } finally {
      await viewerContext?.close();
      await serviceRoleRest(`moderation_flags?id=eq.${flagId}`, { method: "DELETE" });
      await deleteRoleUser(auditViewer.id);
    }
  });

  test("T14-A7: 一般の利用者は監査ログの API に 403 で弾かれる", async ({ regularUser }) => {
    const { status } = await apiRequest(regularUser, "/api/super-admin/audit-logs?per_page=5&page=1");

    expect(status).toBe(403);
  });

  test("T14-A8: admin も監査ログの API は 403 で弾かれる (super_admin 専用)", async ({ adminUser }) => {
    const { status } = await apiRequest(adminUser.page, "/api/super-admin/audit-logs?per_page=5&page=1");

    expect(status).toBe(403);
  });
});
