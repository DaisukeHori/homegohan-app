import { describe, expect, it } from "vitest";

import {
  SINGLE_SERVING_PROMPT_GUIDANCE,
  sanitizeGenerationPromptConstraints,
  sanitizeGenerationPromptProfile,
} from "../supabase/functions/_shared/generation-serving.ts";

describe("generation serving safeguards", () => {
  it("keeps prompt guidance focused on single-serving portions", () => {
    expect(SINGLE_SERVING_PROMPT_GUIDANCE).toContain("1人分");
    expect(SINGLE_SERVING_PROMPT_GUIDANCE).toContain("120〜180g");
    expect(SINGLE_SERVING_PROMPT_GUIDANCE).toContain("100〜180g");
  });

  it("removes household sizing fields from prompt profile input", () => {
    const sanitized = sanitizeGenerationPromptProfile({
      nickname: "テスト",
      family_size: 3,
      servings_config: { default: 3, byDayMeal: {} },
      cooking_experience: "beginner",
    });

    expect(sanitized).toEqual({
      nickname: "テスト",
      cooking_experience: "beginner",
    });
  });

  it("removes family size overrides from prompt constraints", () => {
    const sanitized = sanitizeGenerationPromptConstraints({
      quickMeals: true,
      familySize: 4,
      family_size: 2,
    });

    expect(sanitized).toEqual({
      quickMeals: true,
    });
  });
});
