/**
 * AI 利用回数の記録 - Edge Functions 用 (#1177 / T26)
 *
 * 【いまの方針】当面は無料のまま計測する。全員無制限のまま、回数を記録するだけ。
 * 上限と比べて止める処理は、この作業では足さない (上限を実際に入れる #1149 / T40 が、拒否したときの扱いと一緒に設計して足す)。
 *
 * 【どこで記録するか】
 * AI を使う処理は、Next.js の API ルートが recordAiUsage (src/lib/plan/entitlements.ts) で 1 回と記録する。
 * この関数は、Next.js を経由せず、ユーザー自身の JWT で Edge Function を直接呼ばれた場合 (#1153) のために、
 * Edge Function 側でも記録する。直接呼ばれても記録されないと、AI の利用回数がすり抜けてしまうため。
 *
 * 【二重に記録しない】
 *  - service role key (または cron のシークレット) で呼ばれたとき: 記録しない。この関数は、ユーザーの JWT を確かめた
 *    経路 (requireAuth の成功後・auth.getUser の成功後) からだけ呼ぶ。service role の経路では呼ばない。
 *  - Next.js がユーザーの JWT で Edge Function を呼ぶとき (写真解析・AI 相談の献立生成): Next.js が記録済みなので、
 *    署名つきの印 (x-hg-ai-usage-recorded) を付けて呼ぶ。印の署名・有効期間・ユーザーが合えば、ここでは記録しない。
 *    仕組みは _shared/ai-usage-core.ts。
 *
 * 【順番】同意の判定 (_shared/ai-consent-guard.ts。#1154) → この記録 → AI への送信。同意が無くて止めた呼び出しは記録しない。
 *
 * 【失敗しても止めない】
 * DB の関数が失敗したとき (DB エラー・接続できない・migration が未適用・応答が遅いなど) は、ログに残して先へ進む。
 * 記録は best-effort で、記録の失敗で AI の機能そのものを止めない。
 */

import { createClient } from "@supabase/supabase-js";
import {
  AI_USAGE_RECORDED_HEADER,
  AI_USAGE_TIMEOUT_MS,
  verifyAiUsageRecorded,
  type AiFeature,
} from "./ai-usage-core.ts";
import { createLogger } from "./db-logger.ts";

export { AI_FEATURES, AI_USAGE_RECORDED_HEADER, type AiFeature } from "./ai-usage-core.ts";

/** supabase-js の rpc だけを使う最小の形 (テストで差し替えられる) */
export interface AiUsageRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
}

export interface RecordEdgeAiUsageOptions {
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

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`record_ai_usage timed out after ${timeoutMs}ms`)), timeoutMs);
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

/**
 * ユーザーの JWT を確かめた経路から、AI を 1 回使うことを記録する。AI へ送る直前 (同意の判定のあと) に呼ぶ。
 *
 * @param req    受け取ったリクエスト (記録済みの印のヘッダーを読む)
 * @param userId JWT から確定したユーザー ID (リクエストの本文のユーザー ID は渡さない)
 *
 * 失敗しても例外は投げず、ログに残して戻る (止めない)。
 *
 * @example
 * await recordEdgeAiUsage(req, userId, "photo_analysis");
 */
export async function recordEdgeAiUsage(
  req: Request,
  userId: string,
  feature: AiFeature,
  options: RecordEdgeAiUsageOptions = {},
): Promise<void> {
  try {
    // Next.js が記録済みの呼び出しは記録しない。署名を確かめられなければ記録する側に倒す
    if (await verifyAiUsageRecorded(req.headers.get(AI_USAGE_RECORDED_HEADER), userId, serviceRoleKeys())) return;

    const client = options.client ?? defaultClient();
    const { error } = await withTimeout(
      client.rpc("record_ai_usage", { p_user_id: userId, p_feature: feature }),
      options.timeoutMs ?? AI_USAGE_TIMEOUT_MS,
    );
    if (error) throw toError(error);
  } catch (error) {
    // 記録に失敗した理由をログに残す。ログの保存自体が失敗しても (ここで例外を出さない)、先へ進む
    try {
      createLogger("ai-usage")
        .withUser(userId)
        .error("AI 利用回数の記録に失敗しました (記録せずに続けます)", toError(error), { feature });
    } catch {
      // ログに残せなくても、AI の利用は止めない
    }
  }
}
