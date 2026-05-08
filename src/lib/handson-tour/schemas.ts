import { z } from 'zod';

export const HandsonTourStatusResponseSchema = z.object({
  should_show: z.boolean(),
  completed_at: z.string().datetime().nullable(),
  skipped_at: z.string().datetime().nullable(),
  reason: z.enum([
    'eligible',
    'onboarding_not_completed',
    'already_completed',
    'already_skipped',
    'admin_role',
    'existing_user_auto_skip',
    'feature_disabled',
    'not_in_rollout',
  ]),
});
export type HandsonTourStatusResponse = z.infer<typeof HandsonTourStatusResponseSchema>;

export const HandsonTourCompleteResponseSchema = z.object({
  completed_at: z.string().datetime(),
  badge_awarded: z.object({
    code: z.literal('tutorial_complete'),
    name: z.string(),
    obtained_at: z.string().datetime(),
    icon_url: z.string().nullable(),
  }),
  already_completed: z.boolean(),
  total_duration_ms: z.number().int().optional(),
});
export type HandsonTourCompleteResponse = z.infer<typeof HandsonTourCompleteResponseSchema>;

export const HandsonTourSkipRequestSchema = z.object({
  step: z.number().int().min(0).max(4),
  reason: z.enum(['user_action', 'hard_back']),
});
export type HandsonTourSkipRequest = z.infer<typeof HandsonTourSkipRequestSchema>;

export const HandsonTourSkipResponseSchema = z.object({
  skipped_at: z.string().datetime(),
});
export type HandsonTourSkipResponse = z.infer<typeof HandsonTourSkipResponseSchema>;
