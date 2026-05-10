// src/schemas/membership/family-member.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';
import { FamilyRoleSchema } from './family-group';

export const FamilyMemberStatusSchema = z.enum(['active', 'removed', 'left']);

export const FamilyMemberSchema = z.object({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
  user_id: z.string().uuid().nullable(),
  role: FamilyRoleSchema,
  display_name: z.string().nullable(),
  relationship: z.string().nullable(),
  tags: z.array(z.string()),
  share_meals: z.boolean(),
  share_health: z.boolean(),
  share_menu: z.boolean(),
  child_profile: z.record(z.string(), z.unknown()).nullable(),
  avatar_color: z.string(),
  status: FamilyMemberStatusSchema,
  joined_at: z.string().datetime(),
  removed_at: z.string().datetime().nullable(),
});

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

export type FamilyMemberStatus = z.infer<typeof FamilyMemberStatusSchema>;
export type FamilyMember = z.infer<typeof FamilyMemberSchema>;
export type AddFamilyChildBody = z.infer<typeof AddFamilyChildBodySchema>;
export type PromoteChildBody = z.infer<typeof PromoteChildBodySchema>;
export type RemoveFamilyMemberBody = z.infer<typeof RemoveFamilyMemberBodySchema>;
export type LeaveFamilyResponse = z.infer<typeof LeaveFamilyResponseSchema>;
