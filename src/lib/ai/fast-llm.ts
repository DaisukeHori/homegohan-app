import OpenAI from "openai";

import { getOptionalEnv } from "@/lib/env";
import { MissingEnvError } from "@/lib/env-required";

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

// FAST_LLM_MODEL・XAI_BASE_URL は任意の変数 (src/lib/env.ts の一覧)。ほかの任意の変数と同じく getOptionalEnv で読む
// (未設定・空・空白だけなら undefined。プロセスごとに 1 回だけ警告をサーバーのログに出す)。
// 無いときの既定値は以前と同じ (DEFAULT_FAST_LLM_MODEL・DEFAULT_XAI_BASE_URL)。#1522
export function getFastLLMModel(): string {
  return getOptionalEnv("FAST_LLM_MODEL")?.trim() || DEFAULT_FAST_LLM_MODEL;
}

export function getFastLLMBaseUrl(): string {
  return normalizeBaseUrl(getOptionalEnv("XAI_BASE_URL"));
}

export function getFastLLMClient(): OpenAI {
  if (fastLLMClient) return fastLLMClient;

  // XAI_API_KEY は任意の変数 (src/lib/env.ts の一覧)。無ければ fast-llm を使う機能だけが使えない。
  // 変数名は例外の message に入れない (#1182・#1490)。呼び出し元の catch が message を本文や記録に入れても、
  // 変数名が外に出ないようにするため。欠けている変数名は、getOptionalEnv の警告 (サーバーのログ。プロセスごとに 1 回) と、
  // MissingEnvError の envName (internalError() / db-logger の error() が missing_env_name として記録する) にだけ残る。
  const apiKey = getOptionalEnv("XAI_API_KEY")?.trim();
  if (!apiKey) {
    throw new MissingEnvError("XAI_API_KEY");
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
