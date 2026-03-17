import { fetchWithRetry } from "./network-retry.ts";

export type V4FastLLMProvider = "openai" | "xai";

export type V4FastLLMSection =
  | "generateMealWithLLM"
  | "generateDayMealsWithLLM"
  | "regenerateMealForIssue"
  | "ingredientMatcher.selectBestMatchWithLLM";

export interface V4FastLLMConfig {
  provider: V4FastLLMProvider;
  model: string;
  apiKey: string;
  endpoint: string;
}

type V4FastLLMOverride = Partial<Pick<V4FastLLMConfig, "provider" | "model">>;

declare global {
  // deno-lint-ignore no-var
  var __HOMEGOHAN_V4_FAST_LLM_OVERRIDE__: V4FastLLMOverride | undefined;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

const DEFAULT_OPENAI_MODEL = "gpt-5.2";
const DEFAULT_XAI_MODEL = "grok-4-1-fast-non-reasoning";

function resolveProvider(): V4FastLLMProvider {
  const override = globalThis.__HOMEGOHAN_V4_FAST_LLM_OVERRIDE__;
  if (override?.provider === "openai" || override?.provider === "xai") {
    return override.provider;
  }
  const explicit = String(Deno.env.get("V4_FAST_LLM_PROVIDER") ?? "").trim().toLowerCase();
  if (explicit === "openai" || explicit === "xai") return explicit;
  return Deno.env.get("XAI_API_KEY") ? "xai" : "openai";
}

export function setV4FastLLMOverride(override?: V4FastLLMOverride): void {
  globalThis.__HOMEGOHAN_V4_FAST_LLM_OVERRIDE__ = override;
}

export function getV4FastLLMConfig(): V4FastLLMConfig {
  const provider = resolveProvider();
  const override = globalThis.__HOMEGOHAN_V4_FAST_LLM_OVERRIDE__;

  if (provider === "xai") {
    const apiKey = String(Deno.env.get("XAI_API_KEY") ?? "").trim();
    if (!apiKey) {
      throw new Error("Missing XAI_API_KEY");
    }

    return {
      provider,
      model: override?.model ?? (String(Deno.env.get("V4_FAST_LLM_MODEL") ?? "").trim() || DEFAULT_XAI_MODEL),
      apiKey,
      endpoint: "https://api.x.ai/v1/chat/completions",
    };
  }

  const apiKey = String(Deno.env.get("OPENAI_API_KEY") ?? "").trim();
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  return {
    provider,
    model: override?.model ?? (String(Deno.env.get("V4_FAST_LLM_MODEL") ?? "").trim() || DEFAULT_OPENAI_MODEL),
    apiKey,
    endpoint: "https://api.openai.com/v1/chat/completions",
  };
}

export async function callV4FastLLM(input: {
  section: V4FastLLMSection;
  systemPrompt?: string;
  userPrompt: string;
  maxCompletionTokens?: number;
}): Promise<{ text: string; model: string; provider: V4FastLLMProvider }> {
  const config = getV4FastLLMConfig();

  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (input.systemPrompt?.trim()) {
    messages.push({ role: "system", content: input.systemPrompt.trim() });
  }
  messages.push({ role: "user", content: input.userPrompt });

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_completion_tokens: input.maxCompletionTokens ?? 8000,
  };

  if (config.provider === "openai") {
    body.reasoning_effort = "low";
  }

  const res = await fetchWithRetry(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "x-llm-section": input.section,
    },
    body: JSON.stringify(body),
  }, {
    label: `${input.section}:${config.provider}`,
    retries: 2,
    timeoutMs: 60000,
  });

  const json = await res.json() as ChatCompletionResponse;
  const text = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error(`${config.provider} LLM output is empty`);
  }

  return {
    text,
    model: config.model,
    provider: config.provider,
  };
}
