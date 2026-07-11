import OpenAI from "openai";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_FAST_LLM_MODEL = "grok-4-1-fast-non-reasoning";

let fastLLMClient: OpenAI | null = null;

function normalizeBaseUrl(raw?: string | null): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return DEFAULT_XAI_BASE_URL;
  const withoutSlash = trimmed.replace(/\/+$/, "");
  if (withoutSlash.endsWith("/v1")) return withoutSlash;
  return `${withoutSlash}/v1`;
}

export function getFastLLMModel(): string {
  return String(process.env.FAST_LLM_MODEL ?? "").trim() || DEFAULT_FAST_LLM_MODEL;
}

export function getFastLLMBaseUrl(): string {
  return normalizeBaseUrl(process.env.XAI_BASE_URL);
}

export function getFastLLMClient(): OpenAI {
  if (fastLLMClient) return fastLLMClient;

  const apiKey = String(process.env.XAI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("Missing XAI_API_KEY");
  }

  fastLLMClient = new OpenAI({
    apiKey,
    baseURL: getFastLLMBaseUrl(),
    // #1047 F2-15: 呼び出し側が signal を渡し忘れた場合でもハングしないよう、
    // クライアント全体のデフォルトタイムアウト/リトライを設定する
    // （個別呼び出しは引き続き AbortSignal.timeout() を渡すことを推奨）。
    timeout: 25_000,
    maxRetries: 1,
  });

  return fastLLMClient;
}

export function getFastLLMChatCompletionsUrl(): string {
  return `${getFastLLMBaseUrl()}/chat/completions`;
}
