/**
 * A/B テスト スキーマ定義
 * operator/01-data-model.md §3.13 + operator/02-api-spec.md §15 準拠
 */
import { z } from 'zod';
// 日付は YYYY-MM-DD の実在する日付だけを通す (#1482。正規表現だけでは 2026-02-30 が通り、DB の date 型への変換で失敗する)
import { CalendarDateSchema } from '@/lib/calendar-date-schema';

/** 実験の状態 (DB の CHECK experiments_status_check と同じ 4 つ) */
export const EXPERIMENT_STATUSES = ['draft', 'running', 'completed', 'cancelled'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/**
 * 実験の状態の遷移表 (#2059)。画面のボタンと同じ 3 つだけを許す:
 *   draft → running (一覧の「開始」・詳細の「実験開始」)・running → completed (「完了」)・running → cancelled (詳細の「中止」)
 * ここに無い変更 (同じ状態への変更・終わった実験の再開・下書きへの戻しなど) は PATCH が 409 で断る。
 * DB には遷移を止めるトリガーが無い (CHECK は値の範囲だけ) ので、守りは PATCH の route だけ
 */
export const EXPERIMENT_STATUS_TRANSITIONS: Readonly<Record<ExperimentStatus, readonly ExperimentStatus[]>> = {
  draft: ['running'],
  running: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function isExperimentStatus(value: unknown): value is ExperimentStatus {
  return typeof value === 'string' && (EXPERIMENT_STATUSES as readonly string[]).includes(value);
}

/** from (今の状態) から to へ変えてよいか。from が知らない値なら、どこへも変えない */
export function isAllowedExperimentStatusTransition(from: string, to: ExperimentStatus): boolean {
  return isExperimentStatus(from) && EXPERIMENT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * 作成で、同じキー (experiments.key。一意の制約 experiments_key_key) の実験がすでにあるときのエラーの code と文 (HTTP は 409。#2093 W1)。
 * 機能フラグの作成 (OP_FEATURE_FLAG_IN_USE)・機能パッケージ・クーポン・プランの作成と同じく、一意の違反 (23505) を 500 にしない。
 * 作成の応答が切れたあとに押し直したときも、作成は済んでいるのに「作成に失敗しました (HTTP 500)」と出さない
 */
export const EXPERIMENT_KEY_DUPLICATE_ERROR_CODE = 'OP_EXPERIMENT_KEY_DUPLICATE';
export const EXPERIMENT_KEY_DUPLICATE_MESSAGE = '同じキーの実験がすでにあります';

/** 遷移表に無い状態の変更を断るときのエラーの code (HTTP は 409) */
export const EXPERIMENT_INVALID_TRANSITION_ERROR_CODE = 'OP_EXPERIMENT_INVALID_TRANSITION';

/** 遷移表にある遷移を「a → b」の形で並べた文 (断るときの文に添える) */
const ALLOWED_EXPERIMENT_TRANSITIONS_TEXT = EXPERIMENT_STATUSES.flatMap((from) =>
  EXPERIMENT_STATUS_TRANSITIONS[from].map((to) => `${from} → ${to}`),
).join('・');

/** 遷移表に無い状態の変更を断るときの文。変えられる遷移も添える */
export function experimentStatusTransitionMessage(from: string, to: ExperimentStatus): string {
  return `実験の状態は ${from} から ${to} へは変えられません (変えられるのは ${ALLOWED_EXPERIMENT_TRANSITIONS_TEXT} だけです)`;
}

export const ExperimentVariantSchema = z.object({
  key: z.string().min(1).max(50),
  weight: z.number().int().min(0).max(100),
  description: z.string().max(200).optional(),
});

export const CreateExperimentSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/).min(1).max(100),
  name: z.string().min(1).max(200),
  hypothesis: z.string().max(1000).optional(),
  variants: z.array(ExperimentVariantSchema).min(2),
  primary_metric: z.string().max(100).optional(),
  start_date: CalendarDateSchema.optional(),
  end_date: CalendarDateSchema.optional(),
}).refine(
  (data) => data.variants.reduce((sum, v) => sum + v.weight, 0) === 100,
  { message: '全バリアントの重み (weight) の合計は 100 である必要があります', path: ['variants'] },
);

export const UpdateExperimentSchema = z.object({
  status: z.enum(EXPERIMENT_STATUSES).optional(),
  name: z.string().min(1).max(200).optional(),
  hypothesis: z.string().max(1000).optional(),
  end_date: CalendarDateSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});

export type CreateExperimentInput = z.infer<typeof CreateExperimentSchema>;
export type UpdateExperimentInput = z.infer<typeof UpdateExperimentSchema>;
export type ExperimentVariant = z.infer<typeof ExperimentVariantSchema>;

export interface Experiment {
  id: string;
  key: string;
  name: string;
  hypothesis: string | null;
  variants: ExperimentVariant[];
  primary_metric: string | null;
  start_date: string | null;
  end_date: string | null;
  status: ExperimentStatus;
  result: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
}

export interface ExperimentResults {
  experiment_id: string;
  total_assignments: number;
  by_variant: Array<{
    variant_key: string;
    assignment_count: number;
    conversion_rate: number | null;
    p_value: number | null;
    confidence_interval: [number, number] | null;
  }>;
  is_significant: boolean | null;
  winner: string | null;
}
