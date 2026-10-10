/**
 * プランの判定と、AI の利用回数の記録 (#1177 / T26)
 *
 * 【いまの方針】全員無制限のまま、計測だけ行う (2026-10-08 のオーナー判断)。
 * 上限の数値 (T40) と有料プラン (T48) は、この仕組みの上に別の作業で足す。
 * いまは ai_plan_limits が全プラン NULL (無制限) なので、consumeAiQuota は必ず許可し、回数を増やすだけ。
 * 上限を超えたときの 429 (AI_DAILY_LIMIT / AI_MONTHLY_LIMIT) は、いまは通らない。
 *
 * 【使い方】AI を使う API ルートは、認証 (user 確定) と checkRateLimit の直後に、1 回の操作につき 1 回呼ぶ。
 *
 *   const rateLimitResult = await checkRateLimit(user.id, 'analysis');
 *   if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);
 *   const quota = await consumeAiQuota(user.id, 'photo_analysis');
 *   if (!quota.allowed) return aiQuotaExceededResponse(quota);
 *
 * - user.id には、認証で確定した ID だけを渡す (リクエストの本文・URL の未検証の ID は渡さない)。
 *   DB の関数は service_role だけが実行できるので、呼ぶのは必ず認証のあと。
 * - 数える単位は「ユーザーの 1 回の操作 = 1」。究極モード (ultimateMode) も 1 と数える。
 *   究極モードを複数回と数えるか、操作の数え方 (キャッシュの有無・画像 1 枚ごとなど) は、
 *   実際の上限 (T40) を決めるときに、オーナーと一緒に決める。
 * - AI を実際に呼ばない経路 (キャッシュを返すだけ・AI を使わない入力) では、呼ばない。
 *   呼ぶ場所を変えるときは tests/ai-quota-contract.test.ts の一覧と期待を合わせる。
 *
 * 【失敗しても止めない (fail-open)】
 * consume_ai_quota が失敗したとき (DB エラー・接続できない・migration が未適用・応答が遅いなど) は、
 * 記録して許可する。海外の AI へ送る処理を止めない、というオーナーの方針 (2026-10-08)。
 * レート制限 (src/lib/rate-limit.ts) は逆に fail-close だが、あちらは濫用の防止、こちらは今のところ計測が目的のため。
 * 上限を実際に効かせる (T40) ときに、失敗時の扱いを決め直す。
 *
 * 【Edge Function との二重カウントを避ける】
 * Edge Function をユーザーの JWT で呼ぶ処理は、aiQuotaCountedHeaders で数え済みの印 (署名つき) を付ける。
 * service role key で呼ぶ処理 (献立生成・AI 相談・買い物リスト) は、Edge Function 側が数えないので印は要らない。
 * 詳しくは supabase/functions/_shared/ai-quota-core.ts。
 *
 * 共通部分 (機能の一覧・戻り値の読み取り・429 の本文・印の署名) は、Edge Functions と共用の
 * supabase/functions/_shared/ai-quota-core.ts にある (cron-secret.ts と同じ前例)。
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import {
  AI_QUOTA_COUNTED_HEADER,
  AI_QUOTA_TIMEOUT_MS,
  aiQuotaErrorBody,
  parseAiQuotaResult,
  signAiQuotaCounted,
  type AiFeature,
  type AiQuotaResult,
} from '../../../supabase/functions/_shared/ai-quota-core';

export {
  AI_FEATURES,
  AI_QUOTA_COUNTED_HEADER,
  AI_QUOTA_ERROR_CODES,
  AI_QUOTA_TIMEOUT_MS,
  aiQuotaErrorBody,
  parseAiQuotaResult,
  type AiFeature,
  type AiQuotaErrorBody,
  type AiQuotaLimitKind,
  type AiQuotaResult,
} from '../../../supabase/functions/_shared/ai-quota-core';

interface RpcError {
  message?: string;
  code?: string;
}

/** supabase-js の rpc だけを使う最小の形 (テストで差し替えられる) */
export interface QuotaRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export interface ConsumeAiQuotaOptions {
  /** 既定は service_role のクライアント (getSupabaseAdmin) */
  client?: QuotaRpcClient;
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
        timer = setTimeout(() => reject(new Error(`consume_ai_quota timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * AI を 1 回使うことを記録し、使ってよいかを返す。
 * 失敗しても例外は投げず、ログに残して許可する (止めない)。
 */
export async function consumeAiQuota(
  userId: string,
  feature: AiFeature,
  options: ConsumeAiQuotaOptions = {},
): Promise<AiQuotaResult> {
  try {
    const client = options.client ?? (getSupabaseAdmin() as unknown as QuotaRpcClient);
    const { data, error } = await withTimeout(
      client.rpc('consume_ai_quota', { p_user_id: userId, p_feature: feature }),
      options.timeoutMs ?? AI_QUOTA_TIMEOUT_MS,
    );
    if (error) throw toError(error);
    return parseAiQuotaResult(data);
  } catch (error) {
    // 記録に失敗した理由をログに残す。ログの保存自体が失敗しても (ここで例外を出さない)、許可して先へ進む
    try {
      logger
        .withUser(userId)
        .error('AI 利用回数の記録に失敗しました (記録できなかったので、止めずに許可します)', toError(error), { feature });
    } catch {
      // ログに残せなくても、AI の利用は止めない
    }
    return { allowed: true, remaining: null };
  }
}

/** 上限を超えたときの 429。レート制限の 429 (code: RATE_LIMITED) とは code で区別する */
export function aiQuotaExceededResponse(result: AiQuotaResult, now: number = Date.now()): NextResponse {
  const { body, retryAfterSec } = aiQuotaErrorBody(result, now);
  return NextResponse.json(body, {
    status: 429,
    ...(retryAfterSec !== undefined ? { headers: { 'Retry-After': String(retryAfterSec) } } : {}),
  });
}

/**
 * Edge Function を、ユーザーの JWT で呼ぶときに付けるヘッダー (Next.js が数え済みであることを示す署名つきの印)。
 * `supabase.functions.invoke(name, { body, headers: await aiQuotaCountedHeaders(user.id) })` のように使う。
 * リトライでも古い印を使い回さないよう、呼び出しごとに作る。
 * 鍵 (service role key) が無い環境や、署名に失敗したときは空のヘッダー (Edge Function が数える。二重に数えるだけで、止まらない)。
 */
export async function aiQuotaCountedHeaders(userId: string, now: number = Date.now()): Promise<Record<string, string>> {
  // Edge Function 側 (_shared/quota.ts) は SERVICE_ROLE_JWT と SUPABASE_SERVICE_ROLE_KEY のどちらでも検証する。
  // Next.js の triggerMealImageJobProcessing と同じ優先順位で選ぶ
  const secret = process.env.SERVICE_ROLE_JWT || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !userId) return {};
  try {
    return { [AI_QUOTA_COUNTED_HEADER]: await signAiQuotaCounted(secret, userId, now) };
  } catch {
    return {};
  }
}

/**
 * いま効いているプランの plan_key (DB の get_effective_plan)。
 * 個人の契約 (trialing / active / grace / past_due) -> 家族 -> 組織 -> 'free' の順で最初に見つかったもの。
 * 失敗したときは例外を投げる (AI の計測と違い、呼び出し側が扱いを決める)。
 */
export async function getEffectivePlan(userId: string, options: { client?: QuotaRpcClient } = {}): Promise<string> {
  const client = options.client ?? (getSupabaseAdmin() as unknown as QuotaRpcClient);
  const { data, error } = await client.rpc('get_effective_plan', { p_user_id: userId });
  if (error) throw toError(error);
  return typeof data === 'string' && data.length > 0 ? data : 'free';
}
