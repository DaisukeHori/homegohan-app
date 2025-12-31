/**
 * 献立生成v2 - 生成設定・リトライ設定
 */
import { z } from "zod";

// ============================================================
// リトライ設定
// ============================================================

/**
 * エラー種別
 */
export type ErrorType =
  | "llm_timeout"
  | "llm_rate_limit"
  | "json_parse"
  | "zod_validation"
  | "hard_constraint_violation"
  | "db_connection"
  | "proxy_not_found";

/**
 * エラー種別ごとのリトライ設定
 */
export const RETRY_CONFIG: Record<
  ErrorType,
  {
    shouldRetry: boolean;
    maxRetries: number;
    backoffType: "immediate" | "exponential";
    baseDelayMs: number;
  }
> = {
  llm_timeout: {
    shouldRetry: true,
    maxRetries: 3,
    backoffType: "exponential",
    baseDelayMs: 1000,
  },
  llm_rate_limit: {
    shouldRetry: true,
    maxRetries: 5,
    backoffType: "exponential",
    baseDelayMs: 5000,
  },
  json_parse: {
    shouldRetry: true,
    maxRetries: 2,
    backoffType: "immediate",
    baseDelayMs: 0,
  },
  zod_validation: {
    shouldRetry: true,
    maxRetries: 2,
    backoffType: "immediate",
    baseDelayMs: 0,
  },
  hard_constraint_violation: {
    shouldRetry: true,
    maxRetries: 3,
    backoffType: "immediate",
    baseDelayMs: 0,
  },
  db_connection: {
    shouldRetry: true,
    maxRetries: 3,
    backoffType: "exponential",
    baseDelayMs: 1000,
  },
  proxy_not_found: {
    shouldRetry: false,
    maxRetries: 0,
    backoffType: "immediate",
    baseDelayMs: 0,
  },
};

/**
 * 指数バックオフの遅延時間を計算
 */
export function calculateBackoffDelay(
  errorType: ErrorType,
  attemptNumber: number
): number {
  const config = RETRY_CONFIG[errorType];
  if (config.backoffType === "immediate") {
    return 0;
  }
  // 指数バックオフ: baseDelay * 2^(attemptNumber - 1)
  return config.baseDelayMs * Math.pow(2, attemptNumber - 1);
}

// ============================================================
// 品質監視の閾値
// ============================================================

export const QUALITY_THRESHOLDS = {
  // 生成成功率
  SUCCESS_RATE: {
    NORMAL: 0.98,
    WARNING: 0.95,
  },
  // generated率（1週間あたり、63品想定）
  GENERATED_DISH_COUNT: {
    NORMAL: 0,
    WARNING: 3,
    CRITICAL: 6,
  },
  // 平均生成時間（秒）
  AVG_GENERATION_TIME_SEC: {
    NORMAL: 30,
    WARNING: 60,
  },
  // 平均リトライ回数
  AVG_RETRY_COUNT: {
    NORMAL: 0.5,
    WARNING: 1.0,
  },
} as const;

// ============================================================
// planned_meals 拡張カラム用スキーマ
// ============================================================

/**
 * generation_metadata JSONBの構造
 */
export const GenerationMetadataSchema = z.object({
  model: z.string(), // "gpt-5-mini"
  generated_at: z.string().datetime(),
  adjustments: z
    .array(
      z.object({
        original_request: z.string(),
        changed_to: z.string(),
        reason: z.string(),
      })
    )
    .nullable(),
  validation_passed: z.boolean(),
  retry_count: z.number().int().nonnegative(),
  has_generated_dish: z.boolean(), // generated source の料理を含むか
  warnings: z.array(z.string()).nullable(), // 低類似度マッチ等の警告
});

export type GenerationMetadata = z.infer<typeof GenerationMetadataSchema>;

/**
 * source_type カラムの値
 */
export const SourceTypeSchema = z.enum(["legacy", "dataset", "mixed"]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

// ============================================================
// LLMプロンプト生成用の制約分類
// ============================================================

/**
 * ハード制約（必ず守る）
 */
export const HardConstraintSchema = z.object({
  type: z.enum(["allergy", "banned_ingredient", "max_sodium", "max_calories"]),
  value: z.union([z.string(), z.number()]),
  description: z.string(),
});

export type HardConstraint = z.infer<typeof HardConstraintSchema>;

/**
 * ソフト制約（できるだけ守る）
 */
export const SoftConstraintSchema = z.object({
  type: z.enum([
    "avoid_protein_overlap",
    "breakfast_light",
    "time_limit",
    "cuisine_preference",
    "pantry_priority",
    "weekday_quick",
  ]),
  value: z.union([z.string(), z.number(), z.array(z.string())]),
  priority: z.enum(["high", "medium", "low"]),
  description: z.string(),
});

export type SoftConstraint = z.infer<typeof SoftConstraintSchema>;

/**
 * 制約セット
 */
export const ConstraintSetSchema = z.object({
  hard: z.array(HardConstraintSchema),
  soft: z.array(SoftConstraintSchema),
});

export type ConstraintSet = z.infer<typeof ConstraintSetSchema>;

