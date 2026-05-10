// src/schemas/membership/family-group.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const FamilyRoleSchema = z.enum(['representative','adult','child']);
export const FamilyStatusSchema = z.enum(['active','dissolved']);

export const CreateFamilyGroupBodySchema = z.object({
  name: z.string().min(1).max(60),
  plan_key: z.string().default('free'),
});

export const FamilyGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  representative_id: z.string().uuid(),
  plan_key: z.string(),
  member_limit: z.number().int().positive(),
  status: FamilyStatusSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  dissolved_at: z.string().datetime().nullable(),
});

export const CreateFamilyGroupResponseSchema = apiResponse(z.object({
  group: FamilyGroupSchema,
}));

export type FamilyRole = z.infer<typeof FamilyRoleSchema>;
export type FamilyStatus = z.infer<typeof FamilyStatusSchema>;
export type CreateFamilyGroupBody = z.infer<typeof CreateFamilyGroupBodySchema>;
export type FamilyGroup = z.infer<typeof FamilyGroupSchema>;
export type CreateFamilyGroupResponse = z.infer<typeof CreateFamilyGroupResponseSchema>;
