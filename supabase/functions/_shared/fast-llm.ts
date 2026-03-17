import OpenAI from "npm:openai@6.9.1";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_FAST_LLM_MODEL = "grok-4-1-fast-non-reasoning";

function normalizeBaseUrl(raw?: string | null): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return DEFAULT_XAI_BASE_URL;
  const withoutSlash = trimmed.replace(/\/+$/, "");
  if (withoutSlash.endsWith("/v1")) return withoutSlash;
  return `${withoutSlash}/v1`;
}

function readDenoEnv(name: string): string | undefined {
  const denoLike = (globalThis as typeof globalThis & {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
  }).Deno;
  return denoLike?.env?.get?.(name);
}

export function getFastLLMBaseUrl(): string {
  return normalizeBaseUrl(readDenoEnv("XAI_BASE_URL"));
}

export function getFastLLMModel(envName = "FAST_LLM_MODEL"): string {
  return String(readDenoEnv(envName) ?? "").trim() || DEFAULT_FAST_LLM_MODEL;
}

export function getFastLLMApiKey(): string {
  const apiKey = String(readDenoEnv("XAI_API_KEY") ?? "").trim();
  if (!apiKey) {
    throw new Error("Missing XAI_API_KEY");
  }
  return apiKey;
}

export function createFastLLMClient(): OpenAI {
  return new OpenAI({
    apiKey: getFastLLMApiKey(),
    baseURL: getFastLLMBaseUrl(),
  });
}

export function getFastLLMChatCompletionsUrl(): string {
  return `${getFastLLMBaseUrl()}/chat/completions`;
}

export function getFastLLMFetchHeaders(section?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getFastLLMApiKey()}`,
  };
  if (section?.trim()) {
    headers["x-llm-section"] = section.trim();
  }
  return headers;
}
