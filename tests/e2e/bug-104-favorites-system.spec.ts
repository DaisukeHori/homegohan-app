/**
 * Favorites/Recipe System E2E Tests
 * Covers: #104, #106, #109, #112, #113, #114, #117
 *
 * #109: /favorites ページが存在する
 * #104: お気に入りレシピが GET /api/favorites で取得できる
 * #106: DELETE 時に like_count/likeCount が返される (成功の応答の形。レシピの名前の id は 404 になる #1917 の続き)
 * #2011: 献立の料理のお気に入りは料理の写しを dish_favorites に保存する (POST / GET / DELETE /api/favorites。E-1)
 */
import { test, expect } from "./fixtures/fresh-user";

const TEST_RECIPE_NAME = "テスト用照り焼きチキン";
/** レシピが無いときの 404 の本文 (src/lib/api/error-responses.ts の API_NOT_FOUND_MESSAGE。この spec は next/server を読み込まないので文を写す) */
const NOT_FOUND_BODY = { error: "対象が見つかりません" };
/** E-1 で保存する献立の料理の名前 (dish_favorites.dish_name。#2011) */
const TEST_DISH_FAVORITE_NAME = "テスト用の鶏の照り焼き (E-1)";

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

  // #2011 E-1: 献立の料理の写しを保存して、一覧に出て、消せる (API だけ。献立の生成に依らない。docs/design/cross/22-dish-favorites.md §12)
  test("E-1 POST /api/favorites に料理の写しを送ると 201 で、GET /api/favorites に出て、DELETE /api/favorites/{id} で消える", async ({ tourPendingUser }) => {
    const dish = {
      name: TEST_DISH_FAVORITE_NAME,
      role: "main",
      calories_kcal: 320,
      ingredients: [{ name: "鶏もも肉", amount_g: 200, note: null }, "醤油 大さじ1"],
      recipe_steps: ["鶏肉を焼く", "たれを絡める"],
    };

    const postRes = await tourPendingUser.request.post("/api/favorites", { data: { dish } });
    expect(postRes.status()).toBe(201);
    const posted = await postRes.json();
    expect(posted.created).toBe(true);
    expect(posted.favorite.dish_name).toBe(TEST_DISH_FAVORITE_NAME);
    expect(posted.favorite.dish.ingredients).toEqual(dish.ingredients);
    expect(posted.favorite.dish.recipe_steps).toEqual(dish.recipe_steps);
    expect(posted.favorite).not.toHaveProperty("user_id");
    const favoriteId: string = posted.favorite.id;

    const listRes = await tourPendingUser.request.get(`/api/favorites?q=${encodeURIComponent(TEST_DISH_FAVORITE_NAME)}`);
    expect(listRes.status()).toBe(200);
    const listed = await listRes.json();
    expect(listed.total).toBe(1);
    expect(listed.favorites.map((favorite: { id: string }) => favorite.id)).toEqual([favoriteId]);

    const statusRes = await tourPendingUser.request.get(`/api/favorites/status?name=${encodeURIComponent(TEST_DISH_FAVORITE_NAME)}`);
    expect(statusRes.status()).toBe(200);
    expect(await statusRes.json()).toEqual({ favorited: true, id: favoriteId });

    const deleteRes = await tourPendingUser.request.delete(`/api/favorites/${favoriteId}`);
    expect(deleteRes.status()).toBe(200);
    expect(await deleteRes.json()).toEqual({ success: true });

    const afterRes = await tourPendingUser.request.get(`/api/favorites?q=${encodeURIComponent(TEST_DISH_FAVORITE_NAME)}`);
    expect(await afterRes.json()).toEqual({ favorites: [], total: 0 });
    // 消した行をもう一度消すと 404
    const againRes = await tourPendingUser.request.delete(`/api/favorites/${favoriteId}`);
    expect(againRes.status()).toBe(404);
    expect(await againRes.json()).toEqual(NOT_FOUND_BODY);
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
