// src/schemas/membership/family-member.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const AddFamilyChildBodySchema = z.object({
  family_id: z.string().uuid(),
  display_name: z.string().min(1).max(60),
  child_profile: z.record(z.string(), z.unknown()),
});

export const PromoteChildBodySchema = z.object({
  member_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

export const RemoveFamilyMemberBodySchema = z.object({
  family_id: z.string().uuid(),
  member_id: z.string().uuid(),
});

export const LeaveFamilyResponseSchema = apiResponse(z.object({
  family_id: z.string().uuid(),
  member_id: z.string().uuid(),
  left_at: z.string().datetime(),
}));

export type AddFamilyChildBody = z.infer<typeof AddFamilyChildBodySchema>;
export type PromoteChildBody = z.infer<typeof PromoteChildBodySchema>;
export type RemoveFamilyMemberBody = z.infer<typeof RemoveFamilyMemberBodySchema>;
export type LeaveFamilyResponse = z.infer<typeof LeaveFamilyResponseSchema>;
