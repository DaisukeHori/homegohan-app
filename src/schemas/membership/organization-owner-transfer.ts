// src/schemas/membership/organization-owner-transfer.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const ProposeOrgOwnerTransferBodySchema = z.object({
  organization_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
});

export const ProposeOrgOwnerTransferResponseSchema = apiResponse(z.object({
  proposal_id: z.string().uuid(),
  expires_at: z.string().datetime(),
}));

export const AcceptOrgOwnerTransferBodySchema = z.object({
  proposal_id: z.string().uuid(),
});

export const AcceptOrgOwnerTransferResponseSchema = apiResponse(z.object({
  organization_id: z.string().uuid(),
  new_owner_id: z.string().uuid(),
  transferred_at: z.string().datetime(),
}));

export type ProposeOrgOwnerTransferBody = z.infer<typeof ProposeOrgOwnerTransferBodySchema>;
export type ProposeOrgOwnerTransferResponse = z.infer<typeof ProposeOrgOwnerTransferResponseSchema>;
export type AcceptOrgOwnerTransferBody = z.infer<typeof AcceptOrgOwnerTransferBodySchema>;
export type AcceptOrgOwnerTransferResponse = z.infer<typeof AcceptOrgOwnerTransferResponseSchema>;
