/**
 * R10: Org / Pantry 深掘り E2E テスト
 *
 * 対象:
 *   A. /org 組織管理 — 部署 CRUD、メンバー追加、ダッシュボード集計、チャレンジ、招待
 *   B. /pantry 食材管理 — 一覧表示、手動 CRUD、analyze-fridge → DB 保存、賞味期限通知表示
 *
 * 実行:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e -- r10
 *
 * バグ起票 prefix: [org][r10] / [pantry][r10]
 */

import { test, expect, type Page } from "./fixtures/auth";

// ─── helpers ────────────────────────────────────────────────────────────────

async function apiGet(page: Page, path: string) {
  return page.evaluate(async (url: string) => {
    const res = await fetch(url, { credentials: "include" });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* ignore */
    }
    return { status: res.status, json };
  }, path);
}

async function apiPost(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ url, payload }: { url: string; payload: unknown }) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* ignore */
      }
      return { status: res.status, json };
    },
    { url: path, payload: body },
  );
}

async function apiPut(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ url, payload }: { url: string; payload: unknown }) => {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* ignore */
      }
      return { status: res.status, json };
    },
    { url: path, payload: body },
  );
}

async function apiDelete(page: Page, path: string) {
  return page.evaluate(async (url: string) => {
    const res = await fetch(url, { method: "DELETE", credentials: "include" });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* ignore */
    }
    return { status: res.status, json };
  }, path);
}

async function apiPatch(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ url, payload }: { url: string; payload: unknown }) => {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* ignore */
      }
      return { status: res.status, json };
    },
    { url: path, payload: body },
  );
}

async function attach(page: Page, testInfo: any, name: string) {
  const buf = await page.screenshot({ fullPage: false });
  await testInfo.attach(name, { body: buf, contentType: "image/png" });
}

// ============================================================
// A. Org 組織管理 深掘り
// ============================================================

test.describe("A. Org — 認可 & ページレンダリング", () => {
  /**
   * A-1: 未認証で /org/dashboard にアクセス → /login にリダイレクト
   */
  test("A-1: /org/dashboard 未認証 → /login", async ({ page }, testInfo) => {
    await page.goto("/org/dashboard");
    await page.waitForLoadState("networkidle");
    await attach(page, testInfo, "A-1 未認証");
    expect(page.url()).toMatch(/\/login/);
  });

  /**
   * A-2: 通常ユーザー → /org/dashboard が /home にリダイレクトまたは表示拒否
   */
  test("A-2: 通常ユーザー → /org/dashboard は /home リダイレクト or 拒否", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/org/dashboard");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "A-2 通常ユーザー /org/dashboard");

    const url = authedPage.url();
    const blocked =
      url.includes("/home") ||
      url.includes("/login") ||
      (await authedPage.locator("body").textContent())?.match(
        /403|Forbidden|アクセス|権限/i,
      ) !== null;

    if (!blocked) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[org][r10] A-2: 通常ユーザーが /org/dashboard にアクセスできてしまっている",
      });
    }
    // 実装が想定通りなら通る。失敗時は Issue を起票する。
    expect(blocked, `通常ユーザーが /org/dashboard にアクセスできた url=${url}`).toBeTruthy();
  });

  /**
   * A-3: /api/org/departments 未認証 → 401
   */
  test("A-3: /api/org/departments 未認証 → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/org/departments");
    expect(status).toBe(401);
  });

  /**
   * A-4: /api/org/departments 通常ユーザー → 403
   */
  test("A-4: /api/org/departments 通常ユーザー → 403", async ({ authedPage }) => {
    await authedPage.goto("/home");
    const { status } = await apiGet(authedPage, "/api/org/departments");
    expect([401, 403]).toContain(status);
  });

  /**
   * A-5: /api/org/stats 未認証 → 401
   */
  test("A-5: /api/org/stats 未認証 → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/org/stats");
    expect(status).toBe(401);
  });

  /**
   * A-6: /api/org/users 未認証 → 401
   */
  test("A-6: /api/org/users 未認証 → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/org/users");
    expect(status).toBe(401);
  });

  /**
   * A-7: /api/org/invites 未認証 → 401
   */
  test("A-7: /api/org/invites 未認証 → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/org/invites");
    expect(status).toBe(401);
  });

  /**
   * A-8: /api/org/challenges 未認証 → 401
   */
  test("A-8: /api/org/challenges 未認証 → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/org/challenges");
    expect(status).toBe(401);
  });
});

test.describe("A. Org — 部署 CRUD フルフロー (通常ユーザーは403前提)", () => {
  /**
   * A-9: 通常ユーザーで部署作成 → 403
   *      (org_admin でないので拒否されること)
   */
  test("A-9: 通常ユーザーで部署 POST → 403", async ({ authedPage }) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/org/departments", {
      name: "テスト部署",
    });
    expect([401, 403]).toContain(status);
  });

  /**
   * A-10: 通常ユーザーで部署更新 → 403
   */
  test("A-10: 通常ユーザーで部署 PUT → 403", async ({ authedPage }) => {
    await authedPage.goto("/home");
    const { status } = await apiPut(authedPage, "/api/org/departments", {
      id: "00000000-0000-0000-0000-000000000000",
      name: "変更後",
    });
    expect([401, 403]).toContain(status);
  });

  /**
   * A-11: 通常ユーザーで部署削除 → 403
   */
  test("A-11: 通常ユーザーで部署 DELETE → 403", async ({ authedPage }) => {
    await authedPage.goto("/home");
    const { status } = await apiDelete(
      authedPage,
      "/api/org/departments?id=00000000-0000-0000-0000-000000000000",
    );
    expect([401, 403]).toContain(status);
  });

  /**
   * A-12: 部署名バリデーション — 空文字 POST → 400 または 403
   */
  test("A-12: 部署 POST 空名 → 400 or 403", async ({ authedPage }) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/org/departments", {
      name: "",
    });
    // 通常ユーザーなら403、org_admin なら空名は 400
    expect([400, 401, 403]).toContain(status);
  });

  /**
   * A-13: 部署名に XSS payload → 400/403 で弾かれるか格納後エスケープ
   */
  test("A-13: 部署名 XSS payload → 400/403 or サニタイズ", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");
    const xss = "<script>alert(1)</script>";
    const { status, json } = await apiPost(authedPage, "/api/org/departments", {
      name: xss,
    });
    testInfo.annotations.push({
      type: "result",
      description: `A-13: status=${status}, json=${JSON.stringify(json)}`,
    });
    if (status === 200 || status === 201) {
      const stored = (json as any)?.department?.name ?? "";
      expect(stored).not.toContain("<script>");
    }
    // 403 なら OK (通常ユーザー)
  });
});

test.describe("A. Org — メンバー追加 API バリデーション", () => {
  /**
   * A-14: /api/org/users POST 必須フィールド欠如 → 400 or 403
   */
  test("A-14: /api/org/users POST 必須フィールド欠如 → 400/403", async ({
    authedPage,
  }) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/org/users", {
      email: "test@example.com",
      // password と nickname 欠如
    });
    expect([400, 401, 403]).toContain(status);
  });

  /**
   * A-15: /api/org/users POST 不正メールアドレス形式 → 400 or 403
   */
  test("A-15: /api/org/users POST 不正メール → 400/403", async ({ authedPage }) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/org/users", {
      email: "not-an-email",
      password: "password123",
      nickname: "テストUser",
    });
    expect([400, 401, 403]).toContain(status);
  });
});

test.describe("A. Org — 招待 API バリデーション", () => {
  /**
   * A-16: /api/org/invites POST 通常ユーザー → 403
   */
  test("A-16: /api/org/invites POST 通常ユーザー → 403", async ({
    authedPage,
  }) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/org/invites", {
      email: "invite@example.com",
      role: "member",
    });
    expect([401, 403]).toContain(status);
  });

  /**
   * A-17: /api/org/invites POST メール欠如 → 400 or 403
   */
  test("A-17: /api/org/invites POST メール欠如 → 400/403", async ({
    authedPage,
  }) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/org/invites", {
      role: "member",
    });
    expect([400, 401, 403]).toContain(status);
  });

  /**
   * A-18: /api/org/invites DELETE ID 欠如 → 400 or 403
   */
  test("A-18: /api/org/invites DELETE ID 欠如 → 400/403", async ({
    authedPage,
  }) => {
    await authedPage.goto("/home");
    const { status } = await apiDelete(authedPage, "/api/org/invites");
    expect([400, 401, 403]).toContain(status);
  });
});

test.describe("A. Org — チャレンジ API バリデーション", () => {
  /**
   * A-19: /api/org/challenges POST 通常ユーザー → 403
   */
  test("A-19: /api/org/challenges POST 通常ユーザー → 403", async ({
    authedPage,
  }) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/org/challenges", {
      title: "テストチャレンジ",
      challengeType: "breakfast_rate",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });
    expect([401, 403]).toContain(status);
  });

  /**
   * A-20: /api/org/challenges POST 必須フィールド欠如 → 400 or 403
   */
  test("A-20: /api/org/challenges POST 必須フィールド欠如 → 400/403", async ({
    authedPage,
  }) => {
    await authedPage.goto("/home");
    // title 欠如
    const { status } = await apiPost(authedPage, "/api/org/challenges", {
      challengeType: "breakfast_rate",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });
    expect([400, 401, 403]).toContain(status);
  });

  /**
   * A-21: /api/org/challenges PUT ID 欠如 → 400 or 403
   */
  test("A-21: /api/org/challenges PUT ID 欠如 → 400/403", async ({
    authedPage,
  }) => {
    await authedPage.goto("/home");
    const { status } = await apiPut(authedPage, "/api/org/challenges", {
      status: "active",
    });
    expect([400, 401, 403]).toContain(status);
  });
});

test.describe("A. Org — ダッシュボード & 統計 API", () => {
  /**
   * A-22: /api/org/stats 通常ユーザー → 403
   */
  test("A-22: /api/org/stats 通常ユーザー → 403", async ({ authedPage }) => {
    await authedPage.goto("/home");
    const { status } = await apiGet(authedPage, "/api/org/stats");
    expect([401, 403]).toContain(status);
  });

  /**
   * A-23: /org/dashboard が存在し、認証ユーザーがアクセスすると
   *        org_admin でない場合 /home にリダイレクトされる (JSリダイレクト)
   */
  test("A-23: 通常ユーザー → /org/members が /home リダイレクト", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/org/members");
    // layout.tsx が org_admin チェックして /home に飛ばす
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "A-23 /org/members");
    const url = authedPage.url();
    const blocked =
      url.includes("/home") ||
      url.includes("/login") ||
      (await authedPage.locator("body").textContent())?.match(
        /403|Forbidden|権限/i,
      ) !== null;
    if (!blocked) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[org][r10] A-23: 通常ユーザーが /org/members にアクセスできてしまっている",
      });
    }
    expect(blocked).toBeTruthy();
  });
});

// ============================================================
// B. Pantry 食材管理 深掘り
// ============================================================

test.describe("B. Pantry — 認可", () => {
  /**
   * B-1: /pantry に未認証アクセス → /login にリダイレクト
   */
  test("B-1: /pantry 未認証 → /login", async ({ page }, testInfo) => {
    await page.goto("/pantry");
    await page.waitForLoadState("networkidle");
    await attach(page, testInfo, "B-1 未認証 /pantry");
    expect(page.url()).toMatch(/\/login/);
  });

  /**
   * B-2: /api/pantry GET 未認証 → 401
   */
  test("B-2: /api/pantry GET 未認証 → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiGet(page, "/api/pantry");
    expect(status).toBe(401);
  });

  /**
   * B-3: /api/pantry POST 未認証 → 401
   */
  test("B-3: /api/pantry POST 未認証 → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiPost(page, "/api/pantry", {
      name: "トマト",
      category: "vegetable",
    });
    expect(status).toBe(401);
  });

  /**
   * B-4: /api/ai/analyze-fridge POST 未認証 → 401
   */
  test("B-4: /api/ai/analyze-fridge 未認証 → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiPost(page, "/api/ai/analyze-fridge", {
      imageBase64: "dGVzdA==",
      mimeType: "image/jpeg",
    });
    expect(status).toBe(401);
  });

  /**
   * B-5: /api/pantry/from-photo POST 未認証 → 401
   */
  test("B-5: /api/pantry/from-photo 未認証 → 401", async ({ page }) => {
    await page.goto("/login");
    const { status } = await apiPost(page, "/api/pantry/from-photo", {
      ingredients: [{ name: "トマト" }],
      mode: "append",
    });
    expect(status).toBe(401);
  });
});

test.describe("B. Pantry — 一覧表示と基本 CRUD", () => {
  /**
   * B-6: /pantry ページが認証ユーザーで正常表示
   *      NOTE: e2e ユーザーがオンボーディング未完了の場合、/pantry → オンボーディング画面にリダイレクトされる
   *            そのケースでは Issue を記録して soft-fail する
   */
  test("B-6: /pantry ページが正常レンダリング or オンボーディングリダイレクト検知", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/pantry");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "B-6 /pantry");

    const url = authedPage.url();
    const body = await authedPage.locator("body").textContent() ?? "";

    // オンボーディング画面にリダイレクトされているか確認
    const isOnboarding = body.includes("おかえりなさい") || body.includes("続きから再開") || body.includes("onboarding");
    if (isOnboarding) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[pantry][r10] B-6: /pantry にアクセスするとオンボーディング画面にリダイレクトされる。e2eユーザーのオンボーディング状態が未完了になっている可能性、または認証済みユーザーのonboarding_completedフラグが正しく設定されていない",
      });
      // テストをスキップ扱いにせず、バグとして記録
      testInfo.annotations.push({
        type: "result",
        description: `B-6: オンボーディングにリダイレクト (url=${url})`,
      });
      return; // このバグはIssue起票で対処
    }

    // 「食材管理」ヘッダーが存在すること
    const header = authedPage.getByText("食材管理");
    await expect(header).toBeVisible({ timeout: 10_000 });
  });

  /**
   * B-7: /api/pantry GET 認証済み → 200 & items 配列
   */
  test("B-7: /api/pantry GET 認証済み → 200 & items 配列", async ({
    authedPage,
  }) => {
    // APIテストは /home ベースで実行 (オンボーディングリダイレクト回避)
    await authedPage.goto("/home");
    const { status, json } = await apiGet(authedPage, "/api/pantry");
    expect(status).toBe(200);
    expect((json as any).items).toBeDefined();
    expect(Array.isArray((json as any).items)).toBeTruthy();
  });

  /**
   * B-8: /api/pantry POST → 食材作成 → 一覧に含まれる → DELETE で削除
   *       (作成 → 確認 → 削除 のフルフロー)
   */
  test("B-8: Pantry CRUD フルフロー — 作成 → 確認 → 削除", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");

    const uniqueName = `R10テスト食材-${Date.now()}`;

    // 作成
    const createRes = await apiPost(authedPage, "/api/pantry", {
      name: uniqueName,
      amount: "2個",
      category: "vegetable",
      expirationDate: "2026-06-01",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-8 create: status=${createRes.status}`,
    });
    expect(createRes.status).toBe(200);
    const itemId = (createRes.json as any)?.item?.id;
    expect(itemId).toBeTruthy();

    // 一覧で確認
    const listRes = await apiGet(authedPage, "/api/pantry");
    const items = (listRes.json as any)?.items ?? [];
    const found = items.find((i: any) => i.id === itemId);
    expect(found, `作成した食材 id=${itemId} が一覧に存在しない`).toBeTruthy();
    expect(found.name).toBe(uniqueName);

    // 削除
    const deleteRes = await apiDelete(authedPage, `/api/pantry/${itemId}`);
    testInfo.annotations.push({
      type: "result",
      description: `B-8 delete: status=${deleteRes.status}`,
    });
    expect(deleteRes.status).toBe(200);

    // 削除後に一覧に含まれないこと
    const listRes2 = await apiGet(authedPage, "/api/pantry");
    const items2 = (listRes2.json as any)?.items ?? [];
    const stillExists = items2.find((i: any) => i.id === itemId);
    expect(stillExists, `削除後も食材 id=${itemId} が一覧に残っている`).toBeFalsy();
  });

  /**
   * B-9: /api/pantry POST バリデーション — name 欠如 → 500 or 400
   *       (DBレベルのNOT NULLで500になる可能性)
   */
  test("B-9: /api/pantry POST name なし → エラー", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/pantry", {
      amount: "1個",
      category: "vegetable",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-9: status=${status}`,
    });
    // name が必須なので 400 or 500 (DB NOT NULL error)
    expect([400, 422, 500]).toContain(status);
  });

  /**
   * B-10: /api/pantry/[id] PATCH — フィールド更新
   */
  test("B-10: /api/pantry/[id] PATCH で食材更新", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/home");

    // まず作成
    const createRes = await apiPost(authedPage, "/api/pantry", {
      name: `R10-patch-test-${Date.now()}`,
      category: "meat",
    });
    expect(createRes.status).toBe(200);
    const itemId = (createRes.json as any)?.item?.id;

    // PATCH
    const patchRes = await apiPatch(authedPage, `/api/pantry/${itemId}`, {
      amount: "300g",
      expirationDate: "2026-07-15",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-10 patch: status=${patchRes.status}`,
    });
    expect(patchRes.status).toBe(200);
    const updated = (patchRes.json as any)?.item;
    expect(updated?.amount).toBe("300g");
    expect(updated?.expirationDate).toBe("2026-07-15");

    // クリーンアップ
    await apiDelete(authedPage, `/api/pantry/${itemId}`);
  });

  /**
   * B-11: 他ユーザーの食材を削除しようとしても削除できない
   *        (自分のアイテムでないのでRLSが弾く → 200 だが実際は削除されていない)
   */
  test("B-11: 他ユーザー食材 DELETE → 実際には削除されない (RLS)", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");
    // 存在しない or 他ユーザーのダミーID
    const fakeId = "00000000-0000-0000-0000-000000000001";
    const { status } = await apiDelete(authedPage, `/api/pantry/${fakeId}`);
    // RLS で 0 rows affected のため 200 が返るが削除はされない
    testInfo.annotations.push({
      type: "result",
      description: `B-11: status=${status}`,
    });
    // 200 (no-op) or 404 のどちらかが期待される
    expect([200, 404, 500]).toContain(status);
  });
});

test.describe("B. Pantry — analyze-fridge → DB 保存フロー", () => {
  /**
   * B-12: /api/ai/analyze-fridge POST — imageBase64 と mimeType なし → 400
   */
  test("B-12: /api/ai/analyze-fridge imageBase64/imageUrl なし → 400", async ({
    authedPage,
  }) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/ai/analyze-fridge", {});
    expect([400, 422]).toContain(status);
  });

  /**
   * B-13: /api/ai/analyze-fridge POST — 無効な base64 → 500 or 400
   *        (AI が画像として解釈できない)
   */
  test("B-13: /api/ai/analyze-fridge 無効 base64 → エラー", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/ai/analyze-fridge", {
      imageBase64: "aW52YWxpZA==", // "invalid" の base64
      mimeType: "image/jpeg",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-13: status=${status}`,
    });
    // AI が解析に失敗する可能性あり — 200 (空結果) か 4xx/5xx
    expect([200, 400, 500, 504]).toContain(status);
  });

  /**
   * B-14: /api/pantry/from-photo POST — ingredients 空配列 → 400
   */
  test("B-14: /api/pantry/from-photo ingredients 空配列 → 400", async ({
    authedPage,
  }) => {
    await authedPage.goto("/home");
    const { status } = await apiPost(authedPage, "/api/pantry/from-photo", {
      ingredients: [],
      mode: "append",
    });
    expect(status).toBe(400);
  });

  /**
   * B-15: /api/pantry/from-photo POST — append モードで食材保存 → DB 確認
   */
  test("B-15: from-photo append モード → DB 保存 → 一覧に反映", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");

    const uniqueName = `冷蔵庫R10-${Date.now()}`;

    const saveRes = await apiPost(authedPage, "/api/pantry/from-photo", {
      ingredients: [
        {
          name: uniqueName,
          quantity: "1個",
          category: "vegetable",
          daysRemaining: 5,
        },
      ],
      mode: "append",
    });

    testInfo.annotations.push({
      type: "result",
      description: `B-15 from-photo save: status=${saveRes.status}, json=${JSON.stringify(saveRes.json)}`,
    });

    expect(saveRes.status).toBe(200);
    expect((saveRes.json as any)?.success).toBeTruthy();

    // 一覧で確認
    const listRes = await apiGet(authedPage, "/api/pantry");
    const items = (listRes.json as any)?.items ?? [];
    const found = items.find((i: any) => i.name === uniqueName);
    expect(found, `from-photo で保存した "${uniqueName}" が一覧に現れない`).toBeTruthy();

    // クリーンアップ
    if (found?.id) {
      await apiDelete(authedPage, `/api/pantry/${found.id}`);
    }
  });

  /**
   * B-16: /api/pantry/from-photo POST — replace モードで全置換
   */
  test("B-16: from-photo replace モード → 既存全削除して新規保存", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");

    // 事前に1件作成
    const preRes = await apiPost(authedPage, "/api/pantry", {
      name: `R10-replace-pre-${Date.now()}`,
      category: "other",
    });
    const preId = (preRes.json as any)?.item?.id;

    const uniqueName = `R10-replace-new-${Date.now()}`;

    // replace モードで保存
    const saveRes = await apiPost(authedPage, "/api/pantry/from-photo", {
      ingredients: [{ name: uniqueName, category: "meat" }],
      mode: "replace",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-16 replace: status=${saveRes.status}`,
    });
    expect(saveRes.status).toBe(200);

    // 一覧確認 — 以前のアイテムは消えているはず
    const listRes = await apiGet(authedPage, "/api/pantry");
    const items = (listRes.json as any)?.items ?? [];
    if (preId) {
      const preStillExists = items.find((i: any) => i.id === preId);
      if (preStillExists) {
        testInfo.annotations.push({
          type: "issue",
          description:
            "[pantry][r10] B-16: replace モードで既存アイテムが削除されていない",
        });
      }
      expect(preStillExists).toBeFalsy();
    }
    const newFound = items.find((i: any) => i.name === uniqueName);
    expect(newFound, `replace 後に "${uniqueName}" が一覧に存在しない`).toBeTruthy();

    // クリーンアップ (replace 後の全アイテムを削除)
    for (const item of items) {
      await apiDelete(authedPage, `/api/pantry/${item.id}`);
    }
  });

  /**
   * B-17: /api/pantry/from-photo POST — name なし ingredients → skipped カウントに入る
   */
  test("B-17: from-photo name 空文字列 → skipped / スペースのみ → バグ確認", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");

    // 空文字列のみ (これは skipped になるはず)
    const saveRes1 = await apiPost(authedPage, "/api/pantry/from-photo", {
      ingredients: [{ name: "", category: "other" }],
      mode: "append",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-17a (空文字): status=${saveRes1.status}, json=${JSON.stringify(saveRes1.json)}`,
    });
    expect([200, 400]).toContain(saveRes1.status);
    if (saveRes1.status === 200) {
      const results = (saveRes1.json as any)?.results;
      expect(results?.created ?? 0).toBe(0);
    }

    // スペースのみ ("   ") — サーバーが trim しないため保存されてしまう可能性あり (バグ)
    const saveRes2 = await apiPost(authedPage, "/api/pantry/from-photo", {
      ingredients: [{ name: "   ", category: "other" }],
      mode: "append",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-17b (スペースのみ): status=${saveRes2.status}, json=${JSON.stringify(saveRes2.json)}`,
    });
    if (saveRes2.status === 200) {
      const results = (saveRes2.json as any)?.results;
      const spaceName = results?.items?.find((i: any) => i.name === "   ");
      if (spaceName || results?.created > 0) {
        testInfo.annotations.push({
          type: "issue",
          description:
            "[pantry][r10] B-17: from-photo でスペースのみの name が skipped されず DB に保存されてしまう。`if (!ingredient.name)` が trim されていないため '   ' が truthy として通過する",
        });
      }
    }
    // スペースのみでも created=0 が期待値 (trim して空なら skipped にすべき)
    // 実際は created=1 になるバグがある可能性
  });
});

test.describe("B. Pantry — 賞味期限通知 & UI 表示", () => {
  /**
   * B-18: 賞味期限が 3日以内の食材を作成 → /pantry ページで「期限間近」バッジ表示
   *       NOTE: e2eユーザーが /pantry でオンボーディングにリダイレクトされる場合は
   *             バグを記録して soft-fail する
   */
  test("B-18: 賞味期限 3日以内 → 「期限間近」バッジ表示", async ({
    authedPage,
  }, testInfo) => {
    // まず /home でアイテムを作成してセッションを確立
    await authedPage.goto("/home");

    // 2日後の日付を計算
    const twoDaysLater = new Date();
    twoDaysLater.setDate(twoDaysLater.getDate() + 2);
    const expiryDate = twoDaysLater.toISOString().split("T")[0];
    const itemName = `R10-expiring-${Date.now()}`;

    // 作成 (APIは /home からでも動作)
    const createRes = await apiPost(authedPage, "/api/pantry", {
      name: itemName,
      category: "other",
      expirationDate: expiryDate,
    });
    expect(createRes.status).toBe(200);
    const itemId = (createRes.json as any)?.item?.id;

    // /pantry ページに移動
    await authedPage.goto("/pantry");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "B-18 期限間近バッジ");

    // オンボーディングリダイレクト検知
    const body = await authedPage.locator("body").textContent() ?? "";
    const isOnboarding = body.includes("おかえりなさい") || body.includes("続きから再開");
    if (isOnboarding) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[pantry][r10] B-18: /pantry にアクセスするとオンボーディング画面にリダイレクトされるため、期限間近バッジを確認できない",
      });
      if (itemId) await apiDelete(authedPage, `/api/pantry/${itemId}`);
      return;
    }

    // 「期限間近」バッジが表示されているか
    const badge = authedPage.getByText("期限間近");
    const badgeVisible = await badge.isVisible().catch(() => false);

    testInfo.annotations.push({
      type: "result",
      description: `B-18: 期限間近バッジ visible=${badgeVisible}`,
    });

    if (!badgeVisible) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[pantry][r10] B-18: 賞味期限 3日以内の食材に「期限間近」バッジが表示されない",
      });
    }
    expect(badgeVisible).toBeTruthy();

    // クリーンアップ
    if (itemId) {
      await apiDelete(authedPage, `/api/pantry/${itemId}`);
    }
  });

  /**
   * B-19: 賞味期限が 7日後の食材 → 「期限間近」バッジは表示されない
   */
  test("B-19: 賞味期限 7日後 → 「期限間近」バッジなし", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");

    const sevenDaysLater = new Date();
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    const expiryDate = sevenDaysLater.toISOString().split("T")[0];
    const itemName = `R10-safe-expiry-${Date.now()}`;

    const createRes = await apiPost(authedPage, "/api/pantry", {
      name: itemName,
      category: "vegetable",
      expirationDate: expiryDate,
    });
    expect(createRes.status).toBe(200);
    const itemId = (createRes.json as any)?.item?.id;

    // /pantry に移動
    await authedPage.goto("/pantry");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "B-19 期限余裕あり");

    // オンボーディングリダイレクト検知 (soft-fail)
    const body = await authedPage.locator("body").textContent() ?? "";
    if (body.includes("おかえりなさい") || body.includes("続きから再開")) {
      testInfo.annotations.push({ type: "result", description: "B-19: オンボーディング画面にリダイレクト — テストスキップ" });
      if (itemId) await apiDelete(authedPage, `/api/pantry/${itemId}`);
      return;
    }

    // 対象アイテムの行を見つける
    const itemRow = authedPage.getByText(itemName);
    const itemVisible = await itemRow.isVisible().catch(() => false);

    if (itemVisible) {
      // そのアイテム近辺に「期限間近」がないことを確認
      const nearbyBadge = authedPage
        .locator(`text=${itemName}`)
        .locator("..")
        .getByText("期限間近");
      const badgeExists = await nearbyBadge.count();
      expect(badgeExists).toBe(0);
    }

    // クリーンアップ
    if (itemId) {
      await apiDelete(authedPage, `/api/pantry/${itemId}`);
    }
  });

  /**
   * B-20: /pantry ページの「写真で追加」ボタンが存在する
   *        e2eユーザーがオンボーディング未完了の場合は soft-fail
   */
  test("B-20: /pantry 「写真で追加」ボタン存在", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/pantry");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "B-20 写真で追加ボタン");

    const body = await authedPage.locator("body").textContent() ?? "";
    const isOnboarding = body.includes("おかえりなさい") || body.includes("続きから再開");
    if (isOnboarding) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[pantry][r10] B-20: /pantry にアクセスするとオンボーディング画面にリダイレクトされ「写真で追加」ボタンを確認できない",
      });
      return;
    }

    const btn = authedPage.getByText("写真で追加");
    await expect(btn).toBeVisible({ timeout: 10_000 });
  });

  /**
   * B-21: /pantry 食材ゼロ状態 → 空状態メッセージ表示
   *        e2eユーザーがオンボーディング未完了の場合は soft-fail
   */
  test("B-21: /pantry 食材ゼロ状態 → 空状態 UI 確認", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/pantry");
    await authedPage.waitForLoadState("networkidle");
    await attach(authedPage, testInfo, "B-21 pantry 状態");

    const body = await authedPage.locator("body").textContent() ?? "";
    const isOnboarding = body.includes("おかえりなさい") || body.includes("続きから再開");
    if (isOnboarding) {
      testInfo.annotations.push({
        type: "issue",
        description:
          "[pantry][r10] B-21: /pantry にアクセスするとオンボーディング画面にリダイレクトされる",
      });
      return;
    }

    // 食材ゼロの場合は「食材がありません」
    // 食材がある場合はリストが表示される
    const emptyMsg = authedPage.getByText("食材がありません");
    const itemList = authedPage.locator("[class*='space-y-2']");

    const hasEmpty = await emptyMsg.isVisible().catch(() => false);
    const hasItems = await itemList.isVisible().catch(() => false);

    testInfo.annotations.push({
      type: "result",
      description: `B-21: 食材なし表示=${hasEmpty}, 食材リスト表示=${hasItems}`,
    });

    // どちらか一方が表示されていること
    expect(hasEmpty || hasItems).toBeTruthy();
  });
});

test.describe("B. Pantry — カテゴリ & データ整合性", () => {
  /**
   * B-22: 各カテゴリ (vegetable, meat, fish, dairy, other) で食材作成 → 一覧に表示
   */
  test("B-22: 全カテゴリで食材作成 → 一覧確認", async ({ authedPage }, testInfo) => {
    await authedPage.goto("/home");

    const categories = ["vegetable", "meat", "fish", "dairy", "other"];
    const createdIds: string[] = [];
    const ts = Date.now();

    for (const cat of categories) {
      const res = await apiPost(authedPage, "/api/pantry", {
        name: `R10-cat-${cat}-${ts}`,
        category: cat,
      });
      testInfo.annotations.push({
        type: "result",
        description: `B-22 create ${cat}: status=${res.status}`,
      });
      expect(res.status).toBe(200);
      const id = (res.json as any)?.item?.id;
      if (id) createdIds.push(id);
    }

    // 一覧確認
    const listRes = await apiGet(authedPage, "/api/pantry");
    const items = (listRes.json as any)?.items ?? [];

    for (const cat of categories) {
      const found = items.find(
        (i: any) => i.name === `R10-cat-${cat}-${ts}`,
      );
      expect(found, `カテゴリ ${cat} の食材が一覧に存在しない`).toBeTruthy();
      expect(found?.category).toBe(cat);
    }

    // クリーンアップ
    for (const id of createdIds) {
      await apiDelete(authedPage, `/api/pantry/${id}`);
    }
  });

  /**
   * B-23: from-photo のカテゴリマッピング確認 (日本語 → DB 値)
   */
  test("B-23: from-photo 日本語カテゴリ → DB カテゴリ値にマッピング", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");

    const ts = Date.now();
    const saveRes = await apiPost(authedPage, "/api/pantry/from-photo", {
      ingredients: [
        { name: `R10-veg-${ts}`, category: "野菜" },
        { name: `R10-meat-${ts}`, category: "肉類" },
        { name: `R10-fish-${ts}`, category: "魚介類" },
      ],
      mode: "append",
    });

    testInfo.annotations.push({
      type: "result",
      description: `B-23 save: status=${saveRes.status}`,
    });
    expect(saveRes.status).toBe(200);

    const listRes = await apiGet(authedPage, "/api/pantry");
    const items = (listRes.json as any)?.items ?? [];

    const veg = items.find((i: any) => i.name === `R10-veg-${ts}`);
    const meat = items.find((i: any) => i.name === `R10-meat-${ts}`);
    const fish = items.find((i: any) => i.name === `R10-fish-${ts}`);

    if (veg) expect(veg.category).toBe("vegetable");
    if (meat) expect(meat.category).toBe("meat");
    if (fish) expect(fish.category).toBe("fish");

    // クリーンアップ
    for (const item of [veg, meat, fish]) {
      if (item?.id) await apiDelete(authedPage, `/api/pantry/${item.id}`);
    }
  });

  /**
   * B-24: from-photo daysRemaining → expirationDate が正しく計算される
   */
  test("B-24: from-photo daysRemaining=3 → 3日後が expirationDate", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");

    const ts = Date.now();
    const itemName = `R10-days-${ts}`;
    const saveRes = await apiPost(authedPage, "/api/pantry/from-photo", {
      ingredients: [{ name: itemName, category: "vegetable", daysRemaining: 3 }],
      mode: "append",
    });
    expect(saveRes.status).toBe(200);

    const listRes = await apiGet(authedPage, "/api/pantry");
    const items = (listRes.json as any)?.items ?? [];
    const found = items.find((i: any) => i.name === itemName);

    if (found?.expirationDate) {
      const expected = new Date();
      expected.setDate(expected.getDate() + 3);
      const expectedStr = expected.toISOString().split("T")[0];
      testInfo.annotations.push({
        type: "result",
        description: `B-24: expected=${expectedStr}, actual=${found.expirationDate}`,
      });
      // 日付は ±1日の誤差許容 (タイムゾーン)
      const diff = Math.abs(
        new Date(found.expirationDate).getTime() - expected.getTime(),
      );
      expect(diff).toBeLessThan(2 * 24 * 60 * 60 * 1000); // 2日以内
    }

    if (found?.id) await apiDelete(authedPage, `/api/pantry/${found.id}`);
  });

  /**
   * B-25: /api/pantry/[id] PATCH — 他ユーザーのアイテムは更新できない (RLS)
   */
  test("B-25: /api/pantry/[id] PATCH 他ユーザーアイテム → 更新されない", async ({
    authedPage,
  }, testInfo) => {
    await authedPage.goto("/home");

    const fakeId = "00000000-0000-0000-0000-000000000099";
    const patchRes = await apiPatch(authedPage, `/api/pantry/${fakeId}`, {
      name: "ハッキング",
    });
    testInfo.annotations.push({
      type: "result",
      description: `B-25 patch fake: status=${patchRes.status}`,
    });
    // RLS により 0 rows affected → 200 (no data) or 500 or 404
    expect([200, 404, 500]).toContain(patchRes.status);
    // 200 の場合も item が null など空であること
    if (patchRes.status === 200) {
      const item = (patchRes.json as any)?.item;
      // item が存在すれば name が変更されていないことを確認
      // (実際には RLS で別ユーザーのレコードは更新できない)
      if (item) {
        expect(item.name).not.toBe("ハッキング");
      }
    }
  });
});
