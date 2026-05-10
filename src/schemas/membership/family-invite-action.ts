// src/schemas/membership/family-invite-action.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';
import { FamilyInviteSchema } from './family-invite';

export const FamilyInviteTokenParamsSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'invalid token format'),
});

export const AcceptFamilyInviteBodySchema = z.object({
  token: z.string(),
  share_meals: z.boolean().default(true),
  share_health: z.boolean().default(false),
  share_menu: z.boolean().default(true),
});

export const AcceptFamilyInviteResponseSchema = apiResponse(z.object({
  family_id: z.string().uuid(),
  member_id: z.string().uuid(),
  role: z.literal('adult'),
}));

export const RejectFamilyInviteResponseSchema = apiResponse(FamilyInviteSchema);

export type FamilyInviteTokenParams = z.infer<typeof FamilyInviteTokenParamsSchema>;
export type AcceptFamilyInviteBody = z.infer<typeof AcceptFamilyInviteBodySchema>;
export type AcceptFamilyInviteResponse = z.infer<typeof AcceptFamilyInviteResponseSchema>;
export type RejectFamilyInviteResponse = z.infer<typeof RejectFamilyInviteResponseSchema>;
