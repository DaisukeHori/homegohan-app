// src/schemas/membership/family-group.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const FamilyRoleSchema = z.enum(['representative','adult','child']);
export const FamilyStatusSchema = z.enum(['active','dissolved']);

// グループのプランは代表者の契約から DB のトリガーが決める (作成時には選べない)。
// z.object は知らない鍵を捨てるので、plan_key を送る古い画面があっても 400 にならない (#1797 段 D)
export const CreateFamilyGroupBodySchema = z.object({
  name: z.string().min(1).max(60),
});

export const FamilyGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  // active な行では NOT NULL (CHECK family_groups_active_has_representative)。解散した行は NULL (#1917)
  representative_id: z.string().uuid().nullable(),
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
