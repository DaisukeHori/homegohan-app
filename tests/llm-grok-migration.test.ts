import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const MODEL_LITERAL_RE = /gpt-5-nano|gpt-5-mini|gpt-4o-mini/;

const migratedTargets = [
  "supabase/functions/analyze-fridge/index.ts",
  "supabase/functions/normalize-shopping-list/index.ts",
  "supabase/functions/regenerate-shopping-list-v2/index.ts",
  "supabase/functions/generate-health-insights/index.ts",
  "supabase/functions/create-derived-recipe/index.ts",
  "supabase/functions/knowledge-gpt/index.ts",
  "supabase/functions/_shared/catalog-llm.ts",
  "supabase/functions/_shared/nutrition-calculator.ts",
  "src/app/api/ai/nutrition/route.ts",
  "src/app/api/ai/nutrition-analysis/route.ts",
  "src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts",
  "src/app/api/ai/consultation/sessions/[sessionId]/summarize/route.ts",
  "src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts",
  "src/app/api/ai/feedback/route.ts",
];

const originalEnv = {
  FAST_LLM_MODEL: process.env.FAST_LLM_MODEL,
  XAI_BASE_URL: process.env.XAI_BASE_URL,
};

afterEach(() => {
  if (originalEnv.FAST_LLM_MODEL === undefined) delete process.env.FAST_LLM_MODEL;
  else process.env.FAST_LLM_MODEL = originalEnv.FAST_LLM_MODEL;

  if (originalEnv.XAI_BASE_URL === undefined) delete process.env.XAI_BASE_URL;
  else process.env.XAI_BASE_URL = originalEnv.XAI_BASE_URL;
});

describe("fast llm helper defaults", () => {
  it("defaults to Grok and normalizes the xAI base URL", async () => {
    delete process.env.FAST_LLM_MODEL;
    process.env.XAI_BASE_URL = "https://example.x.ai";

    const mod = await import("../src/lib/ai/fast-llm");
    expect(mod.getFastLLMModel()).toBe("grok-4-1-fast-non-reasoning");
    expect(mod.getFastLLMBaseUrl()).toBe("https://example.x.ai/v1");
    expect(mod.getFastLLMChatCompletionsUrl()).toBe("https://example.x.ai/v1/chat/completions");
  });
});

describe("migrated targets", () => {
  it("do not keep GPT mini/nano model literals in active call sites", () => {
    for (const relativePath of migratedTargets) {
      const fullPath = path.join(process.cwd(), relativePath);
      const content = readFileSync(fullPath, "utf8");
      expect(content, relativePath).not.toMatch(MODEL_LITERAL_RE);
    }
  });
});
