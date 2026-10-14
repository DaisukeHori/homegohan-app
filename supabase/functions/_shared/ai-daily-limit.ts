/**
 * AI の 1 日の利用回数の上限 (#1149 / T40) - Next.js API Routes / Supabase Edge Functions / Web の画面 / モバイルのアプリ 共用
 *
 * ここにあるのは次のもの。
 *  - DB の consume_ai_usage の戻り値の読み取り (parseConsumeAiUsageResult) と、判定の結果の型 (AiUsageResult)
 *  - 上限に達したときの応答 (429 AI_DAILY_LIMIT) の形 (aiDailyLimitPayload) と、画面に出す文 (aiDailyLimitMessage / aiDailyLimitMessageOfBody /
 *    aiDailyLimitMessageOfDenied。上限に数えない機能の安全弁で止めたときは AI_AUTO_SAFETY_CAP_MESSAGE、
 *    究極モードの 1 日の上限 (#1142) で止めたときは aiUltimateModeDailyLimitMessage)
 *  - 行に書かれた文が、上のどれかの文か (isAiDailyLimitMessage。画面が行の失敗の文をそのまま出してよいかの判定)
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
 * 上限に数えない機能の安全弁 (DB の ai_unmetered_daily_caps) で止めたときに画面に出す文 (#1487。Web・モバイル共用)。
 * 回数は出さない (安全弁の回数 (例: 30) は明示の 1 日の上限 (10 回) と別のもので、数字を出すと食い違って見えるため)。
 * 安全弁で 429 を返す入口は、栄養士のコメントの自動の取得 (POST /api/ai/nutrition/feedback の forceRefresh なし =
 * nutrition_advice_auto) だけ (ホームの栄養のアドバイスは AI の部分を省き、料理画像は画像だけ見送るので 429 にしない)
 */
export const AI_AUTO_SAFETY_CAP_MESSAGE = "今日はこれ以上、自動のコメントを作れません。明日また表示されます。";

/**
 * 機能ごとの 1 日の上限がある機能 (#1142。DB の consume_ai_usage_capped が止めたときに capped_feature で返す機能名)。
 * _shared/ai-usage-core.ts の AI_CAPPED_FEATURES と同じ (このファイルは import を持たないので、ここにも置く。
 * tests/ai-usage-contract.test.ts が突き合わせる)
 */
export const AI_DAILY_CAPPED_FEATURES = ["menu_generation_ultimate"] as const;

/** 機能ごとの 1 日の上限がある機能の名前 */
export type AiDailyCappedFeature = (typeof AI_DAILY_CAPPED_FEATURES)[number];

const isDailyCappedFeature = (value: unknown): value is AiDailyCappedFeature =>
  typeof value === "string" && (AI_DAILY_CAPPED_FEATURES as readonly string[]).includes(value);

/**
 * 究極モードの 1 日の上限 (#1142) に達したときに画面に出す文 (Web・モバイル・Edge Function の応答の error)。
 * 1 日の AI の上限 (aiDailyLimitMessage) と同じ形で、何の上限かだけを変える (究極モードを使わない生成は、1 日の上限まで使える)
 */
export function aiUltimateModeDailyLimitMessage(limit: number): string {
  return `今日の究極モードの利用回数の上限 (${limit} 回) に達しました。明日 0 時から使えます。`;
}

/** 機能ごとの上限で止めたときの文 */
function cappedFeatureMessage(feature: AiDailyCappedFeature, limit: number): string {
  switch (feature) {
    case "menu_generation_ultimate":
      return aiUltimateModeDailyLimitMessage(limit);
  }
}

/**
 * 回数の入った上限の文 (aiDailyLimitMessage(n) と、機能ごとの上限の文 (aiUltimateModeDailyLimitMessage(n) など)) から
 * 回数を取り出す形。取り出した回数で文を作り直し、一字一句同じかを確かめる (形が合うだけでは通さない)
 */
const AI_LIMIT_MESSAGE_COUNT_PATTERN = /^今日の.+?の利用回数の上限 \((\d+) 回\)/;

/** 回数 limit で止めたときに書きうる、回数の入った上限の文 (1 日の上限の文と、AI_DAILY_CAPPED_FEATURES の各機能の文) */
function aiLimitMessagesWithCount(limit: number): readonly string[] {
  return [aiDailyLimitMessage(limit), ...AI_DAILY_CAPPED_FEATURES.map((feature) => cappedFeatureMessage(feature, limit))];
}

/**
 * 上限で止めたときの文のどれかか (#1478・#1142)。aiDailyLimitMessageOfDenied / aiDailyLimitMessageOfBody が作りうる文を、すべて通す:
 *   aiDailyLimitMessage(n)・機能ごとの上限の文 (究極モードの aiUltimateModeDailyLimitMessage(n))・
 *   AI_DAILY_LIMIT_FALLBACK_MESSAGE・AI_AUTO_SAFETY_CAP_MESSAGE
 * 生成のリクエストの行の失敗の欄 (Edge Function の generate-menu-v4 / v5 が aiDailyLimitMessageOfDenied で書く) を、
 * 画面 (Web・モバイル) が「こちらで書いた文」としてそのまま出してよいかの判定に使う (それ以外の文は汎用の文に寄せる)
 */
export function isAiDailyLimitMessage(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === AI_DAILY_LIMIT_FALLBACK_MESSAGE || value === AI_AUTO_SAFETY_CAP_MESSAGE) return true;
  const match = AI_LIMIT_MESSAGE_COUNT_PATTERN.exec(value);
  return match !== null && aiLimitMessagesWithCount(Number(match[1])).includes(value);
}

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
  /**
   * 上限に数えない機能の安全弁 (ai_unmetered_daily_caps) で止めたとき true (DB の戻り値の metered が false。#1487)。
   * 明示の 1 日の上限で止めたときは付けない。limit はそのときの安全弁の回数で、画面には出さない
   */
  safetyCap?: true;
  /**
   * 機能ごとの 1 日の上限 (#1142。究極モード) で止めたときの機能名 (DB の戻り値の capped_feature)。
   * limit・used はその機能の上限と回数。1 日の上限 (合計) で止めたときは付けない
   */
  cappedFeature?: AiDailyCappedFeature;
}

export type AiUsageResult = AiUsageAllowed | AiUsageDenied;

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isDateString = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * DB の consume_ai_usage の戻り値 (jsonb) を読む。形が違えば null (呼び出し側は判定の失敗として扱い、許可する)。
 *   許可: { allowed: true,  metered, plan, limit (null 可), used (null 可), usage_date }
 *   止め: { allowed: false, metered: true, plan, limit, used, usage_date }
 *         (機能ごとの上限で止めたとき (consume_ai_usage_capped。#1142) は capped_feature も付く)
 */
export function parseConsumeAiUsageResult(data: unknown): AiUsageResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (!isDateString(row.usage_date)) return null;
  if (row.allowed === false) {
    if (!isInt(row.limit) || !isInt(row.used)) return null;
    const denied: AiUsageDenied = { allowed: false, limit: row.limit, used: row.used, usageDate: row.usage_date };
    // 上限に数えない機能の安全弁で止めた (DB は metered: false を返す)。明示の上限で止めたときは metered: true
    if (row.metered === false) denied.safetyCap = true;
    // 機能ごとの上限 (究極モード) で止めた。知らない機能名は付けない (1 日の上限の文になる)
    if (isDailyCappedFeature(row.capped_feature)) denied.cappedFeature = row.capped_feature;
    return denied;
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
  /** 1 日の上限の回数 (安全弁で止めたときは出さない。safetyCap を見る) */
  limit?: number;
  /** 上限に数えない機能の安全弁で止めたとき true (#1487。画面は AI_AUTO_SAFETY_CAP_MESSAGE を出す) */
  safetyCap?: true;
  /** 機能ごとの 1 日の上限 (#1142。究極モード) で止めたときの機能名 (画面は aiUltimateModeDailyLimitMessage を出す)。limit はその機能の上限 */
  cappedFeature?: AiDailyCappedFeature;
  /** 使えるようになるまでの秒数 (次の JST の 0 時まで) */
  retryAfter: number;
}

/**
 * 止めたときに画面に出す文 (止めた理由で選ぶ)。応答の本文の error・生成のリクエストの行の error_message・AI 相談のアクションの結果が使う。
 *   安全弁 (safetyCap) → AI_AUTO_SAFETY_CAP_MESSAGE / 機能ごとの上限 (cappedFeature。究極モード) → その機能の文 / それ以外 → 1 日の上限の文
 */
export function aiDailyLimitMessageOfDenied(denied: Pick<AiUsageDenied, "limit" | "safetyCap" | "cappedFeature">): string {
  if (denied.safetyCap) return AI_AUTO_SAFETY_CAP_MESSAGE;
  if (denied.cappedFeature) return cappedFeatureMessage(denied.cappedFeature, denied.limit);
  return aiDailyLimitMessage(denied.limit);
}

/**
 * 上限に達したときの応答 (状態・ヘッダー・本文)。Next.js と Edge Function が同じ形で返す。
 * 安全弁で止めたとき (denied.safetyCap) は、回数を出さない固定の文 (AI_AUTO_SAFETY_CAP_MESSAGE) にし、本文に limit を入れない。
 * 機能ごとの上限で止めたとき (denied.cappedFeature。究極モード #1142) は、その機能の文にし、本文に cappedFeature を入れる
 * (状態・コードは 1 日の上限と同じ 429 AI_DAILY_LIMIT。画面は今の 429 の扱いのまま、文だけが変わる)
 */
export function aiDailyLimitPayload(
  denied: Pick<AiUsageDenied, "limit" | "safetyCap" | "cappedFeature">,
  nowMs: number = Date.now(),
): { status: number; headers: Record<string, string>; body: AiDailyLimitBody } {
  const retryAfter = secondsUntilNextJstMidnight(nowMs);
  const error = aiDailyLimitMessageOfDenied(denied);
  const body: AiDailyLimitBody = denied.safetyCap
    ? { error, code: AI_DAILY_LIMIT_CODE, safetyCap: true, retryAfter }
    : denied.cappedFeature
      ? { error, code: AI_DAILY_LIMIT_CODE, limit: denied.limit, cappedFeature: denied.cappedFeature, retryAfter }
      : { error, code: AI_DAILY_LIMIT_CODE, limit: denied.limit, retryAfter };
  return {
    status: AI_DAILY_LIMIT_STATUS,
    headers: { "Retry-After": String(retryAfter) },
    body,
  };
}

/**
 * 応答の本文が「上限に達して止めた」ことを表すなら、画面に出す文を返す (そうでなければ null)。
 * { code: 'AI_DAILY_LIMIT' } のほか、{ error: { code } } の入れ子の形も受け付ける。
 * 文は本文の error をそのまま使わず、limit からこちらで作る (本文の文を画面にそのまま出さない)。
 */
export function aiDailyLimitMessageOfBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { code, error, limit, safetyCap, cappedFeature } = body as {
    code?: unknown;
    error?: unknown;
    limit?: unknown;
    safetyCap?: unknown;
    cappedFeature?: unknown;
  };
  const nested =
    error && typeof error === "object"
      ? (error as { code?: unknown; limit?: unknown; safetyCap?: unknown; cappedFeature?: unknown })
      : null;
  if (code !== AI_DAILY_LIMIT_CODE && nested?.code !== AI_DAILY_LIMIT_CODE) return null;
  // 安全弁で止めたときは回数を出さない固定の文 (#1487)
  if (safetyCap === true || nested?.safetyCap === true) return AI_AUTO_SAFETY_CAP_MESSAGE;
  const value = isInt(limit) ? limit : isInt(nested?.limit) ? nested.limit : null;
  if (value === null || value < 0) return AI_DAILY_LIMIT_FALLBACK_MESSAGE;
  // 機能ごとの上限 (究極モード #1142) で止めたときは、その機能の文
  const capped = isDailyCappedFeature(cappedFeature) ? cappedFeature : isDailyCappedFeature(nested?.cappedFeature) ? nested.cappedFeature : null;
  return capped ? cappedFeatureMessage(capped, value) : aiDailyLimitMessage(value);
}
