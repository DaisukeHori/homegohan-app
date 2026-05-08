/**
 * A/B テスト スキーマ定義
 * operator/01-data-model.md §3.13 + operator/02-api-spec.md §15 準拠
 */
import { z } from 'zod';

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
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine(
  (data) => data.variants.reduce((sum, v) => sum + v.weight, 0) === 100,
  { message: '全バリアントの weight 合計は 100 である必要があります', path: ['variants'] },
);

export const UpdateExperimentSchema = z.object({
  status: z.enum(['draft', 'running', 'completed', 'cancelled']).optional(),
  name: z.string().min(1).max(200).optional(),
  hypothesis: z.string().max(1000).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
  status: 'draft' | 'running' | 'completed' | 'cancelled';
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
