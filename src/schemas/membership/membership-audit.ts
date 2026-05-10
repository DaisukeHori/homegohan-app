// src/schemas/membership/membership-audit.ts
// (設計書 01-data-model.md §5)
import { z } from 'zod';

export const AuditScopeSchema = z.enum(['organization', 'family']);

export const AuditActionSchema = z.enum([
  'group_created',
  'group_dissolved',
  'invite_created',
  'invite_accepted',
  'invite_rejected',
  'invite_revoked',
  'invite_expired',
  'member_added',
  'member_removed',
  'member_left',
  'child_added',
  'child_promoted',
  'role_changed',
  'owner_transfer_proposed',
  'owner_transferred',
  'representative_transfer_proposed',
  'representative_transferred',
  'operator_force_owner_transfer',
  'operator_force_representative_transfer',
  'operator_force_dissolve',
  'paste_executed',
]);

export const MembershipAuditSchema = z.object({
  id: z.string().uuid(),
  scope: AuditScopeSchema,
  scope_id: z.string().uuid(),
  action: AuditActionSchema,
  actor_id: z.string().uuid().nullable(),
  target_user_id: z.string().uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string().datetime(),
});

export type AuditScope = z.infer<typeof AuditScopeSchema>;
export type AuditAction = z.infer<typeof AuditActionSchema>;
export type MembershipAudit = z.infer<typeof MembershipAuditSchema>;
