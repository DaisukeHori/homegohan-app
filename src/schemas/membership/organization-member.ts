// src/schemas/membership/organization-member.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';
import { OrgRoleSchema } from './organization-invite';

export const OrgMemberSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  org_role: OrgRoleSchema,
  nickname: z.string().nullable(),
  email: z.string().email().optional(),
  is_active_in_org: z.boolean().nullable(),
  joined_org_at: z.string().date().nullable(),
});

export const RemoveOrgMemberBodySchema = z.object({
  organization_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

export const LeaveOrgResponseSchema = apiResponse(z.object({
  user_id: z.string().uuid(),
  left_at: z.string().datetime(),
}));

export type OrgMember = z.infer<typeof OrgMemberSchema>;
export type RemoveOrgMemberBody = z.infer<typeof RemoveOrgMemberBodySchema>;
export type LeaveOrgResponse = z.infer<typeof LeaveOrgResponseSchema>;
