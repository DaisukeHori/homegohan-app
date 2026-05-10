// src/schemas/membership/organization-invite.ts
// (設計書 01-data-model.md §2.6)
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const OrgRoleSchema = z.enum(['owner','admin','member']);
export const OrgInviteStatusSchema = z.enum(['pending','accepted','rejected','expired','revoked']);

export const CreateOrgInviteBodySchema = z.object({
  organization_id: z.string().uuid(),
  email: z.string().email().toLowerCase(),
  role: OrgRoleSchema.default('member'),
  custom_message: z.string().max(500).optional(),
});

export const OrgInviteSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  email: z.string().email(),
  token: z.string(),
  invited_role: OrgRoleSchema,
  custom_message: z.string().nullable(),
  status: OrgInviteStatusSchema,
  expires_at: z.string().datetime(),
  created_at: z.string().datetime(),
  invited_by: z.string().uuid(),
  accepted_at: z.string().datetime().nullable(),
  accepted_by: z.string().uuid().nullable(),
  rejected_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable(),
  revoked_by: z.string().uuid().nullable(),
});

export const CreateOrgInviteResponseSchema = apiResponse(z.object({
  invite: OrgInviteSchema,
  invite_url: z.string().url(),  // クライアントがコピー/メール表示するための URL
}));

export type OrgRole = z.infer<typeof OrgRoleSchema>;
export type OrgInviteStatus = z.infer<typeof OrgInviteStatusSchema>;
export type CreateOrgInviteBody = z.infer<typeof CreateOrgInviteBodySchema>;
export type OrgInvite = z.infer<typeof OrgInviteSchema>;
export type CreateOrgInviteResponse = z.infer<typeof CreateOrgInviteResponseSchema>;
