// src/schemas/membership/meal-paste.ts
// (設計書 01-data-model.md §4.2)
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const PasteMealBodySchema = z.object({
  source_meal_id: z.string().uuid(),
  target_user_ids: z.array(z.string().uuid()).min(1).max(20),
});

export const PasteMealResponseSchema = apiResponse(z.object({
  paste_group_id: z.string().uuid(),
  inserted_count: z.number().int().nonnegative(),
}));

export type PasteMealBody = z.infer<typeof PasteMealBodySchema>;
export type PasteMealResponse = z.infer<typeof PasteMealResponseSchema>;
