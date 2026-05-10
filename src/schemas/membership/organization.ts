// src/schemas/membership/organization.ts
// (設計書 01-data-model.md §2)
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const OrgRoleEnumSchema = z.enum(['owner', 'admin', 'member']);

// plan_key 9 種 (canonical: 設計書 §1.1)
export const OrgPlanKeySchema = z.enum([
  'free',
  'starter',
  'basic',
  'standard',
  'professional',
  'business',
  'enterprise',
  'trial',
  'custom',
]);

export const OrgStatusSchema = z.enum(['active', 'suspended', 'dissolved']);

export const OrganizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  owner_id: z.string().uuid().nullable(),
  plan: z.string().nullable(),
  status: OrgStatusSchema,
  contact_email: z.string().email().nullable(),
  contact_name: z.string().nullable(),
  industry: z.string().nullable(),
  employee_count: z.number().int().nullable(),
  logo_url: z.string().url().nullable(),
  settings: z.record(z.string(), z.unknown()).nullable(),
  subscription_status: z.string().nullable(),
  subscription_expires_at: z.string().datetime().nullable(),
  dissolved_at: z.string().datetime().nullable(),
  created_at: z.string().datetime().nullable(),
  updated_at: z.string().datetime().nullable(),
});

export const CreateOrganizationBodySchema = z.object({
  name: z.string().min(1).max(100),
  plan: OrgPlanKeySchema.default('free'),
  contact_email: z.string().email().optional(),
});

export const CreateOrganizationResponseSchema = apiResponse(z.object({
  organization: OrganizationSchema,
}));

export type OrgRoleEnum = z.infer<typeof OrgRoleEnumSchema>;
export type OrgPlanKey = z.infer<typeof OrgPlanKeySchema>;
export type OrgStatus = z.infer<typeof OrgStatusSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type CreateOrganizationBody = z.infer<typeof CreateOrganizationBodySchema>;
export type CreateOrganizationResponse = z.infer<typeof CreateOrganizationResponseSchema>;
