// src/schemas/membership/family-representative-transfer.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const ProposeFamilyRepresentativeTransferBodySchema = z.object({
  family_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
});

export const ProposeFamilyRepresentativeTransferResponseSchema = apiResponse(z.object({
  proposal_id: z.string().uuid(),
  expires_at: z.string().datetime(),
}));

export const AcceptFamilyRepresentativeTransferBodySchema = z.object({
  proposal_id: z.string().uuid(),
});

export const AcceptFamilyRepresentativeTransferResponseSchema = apiResponse(z.object({
  family_id: z.string().uuid(),
  new_representative_id: z.string().uuid(),
  transferred_at: z.string().datetime(),
}));

export type ProposeFamilyRepresentativeTransferBody = z.infer<typeof ProposeFamilyRepresentativeTransferBodySchema>;
export type ProposeFamilyRepresentativeTransferResponse = z.infer<typeof ProposeFamilyRepresentativeTransferResponseSchema>;
export type AcceptFamilyRepresentativeTransferBody = z.infer<typeof AcceptFamilyRepresentativeTransferBodySchema>;
export type AcceptFamilyRepresentativeTransferResponse = z.infer<typeof AcceptFamilyRepresentativeTransferResponseSchema>;
