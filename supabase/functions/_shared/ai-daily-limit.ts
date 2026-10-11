/**
 * AI の 1 日の利用回数の上限 (#1149 / T40) - Next.js API Routes / Supabase Edge Functions / Web の画面 / モバイルのアプリ 共用
 *
 * ここにあるのは次のもの。
 *  - DB の consume_ai_usage の戻り値の読み取り (parseConsumeAiUsageResult) と、判定の結果の型 (AiUsageResult)
 *  - 上限に達したときの応答 (429 AI_DAILY_LIMIT) の形 (aiDailyLimitPayload) と、画面に出す文 (aiDailyLimitMessage / aiDailyLimitMessageOfBody)
 *  - 次の JST の 0 時 (上限が戻る時刻) までの秒数 (secondsUntilNextJstMidnight)
 *  - AI の部分を省いた応答の欄 (aiDailyLimitSkippedField)
 *
 * 機能の一覧・上限に数えない機能 (AI_UNMETERED_FEATURES)・記録済みの印は _shared/ai-usage-core.ts。
 *
 * このファイルが守る制約 (崩すと Edge Functions・Next.js・モバイルのどれかが動かなくなる):
 *  - 純粋な TypeScript。import なし、Deno / Node / ブラウザ / React Native 固有の API なし (crypto も TextEncoder も使わない)。
 *    モバイル (apps/mobile/src/lib/ai-daily-limit.ts) が相対パスで import し、EAS のビルドに入る (.easignore で残している)。
 */

/** 上限に達して止めたときの応答のコード (本文の code・aiSkipped) */
export const AI_DAILY_LIMIT_CODE = "AI_DAILY_LIMIT";
/** 上限に達して止めたときの HTTP の状態 (Too Many Requests) */
export const AI_DAILY_LIMIT_STATUS = 429;

/**
 * JST の UTC からのオフセット (ミリ秒)。日本は夏時間が無いので常に +9 時間。
 * _shared/jst-date.ts の JST_OFFSET_MS と同じ値 (このファイルは import を持たないので、ここにも置く。
 * tests/ai-daily-limit-core.test.ts が一致を確かめる)
 */
export const AI_USAGE_JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 1 日のミリ秒 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MS_PER_SEC = 1000;

/** 次の JST の 0 時 (上限が戻る時刻) までの秒数。切り上げで、少なくとも 1 秒 */
export function secondsUntilNextJstMidnight(nowMs: number = Date.now()): number {
  const jstMs = nowMs + AI_USAGE_JST_OFFSET_MS;
  const nextMidnightJstMs = (Math.floor(jstMs / DAY_MS) + 1) * DAY_MS;
  return Math.max(1, Math.ceil((nextMidnightJstMs - jstMs) / MS_PER_SEC));
}

/** 上限に達したときに画面に出す文 (Web・モバイル・Edge Function の応答の error) */
export function aiDailyLimitMessage(limit: number): string {
  return `今日の AI の利用回数の上限 (${limit} 回) に達しました。明日 0 時から使えます。`;
}

/** 回数が分からないときの文 (応答の本文が壊れていたときなど) */
export const AI_DAILY_LIMIT_FALLBACK_MESSAGE = "今日の AI の利用回数の上限に達しました。明日 0 時から使えます。";

/**
 * AI の部分を省いた応答の aiSkipped に入れる値は AI_DAILY_LIMIT_CODE (aiDailyLimitSkippedField)。
 * 画面の出し分け (aiSkippedReasonOf の 'daily_limit') と省いたときの一文は _shared/ai-consent.ts (同意で省いたときと同じ場所)。
 */
export function aiDailyLimitSkippedField(result: AiUsageResult | null): { aiSkipped?: typeof AI_DAILY_LIMIT_CODE } {
  return result && !result.allowed ? { aiSkipped: AI_DAILY_LIMIT_CODE } : {};
}

/** 上限の判定で、許可したとき */
export interface AiUsageAllowed {
  allowed: true;
  /** 上限に数えたか (上限に数えない機能・Next.js が数え済み・判定に失敗したときは false) */
  metered: boolean;
  /** 数えた日 (JST の暦日 YYYY-MM-DD)。数え戻し (refund_ai_usage) に渡す。数えていなければ null */
  usageDate: string | null;
  /** 1 日の上限 (null は無制限か、判定していない) */
  limit: number | null;
  /** 数えたあとの、その日の回数 (判定していなければ null) */
  used: number | null;
}

/** 上限の判定で、止めたとき (記録していない) */
export interface AiUsageDenied {
  allowed: false;
  limit: number;
  used: number;
  usageDate: string;
}

export type AiUsageResult = AiUsageAllowed | AiUsageDenied;

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isDateString = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * DB の consume_ai_usage の戻り値 (jsonb) を読む。形が違えば null (呼び出し側は判定の失敗として扱い、許可する)。
 *   許可: { allowed: true,  metered, plan, limit (null 可), used (null 可), usage_date }
 *   止め: { allowed: false, metered: true, plan, limit, used, usage_date }
 */
export function parseConsumeAiUsageResult(data: unknown): AiUsageResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (!isDateString(row.usage_date)) return null;
  if (row.allowed === false) {
    if (!isInt(row.limit) || !isInt(row.used)) return null;
    return { allowed: false, limit: row.limit, used: row.used, usageDate: row.usage_date };
  }
  if (row.allowed !== true) return null;
  return {
    allowed: true,
    metered: row.metered !== false,
    usageDate: row.usage_date,
    limit: isInt(row.limit) ? row.limit : null,
    used: isInt(row.used) ? row.used : null,
  };
}

/** 判定をせずに許可したとき (判定に失敗した・Next.js が数え済み) の結果 */
export const AI_USAGE_NOT_COUNTED: AiUsageAllowed = Object.freeze({
  allowed: true,
  metered: false,
  usageDate: null,
  limit: null,
  used: null,
});

/** 上限に達したときの応答の本文 */
export interface AiDailyLimitBody {
  error: string;
  code: typeof AI_DAILY_LIMIT_CODE;
  /** 1 日の上限の回数 */
  limit: number;
  /** 使えるようになるまでの秒数 (次の JST の 0 時まで) */
  retryAfter: number;
}

/** 上限に達したときの応答 (状態・ヘッダー・本文)。Next.js と Edge Function が同じ形で返す */
export function aiDailyLimitPayload(
  denied: Pick<AiUsageDenied, "limit">,
  nowMs: number = Date.now(),
): { status: number; headers: Record<string, string>; body: AiDailyLimitBody } {
  const retryAfter = secondsUntilNextJstMidnight(nowMs);
  return {
    status: AI_DAILY_LIMIT_STATUS,
    headers: { "Retry-After": String(retryAfter) },
    body: { error: aiDailyLimitMessage(denied.limit), code: AI_DAILY_LIMIT_CODE, limit: denied.limit, retryAfter },
  };
}

/**
 * 応答の本文が「上限に達して止めた」ことを表すなら、画面に出す文を返す (そうでなければ null)。
 * { code: 'AI_DAILY_LIMIT' } のほか、{ error: { code } } の入れ子の形も受け付ける。
 * 文は本文の error をそのまま使わず、limit からこちらで作る (本文の文を画面にそのまま出さない)。
 */
export function aiDailyLimitMessageOfBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { code, error, limit } = body as { code?: unknown; error?: unknown; limit?: unknown };
  const nested = error && typeof error === "object" ? (error as { code?: unknown; limit?: unknown }) : null;
  if (code !== AI_DAILY_LIMIT_CODE && nested?.code !== AI_DAILY_LIMIT_CODE) return null;
  const value = isInt(limit) ? limit : isInt(nested?.limit) ? nested.limit : null;
  return value !== null && value >= 0 ? aiDailyLimitMessage(value) : AI_DAILY_LIMIT_FALLBACK_MESSAGE;
}
