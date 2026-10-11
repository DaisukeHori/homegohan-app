/**
 * プランの判定と、AI の利用回数の上限 (#1149 / T40) と記録 (#1177 / T26)
 *
 * 【いまの方針】課金は無料のまま計測する (いまは全員が free プラン)。AI の利用は 1 日 10 回まで (究極モードも 1 回)。
 * 上限の値は DB の ai_daily_limits (プランごと。行の無いプランは free の値)。運営画面 (/super-admin/llm/quotas) から変えられる。
 *
 * 【使い方】AI を使う API ルートは、AI 事業者へ送る直前 (認証・外国の AI 事業者への提供の同意の判定・checkRateLimit・
 * 入力の検証などの判定をすべて通ったあと) に、1 回の操作につき 1 回 consumeAiUsage を呼び、結果で止める。
 * 送る前に処理が止まる経路 (入力の誤り・権限なし・同意が無い・キャッシュを返すだけ) では呼ばない。
 * 順番は「同意の判定 (requireAiConsent / checkUserAiConsent。src/lib/ai/consent-guard.ts、#1154) → 上限の判定と記録 → AI への送信」。
 *
 *   const aiConsentDenied = await requireAiConsent(supabase, user.id);
 *   if (aiConsentDenied) return aiConsentDenied;
 *   const rateLimitResult = await checkRateLimit(user.id, 'analysis');
 *   if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);
 *   const aiUsage = await consumeAiUsage(user.id, 'photo_analysis');
 *   if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage);
 *   ... AI へ送る ...
 *
 * - 判定と記録は 1 つの関数 (consumeAiUsage → DB の consume_ai_usage) が、1 回の DB 呼び出しで原子的に行う
 *   (上限を超えていれば記録せずに止め、超えていなければ 1 を足す。同じ利用者・同じ日は DB が 1 本ずつ判定する)。
 *   AI を使う入口は、記録の DB 関数を直接呼ばず、必ずこの関数を通す (tests/ai-usage-contract.test.ts が、記録を呼ぶ場所・
 *   機能名・結果で止める if を検査する)。
 * - 止め方は入口ごとに決めてある (一覧は tests/helpers/ai-consent-enforced-paths.ts の usage の列と、その上の表):
 *     利用者が押した操作 → 429 AI_DAILY_LIMIT (aiDailyLimitResponse。固定の文・retryAfter = 次の JST 0 時までの秒数)
 *     保存と AI の分析を一緒にする操作 (健康診断・血液検査の保存・相談を閉じる) → 保存だけして AI の部分を省く (aiSkipped: AI_DAILY_LIMIT)
 *     料理画像を付ける副作用 (献立の保存・更新) → 画像だけ見送る
 *     キューに積む操作 (週間献立・献立の生成 v5) → 積む時点で判定する (積んだあとの処理は数えない)
 *     画面を開くと自動で呼ばれる AI (ホームの栄養のアドバイス・栄養士のコメントの自動の取得) → 'nutrition_advice_auto' で記録し、上限に数えない
 * - user.id には、認証で確定した ID だけを渡す (リクエストの本文・URL の未検証の ID は渡さない)。
 *   DB の関数は service_role だけが実行できるので、呼ぶのは必ず認証のあと。
 * - キューのテーブル (weekly_menu_requests / meal_image_jobs) は、service role の処理が AI へ送る。利用者 (authenticated) からは
 *   書けない (#1465) ので、行を積むのは判定を通った API ルートだけ (src/lib/ai/ai-queue-writer.ts の getAiQueueWriter で書く)。
 *   tests/ai-usage-contract.test.ts の AI_QUEUE_TABLES が、利用者から書けないことを migration から確かめる。
 *
 * 【数え戻し】 (#1149)
 * 数えたあと、AI へ送る前に DB の処理が失敗して何も送らなかったとき (生成のリクエストの行の insert の失敗など) は、
 * 許可の結果を refundAiUsage に渡して 1 回を戻す。利用者は何も受け取っておらず、AI の費用もかかっていないので、回数を減らさない。
 * AI へ送ったあとの失敗 (AI の応答の誤り・時間切れ) は戻さない (AI の費用はかかっており、戻すと失敗を繰り返して上限を超えて使えるため)。
 *
 * 【失敗しても止めない】
 * consume_ai_usage が失敗したとき (DB エラー・接続できない・migration が未適用・応答が遅いなど) は、ログに残して許可する
 * (#1177 と同じ。上限の判定の失敗で AI の機能そのものを止めない)。
 *
 * 【Edge Function との二重の記録を避ける】
 * Edge Function をユーザーの JWT で呼ぶ処理は、aiUsageRecordedHeaders で記録済みの印 (署名つき) を付ける。
 * service role key で呼ぶ処理 (献立生成・AI 相談・買い物リスト) は、Edge Function 側が数えないので印は要らない。
 * 詳しくは supabase/functions/_shared/ai-usage-core.ts (Edge Functions と共用。cron-secret.ts と同じ前例)。
 */

import { createLogger } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getEdgeFunctionServiceRoleKey, isMissingEnvError } from '@/lib/env-required';
import { NextResponse } from 'next/server';
import {
  AI_USAGE_NOT_COUNTED,
  AI_USAGE_RECORDED_HEADER,
  AI_USAGE_TIMEOUT_MS,
  aiDailyLimitPayload,
  parseConsumeAiUsageResult,
  signAiUsageRecorded,
  type AiFeature,
  type AiUsageAllowed,
  type AiUsageDenied,
  type AiUsageResult,
} from '../../../supabase/functions/_shared/ai-usage-core';

export {
  AI_DAILY_LIMIT_CODE,
  AI_DAILY_LIMIT_STATUS,
  AI_FEATURES,
  AI_UNMETERED_FEATURES,
  AI_USAGE_RECORDED_HEADER,
  AI_USAGE_TIMEOUT_MS,
  aiDailyLimitSkippedField,
  type AiFeature,
  type AiUsageAllowed,
  type AiUsageDenied,
  type AiUsageResult,
} from '../../../supabase/functions/_shared/ai-usage-core';

interface RpcError {
  message?: string;
  code?: string;
}

/** supabase-js の rpc だけを使う最小の形 (テストで差し替えられる) */
export interface PlanRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export interface ConsumeAiUsageOptions {
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

/** ログに残す。ログの保存自体が失敗しても (ここで例外を出さない)、先へ進む */
function logFailure(userId: string, message: string, error: unknown, context: Record<string, unknown>): void {
  try {
    logger.withUser(userId).error(message, toError(error), context);
  } catch {
    // ログに残せなくても、AI の利用は止めない
  }
}

/**
 * AI の利用を 1 回数える (上限の判定と記録を 1 回で行う)。AI へ送る直前 (同意の判定のあと) に呼ぶ。
 *   - 上限に達していれば、記録せずに { allowed: false, limit, used } を返す。呼び出し側は送らずに止める (aiDailyLimitResponse など)
 *   - 達していなければ 1 を足して { allowed: true, usageDate, ... } を返す (上限に数えない機能は、記録だけして許可)
 *   - DB の関数が失敗したとき (エラー・時間切れ・戻り値の形が違う) は、ログに残して許可する (AI_USAGE_NOT_COUNTED。止めない)
 * 例外は投げない。
 */
export async function consumeAiUsage(
  userId: string,
  feature: AiFeature,
  options: ConsumeAiUsageOptions = {},
): Promise<AiUsageResult> {
  try {
    const client = options.client ?? (getSupabaseAdmin() as unknown as PlanRpcClient);
    const { data, error } = await withTimeout(
      client.rpc('consume_ai_usage', { p_user_id: userId, p_feature: feature }),
      options.timeoutMs ?? AI_USAGE_TIMEOUT_MS,
      'consume_ai_usage',
    );
    if (error) throw toError(error);
    const result = parseConsumeAiUsageResult(data);
    if (!result) throw new Error(`consume_ai_usage returned an unexpected value: ${JSON.stringify(data)}`);
    return result;
  } catch (error) {
    logFailure(userId, 'AI 利用回数の判定と記録に失敗しました (数えずに許可します)', error, { feature });
    return AI_USAGE_NOT_COUNTED;
  }
}

/**
 * consumeAiUsage で数えた 1 回を戻す (数え戻し)。数えたあと、AI へ送る前に DB の処理が失敗して何も送らなかったときだけ呼ぶ
 * (生成のリクエストの行の insert の失敗など。AI へ送ったあとの失敗では呼ばない)。
 * 数えていない結果 (上限に数えない機能・判定に失敗した・Edge Function で印があった) では何もしない。
 * 失敗しても例外は投げず、ログに残して戻る。
 */
export async function refundAiUsage(
  userId: string,
  feature: AiFeature,
  usage: AiUsageAllowed,
  options: ConsumeAiUsageOptions = {},
): Promise<void> {
  if (!usage.metered || !usage.usageDate) return;
  try {
    const client = options.client ?? (getSupabaseAdmin() as unknown as PlanRpcClient);
    const { error } = await withTimeout(
      client.rpc('refund_ai_usage', { p_user_id: userId, p_feature: feature, p_usage_date: usage.usageDate }),
      options.timeoutMs ?? AI_USAGE_TIMEOUT_MS,
      'refund_ai_usage',
    );
    if (error) throw toError(error);
  } catch (error) {
    logFailure(userId, 'AI 利用回数の数え戻しに失敗しました', error, { feature, usageDate: usage.usageDate });
  }
}

/**
 * 上限に達したときの応答 (429 AI_DAILY_LIMIT)。本文は { error: 固定の文, code, limit, retryAfter }、
 * Retry-After ヘッダーは次の JST の 0 時までの秒数。Web とモバイルは code を見て文を出す。
 */
export function aiDailyLimitResponse(denied: AiUsageDenied, nowMs: number = Date.now()): NextResponse {
  const { status, headers, body } = aiDailyLimitPayload(denied, nowMs);
  return NextResponse.json(body, { status, headers });
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
