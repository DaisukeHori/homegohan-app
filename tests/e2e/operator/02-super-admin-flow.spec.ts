/**
 * tests/e2e/operator/02-super-admin-flow.spec.ts
 *
 * T14 (#856) — super_admin のペルソナの happy path: ログイン → クーポン作成 → プラン変更 → 機能フラグの操作。
 * どの操作も、監査ログ (GET /api/super-admin/audit-logs) に本人の記録が残ることまで確かめる。
 *
 *   T14-S1: 未ログインでは super_admin の API を使えない (401)
 *   T14-S2: 一般の利用者は super_admin の API を使えない (403)
 *   T14-S3: super_admin がクーポンを作ると、一覧に出て、監査ログに記録が残る
 *   T14-S4: super_admin がプランを変更すると (テスト専用の下書きのプランの表示名)、変更が保存され、監査ログに記録が残る
 *   T14-S5: super_admin が機能フラグの画面で、テスト専用のフラグを ON にして OFF に戻すと、保存され、監査ログに 2 件残る
 *   T14-S6: super_admin がクーポンの管理の画面を開ける
 *
 * ユーザー: fixtures/fresh-user.ts の superAdminUser / regularUser (test ごとに新しく作る)。
 * プラン・機能フラグは、本番の設定や他のテストに触れないよう、テスト専用の行を service_role で作って操作し、終わったら消す
 * (#1148: 既存のフラグを切り替えるテストは、本番の緊急スイッチを動かしてしまう)。作ったクーポンも消す。
 *
 * 実行:
 *   npx playwright test tests/e2e/operator
 */

import { test, expect } from "../fixtures/fresh-user";
import { addDaysToDate, todayLocal } from "../../../packages/shared/src/date-utils";
import {
  EMPTY_STORAGE_STATE,
  apiRequest,
  dataOf,
  expectAuditLogEntryShape,
  fetchAuditLogs,
  serviceRoleRest,
} from "../helpers/persona-api";

// 共有のログイン状態 (playwright.config.ts の storageState) を引き継がず、各テストが自分のユーザーで入る
test.use({ storageState: EMPTY_STORAGE_STATE });

// ─── 定数 ────────────────────────────────────────────────────────────────────

/** 画面の要素が出るまで待つ上限 (ほかの spec と同じ。本番ビルドの初回の描画を含めて足りる長さ) */
const PAGE_READY_TIMEOUT_MS = 20_000;

/** テスト用クーポンの有効期間の日数 (開始日 = JST の今日から、この日数後の日まで) */
const TEST_COUPON_VALID_DAYS = 30;

/** テスト用クーポンの割引率 (%) */
const TEST_COUPON_DISCOUNT_PERCENT = 10;

/** テスト用クーポンの最大利用回数 */
const TEST_COUPON_MAX_USES = 100;

/** クーポンの一覧の API から 1 回に読む件数 (src/lib/super-admin/coupons-schemas.ts の per_page の上限以内) */
const COUPON_LIST_PAGE_SIZE = 100;

/** プランの一覧の API から 1 回に読む件数 (src/lib/super-admin/plans-schemas.ts の per_page の上限以内。下書きだけに絞って読む) */
const PLAN_LIST_PAGE_SIZE = 100;

/** 機能フラグの切り替えの監査ログの action_type (src/app/api/super-admin/flags/[key]/route.ts) */
const FEATURE_FLAG_TOGGLE_ACTION_TYPE = "super_admin.feature_flag.toggle";

/** ON にして OFF に戻すので、切り替えの監査ログは 2 件 */
const FEATURE_FLAG_TOGGLE_COUNT = 2;

/** 機能フラグの画面の表の列の位置 (0 始まり。src/app/super-admin/flags/page.tsx の thead の「ステータス」) */
const FLAG_TABLE_STATUS_COLUMN = 3;

/** 衝突しない識別子 (コード・キー) の後ろに付ける文字列 */
function uniqueSuffix(): string {
  return Date.now().toString(36);
}

/** 機能フラグの enabled を DB から読む (画面の表示だけでなく、保存されたことを確かめる) */
async function readFlagEnabled(flagKey: string): Promise<boolean | undefined> {
  const rows = await serviceRoleRest<{ enabled: boolean }>(`feature_flags?key=eq.${flagKey}&select=enabled`, {
    method: "GET",
  });
  return rows[0]?.enabled;
}

// ─── テスト ──────────────────────────────────────────────────────────────────

test.describe("operator/super-admin: クーポン作成 → プラン変更 → 機能フラグの操作 (T14)", () => {
  test("T14-S1: 未ログインで super_admin の API を使うと 401", async ({ page }) => {
    expect((await apiRequest(page, "/api/super-admin/coupons")).status).toBe(401);
    expect((await apiRequest(page, "/api/super-admin/plans")).status).toBe(401);
    expect((await apiRequest(page, "/api/super-admin/flags")).status).toBe(401);
    expect((await apiRequest(page, "/api/super-admin/audit-logs?per_page=5&page=1")).status).toBe(401);
  });

  test("T14-S2: 一般の利用者は super_admin の API に 403 で弾かれる", async ({ regularUser }) => {
    expect((await apiRequest(regularUser, "/api/super-admin/coupons")).status).toBe(403);
    expect((await apiRequest(regularUser, "/api/super-admin/plans")).status).toBe(403);
    expect((await apiRequest(regularUser, "/api/super-admin/flags")).status).toBe(403);
  });

  test("T14-S3: super_admin がクーポンを作ると、一覧に出て、監査ログに記録が残る", async ({ superAdminUser }) => {
    const { page, userId } = superAdminUser;
    const code = `E2ET14${uniqueSuffix().toUpperCase()}`;
    // #1483 / #1510: 有効開始日・有効期限は JST の暦日で送る (toISOString の先頭 10 文字は UTC の暦日なので使わない)
    const validFrom = todayLocal();
    const validUntil = addDaysToDate(validFrom, TEST_COUPON_VALID_DAYS);
    let couponId: string | null = null;

    try {
      const created = await apiRequest(page, "/api/super-admin/coupons", {
        method: "POST",
        body: {
          code,
          discount_type: "percentage",
          discount_value: TEST_COUPON_DISCOUNT_PERCENT,
          applicable_to: "all",
          valid_from: validFrom,
          valid_until: validUntil,
          max_uses: TEST_COUPON_MAX_USES,
          per_user_limit: 1,
        },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const coupon = dataOf(created.body) as Record<string, unknown>;
      expect(typeof coupon.id).toBe("string");
      couponId = coupon.id as string;
      expect(coupon.code).toBe(code);
      expect(coupon.discount_type).toBe("percentage");
      expect(coupon.discount_value).toBe(TEST_COUPON_DISCOUNT_PERCENT);
      expect(coupon.status).toBe("active");
      expect(coupon.created_by).toBe(userId);

      // 一覧に出る
      const list = await apiRequest(page, `/api/super-admin/coupons?per_page=${COUPON_LIST_PAGE_SIZE}&page=1`);
      expect(list.status).toBe(200);
      const coupons = dataOf(list.body) as Array<Record<string, unknown>>;
      expect(coupons.map((c) => c.id)).toContain(couponId);

      // 監査ログに、作った本人のクーポン作成の記録が 1 件残る
      const { status, logs } = await fetchAuditLogs(page, { actionType: "create_coupon", targetId: couponId });
      expect(status).toBe(200);
      expect(logs).toHaveLength(1);
      const [entry] = logs;
      expectAuditLogEntryShape(entry, { actorId: userId });
      expect(entry.action_type).toBe("create_coupon");
      expect(entry.target_type).toBe("coupon");
      expect(entry.severity).toBe("warn");
      expect(entry.details).toEqual(
        expect.objectContaining({ code, discount_type: "percentage", discount_value: TEST_COUPON_DISCOUNT_PERCENT }),
      );
    } finally {
      if (couponId) {
        await serviceRoleRest(`coupons?id=eq.${couponId}`, { method: "DELETE" });
      }
    }
  });

  test("T14-S4: super_admin がプランを変更すると、保存され、監査ログに記録が残る", async ({ superAdminUser }) => {
    const { page, userId } = superAdminUser;
    const suffix = uniqueSuffix();
    // テスト専用の下書きのプラン (公開中のプランは表示名などしか変えられず、契約者にも見える。下書きなら誰にも見えない)
    const [plan] = await serviceRoleRest<{ id: string; plan_key: string }>("subscription_plans", {
      method: "POST",
      body: {
        plan_key: `e2e_t14_s4_${suffix}`,
        display_name: `E2E T14-S4 ${suffix}`,
        plan_type: "personal",
        status: "draft",
      },
    });
    const newDisplayName = `E2E T14-S4 変更後 ${suffix}`;

    try {
      // 一覧 (下書き) に出る
      const list = await apiRequest(page, `/api/super-admin/plans?status=draft&per_page=${PLAN_LIST_PAGE_SIZE}&page=1`);
      expect(list.status).toBe(200);
      expect((dataOf(list.body) as Array<Record<string, unknown>>).map((p) => p.id)).toContain(plan.id);

      // 表示名を変える
      const patched = await apiRequest(page, `/api/super-admin/plans/${plan.id}`, {
        method: "PATCH",
        body: { display_name: newDisplayName },
      });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect((dataOf(patched.body) as Record<string, unknown>).display_name).toBe(newDisplayName);

      // 保存されている (詳細を読み直す)
      const detail = await apiRequest(page, `/api/super-admin/plans/${plan.id}`);
      expect(detail.status).toBe(200);
      expect((dataOf(detail.body) as Record<string, unknown>).display_name).toBe(newDisplayName);

      // 監査ログに、変更した本人のプラン変更の記録が 1 件残る
      const { status, logs } = await fetchAuditLogs(page, { actionType: "update_plan", targetId: plan.id });
      expect(status).toBe(200);
      expect(logs).toHaveLength(1);
      const [entry] = logs;
      expectAuditLogEntryShape(entry, { actorId: userId });
      expect(entry.action_type).toBe("update_plan");
      expect(entry.target_type).toBe("subscription_plan");
      expect(entry.severity).toBe("info");
      const details = entry.details as { plan_key?: unknown; changes?: Record<string, unknown> };
      expect(details.plan_key).toBe(plan.plan_key);
      expect(details.changes?.display_name).toBe(newDisplayName);
    } finally {
      await serviceRoleRest(`subscription_plans?id=eq.${plan.id}`, { method: "DELETE" });
    }
  });

  test("T14-S5: super_admin が機能フラグの画面でテスト専用のフラグを ON → OFF にすると、保存され、監査ログに残る", async ({
    superAdminUser,
  }) => {
    const { page, userId } = superAdminUser;
    // #1148: 既存のフラグ (maintenance_mode などの緊急スイッチ) には触らず、このテスト専用のフラグだけを切り替える
    const flagKey = `e2e_t14s5_${uniqueSuffix()}`;
    await serviceRoleRest("feature_flags", {
      method: "POST",
      body: { key: flagKey, description: "e2e T14-S5 (自動削除)", enabled: false },
    });

    try {
      await page.goto("/super-admin/flags");
      await expect(page.getByRole("heading", { level: 1, name: "機能フラグ管理" })).toBeVisible({
        timeout: PAGE_READY_TIMEOUT_MS,
      });

      const flagRow = page.locator("tbody tr", { has: page.locator("code", { hasText: flagKey }) });
      const statusCell = flagRow.locator("td").nth(FLAG_TABLE_STATUS_COLUMN);
      await expect(statusCell).toContainText("OFF");

      // ON にする
      await statusCell.getByRole("button").click();
      await expect(statusCell).toContainText("ON");
      await expect.poll(() => readFlagEnabled(flagKey)).toBe(true);

      // OFF に戻す
      await statusCell.getByRole("button").click();
      await expect(statusCell).toContainText("OFF");
      await expect.poll(() => readFlagEnabled(flagKey)).toBe(false);

      // 監査ログに、本人の切り替えの記録が 2 件 (ON と OFF) 残る
      const { status, logs } = await fetchAuditLogs(page, {
        actionType: FEATURE_FLAG_TOGGLE_ACTION_TYPE,
        actorId: userId,
      });
      expect(status).toBe(200);
      const flagLogs = logs.filter((log) => (log.details as { key?: unknown } | null)?.key === flagKey);
      expect(flagLogs).toHaveLength(FEATURE_FLAG_TOGGLE_COUNT);
      for (const entry of flagLogs) {
        expectAuditLogEntryShape(entry, { actorId: userId });
        expect(entry.action_type).toBe(FEATURE_FLAG_TOGGLE_ACTION_TYPE);
        expect(entry.target_type).toBe("feature_flag");
        expect(entry.severity).toBe("info");
      }
      const enabledChanges = flagLogs
        .map((log) => (log.details as { changes?: { enabled?: unknown } }).changes?.enabled)
        .sort();
      expect(enabledChanges).toEqual([false, true]);
    } finally {
      await serviceRoleRest(`feature_flags?key=eq.${flagKey}`, { method: "DELETE" });
    }
  });

  test("T14-S6: super_admin が /super-admin/coupons の画面を表示できる", async ({ superAdminUser }) => {
    const { page } = superAdminUser;

    await page.goto("/super-admin/coupons");

    await expect(page.getByRole("heading", { level: 1, name: "クーポン管理" })).toBeVisible({
      timeout: PAGE_READY_TIMEOUT_MS,
    });
    expect(new URL(page.url()).pathname).toBe("/super-admin/coupons");
  });
});
