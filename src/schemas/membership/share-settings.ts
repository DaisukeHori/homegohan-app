// src/schemas/membership/share-settings.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const UpdateShareSettingsBodySchema = z.object({
  share_meals: z.boolean().optional(),
  share_health: z.boolean().optional(),
  share_menu: z.boolean().optional(),
});

export const UpdateShareSettingsResponseSchema = apiResponse(z.object({
  member_id: z.string().uuid(),
  share_meals: z.boolean(),
  share_health: z.boolean(),
  share_menu: z.boolean(),
  updated_at: z.string().datetime(),
}));

export type UpdateShareSettingsBody = z.infer<typeof UpdateShareSettingsBodySchema>;
export type UpdateShareSettingsResponse = z.infer<typeof UpdateShareSettingsResponseSchema>;
