/**
 * LLM 使用量 スキーマ定義
 * operator/06-ai-llm.md §4 + operator/02-api-spec.md §8 準拠
 */
import { z } from 'zod';
// 期間の開始日・終了日 (YYYY-MM-DD の実在する日付)。使用量の API は JST 0 時の時刻に直して絞る (#1433) ので、
// 存在しない日付は入口で 400 にする (通すと時刻に直すところで例外になり 500 になる)
import { CalendarDateSchema } from '@/lib/calendar-date-schema';

export const LLMProvider = ['gemini', 'xai', 'anthropic', 'openai'] as const;
export type LLMProvider = typeof LLMProvider[number];

export const LLMUsageQuerySchema = z.object({
  period: z.enum(['1d', '7d', '30d', 'custom']).default('7d'),
  from: CalendarDateSchema.optional(),
  to: CalendarDateSchema.optional(),
  model: z.string().optional(),
  function: z.string().optional(),
  provider: z.enum(LLMProvider).optional(),
});

/**
 * 集計する期間の開始日が終了日より後のとき (GET /api/super-admin/llm/usage の 400 の details に入れる文。#1498)。
 * 期間は period と to から決まる (7d / 30d に過去の to を渡しても開始日が後になる) ので、schema ではなく route で判定する
 */
export const LLM_USAGE_FROM_AFTER_TO_MESSAGE = '開始日は終了日と同じ日かそれより前にしてください';

/** 1 日の上限に保存できる最大の回数。運営の入力の打ち間違い (桁の誤り) を止めるための上限 (DB の INTEGER の範囲より十分小さい) */
export const AI_DAILY_LIMIT_MAX = 10_000;
/** プランの鍵の最大の長さ (subscription_plans.plan_key の実際の値より十分長い) */
const PLAN_KEY_MAX_LENGTH = 100;
/** 変更の理由の最大の長さ (監査ログに残す) */
const QUOTA_REASON_MAX_LENGTH = 500;

/**
 * AI の 1 日の上限の変更 (PATCH /api/super-admin/llm/quotas) の入力 (#1149)。
 *   - plan_key   : 変えるプラン (subscription_plans にあるもの、または組織のプランの値 ORG_PLAN_VALUES。#1912)。
 *                  subscription_plans の組織のプランの行 (org_*) は route が 409 PLAN_READ_ONLY で断る (#1912)
 *   - daily_limit: 1 日の上限の回数 (全機能の合計。0 以上 AI_DAILY_LIMIT_MAX 以下の整数)。null は無制限
 *   - reason     : 変更の理由 (監査ログに残す)
 * 保存先は DB の ai_daily_limits。保存した値は、次の AI の利用の判定 (consume_ai_usage) から効く。
 */
export const UpdateAiDailyLimitSchema = z.object({
  plan_key: z.string().trim().min(1).max(PLAN_KEY_MAX_LENGTH),
  daily_limit: z.number().int().min(0).max(AI_DAILY_LIMIT_MAX).nullable(),
  reason: z.string().trim().min(1).max(QUOTA_REASON_MAX_LENGTH),
});

/** 行の無いプランが使う上限のプラン (DB の consume_ai_usage_at の c_default_plan と同じ) */
export const AI_DAILY_LIMIT_DEFAULT_PLAN_KEY = 'free';

/**
 * GET /api/super-admin/llm/quotas の `note` (#1149)。値は AI の利用の判定に使われている。
 * 上限に数えない機能 (AI_UNMETERED_FEATURES: 画面を開いたときの自動のアドバイス・料理を保存したときの料理画像) は、
 * この上限の合計に入らず、機能ごとの安全弁 (DB の ai_unmetered_daily_caps) で止まる (#1487)
 */
export const LLM_QUOTAS_ENFORCED_NOTE =
  'AI の 1 日の利用回数の上限です（全機能の合計・日本時間の 0 時に戻ります）。値を保存すると、次の AI の利用から効きます。' +
  '自分の行が無いプランは free の値を使います。空欄（無制限）にすると、そのプランは上限なしになります。' +
  '画面を開いたときの自動のアドバイスと、料理を保存したときの料理画像は、この上限に数えません（機能ごとの 1 日の安全弁で止まります）。';

export type LLMUsageQuery = z.infer<typeof LLMUsageQuerySchema>;
export type UpdateAiDailyLimitInput = z.infer<typeof UpdateAiDailyLimitSchema>;

/**
 * 一覧の行のキーの出どころ (#1912)
 *   - subscription_plan: subscription_plans にあるプラン (個人・家族・org_*)。保存できる。ただし org_* (plan_type = 'org') の行は
 *                        判定に使われないので保存できない (src/lib/super-admin/ai-daily-limits.ts の isOrgSubscriptionPlanRow。#1912)
 *   - org_plan         : 組織のプランの値 (organizations.plan に書ける値 ORG_PLAN_VALUES。src/lib/org-plans.ts)。
 *                        get_effective_plan が組織の利用者にこの値をそのまま返すので、ai_daily_limits の行が組織の上限になる。保存できる
 *   - unknown          : どちらにも無いキー (ai_daily_limits に行だけがある)。PATCH は 404 PLAN_NOT_FOUND で断るので、画面では保存させない
 */
export const AI_DAILY_LIMIT_PLAN_SOURCES = ['subscription_plan', 'org_plan', 'unknown'] as const;
export type AiDailyLimitPlanSource = (typeof AI_DAILY_LIMIT_PLAN_SOURCES)[number];

/** 組織のプランの値の行の表示名に添える語 (運営の画面で、組織のプランの行だと分かるようにする。#1912) */
export const ORG_PLAN_DISPLAY_SUFFIX = '（組織のプラン）';

/** GET /api/super-admin/llm/quotas の 1 行 (プランごとの AI の 1 日の上限。#1149) */
export interface AiDailyLimitRow {
  plan_key: string;
  /** キーの出どころ (保存できるのは subscription_plan (org_* を除く) と org_plan。#1912) */
  plan_source: AiDailyLimitPlanSource;
  /** subscription_plans の表示名。組織のプランの値は「<値>（組織のプラン）」。どちらにも無いキーは null */
  display_name: string | null;
  /** subscription_plans の種類 (personal / family / org。プランの表に無いキーは null) */
  plan_type: string | null;
  /** そのプランの行の値 (行が無ければ null。無制限も null なので、configured と一緒に読む) */
  daily_limit: number | null;
  /** そのプランの行が ai_daily_limits にあるか (無ければ free の値を使う) */
  configured: boolean;
  /** 実際に効いている上限 (行の値、行が無ければ free の行の値)。null は無制限 */
  effective_daily_limit: number | null;
  /** 行を最後に保存した時刻 (行が無ければ null) */
  updated_at: string | null;
}
