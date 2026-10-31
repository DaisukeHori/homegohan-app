// src/schemas/membership/membership-audit.ts
// (設計書 01-data-model.md §5)
import { z } from 'zod';

export const AuditScopeSchema = z.enum(['organization', 'family']);

// membership_audit.action の全値。DB の CHECK membership_audit_action_check の配列と同じ値を同じ並びで持つ
// (最後の定義は supabase/migrations/20261017030000_parental_consent_and_birth_date.sql の 7.。
// 突き合わせは tests/membership-audit-schema-check-2093.test.ts。CHECK を変えたらここも変える)
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
  'owner_transfer_declined',
  'representative_transfer_proposed',
  'representative_transferred',
  'representative_transfer_declined',
  'operator_force_owner_transfer',
  'operator_force_representative_transfer',
  'operator_force_dissolve',
  'paste_executed',
  'child_promotion_requested',
  'child_promotion_rejected',
  'child_promotion_revoked',
  'parental_consent_recorded',
  'parental_consent_revoked',
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
