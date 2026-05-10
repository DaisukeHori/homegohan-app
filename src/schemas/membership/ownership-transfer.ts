// src/schemas/membership/ownership-transfer.ts
// (設計書 01-data-model.md §4)
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const TransferScopeSchema = z.enum(['organization', 'family']);
export const TransferStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'expired']);

export const OwnershipTransferProposalSchema = z.object({
  id: z.string().uuid(),
  scope: TransferScopeSchema,
  scope_id: z.string().uuid(),
  from_user_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
  status: TransferStatusSchema,
  proposed_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
});

export const ProposeTransferBodySchema = z.object({
  scope: TransferScopeSchema,
  scope_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
});

export const ProposeTransferResponseSchema = apiResponse(z.object({
  proposal_id: z.string().uuid(),
  expires_at: z.string().datetime(),
}));

export const AcceptTransferBodySchema = z.object({
  proposal_id: z.string().uuid(),
});

export const AcceptTransferResponseSchema = apiResponse(z.object({
  scope: TransferScopeSchema,
  scope_id: z.string().uuid(),
  new_owner_id: z.string().uuid(),
  transferred_at: z.string().datetime(),
}));

export type TransferScope = z.infer<typeof TransferScopeSchema>;
export type TransferStatus = z.infer<typeof TransferStatusSchema>;
export type OwnershipTransferProposal = z.infer<typeof OwnershipTransferProposalSchema>;
export type ProposeTransferBody = z.infer<typeof ProposeTransferBodySchema>;
export type ProposeTransferResponse = z.infer<typeof ProposeTransferResponseSchema>;
export type AcceptTransferBody = z.infer<typeof AcceptTransferBodySchema>;
export type AcceptTransferResponse = z.infer<typeof AcceptTransferResponseSchema>;
