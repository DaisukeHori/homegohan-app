/**
 * 監査ログ スキーマ定義
 * operator/07-audit-monitoring.md §3-4 + operator/02-api-spec.md §6 準拠
 * SELECT は super_admin のみ
 */
import { z } from 'zod';

export const AuditLogQuerySchema = z.object({
  actor_id: z.string().uuid().optional(),
  target_id: z.string().uuid().optional(),
  action_type: z.string().optional(),
  severity: z.enum(['info', 'warn', 'critical']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

export interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  actor_email_snapshot: string | null;
  actor_role_snapshot: string | null;
  action_type: string;
  target_id: string | null;
  target_type: string | null;
  details: Record<string, unknown>;
  severity: 'info' | 'warn' | 'critical';
  ip_address: string | null;
  user_agent: string | null;
  session_id: string | null;
  impersonated_by: string | null;
  created_at: string;
}

export interface AuditLogListResponse {
  data: AuditLogEntry[];
  meta: {
    total: number;
    page: number;
    per_page: number;
  };
}
