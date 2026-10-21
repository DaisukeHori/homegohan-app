/**
 * AI の 1 日の利用回数の上限 (#1149 / T40) と、プランごとの機能の上限 (billing/03 §6.5) - Next.js API Routes / Supabase Edge Functions /
 * Web の画面 / モバイルのアプリ 共用
 *
 * ここにあるのは次のもの。
 *  - DB の consume_ai_usage の戻り値の読み取り (parseConsumeAiUsageResult) と、判定の結果の型 (AiUsageResult)
 *  - 止めたときの応答の形 (aiDailyLimitPayload。429 AI_DAILY_LIMIT = 回数の上限 / 403 AI_FEATURE_NOT_IN_PLAN = そのプランでは使えない機能) と、
 *    画面に出す文 (aiDailyLimitMessage / aiDailyLimitMessageOfBody / aiDailyLimitMessageOfStatusAndBody / aiDailyLimitMessageOfDenied。上限に数えない機能の安全弁で止めたときは
 *    AI_AUTO_SAFETY_CAP_MESSAGE、機能ごとの 1 日の上限で止めたときは aiFeatureDailyLimitMessage (究極モードは aiUltimateModeDailyLimitMessage)、
 *    そのプランでは使えない機能で止めたときは aiFeatureNotInPlanMessage)
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
/** そのプランでは使えない機能 (ai_plan_feature_caps の daily_cap = 0) で止めたときの応答のコード (billing/03 §6.5) */
export const AI_FEATURE_NOT_IN_PLAN_CODE = "AI_FEATURE_NOT_IN_PLAN";
/** そのプランでは使えない機能で止めたときの HTTP の状態 (Forbidden。明日になっても使えないので 429 にしない) */
export const AI_FEATURE_NOT_IN_PLAN_STATUS = 403;

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
 * 回数は出さない (安全弁の回数 (例: 30) は明示の 1 日の上限と別のもので、数字を出すと食い違って見えるため)。
 * 安全弁で 429 を返す入口は、栄養士のコメントの自動の取得 (POST /api/ai/nutrition/feedback の forceRefresh なし =
 * nutrition_advice_auto) だけ (ホームの栄養のアドバイスは AI の部分を省き、料理画像は画像だけ見送るので 429 にしない)
 */
export const AI_AUTO_SAFETY_CAP_MESSAGE = "今日はこれ以上、自動のコメントを作れません。明日また表示されます。";

/**
 * プランごとの機能の上限 (DB の ai_plan_feature_caps。billing/03 §6.5) を持てる機能。DB の CHECK
 * (ai_plan_feature_caps_feature_check) と同じ 4 つ (tests/billing-paid-plans-migration-contract.test.ts が突き合わせる)。
 * DB の consume_ai_usage / consume_ai_usage_capped は、止めたときこのどれかを capped_feature で返す
 */
export const AI_PLAN_CAPPED_FEATURES = ["menu_generation_ultimate", "menu_generation", "image_generation", "meal_image_auto"] as const;

/** プランごとの機能の上限を持てる機能の名前 */
export type AiPlanCappedFeature = (typeof AI_PLAN_CAPPED_FEATURES)[number];

const isPlanCappedFeature = (value: unknown): value is AiPlanCappedFeature =>
  typeof value === "string" && (AI_PLAN_CAPPED_FEATURES as readonly string[]).includes(value);

/**
 * 機能ごとの 1 日の上限が呼び出し側の環境変数でも決まる機能 (#1142。究極モード。ai_plan_feature_caps に行の無いプランは
 * 環境変数 AI_ULTIMATE_MODE_DAILY_LIMIT の上限)。_shared/ai-usage-core.ts の AI_CAPPED_FEATURES と同じ
 * (このファイルは import を持たないので、ここにも置く。tests/ai-usage-contract.test.ts が突き合わせる)
 */
export const AI_DAILY_CAPPED_FEATURES = ["menu_generation_ultimate"] as const satisfies readonly AiPlanCappedFeature[];

/** 機能ごとの 1 日の上限が環境変数でも決まる機能の名前 */
export type AiDailyCappedFeature = (typeof AI_DAILY_CAPPED_FEATURES)[number];

/** 機能の表示名 (機能ごとの上限の文と、使えない機能の文に入れる) */
export const AI_PLAN_CAPPED_FEATURE_LABELS: Readonly<Record<AiPlanCappedFeature, string>> = {
  menu_generation_ultimate: "究極モード",
  menu_generation: "献立の作成",
  image_generation: "料理画像の作成",
  meal_image_auto: "料理画像の作成",
};

/**
 * 機能ごとの 1 日の上限 (daily_cap > 0) に達したときに画面に出す文 (Web・モバイル・Edge Function の応答の error)。
 * 1 日の AI の上限 (aiDailyLimitMessage) と同じ形で、何の上限かだけを変える
 */
export function aiFeatureDailyLimitMessage(feature: AiPlanCappedFeature, limit: number): string {
  return `今日の${AI_PLAN_CAPPED_FEATURE_LABELS[feature]}の利用回数の上限 (${limit} 回) に達しました。明日 0 時から使えます。`;
}

/** 究極モードの 1 日の上限 (#1142) に達したときの文 (aiFeatureDailyLimitMessage の究極モードの文と同じ。既存の呼び出しのために残す) */
export function aiUltimateModeDailyLimitMessage(limit: number): string {
  return aiFeatureDailyLimitMessage("menu_generation_ultimate", limit);
}

/** そのプランでは使えない機能 (daily_cap = 0) で止めたときに画面に出す文 */
export function aiFeatureNotInPlanMessage(feature: AiPlanCappedFeature): string {
  return `${AI_PLAN_CAPPED_FEATURE_LABELS[feature]}は、有料プランでお使いいただけます。`;
}

/** そのプランでは使えない機能で止めたが、機能名が分からないとき (本文が壊れていたときなど) の文 */
export const AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE = "この機能は、有料プランでお使いいただけます。";

/**
 * 回数の入った上限の文 (aiDailyLimitMessage(n) と、機能ごとの上限の文 aiFeatureDailyLimitMessage(feature, n)) から
 * 回数を取り出す形。取り出した回数で文を作り直し、一字一句同じかを確かめる (形が合うだけでは通さない)
 */
const AI_LIMIT_MESSAGE_COUNT_PATTERN = /^今日の.+?の利用回数の上限 \((\d+) 回\)/;

/** 回数 limit で止めたときに書きうる、回数の入った上限の文 (1 日の上限の文と、AI_PLAN_CAPPED_FEATURES の各機能の文) */
function aiLimitMessagesWithCount(limit: number): readonly string[] {
  return [aiDailyLimitMessage(limit), ...AI_PLAN_CAPPED_FEATURES.map((feature) => aiFeatureDailyLimitMessage(feature, limit))];
}

/** そのプランでは使えない機能で止めたときに書きうる文 (回数を含まない) */
const AI_FEATURE_NOT_IN_PLAN_MESSAGES: readonly string[] = [
  ...AI_PLAN_CAPPED_FEATURES.map((feature) => aiFeatureNotInPlanMessage(feature)),
  AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE,
];

/**
 * 止めたときの文のどれかか (#1478・#1142・billing/03)。aiDailyLimitMessageOfDenied / aiDailyLimitMessageOfBody が作りうる文を、すべて通す:
 *   aiDailyLimitMessage(n)・機能ごとの上限の文 (aiFeatureDailyLimitMessage(feature, n))・そのプランでは使えない機能の文
 *   (aiFeatureNotInPlanMessage(feature)・AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE)・AI_DAILY_LIMIT_FALLBACK_MESSAGE・AI_AUTO_SAFETY_CAP_MESSAGE
 * 生成のリクエストの行の失敗の欄 (Edge Function の generate-menu-v4 / v5 が aiDailyLimitMessageOfDenied で書く) を、
 * 画面 (Web・モバイル) が「こちらで書いた文」としてそのまま出してよいかの判定に使う (それ以外の文は汎用の文に寄せる)
 */
export function isAiDailyLimitMessage(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === AI_DAILY_LIMIT_FALLBACK_MESSAGE || value === AI_AUTO_SAFETY_CAP_MESSAGE) return true;
  if (AI_FEATURE_NOT_IN_PLAN_MESSAGES.includes(value)) return true;
  const match = AI_LIMIT_MESSAGE_COUNT_PATTERN.exec(value);
  return match !== null && aiLimitMessagesWithCount(Number(match[1])).includes(value);
}

/**
 * AI の部分を省いた応答の aiSkipped に入れる値は AI_DAILY_LIMIT_CODE (aiDailyLimitSkippedField)。
 * 画面の出し分け (aiSkippedReasonOf の 'daily_limit') と省いたときの一文は _shared/ai-consent.ts (同意で省いたときと同じ場所)。
 * そのプランでは使えない機能で止めたとき (planLocked。無料の自動の料理画像) は付けない (回数の上限ではないので、上限の一文を出させない。
 * 料理の画面は料理の image_error = 'skipped_plan' で有料プランの案内を出す。billing/03 §8.8)
 */
export function aiDailyLimitSkippedField(result: AiUsageResult | null): { aiSkipped?: typeof AI_DAILY_LIMIT_CODE } {
  return result && !result.allowed && result.planLocked !== true ? { aiSkipped: AI_DAILY_LIMIT_CODE } : {};
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
   * 機能ごとの上限 (#1142 の究極モード・billing/03 の ai_plan_feature_caps) で止めたときの機能名 (DB の戻り値の capped_feature)。
   * limit・used はその機能の上限と回数。1 日の上限 (合計) で止めたときは付けない
   */
  cappedFeature?: AiPlanCappedFeature;
  /**
   * そのプランでは使えない機能 (ai_plan_feature_caps の daily_cap = 0) で止めたとき true (DB の戻り値の plan_locked。billing/03 §6.5)。
   * cappedFeature があるときだけ付く。limit は 0。応答は 403 AI_FEATURE_NOT_IN_PLAN
   */
  planLocked?: true;
}

export type AiUsageResult = AiUsageAllowed | AiUsageDenied;

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isDateString = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * DB の consume_ai_usage の戻り値 (jsonb) を読む。形が違えば null (呼び出し側は判定の失敗として扱い、許可する)。
 *   許可: { allowed: true,  metered, plan, limit (null 可), used (null 可), usage_date }
 *   止め: { allowed: false, metered: true, plan, limit, used, usage_date }
 *         (機能ごとの上限で止めたときは capped_feature、そのプランでは使えない機能のときは plan_locked: true も付く)
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
    // 機能ごとの上限で止めた。知らない機能名は付けない (1 日の上限の文になる)
    if (isPlanCappedFeature(row.capped_feature)) {
      denied.cappedFeature = row.capped_feature;
      // そのプランでは使えない機能 (cap 0)。機能名が分かるときだけ (文に機能名が要るため)
      if (row.plan_locked === true) denied.planLocked = true;
    }
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

/** 回数の上限に達したときの応答の本文 (429) */
export interface AiDailyLimitBody {
  error: string;
  code: typeof AI_DAILY_LIMIT_CODE;
  /** 1 日の上限の回数 (安全弁で止めたときは出さない。safetyCap を見る) */
  limit?: number;
  /** 上限に数えない機能の安全弁で止めたとき true (#1487。画面は AI_AUTO_SAFETY_CAP_MESSAGE を出す) */
  safetyCap?: true;
  /** 機能ごとの 1 日の上限で止めたときの機能名 (画面は aiFeatureDailyLimitMessage を出す)。limit はその機能の上限 */
  cappedFeature?: AiPlanCappedFeature;
  /** 使えるようになるまでの秒数 (次の JST の 0 時まで) */
  retryAfter: number;
}

/** そのプランでは使えない機能で止めたときの応答の本文 (403。明日になっても使えないので retryAfter・limit を持たない) */
export interface AiFeatureNotInPlanBody {
  error: string;
  code: typeof AI_FEATURE_NOT_IN_PLAN_CODE;
  feature: AiPlanCappedFeature;
}

/** 止めたときの応答の本文 (aiDailyLimitPayload が返す 2 つの形) */
export type AiUsageDeniedBody = AiDailyLimitBody | AiFeatureNotInPlanBody;

/** 止めた理由のうち、文と応答を決める項目 */
export type AiUsageDenialReason = Pick<AiUsageDenied, "limit" | "safetyCap" | "cappedFeature" | "planLocked">;

/**
 * 止めたときに画面に出す文 (止めた理由で選ぶ)。応答の本文の error・生成のリクエストの行の error_message・AI 相談のアクションの結果が使う。
 *   安全弁 (safetyCap) → AI_AUTO_SAFETY_CAP_MESSAGE / そのプランでは使えない機能 (planLocked) → aiFeatureNotInPlanMessage /
 *   機能ごとの上限 (cappedFeature) → aiFeatureDailyLimitMessage / それ以外 → 1 日の上限の文
 */
export function aiDailyLimitMessageOfDenied(denied: AiUsageDenialReason): string {
  if (denied.safetyCap) return AI_AUTO_SAFETY_CAP_MESSAGE;
  if (denied.cappedFeature && denied.planLocked) return aiFeatureNotInPlanMessage(denied.cappedFeature);
  if (denied.cappedFeature) return aiFeatureDailyLimitMessage(denied.cappedFeature, denied.limit);
  return aiDailyLimitMessage(denied.limit);
}

/**
 * 止めたときの応答 (状態・ヘッダー・本文)。Next.js と Edge Function が同じ形で返す。
 *   - そのプランでは使えない機能 (denied.planLocked): 403 AI_FEATURE_NOT_IN_PLAN。本文 { error, code, feature }。Retry-After を付けない
 *   - 安全弁 (denied.safetyCap): 429。回数を出さない固定の文 (AI_AUTO_SAFETY_CAP_MESSAGE)、本文に limit を入れない
 *   - 機能ごとの上限 (denied.cappedFeature): 429。その機能の文、本文に cappedFeature を入れる
 *   - それ以外: 429。1 日の上限の文
 */
export function aiDailyLimitPayload(
  denied: AiUsageDenialReason,
  nowMs: number = Date.now(),
): { status: number; headers: Record<string, string>; body: AiUsageDeniedBody } {
  if (denied.cappedFeature && denied.planLocked && !denied.safetyCap) {
    const feature = denied.cappedFeature;
    return {
      status: AI_FEATURE_NOT_IN_PLAN_STATUS,
      headers: {},
      body: { error: aiFeatureNotInPlanMessage(feature), code: AI_FEATURE_NOT_IN_PLAN_CODE, feature },
    };
  }
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
 * 応答の本文が「止めた」ことを表すなら、画面に出す文を返す (そうでなければ null)。
 * { code: 'AI_DAILY_LIMIT' | 'AI_FEATURE_NOT_IN_PLAN' } のほか、{ error: { code } } の入れ子の形も受け付ける。
 * 文は本文の error をそのまま使わず、limit・機能名からこちらで作る (本文の文を画面にそのまま出さない)。
 */
export function aiDailyLimitMessageOfBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { code, error, limit, safetyCap, cappedFeature, feature } = body as {
    code?: unknown;
    error?: unknown;
    limit?: unknown;
    safetyCap?: unknown;
    cappedFeature?: unknown;
    feature?: unknown;
  };
  const nested =
    error && typeof error === "object"
      ? (error as { code?: unknown; limit?: unknown; safetyCap?: unknown; cappedFeature?: unknown; feature?: unknown })
      : null;
  // そのプランでは使えない機能 (billing/03)
  if (code === AI_FEATURE_NOT_IN_PLAN_CODE || nested?.code === AI_FEATURE_NOT_IN_PLAN_CODE) {
    const lockedFeature = isPlanCappedFeature(feature) ? feature : isPlanCappedFeature(nested?.feature) ? nested.feature : null;
    return lockedFeature ? aiFeatureNotInPlanMessage(lockedFeature) : AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE;
  }
  if (code !== AI_DAILY_LIMIT_CODE && nested?.code !== AI_DAILY_LIMIT_CODE) return null;
  // 安全弁で止めたときは回数を出さない固定の文 (#1487)
  if (safetyCap === true || nested?.safetyCap === true) return AI_AUTO_SAFETY_CAP_MESSAGE;
  const value = isInt(limit) ? limit : isInt(nested?.limit) ? nested.limit : null;
  if (value === null || value < 0) return AI_DAILY_LIMIT_FALLBACK_MESSAGE;
  // 機能ごとの上限で止めたときは、その機能の文
  const capped = isPlanCappedFeature(cappedFeature) ? cappedFeature : isPlanCappedFeature(nested?.cappedFeature) ? nested.cappedFeature : null;
  return capped ? aiFeatureDailyLimitMessage(capped, value) : aiDailyLimitMessage(value);
}

/** 本文の code (平らな { code } と入れ子の { error: { code } })。止めたときの 2 つのコードのどちらでもなければ null。順は aiDailyLimitMessageOfBody と同じ (使えない機能が先) */
function deniedCodeOfBody(body: unknown): typeof AI_DAILY_LIMIT_CODE | typeof AI_FEATURE_NOT_IN_PLAN_CODE | null {
  if (!body || typeof body !== "object") return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  const nestedCode = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === AI_FEATURE_NOT_IN_PLAN_CODE || nestedCode === AI_FEATURE_NOT_IN_PLAN_CODE) return AI_FEATURE_NOT_IN_PLAN_CODE;
  if (code === AI_DAILY_LIMIT_CODE || nestedCode === AI_DAILY_LIMIT_CODE) return AI_DAILY_LIMIT_CODE;
  return null;
}

/**
 * HTTP の状態と本文の組から、画面に出す文を返す (組が合わなければ null)。状態と code の組の正本はここだけで、
 * Web の aiDailyLimitMessageOfResponse (src/lib/ai/daily-limit-client.ts) とモバイルの aiDailyLimitErrorOf
 * (apps/mobile/src/lib/ai-daily-limit.ts) が使う。aiDailyLimitMessageOfBody は状態を見ないので、画面の側から直接呼ばない。
 *   - 429 (AI_DAILY_LIMIT_STATUS): 本文の code が AI_DAILY_LIMIT のときだけ。レート制限の 429 (RATE_LIMITED) は null
 *   - 403 (AI_FEATURE_NOT_IN_PLAN_STATUS): 本文の code が AI_FEATURE_NOT_IN_PLAN のときだけ。同意の 403
 *     (AI_CONSENT_REQUIRED・LEGAL_CONSENT_REQUIRED) と、403 に AI_DAILY_LIMIT の本文が付いたもの (aiDailyLimitPayload はこの組を作らない) は null
 *   - 429 に AI_FEATURE_NOT_IN_PLAN の本文が付いたもの・ほかの状態: null
 */
export function aiDailyLimitMessageOfStatusAndBody(status: number, body: unknown): string | null {
  const code = deniedCodeOfBody(body);
  if (code === null) return null;
  const pairedStatus = code === AI_FEATURE_NOT_IN_PLAN_CODE ? AI_FEATURE_NOT_IN_PLAN_STATUS : AI_DAILY_LIMIT_STATUS;
  return status === pairedStatus ? aiDailyLimitMessageOfBody(body) : null;
}
