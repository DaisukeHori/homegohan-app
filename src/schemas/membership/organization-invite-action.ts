// src/schemas/membership/organization-invite-action.ts
// (設計書 01-data-model.md §2.6)
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';
import { OrgInviteSchema } from './organization-invite';

export const InviteTokenParamsSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'invalid token format'),
});

export const AcceptOrgInviteResponseSchema = apiResponse(z.object({
  organization_id: z.string().uuid(),
  org_role: z.enum(['owner','admin','member']),
}));

export const RejectOrgInviteResponseSchema = apiResponse(OrgInviteSchema);

export type InviteTokenParams = z.infer<typeof InviteTokenParamsSchema>;
export type AcceptOrgInviteResponse = z.infer<typeof AcceptOrgInviteResponseSchema>;
export type RejectOrgInviteResponse = z.infer<typeof RejectOrgInviteResponseSchema>;
