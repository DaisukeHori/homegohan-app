/**
 * AI の利用回数の上限 (#1149 / T40) と記録 (#1177 / T26) - Edge Functions 用
 *
 * 【どこで数えるか】
 * AI を使う処理は、Next.js の API ルートが consumeAiUsage (src/lib/plan/entitlements.ts) で 1 回と数える (上限の判定と記録)。
 * この関数は、Next.js を経由せず、ユーザー自身の JWT で Edge Function を直接呼ばれた場合 (#1153) のために、
 * Edge Function 側でも数える。直接呼ばれても数えないと、上限をすり抜けてしまうため。
 * 上限に達していれば記録せずに { allowed: false } を返す。呼び出し側は送らずに 429 (aiDailyLimitEdgeResponse) で止める。
 *
 * 【二重に数えない】
 *  - service role key (または cron のシークレット) で呼ばれたとき: 数えない。この関数は、ユーザーの JWT を確かめた
 *    経路 (requireAuth の成功後・auth.getUser の成功後) からだけ呼ぶ。service role の経路では呼ばない。
 *  - Next.js がユーザーの JWT で Edge Function を呼ぶとき (写真解析): Next.js が数え済みなので、
 *    署名つきの印 (x-hg-ai-usage-recorded) を付けて呼ぶ。印の署名・有効期間・ユーザーが合えば、ここでは数えずに許可する。
 *    仕組みは _shared/ai-usage-core.ts。
 *
 * 【順番】同意の判定 (_shared/ai-consent-guard.ts。#1154) → この判定と記録 → AI への送信。同意が無くて止めた呼び出しは数えない。
 *
 *   const aiUsage = await consumeEdgeAiUsage(req, userId, "photo_analysis");
 *   if (!aiUsage.allowed) return aiDailyLimitEdgeResponse(aiUsage, corsHeaders);
 *
 * 【失敗しても止めない】
 * DB の関数が失敗したとき (DB エラー・接続できない・migration が未適用・応答が遅いなど) は、ログに残して許可する。
 */

import { createClient } from "@supabase/supabase-js";
import {
  AI_USAGE_RECORDED_HEADER,
  AI_USAGE_TIMEOUT_MS,
  verifyAiUsageRecorded,
  type AiFeature,
} from "./ai-usage-core.ts";
import {
  AI_USAGE_NOT_COUNTED,
  aiDailyLimitPayload,
  parseConsumeAiUsageResult,
  type AiUsageAllowed,
  type AiUsageDenied,
  type AiUsageResult,
} from "./ai-daily-limit.ts";
import { createLogger } from "./db-logger.ts";

export { AI_FEATURES, AI_USAGE_RECORDED_HEADER, type AiFeature } from "./ai-usage-core.ts";
export { AI_DAILY_LIMIT_CODE, type AiUsageAllowed, type AiUsageDenied, type AiUsageResult } from "./ai-daily-limit.ts";

/** supabase-js の rpc だけを使う最小の形 (テストで差し替えられる) */
export interface AiUsageRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
}

export interface ConsumeEdgeAiUsageOptions {
  /** 既定は service_role のクライアント */
  client?: AiUsageRpcClient;
  timeoutMs?: number;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === "object") {
    const { code, message } = value as { code?: string; message?: string };
    return new Error([code, message].filter(Boolean).join(" ") || "unknown error");
  }
  return new Error(String(value));
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 記録済みの印の検証に使う鍵。Edge Function の他の箇所と同じく、SERVICE_ROLE_JWT と SUPABASE_SERVICE_ROLE_KEY のどちらも許容する */
function serviceRoleKeys(): string[] {
  return [Deno.env.get("SERVICE_ROLE_JWT"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")].filter(
    (key): key is string => !!key,
  );
}

function defaultClient(): AiUsageRpcClient {
  const keys = serviceRoleKeys();
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", keys[0] ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as AiUsageRpcClient;
}

/** ログに残す。ログの保存自体が失敗しても (ここで例外を出さない)、先へ進む */
function logFailure(userId: string, message: string, error: unknown, context: Record<string, unknown>): void {
  try {
    createLogger("ai-usage").withUser(userId).error(message, toError(error), context);
  } catch {
    // ログに残せなくても、AI の利用は止めない
  }
}

/**
 * ユーザーの JWT を確かめた経路から、AI の利用を 1 回数える (上限の判定と記録)。AI へ送る直前 (同意の判定のあと) に呼ぶ。
 *
 * @param req    受け取ったリクエスト (記録済みの印のヘッダーを読む)
 * @param userId JWT から確定したユーザー ID (リクエストの本文のユーザー ID は渡さない)
 *
 * 上限に達していれば、記録せずに { allowed: false } を返す (呼び出し側は送らずに aiDailyLimitEdgeResponse で止める)。
 * Next.js が数え済みの印があれば、数えずに許可する。DB の関数が失敗したときは、ログに残して許可する。例外は投げない。
 *
 * @example
 * const aiUsage = await consumeEdgeAiUsage(req, userId, "photo_analysis");
 * if (!aiUsage.allowed) return aiDailyLimitEdgeResponse(aiUsage, corsHeaders);
 */
export async function consumeEdgeAiUsage(
  req: Request,
  userId: string,
  feature: AiFeature,
  options: ConsumeEdgeAiUsageOptions = {},
): Promise<AiUsageResult> {
  try {
    // Next.js が数え済みの呼び出しは数えない。署名を確かめられなければ数える側に倒す
    if (await verifyAiUsageRecorded(req.headers.get(AI_USAGE_RECORDED_HEADER), userId, serviceRoleKeys())) {
      return AI_USAGE_NOT_COUNTED;
    }

    const client = options.client ?? defaultClient();
    const { data, error } = await withTimeout(
      client.rpc("consume_ai_usage", { p_user_id: userId, p_feature: feature }),
      options.timeoutMs ?? AI_USAGE_TIMEOUT_MS,
      "consume_ai_usage",
    );
    if (error) throw toError(error);
    const result = parseConsumeAiUsageResult(data);
    if (!result) throw new Error(`consume_ai_usage returned an unexpected value: ${JSON.stringify(data)}`);
    return result;
  } catch (error) {
    logFailure(userId, "AI 利用回数の判定と記録に失敗しました (数えずに許可します)", error, { feature });
    return AI_USAGE_NOT_COUNTED;
  }
}

/**
 * consumeEdgeAiUsage で数えた 1 回を戻す (数え戻し)。数えたあと、AI へ送る前に処理が失敗して何も送らなかったときだけ呼ぶ。
 * 数えていない結果では何もしない。失敗しても例外は投げない。
 */
export async function refundEdgeAiUsage(
  userId: string,
  feature: AiFeature,
  usage: AiUsageAllowed,
  options: ConsumeEdgeAiUsageOptions = {},
): Promise<void> {
  if (!usage.metered || !usage.usageDate) return;
  try {
    const client = options.client ?? defaultClient();
    const { error } = await withTimeout(
      client.rpc("refund_ai_usage", { p_user_id: userId, p_feature: feature, p_usage_date: usage.usageDate }),
      options.timeoutMs ?? AI_USAGE_TIMEOUT_MS,
      "refund_ai_usage",
    );
    if (error) throw toError(error);
  } catch (error) {
    logFailure(userId, "AI 利用回数の数え戻しに失敗しました", error, { feature, usageDate: usage.usageDate });
  }
}

/** 上限に達したときの応答 (429 AI_DAILY_LIMIT。Next.js の aiDailyLimitResponse と同じ形)。CORS などのヘッダーを足して返す */
export function aiDailyLimitEdgeResponse(
  denied: AiUsageDenied,
  headers: Record<string, string> = {},
  nowMs: number = Date.now(),
): Response {
  const payload = aiDailyLimitPayload(denied, nowMs);
  return new Response(JSON.stringify(payload.body), {
    status: payload.status,
    headers: { ...headers, ...payload.headers, "Content-Type": "application/json" },
  });
}
