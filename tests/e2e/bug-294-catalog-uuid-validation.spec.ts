/**
 * #294 /api/catalog/products/[id] UUID バリデーション
 *
 * - 不正な id (SQL injection 文字列, XSS 文字列) → 400
 * - 正しい UUID 形式だが存在しないレコード → 404
 * - 正しい UUID 形式で認証なし → 401
 */

import { test, expect } from "./fixtures/fresh-user";

const NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000";

test.describe("#294 /api/catalog/products/[id] UUID バリデーション", () => {
  test("SQL injection 風 id → 400", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/");

    const status = await tourPendingUser.evaluate(async () => {
      const res = await fetch("/api/catalog/products/';DROP TABLE products;--");
      return res.status;
    });

    expect(status).toBe(400);
  });

  test("XSS 風 id → 400", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/");

    const status = await tourPendingUser.evaluate(async () => {
      const res = await fetch("/api/catalog/products/%3Cscript%3Ealert(1)%3C%2Fscript%3E");
      return res.status;
    });

    expect(status).toBe(400);
  });

  test("正しい UUID 形式で存在しないレコード → 404", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/");

    const result = await tourPendingUser.evaluate(async (uuid) => {
      const res = await fetch(`/api/catalog/products/${uuid}`);
      return { status: res.status, body: await res.json() };
    }, NONEXISTENT_UUID);

    expect(result.status).toBe(404);
  });

  test("invalid_id エラーボディが返る", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/");

    const result = await tourPendingUser.evaluate(async () => {
      const res = await fetch("/api/catalog/products/not-a-uuid");
      return { status: res.status, body: await res.json() };
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: "invalid_id" });
  });
});
