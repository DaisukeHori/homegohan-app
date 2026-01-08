/**
 * LLMトークン使用量計測モジュール
 * 
 * Edge Functions内の全OpenAI呼び出し（Chat/Responses/Embeddings/@openai/agents）を
 * globalThis.fetchをラップして自動計測し、llm_usage_logsテーブルに記録する
 */

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ============================================
// 型定義
// ============================================

export interface LLMUsageContext {
  functionName: string;
  executionId: string;
  requestId?: string;
  userId?: string;
  supabaseClient: SupabaseClient;
}

interface UsageRecord {
  function_name: string;
  execution_id: string;
  request_id: string | null;
  user_id: string | null;
  provider: string;
  endpoint: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  call_type: string | null;
  duration_ms: number;
  success: boolean;
  status_code: number | null;
  openai_response_id: string | null;
  openai_request_id: string | null;
  is_summary: boolean;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
}

interface ParsedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  model: string;
  responseId: string | null;
}

// ============================================
// コスト計算レート（参考値、変更可能）
// ============================================

const COST_RATES: Record<string, { input: number; output: number }> = {
  "gpt-5-mini": { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  "gpt-4o-mini": { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  "gpt-4o": { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
  "text-embedding-3-small": { input: 0.02 / 1_000_000, output: 0 },
  "text-embedding-3-large": { input: 0.13 / 1_000_000, output: 0 },
};

function estimateCost(model: string, inputTokens: number | null, outputTokens: number | null): number | null {
  const rate = COST_RATES[model];
  if (!rate) return null;
  const input = (inputTokens ?? 0) * rate.input;
  const output = (outputTokens ?? 0) * rate.output;
  return input + output;
}

// ============================================
// Usage解析
// ============================================

function parseUsageFromResponse(endpoint: string, json: unknown): ParsedUsage {
  const result: ParsedUsage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    model: "unknown",
    responseId: null,
  };

  if (!json || typeof json !== "object") return result;
  const data = json as Record<string, unknown>;

  // model
  if (typeof data.model === "string") {
    result.model = data.model;
  }

  // response id
  if (typeof data.id === "string") {
    result.responseId = data.id;
  }

  // usage object
  const usage = data.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === "object") {
    // Chat Completions: prompt_tokens, completion_tokens, total_tokens
    if (typeof usage.prompt_tokens === "number") {
      result.inputTokens = usage.prompt_tokens;
    }
    if (typeof usage.completion_tokens === "number") {
      result.outputTokens = usage.completion_tokens;
    }
    // Responses API: input_tokens, output_tokens
    if (typeof usage.input_tokens === "number") {
      result.inputTokens = usage.input_tokens;
    }
    if (typeof usage.output_tokens === "number") {
      result.outputTokens = usage.output_tokens;
    }
    // total_tokens
    if (typeof usage.total_tokens === "number") {
      result.totalTokens = usage.total_tokens;
    } else if (result.inputTokens !== null || result.outputTokens !== null) {
      result.totalTokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
    }
  }

  // Embeddings: usage.total_tokens のみの場合
  if (endpoint.includes("/embeddings") && result.totalTokens !== null && result.inputTokens === null) {
    result.inputTokens = result.totalTokens;
    result.outputTokens = 0;
  }

  return result;
}

function detectCallType(endpoint: string): string {
  if (endpoint.includes("/chat/completions")) return "chat";
  if (endpoint.includes("/responses")) return "response";
  if (endpoint.includes("/embeddings")) return "embedding";
  return "unknown";
}

// ============================================
// 累積トラッカー
// ============================================

class UsageTracker {
  private records: UsageRecord[] = [];
  private ctx: LLMUsageContext;

  constructor(ctx: LLMUsageContext) {
    this.ctx = ctx;
  }

  addRecord(record: Omit<UsageRecord, "function_name" | "execution_id" | "request_id" | "user_id" | "is_summary">) {
    this.records.push({
      ...record,
      function_name: this.ctx.functionName,
      execution_id: this.ctx.executionId,
      request_id: this.ctx.requestId ?? null,
      user_id: this.ctx.userId ?? null,
      is_summary: false,
    });
  }

  getSummary(): UsageRecord {
    let totalInput = 0;
    let totalOutput = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let totalDuration = 0;
    let allSuccess = true;

    for (const r of this.records) {
      totalInput += r.input_tokens ?? 0;
      totalOutput += r.output_tokens ?? 0;
      totalTokens += r.total_tokens ?? 0;
      totalCost += r.estimated_cost_usd ?? 0;
      totalDuration += r.duration_ms;
      if (!r.success) allSuccess = false;
    }

    return {
      function_name: this.ctx.functionName,
      execution_id: this.ctx.executionId,
      request_id: this.ctx.requestId ?? null,
      user_id: this.ctx.userId ?? null,
      provider: "openai",
      endpoint: "summary",
      model: "mixed",
      input_tokens: totalInput || null,
      output_tokens: totalOutput || null,
      total_tokens: totalTokens || null,
      estimated_cost_usd: totalCost || null,
      call_type: "summary",
      duration_ms: totalDuration,
      success: allSuccess,
      status_code: null,
      openai_response_id: null,
      openai_request_id: null,
      is_summary: true,
      error_message: null,
      metadata: { call_count: this.records.length },
    };
  }

  getRecords(): UsageRecord[] {
    return this.records;
  }

  hasRecords(): boolean {
    return this.records.length > 0;
  }
}

// ============================================
// メイン: withOpenAIUsageContext
// ============================================

/**
 * LLM使用量計測コンテキストでfnを実行する
 * 
 * @example
 * ```ts
 * const result = await withOpenAIUsageContext({
 *   functionName: "generate-menu-v4",
 *   executionId: crypto.randomUUID(),
 *   requestId: req.requestId,
 *   userId: userId,
 *   supabaseClient: supabase,
 * }, async () => {
 *   // この中のOpenAI呼び出しは自動計測される
 *   const response = await fetch("https://api.openai.com/v1/chat/completions", { ... });
 *   return response.json();
 * });
 * ```
 */
export async function withOpenAIUsageContext<T>(
  ctx: LLMUsageContext,
  fn: () => Promise<T>
): Promise<T> {
  const tracker = new UsageTracker(ctx);
  const originalFetch = globalThis.fetch;

  // fetchをラップ
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // OpenAI APIへのリクエストかチェック
    if (!url.includes("api.openai.com")) {
      return originalFetch(input, init);
    }

    const startTime = Date.now();
    let response: Response;
    let success = true;
    let statusCode: number | null = null;
    let errorMessage: string | null = null;
    let parsedUsage: ParsedUsage | null = null;
    let openaiRequestId: string | null = null;

    try {
      response = await originalFetch(input, init);
      statusCode = response.status;
      success = response.ok;

      // x-request-id ヘッダーを取得
      openaiRequestId = response.headers.get("x-request-id");

      // レスポンスをクローンしてJSONを解析
      const clonedResponse = response.clone();
      try {
        const json = await clonedResponse.json();
        parsedUsage = parseUsageFromResponse(url, json);
      } catch {
        // JSONパースエラーは無視（ストリーミング等）
      }

      return response;
    } catch (error) {
      success = false;
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      const duration = Date.now() - startTime;
      const endpoint = new URL(url).pathname;

      tracker.addRecord({
        provider: "openai",
        endpoint,
        model: parsedUsage?.model ?? "unknown",
        input_tokens: parsedUsage?.inputTokens ?? null,
        output_tokens: parsedUsage?.outputTokens ?? null,
        total_tokens: parsedUsage?.totalTokens ?? null,
        estimated_cost_usd: parsedUsage ? estimateCost(
          parsedUsage.model,
          parsedUsage.inputTokens,
          parsedUsage.outputTokens
        ) : null,
        call_type: detectCallType(endpoint),
        duration_ms: duration,
        success,
        status_code: statusCode,
        openai_response_id: parsedUsage?.responseId ?? null,
        openai_request_id: openaiRequestId,
        error_message: errorMessage,
        metadata: null,
      });
    }
  };

  try {
    // 本体実行
    const result = await fn();
    return result;
  } finally {
    // fetchを元に戻す
    globalThis.fetch = originalFetch;

    // 非同期でDBに記録
    if (tracker.hasRecords()) {
      const recordsToInsert = [...tracker.getRecords(), tracker.getSummary()];

      // EdgeRuntime.waitUntilが使える場合は使う（レイテンシ改善）
      const insertPromise = ctx.supabaseClient
        .from("llm_usage_logs")
        .insert(recordsToInsert)
        .then(({ error }) => {
          if (error) {
            console.error("[llm-usage] Failed to insert usage logs:", error);
          } else {
            console.log(`[llm-usage] Recorded ${recordsToInsert.length} usage logs for ${ctx.functionName}`);
          }
        });

      // @ts-ignore - EdgeRuntime is Deno-specific
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(insertPromise);
      } else {
        // フォールバック: awaitする（ただし若干遅延）
        await insertPromise;
      }
    }
  }
}

/**
 * 実行IDを生成するヘルパー
 */
export function generateExecutionId(): string {
  return crypto.randomUUID();
}
