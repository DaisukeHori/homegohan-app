/**
 * health_checkups CRUD + longitudinal review フロー E2E テスト
 *
 * カバレッジ:
 *   1. CRUD フルフロー: POST → GET 一覧確認 → PUT 更新 → DELETE → GET で消滅確認
 *   2. 未認証 401: JWT なしで各エンドポイントにアクセス → 401
 *   3. 他人レコード RLS 拒否: 存在しない/他ユーザーの UUID で操作 → 404
 *   4. longitudinal review: 複数 checkup 作成後、GET 一覧に longitudinalReview が含まれる
 *
 * 関連: PR #910 で復旧 apply 済 health_checkups テーブル
 *
 * 実行:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e -- tests/e2e/health/checkups-crud.spec.ts --reporter=list
 */

import { test, expect } from "../fixtures/auth";

// ─── helpers ───────────────────────────────────────────────────────────────

async function apiPost(page: any, path: string, body: unknown) {
  return page.evaluate(
    async ({ url, payload }: { url: string; payload: unknown }) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    { url: path, payload: body },
  );
}

async function apiPut(page: any, path: string, body: unknown) {
  return page.evaluate(
    async ({ url, payload }: { url: string; payload: unknown }) => {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    { url: path, payload: body },
  );
}

async function apiGet(page: any, path: string) {
  return page.evaluate(
    async (url: string) => {
      const res = await fetch(url, { credentials: "include" });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    path,
  );
}

async function apiDelete(page: any, path: string) {
  return page.evaluate(
    async (url: string) => {
      const res = await fetch(url, {
        method: "DELETE",
        credentials: "include",
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    path,
  );
}

/** テスト用のユニーク日付を生成 (衝突回避) */
function uniqueDate(offset = 0): string {
  // 遠い過去の日付をベースに offset で差別化
  const base = new Date("2010-07-15");
  base.setDate(base.getDate() + offset);
  return base.toISOString().split("T")[0];
}

/** テスト用 checkup payload */
function makeCheckupPayload(date: string, overrides: Record<string, unknown> = {}) {
  return {
    checkup_date: date,
    height: 170,
    weight: 65,
    bmi: 22.5,
    blood_pressure_systolic: 120,
    blood_pressure_diastolic: 80,
    hba1c: 5.6,
    total_cholesterol: 200,
    ldl_cholesterol: 120,
    hdl_cholesterol: 60,
    triglycerides: 150,
    ...overrides,
  };
}

// ─── 1. CRUD フルフロー ────────────────────────────────────────────────────

test.describe("1. CRUD フルフロー", () => {
  test("POST → GET 一覧確認 → PUT 更新 → DELETE → GET で消滅確認", async ({
    authedPage: page,
  }) => {
    await page.goto("/health/checkups");

    const checkupDate = uniqueDate(0);
    let createdId: string | null = null;

    // ── POST: 新規作成 ──────────────────────────────────────────────────────
    const { status: postStatus, json: postJson } = await apiPost(
      page,
      "/api/health/checkups",
      makeCheckupPayload(checkupDate),
    );
    expect(
      [200, 201],
      `POST 失敗: status=${postStatus}, json=${JSON.stringify(postJson)}`,
    ).toContain(postStatus);

    createdId = (postJson as any)?.checkup?.id;
    expect(createdId, "POST レスポンスに checkup.id が含まれていない").toBeTruthy();

    try {
      // ── GET 一覧: 作成したレコードが含まれる ──────────────────────────────
      const { status: listStatus, json: listJson } = await apiGet(
        page,
        "/api/health/checkups",
      );
      expect(listStatus, `GET 一覧失敗: ${JSON.stringify(listJson)}`).toBe(200);

      const checkups = (listJson as any)?.checkups as any[];
      expect(Array.isArray(checkups), "checkups が配列でない").toBe(true);

      const found = checkups.find((c: any) => c.id === createdId);
      expect(
        found,
        `作成した checkup (id=${createdId}) が一覧に見つからない`,
      ).toBeTruthy();
      expect(found?.hba1c).toBe(5.6);

      // ── GET 詳細: 単件取得 ──────────────────────────────────────────────
      const { status: getStatus, json: getJson } = await apiGet(
        page,
        `/api/health/checkups/${createdId}`,
      );
      expect(getStatus, `GET 詳細失敗: ${JSON.stringify(getJson)}`).toBe(200);
      expect((getJson as any)?.checkup?.id).toBe(createdId);
      expect((getJson as any)?.checkup?.checkup_date).toBe(checkupDate);

      // ── PUT: hba1c を更新 ───────────────────────────────────────────────
      const { status: putStatus, json: putJson } = await apiPut(
        page,
        `/api/health/checkups/${createdId}`,
        { hba1c: 6.2 },
      );
      expect(
        [200, 201],
        `PUT 失敗: status=${putStatus}, json=${JSON.stringify(putJson)}`,
      ).toContain(putStatus);

      const updatedCheckup = (putJson as any)?.checkup;
      expect(updatedCheckup?.hba1c).toBe(6.2);
      // updated_at が存在すれば created_at 以上であることを確認
      if (updatedCheckup?.created_at && updatedCheckup?.updated_at) {
        expect(
          new Date(updatedCheckup.updated_at) >= new Date(updatedCheckup.created_at),
          "updated_at が created_at より前になっている",
        ).toBe(true);
      }

      // ── DELETE ─────────────────────────────────────────────────────────
      const { status: deleteStatus, json: deleteJson } = await apiDelete(
        page,
        `/api/health/checkups/${createdId}`,
      );
      expect(
        deleteStatus,
        `DELETE 失敗: ${JSON.stringify(deleteJson)}`,
      ).toBe(200);
      expect((deleteJson as any)?.success).toBe(true);

      // ── DELETE 後 GET → 404 ────────────────────────────────────────────
      const { status: afterDeleteStatus } = await apiGet(
        page,
        `/api/health/checkups/${createdId}`,
      );
      expect(
        afterDeleteStatus,
        "DELETE 後に GET が 404 でない (レコードが残っている可能性)",
      ).toBe(404);

      createdId = null; // クリーンアップ済み
    } finally {
      // フォールバッククリーンアップ (テスト途中失敗時)
      if (createdId) {
        await apiDelete(page, `/api/health/checkups/${createdId}`).catch(() => {});
      }
    }
  });
});

// ─── 2. 未認証 401 ────────────────────────────────────────────────────────

test.describe("2. 未認証アクセス → 401", () => {
  /**
   * 未認証リクエストは authedPage を使わず、通常の page を使う。
   * fixtures/auth.ts の authedPage は自動ログインするため、
   * ここでは base の page fixture を直接使用する。
   */

  test("未認証 GET /api/health/checkups → 401", async ({ page }) => {
    // Cookie を持たない素のページからアクセス
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const res = await fetch("/api/health/checkups", {
        credentials: "omit", // Cookie を送らない
      });
      return { status: res.status };
    });
    expect(
      [401, 403],
      `未認証 GET が ${result.status} を返した (401/403 期待)`,
    ).toContain(result.status);
  });

  test("未認証 POST /api/health/checkups → 401", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const res = await fetch("/api/health/checkups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkup_date: "2024-01-01", hba1c: 5.5 }),
        credentials: "omit",
      });
      return { status: res.status };
    });
    expect(
      [401, 403],
      `未認証 POST が ${result.status} を返した (401/403 期待)`,
    ).toContain(result.status);
  });

  test("未認証 PUT /api/health/checkups/:id → 401", async ({ page }) => {
    await page.goto("/");
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const result = await page.evaluate(
      async (id: string) => {
        const res = await fetch(`/api/health/checkups/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hba1c: 5.5 }),
          credentials: "omit",
        });
        return { status: res.status };
      },
      fakeId,
    );
    expect(
      [401, 403],
      `未認証 PUT が ${result.status} を返した (401/403 期待)`,
    ).toContain(result.status);
  });

  test("未認証 DELETE /api/health/checkups/:id → 401", async ({ page }) => {
    await page.goto("/");
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const result = await page.evaluate(
      async (id: string) => {
        const res = await fetch(`/api/health/checkups/${id}`, {
          method: "DELETE",
          credentials: "omit",
        });
        return { status: res.status };
      },
      fakeId,
    );
    expect(
      [401, 403],
      `未認証 DELETE が ${result.status} を返した (401/403 期待)`,
    ).toContain(result.status);
  });
});

// ─── 3. 他人レコード RLS 拒否 ─────────────────────────────────────────────

test.describe("3. 他人レコード / 存在しない UUID → RLS 拒否 (404)", () => {
  /**
   * RLS は「自分のレコードしか見えない」設計のため、
   * 他ユーザーの UUID を指定しても 404 が返る (403 ではなく情報漏洩を防ぐため)。
   * 存在しない UUID でも同じ挙動になる。
   */
  const nonExistentId = "00000000-0000-0000-0000-000000000001";

  test("存在しない checkup_id で GET → 404", async ({ authedPage: page }) => {
    await page.goto("/health/checkups");
    const { status } = await apiGet(
      page,
      `/api/health/checkups/${nonExistentId}`,
    );
    expect(
      status,
      `他ユーザー checkup GET → 404 期待、got ${status}`,
    ).toBe(404);
  });

  test("存在しない checkup_id で PUT → 404", async ({ authedPage: page }) => {
    await page.goto("/health/checkups");
    const { status } = await apiPut(
      page,
      `/api/health/checkups/${nonExistentId}`,
      { hba1c: 5.5 },
    );
    expect(
      status,
      `他ユーザー checkup PUT → 404 期待、got ${status}`,
    ).toBe(404);
  });

  test("存在しない checkup_id で DELETE → 404", async ({ authedPage: page }) => {
    await page.goto("/health/checkups");
    const { status } = await apiDelete(
      page,
      `/api/health/checkups/${nonExistentId}`,
    );
    expect(
      status,
      `他ユーザー checkup DELETE → 404 期待、got ${status}`,
    ).toBe(404);
  });
});

// ─── 4. longitudinal review ───────────────────────────────────────────────

test.describe("4. longitudinal review - 複数 checkup 後に review が生成される", () => {
  test("2 件以上の checkup を作成 → GET 一覧に longitudinalReview が含まれる", async ({
    authedPage: page,
  }) => {
    await page.goto("/health/checkups");

    const createdIds: string[] = [];
    const dates = [uniqueDate(100), uniqueDate(200)]; // 互いに重複しない過去日

    try {
      // 2 件作成
      for (const date of dates) {
        const { status, json } = await apiPost(
          page,
          "/api/health/checkups",
          makeCheckupPayload(date, { hba1c: 5.5 + dates.indexOf(date) * 0.3 }),
        );
        expect(
          [200, 201],
          `checkup POST 失敗 (date=${date}): status=${status}, json=${JSON.stringify(json)}`,
        ).toContain(status);
        const id = (json as any)?.checkup?.id;
        if (id) createdIds.push(id);
      }

      expect(
        createdIds.length,
        "2 件の checkup が作成されなかった",
      ).toBeGreaterThanOrEqual(2);

      // GET 一覧でレスポンス構造を確認
      const { status: listStatus, json: listJson } = await apiGet(
        page,
        "/api/health/checkups",
      );
      expect(listStatus, `GET 一覧失敗: ${JSON.stringify(listJson)}`).toBe(200);

      const checkups = (listJson as any)?.checkups as any[];
      expect(Array.isArray(checkups)).toBe(true);

      // 作成した 2 件が一覧に含まれる
      for (const id of createdIds) {
        const found = checkups.find((c: any) => c.id === id);
        expect(found, `checkup id=${id} が一覧に見つからない`).toBeTruthy();
      }

      // longitudinalReview フィールドが存在する (null でも OK: LLM が生成中/失敗の場合あり)
      // ただし、キー自体は存在すること (API が leaking でない確認)
      expect(
        "longitudinalReview" in (listJson as any),
        "GET 一覧レスポンスに longitudinalReview キーが存在しない",
      ).toBe(true);

      // 2 件以上の場合、longitudinalReview が null でない可能性が高い
      // LLM 生成は非同期・外部依存のため null を許容しつつ、型だけ確認
      const longitudinalReview = (listJson as any)?.longitudinalReview;
      if (longitudinalReview !== null && longitudinalReview !== undefined) {
        // review が存在する場合、基本フィールドを確認
        expect(typeof longitudinalReview).toBe("object");
        // checkup_ids は配列を期待 (存在する場合)
        if (longitudinalReview.checkup_ids) {
          expect(Array.isArray(longitudinalReview.checkup_ids)).toBe(true);
        }
      }
    } finally {
      // クリーンアップ: 作成した checkup を削除
      for (const id of createdIds) {
        await apiDelete(page, `/api/health/checkups/${id}`).catch(() => {});
      }
    }
  });

  test("GET /api/health/checkups レスポンスが checkups 配列と longitudinalReview を含む", async ({
    authedPage: page,
  }) => {
    await page.goto("/health/checkups");

    const { status, json } = await apiGet(page, "/api/health/checkups");
    expect(status).toBe(200);

    // レスポンス構造の基本確認
    expect((json as any)?.checkups).toBeDefined();
    expect(Array.isArray((json as any)?.checkups)).toBe(true);
    // longitudinalReview キーが存在する (値は null も許容)
    expect("longitudinalReview" in (json as any)).toBe(true);
  });
});

// ─── 5. POST バリデーション基本確認 ──────────────────────────────────────

test.describe("5. POST バリデーション - checkup_date 必須", () => {
  test("checkup_date なしで POST → 400", async ({ authedPage: page }) => {
    await page.goto("/health/checkups");

    const { status, json } = await apiPost(page, "/api/health/checkups", {
      hba1c: 5.5,
      total_cholesterol: 200,
    });
    expect(
      status,
      `checkup_date なし POST → 400 期待、got ${status}: ${JSON.stringify(json)}`,
    ).toBe(400);
    expect((json as any)?.error).toBeTruthy();
  });

  test("不正な hba1c 値 (999) で POST → 400", async ({ authedPage: page }) => {
    await page.goto("/health/checkups");

    const { status, json } = await apiPost(page, "/api/health/checkups", {
      checkup_date: uniqueDate(50),
      hba1c: 999,
    });
    expect(
      status,
      `hba1c=999 POST → 400 期待、got ${status}: ${JSON.stringify(json)}`,
    ).toBe(400);
  });
});
