import { describe, expect, it, vi } from "vitest";

import { enqueueMealImageJobs } from "../supabase/functions/_shared/meal-image-jobs";

describe("meal image generation contracts", () => {
  it("enqueues jobs with idempotency keys and request metadata", async () => {
    const upsert = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = {
      from: vi.fn(() => ({
        upsert,
      })),
    };

    await enqueueMealImageJobs({
      supabase,
      plannedMealId: "meal-1",
      userId: "user-1",
      jobs: [
        {
          dishIndex: 0,
          dishName: "親子丼",
          subjectHash: "hash-1",
          prompt: "prompt",
          model: "gemini-3.1-flash-image-preview",
          referenceImageUrls: ["https://example.com/ref.png"],
          triggerSource: "generate-menu-v4:req-1",
        },
      ],
      requestId: "req-1",
    });

    expect(supabase.from).toHaveBeenCalledWith("meal_image_jobs");
    expect(upsert).toHaveBeenCalled();
    const rows = upsert.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].planned_meal_id).toBe("meal-1");
    expect(rows[0].request_id).toBe("req-1");
    expect(rows[0].trigger_source).toBe("generate-menu-v4:req-1");
    expect(rows[0].reference_image_urls).toEqual(["https://example.com/ref.png"]);
    expect(rows[0].subject_hash).toBe("hash-1");
    expect(rows[0].idempotency_key).toBeDefined();
  });
});
