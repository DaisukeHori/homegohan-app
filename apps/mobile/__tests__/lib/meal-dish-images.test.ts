/**
 * #1487: 端末が直に保存する写真・商品の料理の画像の項目
 * (サーバーと同じ形であることは、リポジトリの直下の tests/mobile-meal-dish-images-parity.test.ts が確かめる)
 */
import { buildPhotoDishList, catalogDishImageFields } from "../../src/lib/meal-dish-images";

const PHOTO_URL = "https://example.com/photo.jpg";

describe("meal-dish-images (#1487)", () => {
  it("写真の料理が 1 つなら、写真をその料理の画像にし、source を meal_photo にする (subject_hash は付けない)", () => {
    const [dish] = buildPhotoDishList([{ name: "親子丼", role: "main" }], PHOTO_URL);
    expect(dish).toMatchObject({ name: "親子丼", image_url: PHOTO_URL, image_source: "meal_photo", image_status: "ready" });
    expect(typeof dish.image_generated_at).toBe("string");
    expect(dish).not.toHaveProperty("image_subject_hash");
  });

  it("写真の料理が複数なら、料理ごとの画像は付けず stale にする", () => {
    const dishes = buildPhotoDishList([{ name: "親子丼" }, { name: "味噌汁" }], PHOTO_URL);
    expect(dishes.map((dish) => [dish.image_url, dish.image_source, dish.image_status])).toEqual([
      [null, "meal_photo", "stale"],
      [null, "meal_photo", "stale"],
    ]);
  });

  it("商品の料理は商品の画像を付け、source を catalog にする。画像が無ければ状態を付けない", () => {
    expect(catalogDishImageFields("https://example.com/bento.jpg")).toEqual({
      image_url: "https://example.com/bento.jpg",
      image_source: "catalog",
      image_status: "ready",
    });
    expect(catalogDishImageFields(null)).toEqual({ image_url: null, image_source: "catalog", image_status: null });
  });
});
