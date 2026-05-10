// src/schemas/membership/operator-membership.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const ForceTransferScopeSchema = z.enum(['org','family']);

export const ForceTransferBodySchema = z.object({
  scope: ForceTransferScopeSchema,
  scope_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
  reason: z.string().min(1).max(1000),
});

export const ForceDissolveBodySchema = z.object({
  scope: ForceTransferScopeSchema,
  scope_id: z.string().uuid(),
  reason: z.string().min(1).max(1000),
  notify_members: z.boolean().default(true),
});

export const ForceTransferResponseSchema = apiResponse(z.object({
  scope: ForceTransferScopeSchema,
  scope_id: z.string().uuid(),
  new_owner_id: z.string().uuid(),
  transferred_at: z.string().datetime(),
}));

export const ForceDissolveResponseSchema = apiResponse(z.object({
  scope: ForceTransferScopeSchema,
  scope_id: z.string().uuid(),
  dissolved_at: z.string().datetime(),
  notified_count: z.number().int().nonnegative(),
}));

export type ForceTransferBody = z.infer<typeof ForceTransferBodySchema>;
export type ForceDissolveBody = z.infer<typeof ForceDissolveBodySchema>;
export type ForceTransferResponse = z.infer<typeof ForceTransferResponseSchema>;
export type ForceDissolveResponse = z.infer<typeof ForceDissolveResponseSchema>;
