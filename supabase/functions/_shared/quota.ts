/**
 * AI 利用回数の記録 - Edge Functions 用 (#1177 / T26)
 *
 * 【いまの方針】当面は無料のまま計測する (オーナーの選択 2026-10-10)。全員無制限のまま回数を記録するだけ。上限の数値 (T40) は別の作業。
 * 全プランの上限が NULL (無制限) の間は、必ず許可し、回数を増やすだけ。拒否 (429) は通らない。
 *
 * 【どこで数えるか】
 * AI を使う処理は、Next.js の API ルートが consumeAiQuota (src/lib/plan/entitlements.ts) で 1 回と数える。
 * この関数は、Next.js を経由せず、ユーザー自身の JWT で Edge Function を直接呼ばれた場合 (#1153) のために、
 * Edge Function 側でも数える。直接呼ばれても回数が数えられないと、AI の利用回数がすり抜けてしまうため。
 *
 * 【二重に数えない】
 *  - service role key (または cron のシークレット) で呼ばれたとき: 数えない。この関数は、ユーザーの JWT を確かめた
 *    経路 (requireAuth の成功後・auth.getUser の成功後) からだけ呼ぶ。service role の経路では呼ばない。
 *  - Next.js がユーザーの JWT で Edge Function を呼ぶとき (写真解析・AI 相談の献立生成): Next.js が数え済みなので、
 *    署名つきの印 (x-hg-ai-quota-counted) を付けて呼ぶ。印の署名・有効期間・ユーザーが合えば、ここでは数えない。
 *    仕組みは _shared/ai-quota-core.ts。
 *
 * 【失敗しても止めない (fail-open)】
 * DB の関数が失敗したとき (DB エラー・接続できない・migration が未適用・応答が遅いなど) は、記録して許可する。
 * 記録は best-effort で、記録の失敗で AI の機能そのものを止めない。
 */

import { createClient } from "@supabase/supabase-js";
import {
  AI_QUOTA_COUNTED_HEADER,
  AI_QUOTA_TIMEOUT_MS,
  aiQuotaErrorBody,
  parseAiQuotaResult,
  verifyAiQuotaCounted,
  type AiFeature,
  type AiQuotaResult,
} from "./ai-quota-core.ts";
import { createLogger } from "./db-logger.ts";

export {
  AI_FEATURES,
  AI_QUOTA_COUNTED_HEADER,
  AI_QUOTA_ERROR_CODES,
  type AiFeature,
  type AiQuotaLimitKind,
  type AiQuotaResult,
} from "./ai-quota-core.ts";

/** supabase-js の rpc だけを使う最小の形 (テストで差し替えられる) */
export interface QuotaRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
}

export interface ConsumeEdgeAiQuotaOptions {
  /** 既定は service_role のクライアント */
  client?: QuotaRpcClient;
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

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`consume_ai_quota timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 数え済みの印の検証に使う鍵。Edge Function の他の箇所と同じく、SERVICE_ROLE_JWT と SUPABASE_SERVICE_ROLE_KEY のどちらも許容する */
function serviceRoleKeys(): string[] {
  return [Deno.env.get("SERVICE_ROLE_JWT"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")].filter(
    (key): key is string => !!key,
  );
}

function defaultClient(): QuotaRpcClient {
  const keys = serviceRoleKeys();
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", keys[0] ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as QuotaRpcClient;
}

/**
 * ユーザーの JWT を確かめた経路から、AI を 1 回使うことを記録する。
 *
 * @param req    受け取ったリクエスト (数え済みの印のヘッダーを読む)
 * @param userId JWT から確定したユーザー ID (リクエストの本文のユーザー ID は渡さない)
 *
 * 失敗しても例外は投げず、ログに残して許可する (止めない)。
 *
 * @example
 * const quota = await consumeEdgeAiQuota(req, userId, "photo_analysis");
 * if (!quota.allowed) return aiQuotaExceededResponse(quota, corsHeaders);
 */
export async function consumeEdgeAiQuota(
  req: Request,
  userId: string,
  feature: AiFeature,
  options: ConsumeEdgeAiQuotaOptions = {},
): Promise<AiQuotaResult> {
  try {
    // Next.js が数え済みの呼び出しは数えない。署名を確かめられなければ数える側に倒す
    if (await verifyAiQuotaCounted(req.headers.get(AI_QUOTA_COUNTED_HEADER), userId, serviceRoleKeys())) {
      return { allowed: true, remaining: null, skipped: true };
    }

    const client = options.client ?? defaultClient();
    const { data, error } = await withTimeout(
      client.rpc("consume_ai_quota", { p_user_id: userId, p_feature: feature }),
      options.timeoutMs ?? AI_QUOTA_TIMEOUT_MS,
    );
    if (error) throw toError(error);
    return parseAiQuotaResult(data);
  } catch (error) {
    // 記録に失敗した理由をログに残す。ログの保存自体が失敗しても (ここで例外を出さない)、許可して先へ進む
    try {
      createLogger("ai-quota")
        .withUser(userId)
        .error("AI 利用回数の記録に失敗しました (記録できなかったので、止めずに許可します)", toError(error), { feature });
    } catch {
      // ログに残せなくても、AI の利用は止めない
    }
    return { allowed: true, remaining: null };
  }
}

/**
 * 上限を超えたときの 429 (いまは通らない)。レート制限の 429 とは code で区別する。
 * corsHeaders は、その関数が getCorsHeaders(req) で作ったものを渡す。
 */
export function aiQuotaExceededResponse(
  result: AiQuotaResult,
  corsHeaders: Record<string, string> = {},
): Response {
  const { body, retryAfterSec } = aiQuotaErrorBody(result);
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...(retryAfterSec !== undefined ? { "Retry-After": String(retryAfterSec) } : {}),
    },
  });
}
