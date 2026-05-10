// src/schemas/membership/organization-member.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const RemoveOrgMemberBodySchema = z.object({
  organization_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

export const LeaveOrgResponseSchema = apiResponse(z.object({
  user_id: z.string().uuid(),
  left_at: z.string().datetime(),
}));

export type RemoveOrgMemberBody = z.infer<typeof RemoveOrgMemberBodySchema>;
export type LeaveOrgResponse = z.infer<typeof LeaveOrgResponseSchema>;
