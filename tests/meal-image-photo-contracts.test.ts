import { describe, expect, it, vi } from "vitest";

import { buildPhotoDishList } from "../lib/meal-image";
import { cancelPendingMealImageJobs } from "../lib/meal-image-jobs";

describe("meal image photo contracts", () => {
  it("marks single-dish photo as ready meal photo metadata", () => {
    const dishes = buildPhotoDishList([{ name: "親子丼", role: "main" }], "https://example.com/photo.jpg");
    expect(dishes).toHaveLength(1);
    expect(dishes[0].image_source).toBe("meal_photo");
    expect(dishes[0].image_status).toBe("ready");
    expect(dishes[0].image_url).toBe("https://example.com/photo.jpg");
    expect(dishes[0].image_generated_at).toBeTruthy();
  });

  it("treats multi-dish photos as stale fallbacks that still record the source", () => {
    const dishes = buildPhotoDishList(
      [
        { name: "麻婆豆腐", role: "main" },
        { name: "青菜炒め", role: "side" },
      ],
      "https://example.com/multi.jpg",
    );
    expect(dishes).toHaveLength(2);
    expect(dishes.every((dish) => dish.image_source === "meal_photo")).toBe(true);
    expect(dishes.every((dish) => dish.image_status === "stale")).toBe(true);
    expect(dishes.every((dish) => dish.image_url === null)).toBe(true);
  });

  it("cancels pending image jobs when a photo overwrite happens", async () => {
    const inFn = vi.fn().mockResolvedValue({ data: null, error: null });
    const eqFn = vi.fn(() => ({ in: inFn }));
    const updateFn = vi.fn(() => ({ eq: eqFn }));
    const fromFn = vi.fn(() => ({ update: updateFn }));
    const supabase = { from: fromFn };

    await cancelPendingMealImageJobs({
      supabase,
      plannedMealId: "meal-1",
      reason: "photo overwrite",
    });

    expect(fromFn).toHaveBeenCalledWith("meal_image_jobs");
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
        last_error: "photo overwrite",
        updated_at: expect.any(String),
      }),
    );
    expect(eqFn).toHaveBeenCalledWith("planned_meal_id", "meal-1");
    expect(inFn).toHaveBeenCalledWith("status", ["pending", "processing"]);
  });
});
