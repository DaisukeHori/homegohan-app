// src/schemas/membership/family-invite.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const FamilyInviteStatusSchema = z.enum(['pending','accepted','rejected','expired','revoked']);

export const CreateFamilyInviteBodySchema = z.object({
  family_id: z.string().uuid(),
  email: z.string().email().toLowerCase(),
  custom_message: z.string().max(500).optional(),
});

export const FamilyInviteSchema = z.object({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
  email: z.string().email(),
  token: z.string(),
  invited_role: z.literal('adult'),
  custom_message: z.string().nullable(),
  status: FamilyInviteStatusSchema,
  expires_at: z.string().datetime(),
  created_at: z.string().datetime(),
  invited_by: z.string().uuid().nullable(),
  accepted_by: z.string().uuid().nullable(),
  accepted_at: z.string().datetime().nullable(),
  rejected_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable(),
  revoked_by: z.string().uuid().nullable(),
});

export const CreateFamilyInviteResponseSchema = apiResponse(z.object({
  invite: FamilyInviteSchema,
  invite_url: z.string().url(),
}));

export type FamilyInviteStatus = z.infer<typeof FamilyInviteStatusSchema>;
export type CreateFamilyInviteBody = z.infer<typeof CreateFamilyInviteBodySchema>;
export type FamilyInvite = z.infer<typeof FamilyInviteSchema>;
export type CreateFamilyInviteResponse = z.infer<typeof CreateFamilyInviteResponseSchema>;
