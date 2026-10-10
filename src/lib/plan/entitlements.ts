/**
 * プランの判定と、AI の利用回数の記録 (#1177 / T26)
 *
 * 【いまの方針】当面は無料のまま計測する。全員無制限のまま、回数を記録するだけ。
 * この作業は「記録だけ」で、上限と比べて止める処理は入れない。上限の値と、上限を超えたときの扱い
 * (429 にするか・AI の部分だけ省くか・キューの行をどうするか) は、上限を実際に入れる作業 (#1149 / T40) が入口ごとに設計して足す。
 *
 * 【使い方】AI を使う API ルートは、AI 事業者へ送る直前 (認証・外国の AI 事業者への提供の同意の判定・checkRateLimit・
 * 入力の検証などの判定をすべて通ったあと) に、1 回の操作につき 1 回呼ぶ。送る前に処理が止まる経路
 * (入力の誤り・権限なし・同意が無い・キャッシュを返すだけ) では記録しない。
 * 順番は「同意の判定 (requireAiConsent / checkUserAiConsent。src/lib/ai/consent-guard.ts、#1154) → この記録 → AI への送信」。
 *
 *   const aiConsentDenied = await requireAiConsent(supabase, user.id);
 *   if (aiConsentDenied) return aiConsentDenied;
 *   const rateLimitResult = await checkRateLimit(user.id, 'analysis');
 *   if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);
 *   await recordAiUsage(user.id, 'photo_analysis');
 *
 * - user.id には、認証で確定した ID だけを渡す (リクエストの本文・URL の未検証の ID は渡さない)。
 *   DB の関数は service_role だけが実行できるので、呼ぶのは必ず認証のあと。
 * - 記録する単位は「ユーザーの 1 回の操作 = 1」。究極モード (ultimateMode) も 1 と記録する。
 * - どの入口が記録するかの一覧は tests/helpers/ai-consent-enforced-paths.ts (同意の判定と同じ一覧の usage の列)。
 *   入口を足したら、その一覧と tests/ai-consent-enforcement-routes.test.ts の表に行を足す。
 * - キューのテーブル (weekly_menu_requests / meal_image_jobs) は、service role の処理が AI へ送る。利用者 (authenticated) からは
 *   書けない (#1465) ので、行を積むのは記録を通った API ルートだけ (src/lib/ai/ai-queue-writer.ts の getAiQueueWriter で書く)。
 *   tests/ai-usage-contract.test.ts の AI_QUEUE_TABLES が、利用者から書けないことを migration から確かめる。
 *
 * 【失敗しても止めない】
 * record_ai_usage が失敗したとき (DB エラー・接続できない・migration が未適用・応答が遅いなど) は、ログに残して先へ進む。
 * 記録は best-effort で、記録の失敗で AI の機能そのものを止めない。
 *
 * 【Edge Function との二重の記録を避ける】
 * Edge Function をユーザーの JWT で呼ぶ処理は、aiUsageRecordedHeaders で記録済みの印 (署名つき) を付ける。
 * service role key で呼ぶ処理 (献立生成・AI 相談・買い物リスト) は、Edge Function 側が記録しないので印は要らない。
 * 詳しくは supabase/functions/_shared/ai-usage-core.ts (Edge Functions と共用。cron-secret.ts と同じ前例)。
 */

import { createLogger } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getEdgeFunctionServiceRoleKey, isMissingEnvError } from '@/lib/env-required';
import {
  AI_USAGE_RECORDED_HEADER,
  AI_USAGE_TIMEOUT_MS,
  signAiUsageRecorded,
  type AiFeature,
} from '../../../supabase/functions/_shared/ai-usage-core';

export {
  AI_FEATURES,
  AI_USAGE_RECORDED_HEADER,
  AI_USAGE_TIMEOUT_MS,
  type AiFeature,
} from '../../../supabase/functions/_shared/ai-usage-core';

interface RpcError {
  message?: string;
  code?: string;
}

/** supabase-js の rpc だけを使う最小の形 (テストで差し替えられる) */
export interface PlanRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export interface RecordAiUsageOptions {
  /** 既定は service_role のクライアント (getSupabaseAdmin) */
  client?: PlanRpcClient;
  timeoutMs?: number;
}

const logger = createLogger('plan/entitlements');

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === 'object') {
    const { code, message } = value as RpcError;
    return new Error([code, message].filter(Boolean).join(' ') || 'unknown error');
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

/**
 * AI を 1 回使うことを記録する。AI へ送る直前 (同意の判定のあと) に呼ぶ。
 * 失敗しても例外は投げず、ログに残して戻る (止めない)。
 */
export async function recordAiUsage(userId: string, feature: AiFeature, options: RecordAiUsageOptions = {}): Promise<void> {
  try {
    const client = options.client ?? (getSupabaseAdmin() as unknown as PlanRpcClient);
    const { error } = await withTimeout(
      client.rpc('record_ai_usage', { p_user_id: userId, p_feature: feature }),
      options.timeoutMs ?? AI_USAGE_TIMEOUT_MS,
    );
    if (error) throw toError(error);
  } catch (error) {
    // 記録に失敗した理由をログに残す。ログの保存自体が失敗しても (ここで例外を出さない)、先へ進む
    try {
      logger.withUser(userId).error('AI 利用回数の記録に失敗しました (記録せずに続けます)', toError(error), { feature });
    } catch {
      // ログに残せなくても、AI の利用は止めない
    }
  }
}

/**
 * Edge Function を、ユーザーの JWT で呼ぶときに付けるヘッダー (Next.js が記録済みであることを示す署名つきの印)。
 * `supabase.functions.invoke(name, { body, headers: await aiUsageRecordedHeaders(user.id) })` のように使う。
 * リトライでも古い印を使い回さないよう、呼び出しごとに作る。
 * 鍵 (service role key) が無い環境や、署名に失敗したときは空のヘッダー (Edge Function が記録する。二重に記録するだけで、止まらない)。
 */
export async function aiUsageRecordedHeaders(userId: string, now: number = Date.now()): Promise<Record<string, string>> {
  // Edge Function 側 (_shared/ai-usage.ts) は SERVICE_ROLE_JWT と SUPABASE_SERVICE_ROLE_KEY のどちらでも検証する。
  // Next.js の triggerMealImageJobProcessing と同じ優先順位 (env-required の getEdgeFunctionServiceRoleKey。#1434) で選ぶ
  if (!userId) return {};
  let secret: string;
  try {
    secret = getEdgeFunctionServiceRoleKey();
  } catch (error) {
    if (isMissingEnvError(error)) return {};
    throw error;
  }
  try {
    return { [AI_USAGE_RECORDED_HEADER]: await signAiUsageRecorded(secret, userId, now) };
  } catch {
    return {};
  }
}

/**
 * いま効いているプランの plan_key (DB の get_effective_plan)。
 * 個人の契約 (trialing / active / grace / past_due) -> 家族 -> 組織 -> 'free' の順で最初に見つかったもの。
 * 失敗したときは例外を投げる (AI の記録と違い、呼び出し側が扱いを決める)。
 */
export async function getEffectivePlan(userId: string, options: { client?: PlanRpcClient } = {}): Promise<string> {
  const client = options.client ?? (getSupabaseAdmin() as unknown as PlanRpcClient);
  const { data, error } = await client.rpc('get_effective_plan', { p_user_id: userId });
  if (error) throw toError(error);
  return typeof data === 'string' && data.length > 0 ? data : 'free';
}
