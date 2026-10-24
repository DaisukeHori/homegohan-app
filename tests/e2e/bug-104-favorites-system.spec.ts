/**
 * Favorites/Recipe System E2E Tests
 * Covers: #104, #106, #109, #112, #113, #114, #117
 *
 * #109: /favorites ページが存在する
 * #104: お気に入りレシピが GET /api/favorites で取得できる
 * #106: DELETE 時に like_count/likeCount が返される (成功の応答の形。レシピの名前の id は 404 になる #1917 の続き)
 */
import { test, expect } from "./fixtures/fresh-user";

const TEST_RECIPE_NAME = "テスト用照り焼きチキン";
/** レシピが無いときの 404 の本文 (src/lib/api/error-responses.ts の API_NOT_FOUND_MESSAGE。この spec は next/server を読み込まないので文を写す) */
const NOT_FOUND_BODY = { error: "対象が見つかりません" };

test.describe("Favorites system (#104 #106 #109)", () => {
  test("GET /favorites page loads and shows correct header", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/favorites");
    await tourPendingUser.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    // ページタイトルを確認
    await expect(tourPendingUser.getByRole("heading", { name: "お気に入りレシピ", exact: true })).toBeVisible({ timeout: 8000 });
  });

  test("GET /favorites page shows empty state when no favorites", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/favorites");
    await tourPendingUser.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    // お気に入りがない場合の空状態 or リスト確認
    const hasEmpty = await tourPendingUser.locator("text=お気に入りレシピはまだありません").isVisible({ timeout: 5000 }).catch(() => false);
    const hasList = await tourPendingUser.locator('[style*="border-radius: 16px"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasEmpty || hasList).toBe(true);
  });

  test("GET /api/favorites returns JSON array", async ({ tourPendingUser }) => {
    const res = await tourPendingUser.request.get("/api/favorites");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.favorites)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  // recipe_likes.recipe_id は uuid の列 (recipes.id への外部キー)。レシピの名前 (UUID の形でない id) は DB に渡さず、
  // GET は いいねの行が無いときと同じ { liked: false }、POST・DELETE はレシピが無いときと同じ 404 (#1917 の続き)
  test("GET /api/recipes/:name/like は UUID の形でない id に { liked: false } を返す", async ({ tourPendingUser }) => {
    const testRecipeName = encodeURIComponent(TEST_RECIPE_NAME);
    const res = await tourPendingUser.request.get(`/api/recipes/${testRecipeName}/like`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ liked: false });
  });

  test("POST /api/recipes/:name/like は UUID の形でない id を 404 にする (500 にしない)", async ({ tourPendingUser }) => {
    const testRecipeName = encodeURIComponent(TEST_RECIPE_NAME);
    const postRes = await tourPendingUser.request.post(`/api/recipes/${testRecipeName}/like`);
    expect(postRes.status()).toBe(404);
    expect(await postRes.json()).toEqual(NOT_FOUND_BODY);
  });

  test("DELETE /api/recipes/:name/like は UUID の形でない id を 404 にする (500 にしない)", async ({ tourPendingUser }) => {
    const testRecipeName = encodeURIComponent(TEST_RECIPE_NAME);
    const deleteRes = await tourPendingUser.request.delete(`/api/recipes/${testRecipeName}/like`);
    expect(deleteRes.status()).toBe(404);
    expect(await deleteRes.json()).toEqual(NOT_FOUND_BODY);
  });

  test("favorites search filter works", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/favorites");
    await tourPendingUser.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const searchInput = tourPendingUser.locator('input[placeholder="レシピ名で検索..."]');
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    await searchInput.fill("存在しないレシピ名XYZABC");
    // 少し待って再取得
    await tourPendingUser.waitForTimeout(1000);

    // 空状態 or 0件
    const emptyText = tourPendingUser.locator("text=に一致するレシピが見つかりませんでした");
    const isEmpty = await emptyText.isVisible({ timeout: 5000 }).catch(() => false);
    const count = await tourPendingUser.locator("text=0 件").isVisible().catch(() => false);
    expect(isEmpty || count).toBe(true);
  });
});
